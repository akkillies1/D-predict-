FROM python:3.12-slim

WORKDIR /app/ml_service
COPY ml-service/requirements.txt /app/ml_service/requirements.txt
RUN pip install --no-cache-dir -r /app/ml_service/requirements.txt
COPY training /app/training
COPY ml-service /app/ml_service
# Serve app.py as the top-level module `app` so the runtime module identity
# matches the training job and tests (which use `import app` / `from app import`).
# joblib pickles record ModelBundle.__module__; if the server imported it as
# `ml_service.app` while training wrote `app`, artifacts would fail to load with
# "No module named 'app'". /app stays on the path for the `training` package.
ENV PYTHONPATH=/app:/app/ml_service
EXPOSE 4300
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "4300"]
