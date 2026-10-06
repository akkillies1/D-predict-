import { useCallback, useEffect, useState } from "react";
import { Activity, BrainCircuit, Database, RefreshCw, Wifi } from "lucide-react";
import { getAiStatus, getLocalHealth, getTrainingCoverage, type AiStatus, type LocalHealth, type TrainingCoverage } from "@/lib/localApi";

export default function SystemOperationsPanel({ wsConnected }: { wsConnected?: boolean }) {
  const [health, setHealth] = useState<LocalHealth | null>(null);
  const [coverage, setCoverage] = useState<TrainingCoverage | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const [h, c, a] = await Promise.allSettled([getLocalHealth(), getTrainingCoverage(), getAiStatus()]);
    setHealth(h.status === "fulfilled" ? h.value : null);
    setCoverage(c.status === "fulfilled" ? c.value : null);
    setAi(a.status === "fulfilled" ? a.value : null);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const summary = coverage?.summary;
  const modelState = !coverage ? "UNKNOWN" : summary?.productionModels ? "READY" : summary?.trainingRequired ? "TRAINING_REQUIRED" : "NO_PROMOTED_MODEL";

  const Status = ({ ok, label, detail }: { ok: boolean; label: string; detail: string }) => (
    <div className="rounded-xl border border-[#1d332f] bg-[#091512] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-semibold text-[#d7e8d9]"><span className={`h-2 w-2 rounded-full ${ok ? "bg-[#c8f169]" : "bg-[#e5b55f]"}`} />{label}</span>
        <span className={`font-mono-ui text-[9px] uppercase tracking-[.14em] ${ok ? "text-[#c8f169]" : "text-[#e5b55f]"}`}>{ok ? "READY" : "CHECK"}</span>
      </div>
      <p className="mt-1 text-[10px] leading-4 text-[#789087]">{detail}</p>
    </div>
  );

  return (
    <section className="mx-auto mb-6 w-full max-w-[1400px] px-4">
      <div className="rounded-2xl border border-[#1d332f] bg-[#0b1714] p-5 shadow-[0_18px_50px_rgba(0,0,0,.12)]">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#70887d]">Runtime · provenance · readiness</div>
            <h2 className="mt-1 font-display text-lg font-semibold text-[#eff7ea]">System Operations</h2>
          </div>
          <button onClick={() => void refresh()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-[#29463b] px-3 py-1.5 text-xs font-semibold text-[#9fb4a8] hover:bg-[#10231e] disabled:opacity-50">
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
          <Status ok={health?.ok === true} label="Local API" detail={health?.ok ? `Database: ${health.database ?? "connected"} · ${health.time ?? "time unavailable"}` : "The local backend health check is unavailable."} />
          <Status ok={wsConnected === true} label="Realtime" detail={wsConnected ? "WebSocket /live connected; quotes and paper state can stream without dashboard polling." : "WebSocket /live is reconnecting. REST remains authoritative."} />
          <Status ok={modelState === "READY"} label="ML pipeline" detail={summary ? `${summary.productionModels} promoted · ${summary.upToDate} up to date · ${summary.trainingRequired} training required · ${summary.insufficientHistory} insufficient history` : "Training coverage is unavailable."} />
          <Status ok={ai?.configured === true && ai.enabled === true} label="Nemotron agent" detail={ai?.configured ? `${ai.model ?? "Configured model"} · local BYOK configuration` : "No local AI key is configured. The deterministic dashboard still works."} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] text-[#70887d]">
          <span className="inline-flex items-center gap-1.5"><Database size={11} /> REST is authoritative for state and commands</span>
          <span className="inline-flex items-center gap-1.5"><Wifi size={11} /> WebSocket is transport for live events</span>
          <span className="inline-flex items-center gap-1.5"><BrainCircuit size={11} /> Candidate gates remain backend-controlled</span>
          <span className="inline-flex items-center gap-1.5"><Activity size={11} /> No live broker execution</span>
        </div>
      </div>
    </section>
  );
}
