import { FormEvent, useState } from "react";
import { Building2, Calculator, ShieldAlert } from "lucide-react";
import { analyzeIPO, type IPOAnalysis, type IPOInput } from "@/lib/localApi";

const fields: Array<[keyof IPOInput, string, string]> = [
  ["revenue", "Revenue", "₹ crore"], ["revenueGrowth", "Revenue growth", "%"], ["ebitda", "EBITDA", "₹ crore"],
  ["pat", "PAT", "₹ crore"], ["issuePrice", "Issue price", "₹/share"], ["postIssueShares", "Post-issue shares", "crore shares"],
  ["freshIssue", "Fresh issue", "₹ crore face value / issue units"], ["ofs", "OFS", "₹ crore"], ["debt", "Debt", "₹ crore"],
  ["cash", "Cash", "₹ crore"], ["roe", "ROE", "%"], ["roce", "ROCE", "%"],
];

export default function IPOAnalyzer() {
  const [form, setForm] = useState<Record<string, string>>({ companyName: "", symbol: "" });
  const [result, setResult] = useState<IPOAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setLoading(true); setError(null);
    try {
      const input: IPOInput = { companyName: form.companyName ?? "", symbol: form.symbol || undefined };
      for (const [key] of fields) if (form[key]) (input as Record<string, unknown>)[key] = Number(form[key]);
      setResult(await analyzeIPO(input));
    } catch (e) { setError(e instanceof Error ? e.message : "IPO analysis failed"); }
    finally { setLoading(false); }
  };
  const set = (key: string, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  return <section className="mx-auto max-w-[1600px] px-4 pb-6 lg:px-8">
    <div className="rounded-xl border border-[#27443a] bg-[#0b1714] p-5">
      <div className="mb-5 flex items-center gap-2"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#c8f169] text-[#13230d]"><Building2 size={16}/></span><div><div className="font-mono-ui text-[9px] tracking-[.18em] text-[#70887d]">PRIMARY MARKET / IPO</div><h2 className="font-display text-xl font-semibold">IPO valuation & quality analyzer</h2></div></div>
      <form onSubmit={submit} className="grid gap-3 md:grid-cols-3 lg:grid-cols-4">
        <label className="md:col-span-2"><span className="font-mono-ui text-[9px] text-[#70887d]">COMPANY NAME *</span><input required value={form.companyName ?? ""} onChange={e=>set("companyName",e.target.value)} className="mt-1 w-full rounded-lg border border-[#29463b] bg-[#08120f] px-3 py-2 text-sm outline-none" placeholder="Example: ABC Technologies Ltd"/></label>
        <label><span className="font-mono-ui text-[9px] text-[#70887d]">SYMBOL</span><input value={form.symbol ?? ""} onChange={e=>set("symbol",e.target.value.toUpperCase())} className="mt-1 w-full rounded-lg border border-[#29463b] bg-[#08120f] px-3 py-2 text-sm outline-none" placeholder="Optional"/></label>
        {fields.map(([key,label,unit])=><label key={key}><span className="font-mono-ui text-[9px] text-[#70887d]">{label.toUpperCase()}</span><div className="mt-1 flex rounded-lg border border-[#29463b] bg-[#08120f]"><input type="number" step="any" value={form[key] ?? ""} onChange={e=>set(String(key),e.target.value)} className="min-w-0 flex-1 bg-transparent px-3 py-2 text-sm outline-none"/><span className="px-2 py-2 font-mono-ui text-[9px] text-[#597369]">{unit}</span></div></label>)}
        <div className="md:col-span-3 lg:col-span-4 flex items-center justify-between gap-3 pt-2"><p className="text-[9px] leading-relaxed text-[#657b71]">Enter verified prospectus/DRHP figures. The analyzer never invents missing IPO data.</p><button disabled={loading} className="flex items-center gap-2 rounded-lg bg-[#c8f169] px-4 py-2 font-mono-ui text-[10px] font-semibold text-[#11210b] disabled:opacity-50"><Calculator size={13}/>{loading ? "ANALYZING…" : "ANALYZE IPO"}</button></div>
      </form>
      {error && <div className="mt-4 rounded-lg border border-[#59342e] bg-[#1a100f] p-3 text-xs text-[#ff9d91]">{error}</div>}
      {result && <div className="mt-5 grid gap-4 lg:grid-cols-[.7fr_1fr]">
        <div className="rounded-lg border border-[#263f36] bg-[#09130f] p-5"><div className="font-mono-ui text-[9px] tracking-[.16em] text-[#70887d]">VERDICT</div><div className={`mt-2 font-display text-4xl font-bold ${result.verdict === "ATTRACTIVE" ? "text-[#c8f169]" : result.verdict === "WATCH" ? "text-[#e5b55f]" : "text-[#ff9d91]"}`}>{result.verdict}</div><div className="mt-2 font-mono-ui text-sm">Composite score {result.score}/100</div><div className="mt-5 grid grid-cols-3 gap-2 text-center"><div><div className="font-display text-xl">{result.valuationScore}</div><div className="font-mono-ui text-[8px] text-[#70887d]">VALUATION</div></div><div><div className="font-display text-xl">{result.businessScore}</div><div className="font-mono-ui text-[8px] text-[#70887d]">BUSINESS</div></div><div><div className="font-display text-xl">{result.structureScore}</div><div className="font-mono-ui text-[8px] text-[#70887d]">STRUCTURE</div></div></div></div>
        <div className="rounded-lg border border-[#263f36] bg-[#09130f] p-5"><div className="grid gap-3 sm:grid-cols-3"><Metric label="P/E" value={result.metrics.pe}/><Metric label="EV/EBITDA" value={result.metrics.evEbitda}/><Metric label="EBITDA margin" value={result.metrics.ebitdaMargin == null ? null : result.metrics.ebitdaMargin*100} suffix="%"/><Metric label="Profit margin" value={result.metrics.profitMargin == null ? null : result.metrics.profitMargin*100} suffix="%"/><Metric label="Fresh issue ratio" value={result.metrics.freshIssueRatio == null ? null : result.metrics.freshIssueRatio*100} suffix="%"/><Metric label="Enterprise value" value={result.metrics.enterpriseValue} prefix="₹"/></div><div className="mt-5 flex items-center gap-2 text-[#e5b55f]"><ShieldAlert size={14}/><span className="font-mono-ui text-[9px] tracking-[.15em]">RISKS / REVIEW ITEMS</span></div><div className="mt-2 space-y-2 text-xs text-[#c8b582]">{result.risks.map(risk=><div key={risk}>{risk}</div>)}</div></div>
      </div>}
      {result && <p className="mt-4 border-t border-[#19312a] pt-3 text-[9px] leading-relaxed text-[#657b71]">{result.disclaimer}</p>}
    </div>
  </section>;
}
function Metric({ label, value, prefix="", suffix="" }: { label:string; value:number|null; prefix?:string; suffix?:string }) { return <div className="rounded-lg border border-[#1d332f] bg-[#08120f] p-3"><div className="font-mono-ui text-[8px] text-[#70887d]">{label}</div><div className="mt-1 font-display text-lg">{value == null ? "—" : `${prefix}${value.toFixed(2)}${suffix}`}</div></div>; }
