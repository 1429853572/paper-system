#!/usr/bin/env python3
"""切换前验证：ollama vs xinference 的 embedding 一致性 + 检索效果对比。

用法:
  python3 scripts/compare-embed.py                  # 对比（需要两个服务都在跑）
输出: 逐文本余弦相似度、检索 top-5 对比、结论
"""
import json
import sys
import time

import httpx

OLLAMA = "http://localhost:11434/v1/embeddings"
XINF = "http://localhost:9997/v1/embeddings"

TEXTS = [
    "The Transformer architecture relies entirely on self-attention mechanisms.",
    "深度学习模型通过多头注意力捕获长距离依赖关系。",
    "We propose a novel view synthesis approach for sparse-view reconstruction.",
    "The kitchen is clean and the weather is sunny today.",
    "Neural Radiance Fields represent scenes as continuous volumetric functions.",
    "图神经网络在推荐系统中展现出优异的性能。",
]


def embed(url, model, texts):
    r = httpx.post(url, json={"model": model, "input": texts}, timeout=180)
    r.raise_for_status()
    d = sorted(r.json()["data"], key=lambda x: x["index"])
    return [x["embedding"] for x in d]


def cos(a, b):
    na = sum(x * x for x in a) ** 0.5
    nb = sum(x * x for x in b) ** 0.5
    return sum(x * y for x, y in zip(a, b)) / (na * nb + 1e-9)


def main():
    try:
        t0 = time.time()
        v_oll = embed(OLLAMA, "bge-m3", TEXTS)
        t_oll = time.time() - t0
    except Exception as e:
        print(f"ollama 不可用: {e}")
        return 1

    try:
        t0 = time.time()
        v_xin = embed(XINF, "bge-m3", TEXTS)
        t_xin = time.time() - t0
    except Exception as e:
        print(f"xinference 不可用: {e}")
        return 1

    print(f"维度: ollama={len(v_oll[0])} xinference={len(v_xin[0])}")
    print(f"耗时: ollama={t_oll:.2f}s xinference={t_xin:.2f}s")
    print("\n逐文本余弦相似度（同一文本两服务输出）:")
    sims = []
    for i, t in enumerate(TEXTS):
        s = cos(v_oll[i], v_xin[i])
        sims.append(s)
        print(f"  {s:.4f}  {t[:50]}")

    mean = sum(sims) / len(sims)
    print(f"\n平均相似度: {mean:.4f}")
    print(f"最差: {min(sims):.4f}")

    # 检索效果：各服务内部，query=TEXTS[0] vs 其他
    print("\n各服务自身检索 (query=TEXTS[0]) 排序:")
    for name, vecs in (("ollama", v_oll), ("xinference", v_xin)):
        ranked = sorted(
            ((cos(vecs[0], v), TEXTS[i][:45]) for i in range(len(TEXTS)) if i != 0),
            reverse=True)
        print(f"  [{name}]")
        for s, t in ranked[:3]:
            print(f"    {s:.4f} {t}")

    ok = mean >= 0.99
    print(f"\n结论: {'✅ 可切换（输出高度一致）' if ok else '⚠️ 输出差异较大，需评估'}")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
