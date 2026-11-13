#!/usr/bin/env python3
"""重编码 PDF 内的 JPXDecode(JPEG2000) 图片为 DCTDecode(JPEG)。

为什么：pdf.js 的内置 JPX 解码器不完整（Mozilla 未支持全部 JP2 变体），
arXiv tex2pdf 等管线的论文偶尔内嵌 JPX 图——阅读器里该图区域整块留白
（图注文字正常、图片本体空白）。MuPDF 有完整 JPX 解码，宿主重编码为
pdf.js/所有阅读器通吃的 JPEG 后问题消失。

用法（宿主机跑，需 pip install pymupdf）：
    python3 scripts/fix-jpx-images.py            # 扫描并修复整个 data/papers/
    python3 scripts/fix-jpx-images.py --dry-run  # 只报告，不改文件
    python3 scripts/fix-jpx-images.py data/papers/pXXXX/original.pdf  # 指定文件

安全：改动前写 original.pdf.jpxfix.new → 用 MuPDF 重新打开验证结构 → 原子
rename 覆盖；验证失败保留原文件。块索引/向量/摘要不受影响（文本层未动）。
"""
import glob
import os
import sys
import tempfile

os.environ.setdefault("PAPERSYS_DATA", os.path.join(os.path.dirname(__file__), "..", "data"))

import pymupdf  # MuPDF 引擎：完整 JPX 解码


def jpx_image_xrefs(doc):
    """列出文档中所有 JPXDecode 图片的 xref 号。"""
    out = []
    for xref in range(1, doc.xref_length()):
        try:
            if doc.xref_get_key(xref, "Subtype") != ("name", "/Image"):
                continue
            filt = doc.xref_get_key(xref, "Filter")
            if filt[0] == "array" and "JPXDecode" in filt[1]:
                out.append(xref)
            elif filt[0] == "name" and "JPXDecode" in filt[1]:
                out.append(xref)
        except Exception:
            continue
    return out


def reencode_one(doc, xref):
    """单张 JPX 图 → JPEG（RGB, q92）。返回 (宽, 高)；解码失败抛异常。"""
    pix = pymupdf.Pixmap(doc, xref)
    if pix.colorspace is None or pix.colorspace.n not in (1, 3):
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)      # CMYK/ICC/Indexed → RGB
    elif pix.alpha:
        pix = pymupdf.Pixmap(pix, 0)                   # 去 alpha（SMask 独立 xref，不受影响）
    jpg = pix.tobytes("jpg", jpg_quality=92)
    # compress=0 必须：update_stream 默认会把流再包一层 zlib，与随后声明的
    # /DCTDecode 不符（字节 0x78 开头）——所有阅读器都会解码失败
    try:
        doc.update_stream(xref, jpg, new=0, compress=0)   # pymupdf ≥1.20 签名
    except TypeError:
        doc.update_stream(xref, jpg, deflate=0)            # 旧版签名兜底
    doc.xref_set_key(xref, "Filter", "/DCTDecode")
    doc.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
    doc.xref_set_key(xref, "BitsPerComponent", "8")
    doc.xref_set_key(xref, "Decode", "null")           # 删除残留 Decode 数组
    return pix.width, pix.height


def fix_file(path, dry=False):
    doc = pymupdf.open(path)
    xrefs = jpx_image_xrefs(doc)
    if not xrefs:
        doc.close()
        return 0
    if dry:
        print(f"  [dry] {path}: {len(xrefs)} 张 JPX 图 (xref {xrefs})")
        doc.close()
        return len(xrefs)
    fd, tmp = tempfile.mkstemp(suffix=".pdf.jpxfix", dir=os.path.dirname(path))
    os.close(fd)
    try:
        n = 0
        for xref in xrefs:
            reencode_one(doc, xref)
            n += 1
        # 保存禁止 deflate 重压缩——deflate=True 会把刚写入的裸 JPEG 再包一层
        # zlib 并把滤镜覆盖为 /FlateDecode（载荷仍是 JPEG），pdf.js 按原始样本
        # 解码只会画出前 ~12% 行的噪声条、其余留白（真机踩过这个坑）
        doc.save(tmp, garbage=3, deflate=False)
        doc.close()
        # 结构验证：重新打开，逐页光栅化一遍（能渲染=结构完好）
        chk = pymupdf.open(tmp)
        for page in chk:
            page.get_pixmap(dpi=36)
        chk.close()
        os.replace(tmp, path)
        print(f"  ✓ {path}: 重编码 {n} 张 JPX → JPEG")
        return n
    except Exception as e:
        print(f"  ✗ {path}: {e}（原文件保留）")
        if os.path.exists(tmp):
            os.remove(tmp)
        return 0


def main():
    dry = "--dry-run" in sys.argv
    targets = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not targets:
        data = os.environ["PAPERSYS_DATA"]
        targets = sorted(glob.glob(os.path.join(data, "papers", "p*", "original.pdf")))
    total = 0
    for t in targets:
        try:
            total += fix_file(t, dry)
        except Exception as e:
            print(f"  ✗ {t}: 打开失败 {e}")
    print(f"\n完成：{'扫描' if dry else '重编码'} {total} 张 JPX 图（{len(targets)} 个文件）")


if __name__ == "__main__":
    main()
