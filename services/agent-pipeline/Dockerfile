# agent-pipeline：Plan → Execute → Reflect → Critic → (Adversarial) → Summarize
#
# 构建：docker build -t agent-pipeline:0.1.0 services/agent-pipeline
# 运行：docker run --rm -p 8000:8000 -e AGENT_PIPELINE_API_KEY=... agent-pipeline:0.1.0
FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# 先装依赖再拷源码，改代码不废依赖层。
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir . \
    && useradd --create-home --uid 10001 pipeline \
    && mkdir -p /app/data && chown -R pipeline:pipeline /app

USER pipeline

ENV AGENT_PIPELINE_LOG_PATH=/app/data/runs.jsonl \
    AGENT_PIPELINE_DB_PATH=/app/data/agent-pipeline.db

EXPOSE 8000

# 容器里只跑服务；CLI 用法见 README（run / tune / doctor）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3)"

CMD ["agent-pipeline", "serve", "--host", "0.0.0.0", "--port", "8000"]