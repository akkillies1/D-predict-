import { useEffect, useState } from "react";
import { Clock } from "lucide-react";

// Display-only NSE session clock (Mon–Fri 09:15–15:30 IST). Purely informational:
// it does NOT gate fills — those depend on live market data (the "Market live" pill) —
// and it cannot know about exchange holidays. IST is derived via Intl so it is correct
// regardless of the browser's own timezone.
const NSE_OPEN_SECONDS = 9 * 3600 + 15 * 60; // 09:15
const NSE_CLOSE_SECONDS = 15 * 3600 + 30 * 60; // 15:30

function istParts(date: Date): { wd: number; hh: number; mm: number; ss: number; secs: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(date).map(p => [p.type, p.value]));
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hh = parseInt(parts.hour, 10) % 24; const mm = parseInt(parts.minute, 10); const ss = parseInt(parts.second, 10);
  return { wd: wdMap[parts.weekday] ?? 0, hh, mm, ss, secs: hh * 3600 + mm * 60 + ss };
}

function duration(total: number): string {
  const t = Math.max(0, Math.floor(total)); const d = Math.floor(t / 86400); const h = Math.floor((t % 86400) / 3600); const m = Math.floor((t % 3600) / 60); const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, "0"); const hms = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

function describeSession(date: Date): { open: boolean; label: string } {
  const p = istParts(date);
  const clock = `${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}:${String(p.ss).padStart(2, "0")} IST`;
  const isWeekday = p.wd >= 1 && p.wd <= 5;
  if (isWeekday && p.secs >= NSE_OPEN_SECONDS && p.secs < NSE_CLOSE_SECONDS) return { open: true, label: `${clock} · session open · closes in ${duration(NSE_CLOSE_SECONDS - p.secs)}` };
  let add = 0;
  for (; add <= 7; add++) { const cday = (p.wd + add) % 7; if (cday < 1 || cday > 5) continue; if (add === 0 && p.secs >= NSE_OPEN_SECONDS) continue; break; }
  return { open: false, label: `${clock} · closed · opens in ${duration(add * 86400 + (NSE_OPEN_SECONDS - p.secs))}` };
}

export default function MarketSessionClock({ className = "" }: { className?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(timer); }, []);
  const info = describeSession(now);
  return (
    <span title="NSE regular session, Mon–Fri 09:15–15:30 IST. Display only: it neither gates fills nor accounts for exchange holidays — the 'Market live' pill (driven by real tick data) is the source of truth." className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono-ui text-[10px] ${info.open ? "border-[#31506f] text-[#8fb6ff]" : "border-[#1d332f] text-[#789087]"} ${className}`}>
      <Clock size={11} />
      <span>{info.label}</span>
    </span>
  );
}
