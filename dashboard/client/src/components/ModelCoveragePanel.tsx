import { useCallback, useEffect, useState } from "react";
import { Boxes, Database, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { getTrainingCoverage, retrainStale, retrainSymbol, type TrainingCoverage, type TrainingInstrumentRow } from "@/lib/localApi";
import { toast } from "sonner";

const stateStyles: Record<string, string> = {
  UP_TO_DATE: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
  STALE: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  TRAINING_REQUIRED: "text-sky-400 border-sky-500/30 bg-sky-500/10",
  INSUFFICIENT_HISTORY: "text-muted-foreground border-border bg-muted/30",
  WAITING_FOR_DATA: "text-muted-foreground border-border bg-muted/30",
};

const pretty = (value: string) => value.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

export default function ModelCoveragePanel() {
  const [data, setData] = useState<TrainingCoverage | null>(null);
  const [busy, setBusy] = useState(false);
  const [training, setTraining] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    try { setData(await getTrainingCoverage()); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Model coverage unavailable"); }
    finally { setBusy(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const runAllStale = async () => {
    setTraining(true);
    try {
      const report = await retrainStale();
      if (report.ok) toast.success(`Training complete · ${report.summary?.trained ?? 0} trained`);
      else toast.error(report.message ?? report.error ?? "Training run failed");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Training run failed");
    } finally { setTraining(false); }
  };

  const retrain = async (row: TrainingInstrumentRow) => {
    setRowBusy(row.symbol);
    try {
      const report = await retrainSymbol(row.symbol);
      const status = (report.instrument as { status?: string } | undefined)?.status ?? report.status;
      if (report.ok || status === "TRAINED") toast.success(`${row.symbol}: ${pretty(status ?? "done")}`);
      else toast.error(`${row.symbol}: ${status ?? "failed"}`);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Retrain failed");
    } finally { setRowBusy(null); }
  };

  const summary = data?.summary;
  const cards = summary ? [
    { label: "Active universe", value: summary.activeInstruments, icon: Boxes },
    { label: "Up to date", value: summary.upToDate, icon: Database },
    { label: "Training required", value: summary.trainingRequired, icon: RefreshCw },
    { label: "Insufficient history", value: summary.insufficientHistory, icon: TriangleAlert },
    { label: "Promotion-ready", value: summary.productionModels, icon: Sparkles },
  ] : [];

  return (
    <section className="mx-auto mb-6 w-full max-w-[1400px] px-4">
      <div className="rounded-2xl border border-border bg-card/60 p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Automatic · instrument-agnostic</div>
            <h2 className="mt-1 text-lg font-semibold">Model Coverage</h2>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void runAllStale()} disabled={training || busy} className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50">
              <RefreshCw size={13} className={training ? "animate-spin" : ""} /> {training ? "Training…" : "Retrain all stale"}
            </button>
            <button onClick={() => void refresh()} disabled={busy} className="rounded-lg border border-border p-2 hover:bg-accent disabled:opacity-50" aria-label="Refresh coverage"><RefreshCw size={14} className={busy ? "animate-spin" : ""} /></button>
          </div>
        </div>

        {summary && <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {cards.map((card) => <div key={card.label} className="rounded-xl border border-border/70 p-3">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><card.icon size={12} /> {card.label}</div>
            <div className="mt-1 font-mono text-xl font-semibold">{card.value}</div>
          </div>)}
        </div>}

        {summary && summary.productionModels === 0 && <p className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">No model has cleared its out-of-sample promotion gate yet, so every live signal abstains. Coverage automation keeps models current; it does not manufacture edge.</p>}

        <div className="overflow-x-auto rounded-xl border border-border/70">
          <table className="w-full text-left text-xs">
            <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>{["Instrument", "Type", "Data", "Model", "Training", "OOS acc", "Meta", "Action"].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {(data?.instruments ?? []).map((row) => (
                <tr key={`${row.symbol}:${row.horizon}`} className="hover:bg-accent/30">
                  <td className="px-3 py-2 font-mono font-semibold">{row.symbol}</td>
                  <td className="px-3 py-2 text-muted-foreground">{row.instrument_type ?? "—"}</td>
                  <td className="px-3 py-2"><span className="font-mono">{row.daily_bars.toLocaleString()}</span><span className="ml-1 text-[10px] text-muted-foreground">bars · <span className={row.data_status === "LIVE" ? "text-emerald-400" : "text-amber-400"}>{row.data_status}</span></span></td>
                  <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">{row.model_version ? row.model_version.replace(/^market-v2-1d-histgb-/, "#").slice(0, 14) : "none"}</td>
                  <td className="px-3 py-2"><span className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-semibold ${stateStyles[row.model_state] ?? "border-border text-muted-foreground"}`}>{pretty(row.model_state)}</span></td>
                  <td className="px-3 py-2 font-mono">{row.promotion_ready == null ? "—" : "abstain"}</td>
                  <td className="px-3 py-2">{row.meta_ready == null ? <span className="text-muted-foreground">—</span> : <span className={row.meta_ready ? "text-emerald-400" : "text-muted-foreground"}>{row.meta_ready ? "ready" : "dormant"}</span>}</td>
                  <td className="px-3 py-2"><button onClick={() => void retrain(row)} disabled={rowBusy != null} className="rounded-md border border-border px-2 py-1 text-[10px] font-semibold hover:bg-accent disabled:opacity-40">{rowBusy === row.symbol ? "…" : row.model_state === "UP_TO_DATE" ? "Retrain" : "Train"}</button></td>
                </tr>
              ))}
              {!data && <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">{busy ? "Loading coverage…" : "Coverage unavailable — is the ML service reachable?"}</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[10px] text-muted-foreground">Data freshness and model freshness are reported separately. An instrument with too little history is skipped, never failed or faked. Metrics come only from real persisted bars.</p>
      </div>
    </section>
  );
}
