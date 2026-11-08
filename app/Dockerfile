FROM python:3.12-slim

WORKDIR /app

# 系统依赖：node(服务端 KaTeX 渲染公式) + CJK 字体(PDF 中文) + Chrome 运行库
# 用阿里云源（官方源在国内极慢）；nodejs/字体分层安装，失败不影响其他层
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' \
        /etc/apt/sources.list.d/debian.sources 2>/dev/null || true; \
    apt-get update -qq && \
    apt-get install -y --no-install-recommends fonts-noto-cjk fonts-dejavu-core \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update -qq && apt-get install -y --no-install-recommends mupdf-tools \
    && rm -rf /var/lib/apt/lists/*
# mupdf-tools（mutool）是 CAJ→PDF 的硬依赖——缺失会让真实 .caj 转换全部失败
RUN apt-get update -qq && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* || echo "WARN: nodejs 缺失，公式将回退源码显示"

# PDF 渲染：调用宿主机渲染服务（host-chrome，见 scripts/render-service.py）

# 先装依赖（利用构建缓存）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple

COPY . .

# pdf.js 走本地 vendor（离线可用）
# （构建时由 install.sh 下载放置；见 DEPLOY.md）

EXPOSE 8001
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8001"]
