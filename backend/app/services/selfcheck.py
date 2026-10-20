"""性能自检：评估当前机器是否跑得动各功能模块。

用于部署到 VPS 后快速判断「够不够用」，避免靠猜。
检测项：
  - CPU：核数、单核浮点性能
  - 内存：总量、可用量
  - 磁盘：读写速度（顺序写）
  - SQLite：读写延迟
  - ONNX：模型加载耗时 + 单次推理耗时（若 BabelDOC 已装）
  - 综合：给出各项功能是否可用的结论
"""
from __future__ import annotations

import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any


def _cpu_baseline() -> float:
    """单核整数运算基准，返回耗时秒数（越小越快）。"""
    t0 = time.perf_counter()
    s = 0
    for i in range(2_000_000):
        s += i * i
    return time.perf_counter() - t0


def _mem_info() -> dict[str, Any]:
    info: dict[str, Any] = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k.strip()] = int(v.strip().split()[0])  # KB
    except Exception:
        return {"total_mb": None, "available_mb": None}

    swap_total = info.get("SwapTotal", 0) // 1024
    return {
        "total_mb": info.get("MemTotal", 0) // 1024,
        "available_mb": info.get("MemAvailable", 0) // 1024,
        "swap_mb": swap_total,
    }


def _disk_speed() -> dict[str, Any]:
    """测顺序写速度（写 64MB）。"""
    size_mb = 64
    try:
        with tempfile.NamedTemporaryFile(dir=tempfile.gettempdir(), delete=False) as f:
            path = Path(f.name)
        t0 = time.perf_counter()
        with open(path, "wb") as f:
            chunk = b"\0" * (1024 * 1024)
            for _ in range(size_mb):
                f.write(chunk)
            f.flush()
            os.fsync(f.fileno())
        elapsed = time.perf_counter() - t0
        path.unlink(missing_ok=True)
        return {
            "write_mb_s": round(size_mb / elapsed, 1) if elapsed > 0 else None,
            "elapsed_s": round(elapsed, 2),
        }
    except Exception as e:
        return {"write_mb_s": None, "error": str(e)[:100]}


def _sqlite_speed() -> dict[str, Any]:
    """测 SQLite 写入延迟。"""
    try:
        from ..core.db import db

        t0 = time.perf_counter()
        with db() as conn:
            conn.execute(
                "CREATE TEMP TABLE IF NOT EXISTS _perf_test (a INTEGER, b TEXT)"
            )
            for i in range(200):
                conn.execute("INSERT INTO _perf_test VALUES (?,?)", (i, "x" * 50))
            conn.execute("DROP TABLE _perf_test")
        return {"insert_200_ms": round((time.perf_counter() - t0) * 1000, 1)}
    except Exception as e:
        return {"error": str(e)[:100]}


def _onnx_bench() -> dict[str, Any]:
    """测 ONNX 模型加载与推理耗时。"""
    try:
        import onnxruntime as ort
    except ImportError:
        return {"available": False, "reason": "onnxruntime 未安装"}

    model = Path.home() / ".cache/babeldoc/models/doclayout_yolo_docstructbench_imgsz1024.onnx"
    if not model.exists():
        return {"available": False, "reason": "模型未下载（首次翻译时自动获取）"}

    try:
        import numpy as np

        so = ort.SessionOptions()
        so.intra_op_num_threads = max(1, min(2, os.cpu_count() or 1))
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

        t0 = time.perf_counter()
        sess = ort.InferenceSession(str(model), so, providers=["CPUExecutionProvider"])
        load_s = time.perf_counter() - t0

        inp = sess.get_inputs()[0]
        x = np.random.randn(1, 3, 1024, 1024).astype(np.float32)
        sess.run(None, {inp.name: x})  # 预热

        times = []
        for _ in range(2):
            t1 = time.perf_counter()
            sess.run(None, {inp.name: x})
            times.append(time.perf_counter() - t1)

        infer_ms = sum(times) / len(times) * 1000
        return {
            "available": True,
            "providers": ort.get_available_providers(),
            "model_size_mb": round(model.stat().st_size / 1024 / 1024, 1),
            "load_s": round(load_s, 2),
            "infer_ms": round(infer_ms, 0),
        }
    except Exception as e:
        return {"available": False, "reason": str(e)[:150]}


def run_selfcheck(quick: bool = False) -> dict[str, Any]:
    """执行完整自检。quick=True 时跳过磁盘和 ONNX 测试。"""
    cpu_count = os.cpu_count() or 1
    baseline = _cpu_baseline()
    mem = _mem_info()
    disk = {} if quick else _disk_speed()
    sqlite = _sqlite_speed()
    onnx = {} if quick else _onnx_bench()

    # ---- 单核性能评级 ----
    # 参考：桌面 5GHz ≈ 0.17s，入门 VPS 2.4GHz ≈ 0.35-0.45s
    if baseline < 0.25:
        cpu_level, cpu_desc = "excellent", "桌面级性能"
    elif baseline < 0.40:
        cpu_level, cpu_desc = "good", "主流 VPS 水平"
    elif baseline < 0.70:
        cpu_level, cpu_desc = "fair", "低配 VPS，可用但偏慢"
    else:
        cpu_level, cpu_desc = "slow", "性能很弱，翻译会明显慢"

    # ---- 内存评级 ----
    total_mb = mem.get("total_mb") or 0
    if total_mb >= 4096:
        mem_level = "excellent"
    elif total_mb >= 2048:
        mem_level = "good"
    elif total_mb >= 1024:
        mem_level = "fair"
    else:
        mem_level = "slow"

    # ---- 磁盘评级 ----
    w = disk.get("write_mb_s")
    if w is None:
        disk_level = "unknown"
    elif w >= 500:
        disk_level = "excellent"
    elif w >= 150:
        disk_level = "good"
    elif w >= 50:
        disk_level = "fair"
    else:
        disk_level = "slow"

    # ---- 功能结论 ----
    features: list[dict[str, Any]] = []

    # 基础功能（文献管理/阅读/标注）只要内存够就跑得动
    base_ok = total_mb >= 512
    features.append({
        "name": "文献管理与阅读",
        "ok": base_ok,
        "note": "PDF 渲染、标注、全文检索",
    })

    # 翻译（走远程 API，CPU 影响小）
    features.append({
        "name": "全文翻译 / 划词翻译",
        "ok": total_mb >= 512,
        "note": "计算在远端 API，本机只做请求转发",
    })

    # 双语 PDF（BabelDOC，本地 ONNX + 磁盘）
    if onnx.get("available"):
        infer_s = onnx["infer_ms"] / 1000
        # 单页约 1 次版面推理 + 字体排版，估算
        est_page_s = round(infer_s * 1.5 + 3, 1)
        bd_ok = total_mb >= 1024 and disk_level not in ("slow",)
        features.append({
            "name": "双语 PDF（BabelDOC）",
            "ok": bd_ok,
            "note": (
                f"预计单页约 {est_page_s}s，"
                f"8 页论文约 {round(est_page_s * 8 / 60, 1)} 分钟"
                if bd_ok
                else "内存或磁盘不足，建议只在小文件上使用"
            ),
            "est_page_seconds": est_page_s,
        })
    else:
        features.append({
            "name": "双语 PDF（BabelDOC）",
            "ok": False,
            "note": onnx.get("reason", "不可用"),
        })

    # MinerU 云端解析（远程，不占本地资源）
    features.append({
        "name": "全文解析（MinerU 云）",
        "ok": True,
        "note": "云端处理，本机无压力",
    })

    # ---- 总体结论 ----
    if total_mb >= 2048 and cpu_level in ("excellent", "good"):
        verdict = "良好：可以流畅运行全部功能"
    elif total_mb >= 1024:
        verdict = "可用：常规阅读与翻译流畅，双语 PDF 较慢"
    else:
        verdict = "受限：建议只用阅读/标注/翻译，避免大批量双语 PDF"

    if mem.get("swap_mb", 0) == 0 and total_mb < 3072:
        verdict += "（建议加 swap，防止 OOM）"

    return {
        "cpu": {
            "cores": cpu_count,
            "baseline_s": round(baseline, 3),
            "level": cpu_level,
            "desc": cpu_desc,
        },
        "memory": {
            **mem,
            "level": mem_level,
            "has_swap": mem.get("swap_mb", 0) > 0,
        },
        "disk": {**disk, "level": disk_level},
        "sqlite": sqlite,
        "onnx": onnx,
        "features": features,
        "verdict": verdict,
    }
