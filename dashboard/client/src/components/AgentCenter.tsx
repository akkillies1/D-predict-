import { useState } from "react";
import { Activity, Send } from "lucide-react";
import { runDecisionAgent } from "@/lib/localApi";

export default function AgentCenter({ model, symbol }: { model?: string | null; symbol: string }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [trace, setTrace] = useState<Array<{ event: string; data: unknown }>>([]);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true); setAnswer(""); setTrace([]);
    try {
      await runDecisionAgent(q, model ?? null, {
        onText: delta => setAnswer(value => value + delta),
        onEvent: (event, data) => setTrace(value => [...value, { event, data }].slice(-24)),
      });
    } catch (error) {
      setAnswer(error instanceof Error ? error.message : "Agent unavailable.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-[#1d332f] bg-[#0b1714] p-5 shadow-[0_18px_50px_rgba(0,0,0,.16)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><div className="font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#70887d]">Agentic investigation · {symbol}</div><h2 className="mt-1 font-display text-xl font-semibold text-[#eff7ea]">Decision Copilot</h2><p className="mt-1 text-[10px] text-[#789087]">Bounded investigation over D-Predict evidence. Paper-only and backend-gated.</p></div>
        <Activity size={17} className={busy ? "animate-pulse text-[#c8f169]" : "text-[#70887d]"} />
      </div>
      <div className="mt-4 flex gap-2">
        <input value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void run(); }} placeholder={`Ask why ${symbol} is actionable or blocked…`} className="min-w-0 flex-1 rounded-xl border border-[#29463b] bg-[#07100f] px-4 py-3 text-xs text-[#eaf4e9] outline-none placeholder:text-[#4e655c]" />
        <button onClick={() => void run()} disabled={busy || !question.trim()} className="inline-flex items-center gap-2 rounded-xl bg-[#c8f169] px-4 py-2 font-mono-ui text-[9px] font-bold uppercase tracking-[.1em] text-[#10200b] disabled:opacity-40"><Send size={13}/>{busy ? "Running" : "Ask"}</button>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-[1.2fr_.8fr]">
        <div className="min-h-28 rounded-xl border border-[#1d332f] bg-[#07100f] p-4 text-xs leading-relaxed text-[#c7d5ca]">{answer || "The agent response will appear here."}</div>
        <div className="max-h-48 space-y-1.5 overflow-auto rounded-xl border border-[#1d332f] bg-[#07100f] p-3">{trace.length ? trace.map((item, i) => <div key={i} className="rounded-lg border border-[#1d332f] bg-[#09130f] p-2"><div className="font-mono-ui text-[8px] uppercase tracking-[.12em] text-[#c8f169]">{item.event}</div><div className="mt-1 line-clamp-3 text-[9px] text-[#789087]">{JSON.stringify(item.data)}</div></div>) : <div className="flex h-full items-center justify-center text-[10px] text-[#557067]">Tool trace will appear during investigation.</div>}</div>
      </div>
    </section>
  );
}
