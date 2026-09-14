# D-predict

D-predict is a local research and market-analysis cockpit for Indian equities and NIFTY/BANKNIFTY derivatives.

It is designed around one principle: **do not turn a headline into a trade without checking the evidence around it**.

## What the system does

D-predict combines several layers:

```text
Live / recent market data
        │
        ├── price + volume + history
        ├── option-chain structure
        ├── stored rule-based signals
        │
        ▼
Public research intelligence
        ├── financial/news headlines
        ├── cross-source agreement
        ├── freshness
        ├── NSE corporate announcements
        ├── public insider-trading disclosures
        └── SEBI/public regulatory material
        │
        ▼
Meta-prediction
        ├── direction: BULLISH / BEARISH / MIXED
        ├── confidence
        ├── evidence score
        ├── source agreement
        ├── themes
        └── explicit risks
```

The research layer is intentionally **public-information only**. It does not access, request, infer, or trade on illegal material non-public information. Publicly disclosed insider transactions, exchange announcements and regulator records are valid evidence and are shown separately from general media.

## Accuracy philosophy

The objective is not to display a confident-looking number. The objective is to make the confidence reflect evidence quality.

The research score considers freshness, source diversity, source agreement/disagreement, higher weight for official exchange/regulatory sources, bullish versus bearish evidence, and explicit governance/regulatory risk themes.

A single article should not create a high-confidence conclusion. A strong-looking headline without confirmation should remain a weak signal.

**No prediction system can guarantee accuracy.** D-predict must be evaluated using out-of-sample backtests, probability calibration, false-positive analysis, source-level performance tracking and regime-specific performance before it is trusted with capital.

## Current research sources

### News

The local research service uses Yahoo Finance search/news and GDELT's document-search API for broad recent coverage. GDELT supports keyword/phrase search and rolling time windows for news discovery.

- GDELT: https://www.gdeltproject.org/
- GDELT DOC API: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/

### Official disclosures

The dashboard provides direct access to NSE corporate announcements and NSE public Regulation 7(2) insider-trading disclosures. NSE also publishes corporate-announcement datasets and an insider-trading archive.

- NSE announcements: https://www.nseindia.com/companies-listing/corporate-filings-announcements
- NSE insider trading: https://www.nseindia.com/companies-listing/corporate-filings-insider-trading
- NSE insider-trading archive: https://www.nseindia.com/companies-listing/corporate-filings-insider-trading-archive-data
- SEBI filings: https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=3&smid=11
- SEBI insider-trading search: https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListingAll=yes&search=Insider+Trading

## Local architecture

```text
React dashboard :3000
       │
       ├────────── Local Market API :4100 ─────── PostgreSQL :5433
       │                     │                         ▲
       │                     └── live Yahoo quote     │
       │                                               │
       └────────── Research API :4200 ── Yahoo/GDELT ─┘
                                                     ▲
                                                     │
                                               Python collector
```

The collector stores market data. The market API serves local data and a current quote endpoint. The research service is separate so slow or unavailable news providers cannot block the main market API.

## Windows local installation

Windows is the recommended developer path for this repository.

### 1. Install prerequisites

Install:

- Node.js 22 LTS or newer
- Python 3.12+
- Docker Desktop with Docker Compose
- Git

Make sure `node`, `npm`, `python`, `docker` and `git` work in PowerShell.

### 2. Clone the repository

```powershell
git clone https://github.com/akkillies1/D-predict-.git
cd D-predict-
```

### 3. Prepare the local environment

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 doctor
powershell -ExecutionPolicy Bypass -File .\dp.ps1 init
```

`init` installs backend/dashboard packages, creates the collector virtual environment and installs collector dependencies.

### 4. Start everything

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 start
```

This starts:

```text
PostgreSQL  → 5433
Market API  → 4100
Research API → 4200
Dashboard   → 3000
Collector   → background process
```

Open:

```text
http://127.0.0.1:3000
```

### 5. Check status

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 status
```

### 6. Stop everything

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 stop
```

See [`LOCAL_INSTALL_GUIDE.md`](LOCAL_INSTALL_GUIDE.md) for the full Windows walkthrough and troubleshooting.

## Linux / macOS

The `./dp` launcher starts PostgreSQL, the market API, research service, dashboard and collector.

```bash
git clone https://github.com/akkillies1/D-predict-.git
cd D-predict-
./dp init
./dp doctor
./dp start
```

## Searching a ticker

Use the dashboard search box. Search is debounced and can discover supported Yahoo symbols even when they have not yet been activated locally.

Example:

```text
rel
```

Select a result. D-predict activates it in the local instrument table so the collector can pick it up on its next cycle.

## Live market flow

After selecting a symbol:

1. the dashboard reads the local database for stored 1-minute history;
2. the market API can fetch a current Yahoo quote;
3. the collector continues writing fresh bars;
4. the UI refreshes the market view periodically;
5. NIFTY/BANKNIFTY can additionally show the stored NSE option-chain snapshots.

The application must display `NO DATA`, `WAITING` or `OFFLINE` when the source is unavailable. It must not invent market prices.

## Research flow

Selecting a ticker also updates the research workspace.

The research service:

1. identifies the company where possible;
2. collects recent public news;
3. searches a broader GDELT news window;
4. searches for public NSE/SEBI material where indexed;
5. removes duplicate URLs;
6. scores the direction of the current public evidence;
7. measures source agreement and freshness;
8. highlights themes and risks;
9. provides direct links to official public disclosure pages.

The UI calls this a **Meta-prediction** because it is an attempt to assess the direction implied by the *current evidence stack*, not simply repeat one prediction source.

## Environment variables

The `.env.example` file contains safe local defaults:

```env
DATABASE_URL=postgresql://postgres:localdev@localhost:5433/nifty
API_PORT=4100
RESEARCH_PORT=4200
VITE_API_BASE_URL=http://127.0.0.1:4100
VITE_RESEARCH_BASE_URL=http://127.0.0.1:4200
OPTION_CHAIN_POLL_SECONDS=15
PRICE_BAR_POLL_SECONDS=15
COLLECTOR_INSTRUMENTS=NIFTY,BANKNIFTY
RESEARCH_NEWS_ENABLED=true
RESEARCH_CACHE_SECONDS=60
GDELT_TIMESPAN=3d
RESEARCH_MAX_ARTICLES=30
```

Never commit API keys or private credentials.

## Useful commands

Windows:

```powershell
.\dp.ps1 doctor
.\dp.ps1 init
.\dp.ps1 start
.\dp.ps1 status
.\dp.ps1 test
.\dp.ps1 stop
.\dp.ps1 api
.\dp.ps1 research
.\dp.ps1 ui
.\dp.ps1 collect
```

Unix-like systems:

```bash
./dp doctor
./dp init
./dp start
./dp test
./dp stop
./dp api
./dp research
./dp collect
```

## Validation

GitHub Actions validates the backend, dashboard typecheck/build and collector compile checks. The dashboard install uses the repository's `--legacy-peer-deps` path because the existing `@builder.io/vite-plugin-jsx-loc` dependency has an older Vite peer range.

For local validation on Windows:

```powershell
.\dp.ps1 test
```

## Safety and scope

D-predict is a research tool, not a broker and not an order-execution system.

It must not:

- claim access to secret or non-public inside information;
- convert an unverified rumour into “confirmed” information;
- fabricate prices, option data or company events;
- present model confidence as certainty;
- execute orders automatically.

## Roadmap for higher accuracy

The next accuracy work should be empirical rather than cosmetic:

- historical news/event ingestion with point-in-time timestamps;
- article/source reliability scores learned from outcomes;
- entity resolution for company names, aliases and subsidiaries;
- event-study features around corporate disclosures;
- analyst-consensus revisions and estimate surprises;
- options-implied distributions where reliable data is available;
- contradiction detection across sources;
- probability calibration (for example isotonic/Platt calibration);
- regime-specific meta-models;
- walk-forward out-of-sample testing;
- precision/recall and expected-value dashboards;
- alerting only after measured precision targets are met.

The goal is not “AI that sounds smart”. The goal is a measured, auditable evidence system that can demonstrate when its predictions are actually useful.
