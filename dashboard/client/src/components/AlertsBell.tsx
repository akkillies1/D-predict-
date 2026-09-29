import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Check, Radar, X } from "lucide-react";
import { toast } from "sonner";
import { ackAlert, getAlerts, paperLiveUrl, type BuyAlert } from "@/lib/localApi";

const RULE_LABELS: Record<string, string> = {
  momentum_turn: "20-day momentum crossed the net-of-cost gate",
  sma20_cross_up: "Close crossed above its 20-session mean",
  volume_z20_spike: "Volume ≥2σ spike inside a rising 5-day drift",
};

function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? rule;
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

export default function AlertsBell({ symbol }: { symbol: string }) {
  const [alerts, setAlerts] = useState<BuyAlert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [onlyThis, setOnlyThis] = useState(false);
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
            toast.info(`${alert.symbol} — ${ruleLabel(alert.rule)}`, {
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
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;
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
          toast.info(`${alert.symbol} — ${ruleLabel(alert.rule)}`, {
            description: alert.newToRadar ? "New to radar · rule-evidence flag, not advice" : "Rule-evidence flag, not advice",
          });
        }
      } catch { /* ignore malformed frames */ }
    };
    socket.onclose = () => { if (!closed) setTimeout(() => void refresh(), 2_000); };
    return () => { closed = true; socket?.close(); };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const acknowledge = async (id: number) => {
    try {
      await ackAlert(id);
      setAlerts((current) => current.map((alert) => (alert.id === id ? { ...alert, acknowledged: true } : alert)));
      setUnreadCount((count) => Math.max(0, count - 1));
    } catch { toast.error("Could not acknowledge alert"); }
  };

  const visible = onlyThis ? alerts.filter((alert) => alert.symbol === symbol) : alerts;

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="relative flex items-center gap-2 rounded-lg border border-[#26453a] px-2 py-2 text-[#a8bdb2] hover:bg-[#12251f]"
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
        <div className="absolute right-0 top-full z-50 mt-2 w-[380px] max-w-[90vw] overflow-hidden rounded-xl border border-[#26453a] bg-[#0a1714] shadow-[0_25px_80px_rgba(0,0,0,.45)]">
          <div className="flex items-center gap-2 border-b border-[#173029] px-3 py-2">
            <Radar size={13} className="text-[#c8f169]" />
            <span className="font-mono-ui text-[9px] uppercase tracking-[.16em] text-[#c8f169]">Buy-evidence alerts</span>
            <button
              onClick={() => setOnlyThis((value) => !value)}
              className={`ml-1 rounded-md px-2 py-0.5 font-mono-ui text-[8px] uppercase tracking-[.12em] ${onlyThis ? "bg-[#142a25] text-[#c8f169]" : "text-[#70887d] hover:text-[#d9e9dc]"}`}
            >
              {symbol} only
            </button>
            <button onClick={() => setOpen(false)} className="ml-auto text-[#70887d] hover:text-[#d9e9dc]" aria-label="Close alerts">
              <X size={13} />
            </button>
          </div>
          <div className="max-h-[340px] overflow-y-auto">
            {visible.length === 0 ? (
              <div className="px-4 py-6 text-center font-mono-ui text-[10px] leading-relaxed text-[#70887d]">
                No alerts yet. The radar sweeps closed-form rules over real daily bars every ~5 minutes;
                an alert appears only when a rule actually fires.
              </div>
            ) : (
              visible.map((alert) => (
                <div key={alert.id} className="border-b border-[#12241f] px-3 py-2.5 last:border-0">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-xs font-bold text-[#eaf4e9]">{alert.symbol}</span>
                    {alert.newToRadar ? (
                      <span className="rounded-full border border-[#5a4328] bg-[#21180e] px-1.5 py-0.5 font-mono-ui text-[7px] uppercase tracking-[.14em] text-[#e5b55f]">
                        New to radar
                      </span>
                    ) : null}
                    <span className="ml-auto font-mono-ui text-[8px] text-[#5f766b]">{timeAgo(alert.createdAt)}</span>
                  </div>
                  <div className="mt-1 text-[11px] leading-snug text-[#b9cec3]">{ruleLabel(alert.rule)}</div>
                  <div className="mt-0.5 font-mono-ui text-[9px] text-[#70887d]">
                    {alert.price != null ? `₹${alert.price.toLocaleString("en-IN", { maximumFractionDigits: 2 })} · ` : ""}
                    {evidenceLine(alert.evidence)}
                  </div>
                  {!alert.acknowledged ? (
                    <button
                      onClick={() => void acknowledge(alert.id)}
                      className="mt-1.5 flex items-center gap-1 rounded-md border border-[#2c4a3d] px-2 py-1 font-mono-ui text-[8px] uppercase tracking-[.14em] text-[#c8f169] hover:bg-[#12251f]"
                    >
                      <Check size={10} /> Acknowledge
                    </button>
                  ) : (
                    <div className="mt-1.5 font-mono-ui text-[8px] uppercase tracking-[.14em] text-[#4f675d]">Acknowledged</div>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="border-t border-[#173029] bg-[#081210] px-3 py-2 font-mono-ui text-[8px] leading-relaxed text-[#5f766b]">
            Rule-evidence flags over real daily bars — not investment advice. No ML model participates:
            every artifact currently fails the OOS promotion gate.
          </div>
        </div>
      ) : null}
    </div>
  );
}
