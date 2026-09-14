"""Create and query a local vector memory for research documents.

Preferred provider: sentence-transformers (semantic embeddings).
Fallback: sklearn HashingVectorizer, which is lightweight and deterministic.
Both store normalized vectors as JSONB so the bundled PostgreSQL image needs no
special extension. Similarity is computed locally until pgvector is enabled.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")


def get_conn():
    import psycopg2
    url = os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("DATABASE_URL is required")
    return psycopg2.connect(url)


def build_encoder():
    model_name = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
    try:
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(model_name)
        return "sentence-transformers", model_name, lambda texts: model.encode(texts, normalize_embeddings=True).tolist()
    except Exception as exc:
        from sklearn.feature_extraction.text import HashingVectorizer
        print(f"semantic embedding model unavailable ({exc}); using deterministic hashing vectors")
        vectorizer = HashingVectorizer(n_features=384, alternate_sign=False, norm="l2", lowercase=True)
        return "sklearn", "hashing-384", lambda texts: vectorizer.transform(texts).toarray().tolist()


def upsert_embeddings(limit: int) -> int:
    provider, model_name, encode = build_encoder()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select d.id, coalesce(d.body_text, '') || case when d.body_text is null then '' else ' ' end || d.title
                from research_documents d
                left join event_embeddings e on e.document_id = d.id
                where e.document_id is null
                order by d.published_at desc
                limit %s
                """,
                (limit,),
            )
            rows = cur.fetchall()
            if not rows:
                print("no unembedded research documents")
                return 0
            texts = [str(row[1]).strip() for row in rows]
            vectors = encode(texts)
            for (doc_id, text), vector in zip(rows, vectors):
                normalized = " ".join(text.split())
                cur.execute(
                    """
                    insert into event_embeddings(document_id, embedding_provider, embedding_model, dimensions, embedding, normalized_text)
                    values (%s, %s, %s, %s, %s::jsonb, %s)
                    on conflict (document_id) do update set
                      embedding_provider = excluded.embedding_provider,
                      embedding_model = excluded.embedding_model,
                      dimensions = excluded.dimensions,
                      embedding = excluded.embedding,
                      normalized_text = excluded.normalized_text,
                      created_at = now()
                    """,
                    (doc_id, provider, model_name, len(vector), json.dumps(vector), normalized),
                )
        conn.commit()
    print(f"embedded {len(rows)} documents using {provider}/{model_name}")
    return len(rows)


def query_memory(text: str, top_k: int) -> None:
    provider, model_name, encode = build_encoder()
    query = np.asarray(encode([text])[0], dtype=float)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select d.symbol, d.published_at, d.source, d.title, e.embedding, d.id
                from event_embeddings e
                join research_documents d on d.id = e.document_id
                where e.embedding_provider = %s and e.embedding_model = %s
                order by d.published_at desc
                limit 20000
                """,
                (provider, model_name),
            )
            rows = cur.fetchall()
    scored = []
    for symbol, published_at, source, title, embedding, doc_id in rows:
        vector = np.asarray(embedding, dtype=float)
        denom = float(np.linalg.norm(query) * np.linalg.norm(vector))
        score = float(np.dot(query, vector) / denom) if denom else 0.0
        scored.append((score, symbol, published_at, source, title, doc_id))
    scored.sort(reverse=True, key=lambda x: x[0])
    for score, symbol, published_at, source, title, doc_id in scored[:top_k]:
        print(json.dumps({"similarity": round(score, 6), "symbol": symbol, "published_at": published_at.isoformat() if published_at else None, "source": source, "title": title, "document_id": str(doc_id)}))


def main() -> None:
    parser = argparse.ArgumentParser(description="D-Predict event embedding memory")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--query", default=None)
    parser.add_argument("--top-k", type=int, default=10)
    args = parser.parse_args()
    if args.query:
        query_memory(args.query, args.top_k)
    else:
        upsert_embeddings(max(1, min(args.limit, 5000)))


if __name__ == "__main__":
    main()
