# D-predict — Local PC Installation Guide

This guide is for running D-predict locally on a Windows PC.

## 1. Requirements

Install these before opening the repository:

### Git

Install Git for Windows and verify in PowerShell:

```powershell
git --version
```

### Node.js

Use Node.js 22 LTS or newer.

```powershell
node --version
npm --version
```

### Python

Use Python 3.12 or newer.

```powershell
python --version
```

### Docker Desktop

Install Docker Desktop and make sure its Linux container engine is running.

```powershell
docker --version
docker compose version
```

D-predict uses Docker for the local PostgreSQL database so the database setup is reproducible.

## 2. Get the source

```powershell
git clone https://github.com/akkillies1/D-predict-.git
cd D-predict-
```

To update an existing checkout:

```powershell
git pull --ff-only
```

## 3. Check the machine

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 doctor
```

Expected prerequisites:

```text
node: available
npm: available
python: available
docker: available
```

Warnings about a missing `.env`, dependencies or Python environment are normal before initialization.

## 4. Initialize

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 init
```

This:

- creates `.env` from `.env.example`;
- installs backend dependencies;
- installs dashboard dependencies with the repository's legacy peer dependency mode;
- creates `collector\.venv`;
- installs collector Python dependencies.

Do not commit the generated `.env` if you later add private credentials.

## 5. Start the entire application

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 start
```

The launcher starts four logical processes plus PostgreSQL:

```text
PostgreSQL       127.0.0.1:5433
Market API       127.0.0.1:4100
Research API     127.0.0.1:4200
Dashboard        127.0.0.1:3000
Python collector background process
```

Open the dashboard:

```text
http://127.0.0.1:3000
```

## 6. What should happen

When the application starts:

1. PostgreSQL comes up through Docker Compose.
2. The market API starts on port 4100.
3. The research service starts on port 4200.
4. The React dashboard starts on port 3000.
5. The collector starts and begins polling market data.
6. NIFTY and BANKNIFTY are active by default.

The dashboard should show `LOCAL LIVE` only when the local API is healthy. Missing market data must remain `NO DATA` rather than being replaced by a fabricated number.

## 7. Test the services directly

### Market API

```powershell
Invoke-RestMethod http://127.0.0.1:4100/health
```

### Research API

```powershell
Invoke-RestMethod http://127.0.0.1:4200/health
```

### Research for NIFTY

```powershell
Invoke-RestMethod http://127.0.0.1:4200/api/research/NIFTY
```

### Research for an equity

```powershell
Invoke-RestMethod http://127.0.0.1:4200/api/research/RELIANCE.NS
```

The research response contains recent public articles, evidence direction, confidence, source agreement, themes, risks and official disclosure links.

## 8. Search for a company

In the dashboard search box, type part of a ticker:

```text
rel
```

The instrument discovery endpoint first checks the local database and can use Yahoo Finance search to discover supported `.NS` / `.BO` symbols when the local table does not already contain them.

Select a result. D-predict activates it in PostgreSQL, and the collector will include it on its next polling cycle.

## 9. Understand the research panel

The Research / Evidence Stack is deliberately different from a normal news widget.

### Evidence direction

`BULLISH`, `BEARISH` or `MIXED` reflects the direction of the currently detected public evidence.

### Confidence

Confidence is not a probability that the stock will definitely rise/fall. It is a model score that increases with directional agreement, source diversity, freshness and official-source evidence.

### Evidence score

This measures the strength of the evidence stack itself, not future price certainty.

### Source agreement

This measures whether directional headlines agree. A highly conflicted news environment should not produce a strong directional result.

### Official public information

NSE corporate announcements, NSE public insider-trading disclosures and SEBI filings are surfaced separately. These are public disclosures, not secret inside information.

## 10. “Inside information” boundary

D-predict must not access, request, infer or trade on illegal material non-public information.

The system may analyze:

- public insider transaction disclosures;
- exchange corporate announcements;
- regulatory orders and filings;
- public earnings and company disclosures;
- public news and broad market information.

It should not treat rumours as confirmed facts.

## 11. Stop the system

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 stop
```

## 12. Check what is running

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 status
```

## 13. Run components individually

Market API:

```powershell
.\dp.ps1 api
```

Research API:

```powershell
.\dp.ps1 research
```

Dashboard:

```powershell
.\dp.ps1 ui
```

Collector:

```powershell
.\dp.ps1 collect
```

## 14. Local validation

Run:

```powershell
.\dp.ps1 test
```

This runs the backend test/build, dashboard TypeScript check and dashboard production build.

## 15. If port 3000 or another port is already used

The dashboard server can select another available port in development. The local standalone dashboard launcher uses the port configured by the dashboard server.

The research service is fixed to `RESEARCH_PORT` and the market API is fixed to `API_PORT`. Change these in `.env` and keep the corresponding Vite environment variables aligned:

```env
API_PORT=4100
RESEARCH_PORT=4200
VITE_API_BASE_URL=http://127.0.0.1:4100
VITE_RESEARCH_BASE_URL=http://127.0.0.1:4200
```

Restart the services after changing `.env`.

## 16. If Docker does not start PostgreSQL

Check:

```powershell
docker compose ps
docker compose logs postgres
```

Try:

```powershell
docker compose up -d postgres
```

Then verify:

```powershell
docker compose ps
```

The PostgreSQL service should report healthy.

## 17. If the research panel says “Research unavailable”

Check:

```powershell
Invoke-RestMethod http://127.0.0.1:4200/health
```

If it fails, run the service in the foreground:

```powershell
.\dp.ps1 research
```

Look for a startup error or upstream provider error.

The research service is designed to fail gracefully. A failed news provider must not make the entire market dashboard unusable.

## 18. If ticker search returns nothing

Try a ticker you know should be supported, for example:

```text
RELIANCE.NS
```

The system's remote discovery currently uses Yahoo Finance search. If Yahoo does not return a symbol, the safest response is `No matching instruments found`; the application should not invent a ticker mapping.

## 19. Data freshness

Remember the difference between:

- current upstream quote;
- locally collected 1-minute bar;
- older historical data;
- research article publication time.

These are different timestamps. D-predict should not describe an old local bar as a current exchange tick.

## 20. Accuracy expectations

Do not judge the prediction layer by a handful of live calls.

A serious accuracy program requires:

1. point-in-time storage of every article and disclosure;
2. timestamps showing exactly when the information became public;
3. a future-return label defined in advance;
4. walk-forward out-of-sample testing;
5. probability calibration;
6. source-specific precision measurements;
7. false-positive and false-negative analysis;
8. performance separated by market regime;
9. monitoring for source outages and duplicated news.

Only after those tests should confidence thresholds be trusted with real capital.
