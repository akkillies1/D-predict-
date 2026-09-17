FROM python:3.12-slim

WORKDIR /app
COPY ml-service/requirements.txt /app/ml_service/requirements.txt
RUN pip install --no-cache-dir -r /app/ml_service/requirements.txt
COPY training /app/training
COPY ml-service /app/ml_service
ENV PYTHONPATH=/app
EXPOSE 4300
CMD ["uvicorn", "ml_service.app:app", "--host", "0.0.0.0", "--port", "4300"]
