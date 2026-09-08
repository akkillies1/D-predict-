# Backend service boundary

The current engine is a CLI/worker, not an HTTP API. The production backend should be a separate Node service that reads the PostgreSQL decision tables and exposes authenticated, read-only dashboard endpoints.

Recommended first endpoints are documented in `../DEPLOYMENT.md`. Keep the collector and engine worker separate from this API process. Deploy the API on a managed container service or persistent VM; deploy the dashboard on Vercel.

Do not expose database credentials to the browser and do not place a continuous collector in a Vercel serverless function.
