FROM python:3.12-slim

WORKDIR /app

# 系统依赖：node(服务端 KaTeX 渲染公式) + CJK 字体(PDF 中文) + Chrome 依赖库
RUN apt-get update && apt-get install -y --no-install-recommends \
        nodejs libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
        libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
        fonts-noto-cjk fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Chrome headless shell（HTML→PDF 打印，不走 apt）
ARG CHROME_VER=141.0.7390.54
RUN mkdir -p /opt/chrome && cd /opt/chrome \
    && curl -fsSL -o chrome.zip \
       "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VER}/linux64/chrome-headless-shell-linux64.zip" \
    && python3 -c "import zipfile;zipfile.ZipFile('chrome.zip').extractall('.')" \
    && rm chrome.zip && chmod +x chrome-headless-shell \
    && (chrome-headless-shell --version || true)

# 先装依赖（利用构建缓存）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple

COPY . .

# pdf.js 走本地 vendor（离线可用）
# （构建时由 install.sh 下载放置；见 DEPLOY.md）

EXPOSE 8001
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8001"]
