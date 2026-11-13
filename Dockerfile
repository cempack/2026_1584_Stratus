FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# OpenSky credentials: set OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET in the environment.
# The OpenSky cache snapshot lives in /app/data/cache; mount a volume there to keep it across deploys.
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8090/', timeout=4)"

CMD ["python", "main.py", "--no-browser", "--host", "0.0.0.0", "--port", "8090"]
