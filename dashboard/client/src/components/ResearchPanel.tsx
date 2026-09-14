import { useEffect, useState } from "react";
import { ExternalLink, Newspaper, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
import { getResearch, type ResearchResult } from "@/lib/localApi";

const STORAGE_KEY = "dpredict:selected-symbol";

type Props = { symbol?: string };

export default function ResearchPanel({ symbol: propSymbol }: Props) {
  const [symbol, setSymbol] = useState(propSymbol ?? "NIFTY");
  const [data, setData] = useState<ResearchResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const sync = () => setSymbol(localStorage.getItem(STORAGE_KEY) || propSymbol || "NIFTY");
    sync();
    window.addEventListener("dpredict:symbol", sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener("dpredict:symbol", sync); window.removeEventListener("storage", sync); };
  }, [propSymbol]);

  const refresh = async () => {
    setLoading(true);
    try { setData(await getResearch(symbol)); } catch { setData(null); }
    finally { setLoading(false); }
  };

  useEffect(() => { void refresh(); }, [symbol]);
  useEffect(() => { const timer = window.setInterval(() => void refresh(), 60000); return () => window.clearInterval(timer); }, [symbol]);

  return <section className="mx-auto max-w-[1600px] px-4 pb-6 lg:px-8">
    <div className="rounded-xl border border-[#27443a] bg-[#0b1714] p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#c8f169] text-[#13230d]"><Sparkles size={16}/></span><div><div className="font-mono-ui text-[9px] tracking-[.18em] text-[#70887d]">RESEARCH / EVIDENCE STACK</div><h2 className="font-display text-xl font-semibold">Meta-prediction · {data?.companyName ?? symbol}</h2></div></div>
        <button onClick={() => void refresh()} disabled={loading} className="flex items-center gap-2 rounded-lg border border-[#26453a] px-3 py-2 font-mono-ui text-[10px] text-[#a8bdb2] hover:bg-[#12251f]"><RefreshCw size={13} className={loading ? "animate-spin" : ""}/> Refresh evidence</button>
      </div>

      {data ? <>
        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-[#1d332f] bg-[#08120f] p-4"><div className="font-mono-ui text-[9px] text-[#70887d]">DIRECTION</div><div className={`mt-2 font-display text-2xl font-bold ${data.direction === "BULLISH" ? "text-[#d7f883]" : data.direction === "BEARISH" ? "text-[#ff9d91]" : "text-[#e5b55f]"}`}>{data.direction}</div></div>
          <div className="rounded-lg border border-[#1d332f] bg-[#08120f] p-4"><div className="font-mono-ui text-[9px] text-[#70887d]">CONFIDENCE</div><div className="mt-2 font-display text-2xl font-bold">{(data.confidence * 100).toFixed(0)}%</div></div>
          <div className="rounded-lg border border-[#1d332f] bg-[#08120f] p-4"><div className="font-mono-ui text-[9px] text-[#70887d]">EVIDENCE</div><div className="mt-2 font-display text-2xl font-bold text-[#c8f169]">{data.evidenceScore}/100</div></div>
          <div className="rounded-lg border border-[#1d332f] bg-[#08120f] p-4"><div className="font-mono-ui text-[9px] text-[#70887d]">SOURCE AGREEMENT</div><div className="mt-2 font-display text-2xl font-bold">{(data.agreement * 100).toFixed(0)}%</div></div>
        </div>

        <div className="mt-4 grid gap-5 lg:grid-cols-[1fr_1fr]">
          <div><div className="mb-2 flex items-center gap-2"><Newspaper size={14} className="text-[#c8f169]"/><span className="font-mono-ui text-[10px] tracking-[.16em] text-[#789087]">LATEST PUBLIC SIGNALS</span></div><div className="space-y-2">{data.articles.slice(0, 8).map(article => <a key={article.url} href={article.url} target="_blank" rel="noreferrer" className="block rounded-lg border border-[#1c342d] bg-[#09130f] p-3 hover:border-[#3a5a4b]"><div className="flex items-start justify-between gap-3"><div><div className="text-xs font-medium text-[#dbe9df]">{article.title}</div><div className="mt-1 font-mono-ui text-[9px] text-[#71877d]">{article.source} · {article.publishedAt ? new Date(article.publishedAt).toLocaleString("en-IN") : "time unavailable"}</div></div><span className={`shrink-0 rounded border px-1.5 py-0.5 font-mono-ui text-[8px] ${article.stance === "BULLISH" ? "border-[#3e5d35] text-[#c8f169]" : article.stance === "BEARISH" ? "border-[#5d3733] text-[#ff9d91]" : "border-[#4b452f] text-[#e5b55f]"}`}>{article.stance}</span></div></a>)}</div></div>
          <div className="space-y-4">
            <div className="rounded-lg border border-[#1d332f] bg-[#09130f] p-4"><div className="font-mono-ui text-[9px] tracking-[.16em] text-[#70887d]">THEMES</div><div className="mt-3 flex flex-wrap gap-2">{(data.themes.length ? data.themes : ["No strong theme detected"]).map(item => <span key={item} className="rounded-full border border-[#29463b] bg-[#10211c] px-2 py-1 text-[10px] text-[#a9beb2]">{item}</span>)}</div></div>
            <div className="rounded-lg border border-[#5a432a] bg-[#1b160d] p-4"><div className="flex items-center gap-2 text-[#e5b55f]"><ShieldAlert size={14}/><span className="font-mono-ui text-[9px] tracking-[.16em]">WATCH / RISK</span></div><div className="mt-3 space-y-2 text-[11px] text-[#c8b582]">{(data.risks.length ? data.risks : ["No explicit regulatory/governance risk keyword detected in the current sample."]).map(item => <div key={item}>{item}</div>)}</div></div>
            <div className="rounded-lg border border-[#1d332f] bg-[#09130f] p-4"><div className="font-mono-ui text-[9px] tracking-[.16em] text-[#70887d]">OFFICIAL PUBLIC DISCLOSURES</div><div className="mt-3 grid gap-2 sm:grid-cols-3">{data.publicDisclosureLinks.map(link => <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="flex items-center justify-between gap-2 rounded-lg border border-[#223d34] px-3 py-2 text-[10px] text-[#9fb4a8] hover:bg-[#10211c]">{link.label}<ExternalLink size={11}/></a>)}</div></div>
          </div>
        </div>
        <p className="mt-4 border-t border-[#19312a] pt-3 text-[9px] leading-relaxed text-[#657b71]">{data.disclaimer}</p>
      </> : <div className="rounded-lg border border-dashed border-[#315045] p-8 text-center text-sm text-[#789087]">{loading ? "Scanning public research sources…" : "Research unavailable. Start the local research service and try again."}</div>}
    </div>
  </section>;
}
