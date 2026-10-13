import { useEffect, useState } from "react";
import { WifiOff, Wifi, RefreshCw } from "lucide-react";

type NetworkInformation = EventTarget & { effectiveType?: string; downlink?: number };
type NavigatorWithConnection = Navigator & { connection?: NetworkInformation; mozConnection?: NetworkInformation; webkitConnection?: NetworkInformation };

function readSlowConnection(): boolean {
  const nav = navigator as NavigatorWithConnection;
  const connection = nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
  return connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g" || (connection?.downlink != null && connection.downlink < 0.7);
}

export default function NetworkStatusBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [slow, setSlow] = useState(readSlowConnection);

  useEffect(() => {
    const nav = navigator as NavigatorWithConnection;
    const connection = nav.connection ?? nav.mozConnection ?? nav.webkitConnection;
    const updateOnline = () => setOnline(navigator.onLine);
    const updateConnection = () => setSlow(readSlowConnection());
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    connection?.addEventListener("change", updateConnection);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      connection?.removeEventListener("change", updateConnection);
    };
  }, []);

  if (online && !slow) return null;

  return (
    <div role="status" aria-live="polite" className={`border-b px-4 py-2 text-xs ${!online ? "border-amber-500/30 bg-amber-950/50 text-amber-200" : "border-sky-500/30 bg-sky-950/40 text-sky-200"}`}>
      <div className="mx-auto flex max-w-[1600px] items-center gap-2">
        {!online ? <WifiOff size={14} aria-hidden="true" /> : <Wifi size={14} aria-hidden="true" />}
        <span className="font-semibold">{!online ? "No internet connection" : "Slow network detected"}</span>
        <span className="min-w-0">{!online
          ? "Internet-backed discovery and updates may be unavailable. Local paper data may still work."
          : "Requests may take longer. D-Predict will keep missing or stale market data non-actionable."}</span>
        {!online && <button type="button" onClick={() => setOnline(navigator.onLine)} className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-current/30 px-2 py-1 font-semibold hover:bg-white/5"><RefreshCw size={11} />Check</button>}
      </div>
    </div>
  );
}
