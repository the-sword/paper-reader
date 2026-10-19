"""统一的 HTTP 客户端工厂。

为什么需要它：
  环境里常见的代理配置（`all_proxy=socks5://...`、`no_proxy` 含 `[::1]`）会让
  httpx 自动读取环境变量时内部解析出错（典型报错 `Invalid port: ':1]'`）。
  同时，本地/内网地址本就不该走代理。

策略：
  1. 默认不读取 ENV 代理（trust_env=False），避免上述解析问题；
  2. 若用户显式设置 PAPER_READER_PROXY，则用它；
  3. 需要走系统代理时，设置 PAPER_READER_USE_ENV_PROXY=1 显式开启；
  4. 对 localhost / 127.0.0.1 / 内网段始终直连。
"""
from __future__ import annotations

import os
from urllib.parse import urlparse

import httpx

_PRIVATE_HOSTS = ("localhost", "127.0.0.1", "0.0.0.0", "::1")


def _is_private(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    if not host:
        return False
    if host in _PRIVATE_HOSTS:
        return True
    # 内网地址段
    if host.startswith(("10.", "192.168.", "169.254.")):
        return True
    if host.startswith("172."):
        try:
            second = int(host.split(".")[1])
            if 16 <= second <= 31:
                return True
        except (IndexError, ValueError):
            pass
    return False


def make_client(url: str, timeout: float = 120) -> httpx.Client:
    """按目标 URL 决定是否走代理。"""
    proxy = os.environ.get("PAPER_READER_PROXY", "").strip()
    use_env = os.environ.get("PAPER_READER_USE_ENV_PROXY", "").strip() in ("1", "true", "yes")

    if _is_private(url):
        # 本地服务永远直连
        return httpx.Client(timeout=timeout, trust_env=False)

    if proxy:
        try:
            return httpx.Client(timeout=timeout, proxy=proxy, trust_env=False)
        except Exception:
            # 代理串不合法时退化为直连，而不是让整个请求失败
            return httpx.Client(timeout=timeout, trust_env=False)

    if use_env:
        # 用户明确要求用环境代理：清理掉会让 httpx 解析出错的 no_proxy 项
        cleaned = _clean_no_proxy_env()
        try:
            client = httpx.Client(timeout=timeout, trust_env=True)
        except Exception:
            client = httpx.Client(timeout=timeout, trust_env=False)
        _restore_env(cleaned)
        return client

    return httpx.Client(timeout=timeout, trust_env=False)


def _clean_no_proxy_env() -> dict[str, str | None]:
    """临时移除含 IPv6 方括号的 no_proxy 条目（httpx 解析会误判为端口）。"""
    saved: dict[str, str | None] = {}
    for key in ("NO_PROXY", "no_proxy"):
        val = os.environ.get(key)
        if val is None:
            continue
        saved[key] = val
        parts = [p.strip() for p in val.split(",") if p.strip() and "[" not in p]
        os.environ[key] = ",".join(parts)
    return saved


def _restore_env(saved: dict[str, str | None]) -> None:
    for key, val in saved.items():
        if val is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = val
