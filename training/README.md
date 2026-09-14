# D-Predict ML training

This directory contains the historical-learning layer of D-Predict.

## Design

- `download_historical.py` downloads raw daily index history when local PostgreSQL history is insufficient.
- `build_dataset.py` creates point-in-time features and future-return labels.
- `train_baseline.py` trains the first market classifier/regressor using only earlier information.
- `walk_forward.py` produces strictly out-of-sample predictions with expanding windows.
- `embed_events.py` stores research-document vectors and performs local similarity search.
- `train_meta.py` learns a conservative calibration layer over model probabilities.

## Windows

Run from the repository root:

```powershell
.\dp.ps1 init
.\dp.ps1 migrate
.\dp.ps1 start
.\dp.ps1 train
.\dp.ps1 embed
```

To download a single symbol manually:

```powershell
.\dp.ps1 historical --symbols RELIANCE.NS --start 2015-01-01
```

The current baseline is intentionally simple. Its accuracy is not assumed. The walk-forward output is the source of truth for out-of-sample model evaluation.

## Embeddings

By default the vector engine uses a deterministic 384-dimensional hashing representation, so the local PostgreSQL image needs no extra extension. For semantic embeddings, install `sentence-transformers` into the same Python environment and set `EMBEDDING_MODEL`, for example:

```powershell
.\collector\.venv\Scripts\python.exe -m pip install sentence-transformers
$env:EMBEDDING_MODEL = "all-MiniLM-L6-v2"
.\dp.ps1 embed
```

Embeddings are stored as JSONB today. A future `pgvector` migration can add native approximate-nearest-neighbour indexing without changing the document or embedding contracts.
