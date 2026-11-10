FROM python:3.11.9-slim-bookworm AS otlp
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /tests
COPY tests/ingestion/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY tests/ingestion/clients/ ./

FROM otlp AS jaeger
COPY tests/ingestion/requirements-jaeger.txt ./
RUN pip install --no-cache-dir -r requirements-jaeger.txt
