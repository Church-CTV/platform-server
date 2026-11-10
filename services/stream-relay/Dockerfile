FROM python:3.14-slim AS builder

WORKDIR /build
COPY pyproject.toml requirements.txt ./
RUN pip install --no-cache-dir --prefix=/install .

FROM python:3.14-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /install /usr/local
COPY . .

RUN mkdir -p /app/hls

EXPOSE 8080 8081

CMD ["python", "-m", "ctv_server.main", "--config", "/app/config.yaml"]
