import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, CheckCheck, Radar, X } from "lucide-react";
import { toast } from "sonner";
import { ackAlert, ackAllAlerts, getAlerts, paperLiveUrl, type BuyAlert } from "@/lib/localApi";

const RULE_META: Record<string, { label: string; color: string }> = {
  momentum_turn: { label: "20-day momentum crossed the net-of-cost gate", color: "#e5b55f" },
  sma20_cross_up: { label: "Close crossed above its 20-session mean", color: "#c8f169" },
  volume_z20_spike: { label: "Volume ≥2σ spike inside a rising 5-day drift", color: "#7cc7e8" },
  pcr_band_cross: { label: "Chain PCR exited the 0.70–1.30 band (ATM ±5%, OI-weighted)", color: "#b48ef5" },
  atm_iv_spike: { label: "ATM option IV jumped ≥1.5 vol points intraday", color: "#f5a3c0" },
  atm_oi_buildup: { label: "ATM-band option OI built ≥15% intraday", color: "#7fd6c2" },
};

function ruleMeta(rule: string) {
  return RULE_META[rule] ?? { label: rule, color: "#a8bdb2" };
}

function evidenceLine(evidence: Record<string, unknown>): string {
  const skip = new Set(["basis", "bars_evaluated", "as_of"]);
  return Object.entries(evidence)
    .filter(([key]) => !skip.has(key))
    .slice(0, 3)
    .map(([key, value]) => {
      const num = typeof value === "number" ? value : Number(value);
      const shown = Number.isFinite(num)
        ? Math.abs(num) >= 1000 || Math.abs(num) < 0.01 ? num.toPrecision(3) : num.toFixed(2)
        : String(value);
      return `${key} ${shown}`;
    })
    .join(" · ");
}

function timeAgo(isoString: string | null): string {
  if (!isoString) return "";
  const seconds = Math.max(0, (Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function absoluteTime(isoString: string | null): string {
  if (!isoString) return "";
  return new Date(isoString).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) + " IST";
}

export default function AlertsBell({ symbol, onSelectSymbol }: { symbol: string; onSelectSymbol?: (symbol: string) => void }) {
  const [alerts, setAlerts] = useState<BuyAlert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [onlyThis, setOnlyThis] = useState(false);
  const [, setClockTick] = useState(0);
  const seenIds = useRef<Set<number>>(new Set());
  const hydrated = useRef(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await getAlerts(50, undefined, signal);
      setAlerts(result.alerts);
      setUnreadCount(result.unreadCount);
      if (!hydrated.current) {
        result.alerts.forEach((alert) => seenIds.current.add(alert.id));
        hydrated.current = true;
      } else {
        for (const alert of result.alerts) {
          if (!seenIds.current.has(alert.id) && !alert.acknowledged) {
            seenIds.current.add(alert.id);
            toast.info(`${alert.symbol} — ${ruleMeta(alert.rule).label}`, {
              description: alert.newToRadar ? "New to radar · rule-evidence flag, not advice" : "Rule-evidence flag, not advice",
            });
          } else {
            seenIds.current.add(alert.id);
          }
        }
      }
    } catch { /* offline or not migrated yet; keeps last state */ }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 60_000);
    const clock = setInterval(() => setClockTick((tick) => tick + 1), 30_000);
    return () => { clearInterval(interval); clearInterval(clock); };
  }, [refresh]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    try { socket = new WebSocket(paperLiveUrl()); } catch { return; }
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message?.type !== "alert" || !message.alert) return;
        const alert = message.alert as BuyAlert;
        if (seenIds.current.has(alert.id)) return;
        seenIds.current.add(alert.id);
        setAlerts((current) => [alert, ...current].slice(0, 50));
        setUnreadCount((count) => (alert.acknowledged ? count : count + 1));
        if (!alert.acknowledged) {
          toast.info(`${alert.symbol} — ${ruleMeta(alert.rule).label}`, {
            description: alert.newToRadar ? "New to radar · rule-evidence flag, not advice" : "Rule-evidence flag, not advice",
          });
        }
      } catch { /* ignore malformed frames */ }
    };
    socket.onclose = () => { if (!closed) reconnect = setTimeout(() => void refresh(), 2_000); };
    return () => { closed = true; if (reconnect) clearTimeout(reconnect); socket?.close(); };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const acknowledge = async (id: number) => {
    try {
      await ackAlert(id);
      setAlerts((current) => current.map((alert) => (alert.id === id ? { ...alert, acknowledged: true } : alert)));
      setUnreadCount((count) => Math.max(0, count - 1));
    } catch { toast.error("Could not acknowledge alert"); }
  };

  const acknowledgeAll = async () => {
    try {
      await ackAllAlerts();
      setAlerts((current) => current.map((alert) => ({ ...alert, acknowledged: true })));
      setUnreadCount(0);
    } catch { toast.error("Could not acknowledge alerts"); }
  };

  const jumpToSymbol = (target: string) => {
    if (onSelectSymbol) {
      onSelectSymbol(target);
      setOpen(false);
    }
  };

  const visible = onlyThis ? alerts.filter((alert) => alert.symbol === symbol) : alerts;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="relative flex items-center gap-2 rounded-lg border border-[#26453a] px-2 py-2 text-[#a8bdb2] transition-colors hover:bg-[#12251f]"
        aria-label={`Buy alerts (${unreadCount} unread)`}
      >
        <Bell size={14} className={unreadCount > 0 ? "text-[#c8f169]" : undefined} />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#c8f169] px-1 font-mono-ui text-[8px] font-bold text-[#10200b]">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-[400px] max-w-[92vw] overflow-hidden rounded-xl border border-[#26453a] bg-[#0a1714] shadow-[0_25px_80px_rgba(0,0,0,.45)]">
          <div className="flex items-center gap-2 border-b border-[#173029] px-3 py-2">
            <Radar size={13} className="text-[#c8f169]" />
            <span className="font-mono-ui text-[9px] uppercase tracking-[.16em] text-[#c8f169]">Buy-evidence alerts</span>
            <button
              onClick={() => setOnlyThis((value) => !value)}
              className={`ml-1 rounded-md px-2 py-0.5 font-mono-ui text-[8px] uppercase tracking-[.12em] transition-colors ${onlyThis ? "bg-[#142a25] text-[#c8f169]" : "text-[#70887d] hover:text-[#d9e9dc]"}`}
            >
              {symbol} only
            </button>
            {unreadCount > 0 ? (
              <button
                onClick={() => void acknowledgeAll()}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono-ui text-[8px] uppercase tracking-[.12em] text-[#789087] transition-colors hover:text-[#c8f169]"
              >
                <CheckCheck size={11} /> Mark all read
              </button>
            ) : null}
            <button onClick={() => setOpen(false)} className="ml-auto text-[#70887d] transition-colors hover:text-[#d9e9dc]" aria-label="Close alerts">
              <X size={13} />
            </button>
          </div>
          <div className="max-h-[360px] overflow-y-auto">
            {visible.length === 0 ? (
              <div className="px-4 py-6 text-center font-mono-ui text-[10px] leading-relaxed text-[#70887d]">
                {onlyThis && alerts.length > 0
                  ? `No alerts for ${symbol} yet — others exist, toggle off "${symbol} only".`
                  : "No alerts yet. The radar sweeps closed-form rules over real daily bars every ~5 minutes; an alert appears only when a rule actually fires."}
              </div>
            ) : (
              visible.map((alert) => {
                const meta = ruleMeta(alert.rule);
                return (
                  <div key={alert.id} className={`border-l-2 border-b border-[#12241f] px-3 py-2.5 transition-colors hover:bg-[#0d1f1a] ${alert.acknowledged ? "opacity-60" : ""}`} style={{ borderLeftColor: meta.color }} title={`${absoluteTime(alert.marketTimestamp)}`}>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => jumpToSymbol(alert.symbol)}
                        disabled={!onSelectSymbol}
                        className={`font-display text-xs font-bold ${onSelectSymbol ? "text-[#eaf4e9] hover:text-[#c8f169] hover:underline" : "text-[#eaf4e9] cursor-default"}`}
                        title={onSelectSymbol ? `Open ${alert.symbol} in the Decision view` : undefined}
                      >
                        {alert.symbol}
                      </button>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
                      {alert.newToRadar ? (
                        <span className="rounded-full border border-[#5a4328] bg-[#21180e] px-1.5 py-0.5 font-mono-ui text-[7px] uppercase tracking-[.14em] text-[#e5b55f]">
                          New to radar
                        </span>
                      ) : null}
                      <span className="ml-auto font-mono-ui text-[8px] text-[#5f766b]">{timeAgo(alert.createdAt)}</span>
                    </div>
                    <div className="mt-1 text-[11px] leading-snug text-[#b9cec3]">{meta.label}</div>
                    <div className="mt-0.5 font-mono-ui text-[9px] text-[#70887d]">
                      {alert.price != null ? `₹${alert.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })} · ` : ""}
                      {evidenceLine(alert.evidence)}
                    </div>
                    {!alert.acknowledged ? (
                      <button
                        onClick={() => void acknowledge(alert.id)}
                        className="mt-1.5 flex items-center gap-1 rounded-md border border-[#2c4a3d] px-2 py-1 font-mono-ui text-[8px] uppercase tracking-[.14em] text-[#c8f169] transition-colors hover:bg-[#12251f]"
                      >
                        <Check size={10} /> Acknowledge
                      </button>
                    ) : (
                      <div className="mt-1.5 font-mono-ui text-[8px] uppercase tracking-[.14em] text-[#4f675d]">Acknowledged</div>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <div className="border-t border-[#173029] bg-[#081210] px-3 py-2 font-mono-ui text-[8px] leading-relaxed text-[#5f766b]">
            Rule-evidence flags over completed real daily sessions — not investment advice. No ML model participates:
            every artifact currently fails the OOS promotion gate.
          </div>
        </div>
      ) : null}
    </div>
  );
}
