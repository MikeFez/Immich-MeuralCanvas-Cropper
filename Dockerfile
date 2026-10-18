FROM python:3.13-slim

WORKDIR /app

# Install Python packages
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./
COPY docker-entrypoint.sh /usr/local/bin/

# All state (config.yaml, crops, image cache) lives in this one mount
RUN mkdir /config
VOLUME /config

ENV FLASK_DEBUG=0 \
    PYTHONUNBUFFERED=1

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/health', timeout=4)"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["python", "app.py"]
