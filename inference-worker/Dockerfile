# Build from inference-worker/, never from the folder containing model data.
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    MPLCONFIGDIR=/tmp/matplotlib HF_HOME=/tmp/huggingface \
    STEGASUS_MODEL_RUN=/models STEGASUS_PIPELINE=direct \
    STEGASUS_BATCH_SIZE=32 STEGASUS_READ_WORKERS=4 STEGASUS_REQUIRE_GPU=1 \
    WORKER_CACHE=/cache
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir torch==2.7.1 torchvision==0.22.1 --index-url https://download.pytorch.org/whl/cu126 \
    && python -m pip install --no-cache-dir -r requirements.txt \
    && useradd --uid 10001 --create-home worker \
    && mkdir /cache && chown worker:worker /cache
COPY --chown=worker:worker *.py frozen-hashes.json /app/
COPY --chown=worker:worker frozen/ /app/frozen/
USER worker
ENTRYPOINT ["python", "worker.py"]
