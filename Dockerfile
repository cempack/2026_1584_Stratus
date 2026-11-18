# --- Frontend build ---------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Runtime ----------------------------------------------------------------
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8090 STRATUS_DATA_DIR=/app/data
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY stratus/ stratus/
COPY data/ data/
COPY --from=web /web/dist web/dist

# OpenSky credentials: OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET from the environment.
# Mount a volume on /app/data/cache to keep the plane snapshot and credit budget across deploys.
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/api/status', timeout=4)"

# One worker: the feed pollers live in-process. Threads serve concurrent requests.
# --keep-alive 120: idle connections must outlive the reverse proxy's (Traefik: 90 s). With gunicorn's default 2 s, the
# proxy sometimes reused a connection gunicorn had just closed: GETs were retried silently, POSTs came back as 502.
CMD ["sh", "-c", "exec gunicorn -w 1 --threads 16 --keep-alive 120 -b 0.0.0.0:${PORT} --timeout 60 --access-logfile - 'stratus.api:create_app()'"]
