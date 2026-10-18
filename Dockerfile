FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m playwright install --with-deps chromium
COPY relay_app ./relay_app
COPY static ./static
EXPOSE 8091
CMD ["uvicorn", "relay_app.main:app", "--host", "0.0.0.0", "--port", "8091"]
