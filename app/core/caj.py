"""CAJ → PDF 转换（知网专有格式 → 通用 PDF）。

背景：知网下载的中文文献（尤以学位论文）多为 .caj，MinerU 不支持该格式，
无法进入解析/索引/问答链路。转换借 caj2pdf（JeziL/caj2pdf，纯 Python 解析器，
GLWT 许可，源码内联于 app/core/vendor/caj2pdf/）。

要点：
- caj2pdf 依赖 PyPDF2（新版 API：PdfWriter/PdfReader）；容器装的是其继任者 pypdf，
  这里做一层 sys.modules 兼容垫片（PyPDF2 → pypdf），避免额外依赖与版本冲突
- 格式判定交给 caj2pdf 自己的 CAJParser（CAJ/HN/C8/KDH/PDF 都认），
  我们只在它失败时给出可读原因
- KDH 格式需 mutool 修复 xref（容器内无）→ 明确报错并保留原文件，不丢数据
"""
from __future__ import annotations

import logging
import os
import sys
import tempfile
from pathlib import Path

log = logging.getLogger("caj")

_PDF_MAGIC = b"%PDF-"
_VENDOR = Path(__file__).parent / "vendor" / "caj2pdf"


class ConvertError(Exception):
    """CAJ 转换失败（调用方应记录原因并保留原文件）。"""


def sniff(data: bytes) -> str:
    """粗判：'pdf' | 'caj' | 'unknown'（精确判定由 caj2pdf 自己做）。"""
    if data[:5] == _PDF_MAGIC:
        return "pdf"
    head = data[:16]
    if head.startswith(b"HCAJ") or head.startswith(b"KDH") or b"CAJ" in head:
        return "caj"
    if head.startswith(b"\xc8") or head.startswith(b"\x1b"):
        return "caj"
    return "unknown"


def _install_pypdf2_shim() -> None:
    """把 PyPDF2 名字指向 pypdf（caj2pdf 期望 PyPDF2 新版 API）。"""
    try:
        import pypdf  # noqa: F401
    except Exception as e:  # noqa: BLE001
        raise ConvertError("容器内缺少 pypdf，无法转换") from e
    if "PyPDF2" not in sys.modules:
        sys.modules["PyPDF2"] = pypdf
        for sub in ("generic", "errors", "utils", "_reader", "_writer"):
            mod = getattr(pypdf, sub, None)
            if mod is not None:
                sys.modules[f"PyPDF2.{sub}"] = mod


def _vendor_ready() -> bool:
    return (_VENDOR / "cajparser.py").exists()


def convert_bytes(data: bytes, name: str = "paper.caj") -> bytes:
    """CAJ bytes → PDF bytes。失败抛 ConvertError。"""
    if data[:5] == _PDF_MAGIC:
        return data                      # 伪装的 CAJ（本质是 PDF），直接用
    if not _vendor_ready():
        raise ConvertError("CAJ 转换器未部署（缺少 vendor/caj2pdf）")
    _install_pypdf2_shim()
    if str(_VENDOR) not in sys.path:
        sys.path.insert(0, str(_VENDOR))
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        src = tmp / "in.caj"
        src.write_bytes(data)
        out = tmp / "out.pdf"
        try:
            from cajparser import CAJParser
        except BaseException as e:  # noqa: BLE001 —— 依赖缺失/语法问题（SystemExit 也要拦）
            raise ConvertError(f"CAJ 解析器加载失败: {str(e)[:160]}") from None
        try:
            parser = CAJParser(str(src))
            parser.convert(str(out))
        except BaseException as e:  # noqa: BLE001 —— 解析器用 SystemExit 报「Unknown file type」
            msg = str(e)[:200] or type(e).__name__
            if "mutool" in msg.lower():
                raise ConvertError("KDH 格式需 mutool 修复（容器内未装），请改用 PDF 版或人工转换") from None
            if "Unknown file type" in msg:
                raise ConvertError("CAJ 格式无法识别（可能损坏或为知网未公开格式）") from None
            raise ConvertError(f"CAJ 转换失败: {msg}") from None
        if not out.exists() or out.stat().st_size < 500:
            raise ConvertError("CAJ 转换未产出有效 PDF")
        return out.read_bytes()


def convert_file(src: Path, dst: Path) -> Path:
    """文件版转换（保留原文件，失败不删）。"""
    pdf = convert_bytes(src.read_bytes(), src.name)
    dst.write_bytes(pdf)
    return dst


def tool_status() -> dict:
    """转换器可用性（供诊断展示）。"""
    return {"available": _vendor_ready(),
            "mutool": bool(os.path.exists("/usr/bin/mutool")),
            "note": "CAJ/HN/C8 可转；KDH 需 mutool（容器内未装）；伪 PDF 直接用"}
