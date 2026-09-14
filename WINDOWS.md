# D-predict on Windows

The repository now includes `dp.ps1` for a Windows-native local workflow.

## Prerequisites

Install:

- Node.js 22+
- Python 3.12+
- Docker Desktop with Compose
- Git

## First setup

From the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\dp.ps1 doctor
powershell -ExecutionPolicy Bypass -File .\dp.ps1 init
powershell -ExecutionPolicy Bypass -File .\dp.ps1 start
```

The launcher starts PostgreSQL in Docker, then the local API, dashboard, and Python collector.

Open:

- Dashboard: `http://127.0.0.1:3000`
- API health: `http://127.0.0.1:4100/health`

## Live ticker flow

Type a ticker or company name into the search field, for example `REL` or `Reliance`.

The dashboard first checks the local instrument table and then asks Yahoo Finance for additional NSE/BSE-style matches. Selecting a discovered result automatically activates the symbol in PostgreSQL, after which the collector includes it in its next polling cycle.

The dashboard also requests a current Yahoo quote so a newly selected instrument can show a price before the first persisted collector bar arrives. Stored bars remain the historical source used by the chart and analysis modules.

## Commands

```text
.\dp.ps1 init
.\dp.ps1 doctor
.\dp.ps1 start
.\dp.ps1 stop
.\dp.ps1 status
.\dp.ps1 test
.\dp.ps1 api
.\dp.ps1 ui
.\dp.ps1 collect
```

## Notes

The current public-data path is not a broker tick feed. Yahoo Finance data may be delayed and the collector stores 1-minute bars. The UI labels the quote source so this is not confused with exchange-direct tick data.

For NIFTY and BANKNIFTY, the Python collector also polls the NSE option chain. Ordinary equities receive price-bar collection only.
