"""翻译引擎抽象层。

设计目标：
  - 每个引擎是一个独立 Provider，实现 translate() 即可
  - 配置来自数据库 settings 表（界面可改）或环境变量
  - 支持优先级列表与降级：前一个失败自动尝试下一个
  - 统一返回 EngineResult，UI 可标注译文来源

支持的引擎：
  - baidu    百度领域翻译（academic / it 垂直领域，学术论文首选）
  - google   Google 免费端点（无需 key）
  - bing     Bing 免费端点（需先换 token）
  - deepl    DeepL API
  - ai       任意 OpenAI 兼容大模型（质量最好，速度较慢）
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import re
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..core.db import db
from ..core.http import make_client


@dataclass
class EngineResult:
    text: str
    engine: str
    cached: bool = False
    latency_ms: int = 0
    meta: dict[str, Any] = field(default_factory=dict)


class EngineError(RuntimeError):
    """引擎调用失败。retryable 表示是否值得重试/降级。"""

    def __init__(self, msg: str, retryable: bool = True):
        super().__init__(msg)
        self.retryable = retryable


class TranslationEngine(Protocol):
    name: str
    label: str

    def configured(self) -> bool: ...
    def translate(self, text: str, src: str = "en", dst: str = "zh") -> EngineResult: ...


# ---------------------------------------------------------------------------
# 配置读写
# ---------------------------------------------------------------------------

CONFIG_KEYS = (
    "enabled",          # 是否启用
    "appid",            # 百度 AppID
    "appkey",           # 百度/DeepL 密钥
    "domain",           # 百度领域：academic / it / general...
    "endpoint",         # 自定义端点（可选）
    "region",           # DeepL 免费版用 api-free
)


def get_engine_config(name: str) -> dict[str, Any]:
    """读取某引擎配置：数据库优先，环境变量兜底。"""
    cfg: dict[str, Any] = {}
    with db() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key=?", (f"engine.{name}",)
        ).fetchone()
    if row:
        try:
            cfg = json.loads(row["value"])
        except Exception:
            cfg = {}

    prefix = f"TRANS_{name.upper()}_"
    for key in CONFIG_KEYS:
        env_key = prefix + key.upper()
        val = os.environ.get(env_key, "").strip()
        if val and not cfg.get(key):
            cfg[key] = val

    # 默认值
    if name == "baidu" and not cfg.get("domain"):
        cfg["domain"] = "academic"
    if name == "deepl" and not cfg.get("region"):
        cfg["region"] = "api-free"
    return cfg


def save_engine_config(name: str, cfg: dict[str, Any]) -> None:
    current = get_engine_config(name)
    current.update({k: v for k, v in cfg.items() if v is not None})
    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (f"engine.{name}", json.dumps(current, ensure_ascii=False)),
        )


def get_engine_order() -> list[str]:
    """读取引擎优先级顺序。"""
    with db() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key='engine.order'"
        ).fetchone()
    if row:
        try:
            order = json.loads(row["value"])
            if isinstance(order, list):
                return [str(x) for x in order]
        except Exception:
            pass
    return ["baidu", "tencent", "volcano", "google", "bing", "deepl", "ai"]


def set_engine_order(order: list[str]) -> None:
    with db() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('engine.order', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps(order),),
        )


# ---------------------------------------------------------------------------
# 百度领域翻译
# ---------------------------------------------------------------------------

# 百度错误码 → 可操作的中文提示
_BAIDU_ERRORS = {
    "52001": "请求超时，请重试",
    "52002": "百度系统错误，请重试",
    "52003": "未授权用户：请检查 AppID 是否为「领域翻译」产品、服务是否已开通",
    "54000": "必填参数为空：请检查 AppID 和密钥是否填写完整",
    "54001": "签名错误或领域产品未开通。常见原因："
             "① 未在控制台单独开通「领域翻译」产品；"
             "② 密钥有误或多带空格；"
             "③ 请求了不支持的语言方向",
    "54003": "访问频率受限：请降低调用频率（免费版 QPS 较低）",
    "54004": "账户余额不足：百度翻译免费额度已用完，请到控制台充值或等待月度重置",
    "54005": "长 query 请求频繁：请降低长文本的请求频率",
    "58000": "客户端 IP 非法：请检查是否在开放平台配置了 IP 白名单",
    "58001": "译文语言方向不支持：请检查 from/to 参数",
    "58002": "服务当前已关闭：请在控制台确认服务状态",
    "90107": "认证未通过或未生效：请在控制台完成实名认证",
}

# 这些错误值得重试（临时性问题）
_BAIDU_RETRYABLE = {"52001", "52002", "54003", "54005"}


def _baidu_error_message(code: str, raw: str) -> str:
    hint = _BAIDU_ERRORS.get(code)
    if hint:
        return f"百度翻译 {code}：{hint}"
    return f"百度翻译错误 {code}: {raw}"


class BaiduEngine:
    name = "baidu"
    label = "百度领域翻译"
    # 领域翻译端点
    FIELD_URL = "https://fanyi-api.baidu.com/api/trans/vip/fieldtranslate"
    # 通用翻译端点（领域产品未开通时的兜底）
    GENERAL_URL = "https://fanyi-api.baidu.com/api/trans/vip/translate"

    # 百度返回的语言代码
    LANGS = {"zh": "zh", "en": "en", "ja": "jp", "ko": "kor", "fr": "fra", "de": "de"}

    # 前端下拉可选的领域
    DOMAINS = [
        ("academic", "学术论文"),
        ("it", "信息技术"),
        ("medicine", "生物医药"),
        ("finance", "金融财经"),
        ("mechanics", "机械制造"),
        ("law", "法律法规"),
        ("news", "新闻资讯"),
        ("general", "通用"),
    ]

    def configured(self) -> bool:
        c = get_engine_config(self.name)
        return bool(c.get("appid") and c.get("appkey"))

    def _sign(self, appid: str, q: str, salt: str, appkey: str) -> str:
        raw = appid + q + salt + appkey
        return hashlib.md5(raw.encode("utf-8")).hexdigest()

    def translate(self, text: str, src: str = "en", dst: str = "zh") -> EngineResult:
        c = get_engine_config(self.name)
        appid, appkey = c.get("appid"), c.get("appkey")
        if not appid or not appkey:
            raise EngineError("百度翻译未配置 AppID/密钥", retryable=False)

        domain = (c.get("domain") or "academic").strip()
        t0 = time.time()

        # 先按配置的领域走「领域翻译」；若因 domain 参数报 54001
        # （常见于未单独开通领域翻译产品），自动退到通用翻译重试一次。
        attempts: list[tuple[str, str | None]] = [(self.FIELD_URL, domain)]
        if domain != "general":
            attempts.append((self.GENERAL_URL, None))

        last_err: EngineError | None = None
        for url, dom in attempts:
            body, err = self._request(url, text, src, dst, appid, appkey, dom)
            if err is None and body is not None:
                lines = [item.get("dst", "") for item in body.get("trans_result", [])]
                if not lines:
                    raise EngineError("百度翻译返回为空")
                return EngineResult(
                    text="\n".join(lines),
                    engine=self.name,
                    latency_ms=int((time.time() - t0) * 1000),
                    meta={
                        "domain": dom or "general",
                        "endpoint": "field" if dom else "general",
                    },
                )
            last_err = err
            # 只有「签名/领域未开通」这类错误才值得换端点重试
            if not (err and ("54001" in str(err) or "52003" in str(err))):
                break

        raise last_err or EngineError("百度翻译失败")

    def _request(self, url: str, text: str, src: str, dst: str,
                 appid: str, appkey: str, domain: str | None):
        """发一次请求。返回 (body, None) 或 (None, EngineError)。"""
        salt = str(random.randint(32768, 65536))
        # 签名只用 appid + q + salt + key，domain 不参与
        sign = self._sign(appid, text, salt, appkey)
        params: dict[str, Any] = {
            "q": text,
            "from": self.LANGS.get(src, src),
            "to": self.LANGS.get(dst, dst),
            "appid": appid,
            "salt": salt,
            "sign": sign,
        }
        if domain:
            params["domain"] = domain

        try:
            with make_client(url, timeout=30) as client:
                r = client.get(url, params=params)
        except Exception as e:  # noqa: BLE001
            return None, EngineError(f"百度翻译连接失败：{e}")

        if r.status_code != 200:
            return None, EngineError(f"百度翻译 HTTP {r.status_code}: {r.text[:200]}")

        try:
            body = r.json()
        except Exception:
            return None, EngineError(f"百度翻译返回非 JSON：{r.text[:120]}")

        if body.get("error_code"):
            code = str(body["error_code"])
            return None, EngineError(
                _baidu_error_message(code, body.get("error_msg", "")),
                retryable=code in _BAIDU_RETRYABLE,
            )
        return body, None


# ---------------------------------------------------------------------------
# Google 免费端点
# ---------------------------------------------------------------------------

class GoogleEngine:
    name = "google"
    label = "Google 翻译（免费端点）"
    URL = "https://translate.googleapis.com/translate_a/single"

    def configured(self) -> bool:
        # 无需 key，默认认为可用（可在设置里禁用）
        return True

    def translate(self, text: str, src: str = "en", dst: str = "zh") -> EngineResult:
        c = get_engine_config(self.name)
        url = c.get("endpoint") or self.URL
        params = {
            "client": "gtx",
            "sl": "auto",
            "tl": "zh-CN" if dst == "zh" else dst,
            "dt": "t",
            "q": text,
        }
        t0 = time.time()
        try:
            with make_client(url, timeout=30) as client:
                r = client.get(url, params=params)
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"Google 翻译连接失败：{e}") from e

        if r.status_code != 200:
            raise EngineError(f"Google 翻译 HTTP {r.status_code}")

        try:
            data = r.json()
            parts = [seg[0] for seg in data[0] if seg and seg[0]]
            out = "".join(parts)
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"Google 翻译解析失败：{e}") from e

        if not out.strip():
            raise EngineError("Google 翻译返回为空")
        return EngineResult(text=out, engine=self.name,
                            latency_ms=int((time.time() - t0) * 1000))


# ---------------------------------------------------------------------------
# Bing 免费端点（需要先换 token）
# ---------------------------------------------------------------------------

class BingEngine:
    name = "bing"
    label = "Bing 翻译（免费端点）"
    AUTH_URL = "https://edge.microsoft.com/translate/auth"
    API_URL = "https://api-edge.cognitive.microsofttranslator.com/translate"

    # 进程内缓存 token
    _token: str | None = None
    _token_at: float = 0.0
    # bing 的 token 有效期约 10 分钟
    _TTL = 480

    def configured(self) -> bool:
        return True

    def _get_token(self) -> str:
        now = time.time()
        if self._token and now - self._token_at < self._TTL:
            return self._token
        try:
            with make_client(self.AUTH_URL, timeout=20) as client:
                r = client.get(self.AUTH_URL)
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"Bing token 获取失败：{e}") from e
        if r.status_code != 200 or not r.text.strip():
            raise EngineError(f"Bing token 获取失败 HTTP {r.status_code}")
        BingEngine._token = r.text.strip()
        BingEngine._token_at = now
        return BingEngine._token

    def translate(self, text: str, src: str = "en", dst: str = "zh") -> EngineResult:
        c = get_engine_config(self.name)
        url = c.get("endpoint") or self.API_URL
        to = "zh-Hans" if dst == "zh" else dst
        t0 = time.time()

        def _call(token: str):
            params = {"api-version": "3.0", "to": to, "from": "en" if src == "en" else "auto"}
            headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
            with make_client(url, timeout=30) as client:
                return client.post(url, params=params, headers=headers,
                                   json=[{"Text": text}])

        token = self._get_token()
        try:
            r = _call(token)
            if r.status_code == 401:
                # token 失效，刷新一次
                BingEngine._token = None
                token = self._get_token()
                r = _call(token)
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"Bing 翻译连接失败：{e}") from e

        if r.status_code != 200:
            raise EngineError(f"Bing 翻译 HTTP {r.status_code}: {r.text[:120]}")

        body = r.json()
        try:
            out = body[0]["translations"][0]["text"]
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"Bing 翻译解析失败：{e}") from e

        return EngineResult(text=out, engine=self.name,
                            latency_ms=int((time.time() - t0) * 1000))


# ---------------------------------------------------------------------------
# DeepL
# ---------------------------------------------------------------------------

class DeepLEngine:
    name = "deepl"
    label = "DeepL"
    LANGS = {"zh": "ZH", "en": "EN", "ja": "JA", "ko": "KO", "fr": "FR", "de": "DE"}

    def configured(self) -> bool:
        c = get_engine_config(self.name)
        return bool(c.get("appkey"))

    def translate(self, text: str, src: str = "en", dst: str = "zh") -> EngineResult:
        c = get_engine_config(self.name)
        key = c.get("appkey")
        if not key:
            raise EngineError("DeepL 未配置 API Key", retryable=False)

        region = c.get("region") or "api-free"
        base = c.get("endpoint") or (
            "https://api-free.deepl.com" if region == "api-free" else "https://api.deepl.com"
        )
        url = f"{base.rstrip('/')}/v2/translate"

        t0 = time.time()
        try:
            with make_client(url, timeout=40) as client:
                r = client.post(
                    url,
                    headers={"Authorization": f"DeepL-Auth-Key {key}"},
                    data={
                        "text": text,
                        "target_lang": self.LANGS.get(dst, "ZH"),
                        "source_lang": self.LANGS.get(src, "EN"),
                    },
                )
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"DeepL 连接失败：{e}") from e

        if r.status_code == 429:
            raise EngineError("DeepL 限流", retryable=True)
        if r.status_code != 200:
            raise EngineError(f"DeepL HTTP {r.status_code}: {r.text[:200]}")

        body = r.json()
        try:
            out = body["translations"][0]["text"]
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"DeepL 解析失败：{e}") from e

        return EngineResult(text=out, engine=self.name,
                            latency_ms=int((time.time() - t0) * 1000))


# ---------------------------------------------------------------------------
# AI（复用 translate 模块的 OpenAI 兼容调用）
# ---------------------------------------------------------------------------

class AIEngine:
    name = "ai"
    label = "AI 大模型"

    def configured(self) -> bool:
        from . import translate as ai_mod

        cfg = ai_mod.get_ai_config()
        return bool(cfg.get("base_url") and cfg.get("api_key"))

    def translate(self, text: str, src: str = "en", dst: str = "zh", kind: str = "text") -> EngineResult:
        from . import translate as ai_mod

        t0 = time.time()
        try:
            res = ai_mod.translate_text(text, kind)
        except Exception as e:  # noqa: BLE001
            # 把限流识别成可重试
            msg = str(e)
            raise EngineError(msg, retryable=("429" in msg or "限流" in msg)) from e

        return EngineResult(
            text=res["text"], engine=self.name,
            latency_ms=int((time.time() - t0) * 1000),
            meta={"model": res.get("model")},
        )


# ---------------------------------------------------------------------------
# 注册表
# ---------------------------------------------------------------------------

_ENGINE_HINTS = {
    "baidu": "推荐。百度翻译开放平台申请 AppID 与密钥，选择「领域翻译」产品，"
             "学术论文领域每月 50 万字符免费，QPS 10",
    "tencent": "推荐。腾讯云控制台开通机器翻译，获取 SecretId/SecretKey，"
               "每月 500 万字符免费（额度最大）",
    "volcano": "火山引擎控制台开通机器翻译，获取 AK/SK，每月 200 万字符免费",
    "google": "无需配置。非官方端点，可能被限流或需要代理，仅作备用",
    "bing": "无需配置。非官方端点，token 可能失效，仅作备用",
    "deepl": "DeepL 官网申请 API Key，免费版每月 50 万字符，服务器在境外",
    "ai": "质量最好但较慢（单段约 5-10 秒）。适合全文精翻，不适合划词",
}

def get_engine(name: str):
    return ENGINES.get(name)


def available_engines() -> list[dict[str, Any]]:
    """列出所有引擎及其状态，供设置界面渲染。"""
    order = get_engine_order()
    out = []
    for name in list(ENGINES.keys()):
        eng = ENGINES[name]
        cfg = get_engine_config(name)
        enabled = cfg.get("enabled")
        if enabled is None:
            enabled = True
        out.append({
            "name": name,
            "label": eng.label,
            "enabled": bool(enabled),
            "configured": bool(eng.configured()),
            "priority": order.index(name) if name in order else 99,
            "config": {
                k: ("已设置" if k == "appkey" and v else v)
                for k, v in cfg.items() if k in CONFIG_KEYS
            },
            "hint": _ENGINE_HINTS.get(name, ""),
            "domains": (
                [{"value": v, "label": lb} for v, lb in BaiduEngine.DOMAINS]
                if name == "baidu" else []
            ),
        })
    out.sort(key=lambda x: x["priority"])
    return out


def translate_with_fallback(
    text: str,
    kind: str = "text",
    preferred: str | None = None,
    src: str = "en",
    dst: str = "zh",
) -> EngineResult:
    """按优先级尝试各引擎，失败自动降级。

    preferred 指定时优先尝试该引擎，其余按顺序作为后备。
    """
    order = get_engine_order()
    if preferred and preferred in ENGINES:
        order = [preferred] + [x for x in order if x != preferred]

    errors: list[str] = []
    for name in order:
        eng = ENGINES.get(name)
        if not eng:
            continue
        cfg = get_engine_config(name)
        if cfg.get("enabled") is False:
            continue
        if not eng.configured():
            continue
        try:
            if name == "ai":
                res = eng.translate(text, src, dst, kind=kind)
            else:
                res = eng.translate(text, src, dst)
            if res.text and res.text.strip():
                if errors:
                    res.meta["fallbacks"] = errors
                return res
            errors.append(f"{name}: 返回为空")
        except EngineError as e:
            errors.append(f"{name}: {e}")
            continue
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {type(e).__name__}: {e}")
            continue

    raise EngineError(
        "所有翻译引擎均失败：" + "；".join(errors) if errors else "没有可用的翻译引擎"
    )


def test_engine(name: str) -> dict[str, Any]:
    """测试单个引擎连通性，返回耗时与译文。"""
    eng = ENGINES.get(name)
    if not eng:
        return {"ok": False, "error": "未知引擎"}
    if not eng.configured():
        return {"ok": False, "error": "未配置"}
    try:
        res = eng.translate("This paper proposes a novel method for stereo matching.")
        return {
            "ok": True, "engine": name, "text": res.text,
            "latency_ms": res.latency_ms, "meta": res.meta,
        }
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "engine": name, "error": str(e)[:300]}


# ---------------------------------------------------------------------------
# 腾讯云机器翻译（TC3-HMAC-SHA256 签名）
# ---------------------------------------------------------------------------

class TencentEngine:
    name = "tencent"
    label = "腾讯云机器翻译"
    HOST = "tmt.tencentcloudapi.com"
    SERVICE = "tmt"
    VERSION = "2018-03-21"
    ACTION = "TextTranslate"

    LANGS = {"zh": "zh", "en": "en", "ja": "ja", "ko": "ko", "fr": "fr", "de": "de"}

    def configured(self) -> bool:
        c = get_engine_config(self.name)
        return bool(c.get("appid") and c.get("appkey"))

    def _sign(self, secret_id: str, secret_key: str, payload: str,
              timestamp: int) -> dict[str, str]:
        """构造 TC3-HMAC-SHA256 签名所需的 header。"""
        import datetime as _dt

        date = _dt.datetime.fromtimestamp(timestamp, _dt.timezone.utc).strftime("%Y-%m-%d")

        # 1) 规范化请求
        content_type = "application/json; charset=utf-8"
        canonical_headers = f"content-type:{content_type}\nhost:{self.HOST}\n"
        signed_headers = "content-type;host"
        hashed_payload = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        canonical_request = (
            f"POST\n/\n\n{canonical_headers}\n{signed_headers}\n{hashed_payload}"
        )

        # 2) 待签名字符串
        credential_scope = f"{date}/{self.SERVICE}/tc3_request"
        string_to_sign = (
            "TC3-HMAC-SHA256\n"
            f"{timestamp}\n"
            f"{credential_scope}\n"
            f"{hashlib.sha256(canonical_request.encode('utf-8')).hexdigest()}"
        )

        # 3) 逐层派生密钥并计算签名
        import hmac as _hmac

        def _digest(key: bytes, msg: str) -> bytes:
            return _hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

        secret_date = _digest(f"TC3{secret_key}".encode("utf-8"), date)
        secret_service = _digest(secret_date, self.SERVICE)
        secret_signing = _digest(secret_service, "tc3_request")
        signature = _hmac.new(
            secret_signing, string_to_sign.encode("utf-8"), hashlib.sha256
        ).hexdigest()

        authorization = (
            f"TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        return {
            "Authorization": authorization,
            "Content-Type": content_type,
            "Host": self.HOST,
            "X-TC-Action": self.ACTION,
            "X-TC-Version": self.VERSION,
            "X-TC-Timestamp": str(timestamp),
        }

    def translate(self, text: str, src: str = "en", dst: str = "zh") -> EngineResult:
        import json as _json
        import time as _time

        c = get_engine_config(self.name)
        secret_id, secret_key = c.get("appid"), c.get("appkey")
        if not secret_id or not secret_key:
            raise EngineError("腾讯云未配置 SecretId/SecretKey", retryable=False)

        region = c.get("region") or "ap-guangzhou"
        payload = _json.dumps({
            "SourceText": text,
            "Source": self.LANGS.get(src, src),
            "Target": self.LANGS.get(dst, dst),
            "ProjectId": 0,
        }, ensure_ascii=False)

        ts = int(_time.time())
        headers = self._sign(secret_id, secret_key, payload, ts)
        headers["X-TC-Region"] = region

        t0 = _time.time()
        try:
            with make_client(f"https://{self.HOST}", timeout=30) as client:
                r = client.post(f"https://{self.HOST}", headers=headers,
                                content=payload.encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"腾讯云连接失败：{e}") from e

        if r.status_code != 200:
            raise EngineError(f"腾讯云 HTTP {r.status_code}: {r.text[:200]}")

        body = r.json()
        resp = body.get("Response") or {}
        if resp.get("Error"):
            err = resp["Error"]
            code = err.get("Code", "")
            msg = err.get("Message", "")
            hint = _TENCENT_ERRORS.get(code)
            raise EngineError(
                f"腾讯云 {code}：{hint or msg}",
                retryable=code in ("RequestLimitExceeded", "InternalError"),
            )

        out = resp.get("TargetText", "")
        if not out:
            raise EngineError("腾讯云返回为空")
        return EngineResult(
            text=out, engine=self.name,
            latency_ms=int((_time.time() - t0) * 1000),
            meta={"region": region},
        )


_TENCENT_ERRORS = {
    "AuthFailure.SignatureFailure": "签名错误：请检查 SecretId/SecretKey 是否正确",
    "AuthFailure.SecretIdNotFound": "SecretId 不存在：请到腾讯云控制台确认密钥",
    "AuthFailure.TokenFailure": "临时凭证 Token 无效",
    "UnauthorizedOperation": "未授权：请确认已开通机器翻译服务",
    "FailedOperation.NoFreeAmount": "免费额度已用完，请充值",
    "FailedOperation.UserNotRegistered": "账号未开通机器翻译服务",
    "RequestLimitExceeded": "请求频率超限，请降低调用速度",
    "InternalError": "腾讯云内部错误，请重试",
    "InvalidParameter": "参数错误",
}


# ---------------------------------------------------------------------------
# 火山引擎翻译（V4 签名）
# ---------------------------------------------------------------------------

class VolcanoEngine:
    name = "volcano"
    label = "火山引擎翻译"
    HOST = "translate.volcengineapi.com"
    SERVICE = "translate"
    VERSION = "2020-06-01"
    ACTION = "TranslateText"
    REGION = "cn-north-1"

    LANGS = {"zh": "zh", "en": "en", "ja": "ja", "ko": "ko", "fr": "fr", "de": "de"}

    def configured(self) -> bool:
        c = get_engine_config(self.name)
        return bool(c.get("appid") and c.get("appkey"))

    @staticmethod
    def _sha256_hex(data: bytes) -> str:
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def _hmac(key: bytes, msg: str) -> bytes:
        import hmac

        return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()

    @staticmethod
    def _norm_uri(path: str) -> str:
        from urllib.parse import quote

        if not path:
            return "/"
        return quote(path, safe="/-_.~")

    @staticmethod
    def _norm_query(params: dict[str, str]) -> str:
        from urllib.parse import quote

        items = sorted(params.items())
        return "&".join(
            f"{quote(k, safe='-_.~')}={quote(v, safe='-_.~')}" for k, v in items
        )

    def _sign(self, ak: str, sk: str, query: str, payload: str,
              timestamp: str) -> dict[str, str]:
        """构造火山 V4 签名（HMAC-SHA256）。"""
        import datetime as _dt

        # 日期与时间（UTC）
        dt = _dt.datetime.fromtimestamp(int(timestamp), _dt.timezone.utc)
        x_date = dt.strftime("%Y%m%dT%H%M%SZ")
        short_date = x_date[:8]

        body_hash = self._sha256_hex(payload.encode("utf-8"))
        content_type = "application/json"

        canonical_headers = (
            f"content-type:{content_type}\n"
            f"host:{self.HOST}\n"
            f"x-content-sha256:{body_hash}\n"
            f"x-date:{x_date}\n"
        )
        signed_headers = "content-type;host;x-content-sha256;x-date"

        canonical_request = "\n".join([
            "POST",
            self._norm_uri("/"),
            self._norm_query(dict(
                item.split("=", 1) for item in query.split("&") if "=" in item
            )),
            canonical_headers,
            signed_headers,
            body_hash,
        ])

        credential_scope = f"{short_date}/{self.REGION}/{self.SERVICE}/request"
        string_to_sign = "\n".join([
            "HMAC-SHA256",
            x_date,
            credential_scope,
            self._sha256_hex(canonical_request.encode("utf-8")),
        ])

        k_date = self._hmac(sk.encode("utf-8"), short_date)
        k_region = self._hmac(k_date, self.REGION)
        k_service = self._hmac(k_region, self.SERVICE)
        k_signing = self._hmac(k_service, "request")
        import hmac as _hmac_mod

        signature = _hmac_mod.new(
            k_signing, string_to_sign.encode("utf-8"), hashlib.sha256
        ).hexdigest()

        authorization = (
            f"HMAC-SHA256 Credential={ak}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        return {
            "Authorization": authorization,
            "Content-Type": content_type,
            "Host": self.HOST,
            "X-Content-Sha256": body_hash,
            "X-Date": x_date,
        }

    def translate(self, text: str, src: str = "en", dst: str = "zh") -> EngineResult:
        import json as _json
        import time as _time

        c = get_engine_config(self.name)
        ak, sk = c.get("appid"), c.get("appkey")
        if not ak or not sk:
            raise EngineError("火山引擎未配置 AK/SK", retryable=False)

        # 火山 TranslateText 的文本以数组形式提交
        payload = _json.dumps({
            "TargetLanguage": "zh" if dst == "zh" else dst,
            "TextList": [text],
        }, ensure_ascii=False)

        query = f"Action={self.ACTION}&Version={self.VERSION}"
        ts = str(int(_time.time()))
        headers = self._sign(ak, sk, query, payload, ts)

        url = f"https://{self.HOST}/?{query}"
        t0 = _time.time()
        try:
            with make_client(f"https://{self.HOST}", timeout=30) as client:
                r = client.post(url, headers=headers, content=payload.encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            raise EngineError(f"火山引擎连接失败：{e}") from e

        if r.status_code != 200:
            raise EngineError(f"火山引擎 HTTP {r.status_code}: {r.text[:200]}")

        body = r.json()
        meta = body.get("ResponseMetadata") or {}
        if meta.get("Error"):
            err = meta["Error"]
            code = err.get("Code", "")
            msg = err.get("Message", "")
            hint = _VOLCANO_ERRORS.get(code)
            raise EngineError(
                f"火山引擎 {code}：{hint or msg}",
                retryable="Limit" in code or "Internal" in code,
            )

        data = body.get("TranslationList") or body.get("Result") or []
        if isinstance(data, dict):
            data = data.get("TranslationList") or []
        out = ""
        if isinstance(data, list) and data:
            first = data[0]
            out = first.get("Translation") or first.get("translation") or ""
        if not out:
            raise EngineError("火山引擎返回为空")

        return EngineResult(
            text=out, engine=self.name,
            latency_ms=int((_time.time() - t0) * 1000),
        )


_VOLCANO_ERRORS = {
    "SignatureDoesNotMatch": "签名错误：请检查 AK/SK 是否正确、本机时间是否准确",
    "InvalidAccessKey": "AK 无效：请到火山控制台确认",
    "InvalidAuthorization": "授权信息无效",
    "FlowLimitExceeded": "请求频率超限，请降低调用速度",
    "QuotaExceeded": "额度已用完",
    "AccessDenied": "无权限：请确认已开通机器翻译服务",
}


ENGINES: dict[str, Any] = {
    "baidu": BaiduEngine(),
    "tencent": TencentEngine(),
    "volcano": VolcanoEngine(),
    "google": GoogleEngine(),
    "bing": BingEngine(),
    "deepl": DeepLEngine(),
    "ai": AIEngine(),
}
