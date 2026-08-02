# 剧本杀语音房 - Hugging Face Spaces (Docker) 部署
# HF 免费档：CPU basic 2 vCPU / 16GB RAM；平台自动提供 HTTPS，端口固定 7860
FROM python:3.11-slim

WORKDIR /app

COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

WORKDIR /app/backend

EXPOSE 7860

# 单 worker（GAME 为进程内存态，多 worker 会各自持有房间状态）
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]
