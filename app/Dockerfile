FROM python:3.12-slim

WORKDIR /app

# 先装依赖（利用构建缓存）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple

COPY . .

# pdf.js 走本地 vendor（离线可用）
# （构建时由 install.sh 下载放置；见 DEPLOY.md）

EXPOSE 8001
CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8001"]
