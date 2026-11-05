# paper-system MinerU image — based on official docker/china/Dockerfile,
# with the mineru version PINNED for reproducible deployments.
# Base: vLLM 0.21.0 + CUDA 13.0 (host driver >= 580 required; host CUDA toolkit irrelevant).
FROM docker.m.daocloud.io/vllm/vllm-openai:v0.21.0

# libgl for opencv
RUN apt-get update && \
    apt-get install -y libgl1 && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# MinerU 4.1.6 pinned (upstream uses floating >=4.0,<5)
RUN python3 -m pip install -U 'mineru[torch]==4.1.6' -i https://mirrors.aliyun.com/pypi/simple --break-system-packages && \
    python3 -m pip cache purge

# Keep build-time model downloads and runtime selection aligned
ENV MINERU_MODEL_SMALL_BACKEND=torch \
    MINERU_MODEL_VLM_ENGINE=vllm

# Bake models into the image (ModelScope) — makes `docker save` offline export self-contained
RUN /bin/bash -c "mineru-kit models download --tier standard --small-backend torch --vlm-engine vllm -s modelscope"

ENTRYPOINT ["/bin/bash", "-c", "export MINERU_MODEL_SOURCE=local && exec \"$@\"", "--"]
