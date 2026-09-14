import { useEffect, useRef, useState } from "react";
import { Search, Loader2, X } from "lucide-react";
import { addInstrument } from "@/lib/localApi";
import { searchInstruments } from "@/lib/instrumentSearch";
import type { Instrument } from "@/lib/localApi";
import { toast } from "sonner";

type Props = { value: string; onChange: (symbol: string) => void };

export default function LiveTickerSearch({ value, onChange }: Props) {
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<Instrument[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => setQuery(value), [value]);
  useEffect(() => {
    const text = query.trim();
    if (!text) { setResults([]); setOpen(false); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try { setResults(await searchInstruments(text, controller.signal)); setOpen(true); }
      catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) setResults([]); }
      finally { setLoading(false); }
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const select = async (item: Instrument) => {
    setSelecting(true);
    setOpen(false);
    try {
      await addInstrument(item.symbol);
      onChange(item.symbol);
      setQuery(item.symbol);
      toast.success(`${item.symbol} activated — collecting now`);
    } catch {
      toast.error(`Could not activate ${item.symbol}. Start the local API and database.`);
    } finally { setSelecting(false); }
  };

  return <div ref={rootRef} className="relative w-[250px]">
    <div className="flex items-center gap-2 rounded-lg border border-[#26453a] bg-[#10211c] px-3 py-2.5">
      <Search size={14} className="shrink-0 text-[#789087]" />
      <input disabled={selecting} value={query} onFocus={() => query.trim() && setOpen(true)} onChange={(e) => setQuery(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); if (e.key === "Enter" && results[0]) void select(results[0]); }} placeholder="Search ticker or company" aria-label="Search ticker or company" className="min-w-0 flex-1 bg-transparent font-mono-ui text-xs text-[#d7e8d9] outline-none placeholder:text-[#5f766c]" />
      {loading || selecting ? <Loader2 size={13} className="animate-spin text-[#c8f169]" /> : query ? <button aria-label="Clear ticker search" onClick={() => { setQuery(""); setOpen(false); }} className="text-[#71887d] hover:text-[#d7e8d9]"><X size={13} /></button> : null}
    </div>
    {open ? <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-xl border border-[#28483d] bg-[#0b1714] shadow-2xl">
      {results.length ? results.map((item) => <button key={`${item.exchange}:${item.symbol}`} onMouseDown={(e) => e.preventDefault()} onClick={() => void select(item)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-[#142b24]"><span className="min-w-0"><span className="block font-mono-ui text-xs font-semibold text-[#e4f1e5]">{item.symbol}</span><span className="block truncate text-[10px] text-[#789087]">{item.name ?? item.symbol}</span></span><span className="shrink-0 rounded border border-[#254237] px-1.5 py-0.5 font-mono-ui text-[9px] text-[#8da99b]">{item.exchange || item.source || "MARKET"}</span></button>) : !loading ? <div className="px-3 py-3 text-[11px] text-[#71887d]">No matching instruments found.</div> : null}
    </div> : null}
  </div>;
}
