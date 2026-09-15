"""Local, point-in-time research memory for D-Predict.

This module deliberately separates textual research from numerical market data.
It supports a lightweight deterministic hashing embedding fallback so a fresh
laptop can ingest/search documents without requiring a large ML model. If
sentence-transformers is installed, callers may provide a model later; the
stored model name is part of provenance.

Embeddings are evidence retrieval only. They never create or modify trading
labels, predictions, or outcomes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MEMORY_DIR = ROOT / "data" / "research"
DEFAULT_DIMENSIONS = 384
TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")


@dataclass(frozen=True)
class ResearchDocument:
    document_id: str
    symbol: str | None
    document_type: str
    title: str
    source: str
    source_url: str | None
    published_at: str | None
    content: str
    metadata: dict


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _hash_embedding(text: str, dimensions: int = DEFAULT_DIMENSIONS) -> list[float]:
    values = [0.0] * dimensions
    tokens = TOKEN_RE.findall(text.lower())
    if not tokens:
        return values
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        index = int.from_bytes(digest[:4], "big") % dimensions
        sign = 1.0 if digest[4] & 1 else -1.0
        values[index] += sign
    norm = math.sqrt(sum(value * value for value in values))
    return [value / norm for value in values] if norm else values


def chunk_text(text: str, max_chars: int = 1800, overlap: int = 200) -> list[str]:
    if max_chars <= overlap:
        raise ValueError("max_chars must be greater than overlap")
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = min(len(text), start + max_chars)
        if end < len(text):
            boundary = text.rfind(" ", start, end)
            if boundary > start + max_chars // 2:
                end = boundary
        chunks.append(text[start:end])
        if end == len(text):
            break
        start = max(0, end - overlap)
    return chunks


def save_document(document: ResearchDocument, embedding_model: str = "hash-v1") -> Path:
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    chunks = chunk_text(document.content)
    payload = {
        "document_id": document.document_id,
        "symbol": document.symbol,
        "document_type": document.document_type,
        "title": document.title,
        "source": document.source,
        "source_url": document.source_url,
        "published_at": document.published_at,
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "content_sha256": _sha256(document.content),
        "metadata": document.metadata,
        "embedding_model": embedding_model,
        "chunks": [
            {
                "chunk_id": f"{document.document_id}:{index}",
                "chunk_index": index,
                "content": chunk,
                "content_sha256": _sha256(chunk),
                "embedding": _hash_embedding(chunk),
            }
            for index, chunk in enumerate(chunks)
        ],
    }
    path = MEMORY_DIR / f"{document.document_id}.json"
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return path


def _cosine(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right))


def search(query: str, symbol: str | None = None, before: str | None = None, top_k: int = 8) -> list[dict]:
    if top_k < 1:
        raise ValueError("top_k must be positive")
    query_vector = _hash_embedding(query)
    cutoff = None if before is None else datetime.fromisoformat(before.replace("Z", "+00:00"))
    results = []
    for path in sorted(MEMORY_DIR.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if symbol and payload.get("symbol") not in {None, symbol.upper()}:
            continue
        published = payload.get("published_at")
        if cutoff and published:
            published_at = datetime.fromisoformat(published.replace("Z", "+00:00"))
            if published_at > cutoff:
                continue
        for chunk in payload.get("chunks", []):
            score = _cosine(query_vector, chunk["embedding"])
            results.append({
                "document_id": payload["document_id"],
                "chunk_id": chunk["chunk_id"],
                "symbol": payload.get("symbol"),
                "document_type": payload["document_type"],
                "title": payload["title"],
                "source": payload["source"],
                "source_url": payload.get("source_url"),
                "published_at": published,
                "score": round(score, 6),
                "content": chunk["content"],
            })
    return sorted(results, key=lambda item: item["score"], reverse=True)[:top_k]


def main() -> None:
    parser = argparse.ArgumentParser(description="Store/search D-Predict point-in-time research memory")
    sub = parser.add_subparsers(dest="command", required=True)
    ingest = sub.add_parser("ingest")
    ingest.add_argument("--document-id", required=True)
    ingest.add_argument("--symbol")
    ingest.add_argument("--document-type", required=True)
    ingest.add_argument("--title", required=True)
    ingest.add_argument("--source", required=True)
    ingest.add_argument("--source-url")
    ingest.add_argument("--published-at")
    ingest.add_argument("--text-file", type=Path, required=True)
    search_parser = sub.add_parser("search")
    search_parser.add_argument("query")
    search_parser.add_argument("--symbol")
    search_parser.add_argument("--before")
    search_parser.add_argument("--top-k", type=int, default=8)
    args = parser.parse_args()
    if args.command == "ingest":
        document = ResearchDocument(
            document_id=args.document_id,
            symbol=args.symbol.upper() if args.symbol else None,
            document_type=args.document_type,
            title=args.title,
            source=args.source,
            source_url=args.source_url,
            published_at=args.published_at,
            content=args.text_file.read_text(encoding="utf-8"),
            metadata={},
        )
        print(save_document(document))
    else:
        print(json.dumps(search(args.query, args.symbol, args.before, args.top_k), indent=2))


if __name__ == "__main__":
    main()
