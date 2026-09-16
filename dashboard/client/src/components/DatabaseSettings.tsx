import { useCallback, useEffect, useState } from "react";
import { Database, HardDrive, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type DatabaseStatus = {
  configured: boolean;
  mode: "local_postgres" | "supabase_cloud" | "self_hosted_supabase" | null;
  dataRoot: string | null;
  configPath: string | null;
};

const modeLabel: Record<NonNullable<DatabaseStatus["mode"]>, string> = {
  local_postgres: "Local PostgreSQL",
  supabase_cloud: "Supabase Cloud",
  self_hosted_supabase: "Self-hosted Supabase",
};

export default function DatabaseSettings() {
  const [status, setStatus] = useState<DatabaseStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/system/database", { cache: "no-store" });
      if (!response.ok) throw new Error("Database status unavailable");
      setStatus(await response.json());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Database status unavailable");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (status && !status.configured) setOpen(true); }, [status]);

  async function openSetup() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/system/database/setup", { method: "POST" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Could not open database setup");
      setMessage("Database setup opened. Finish the setup window, then refresh this panel.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open database setup");
    } finally {
      setBusy(false);
    }
  }

  const configured = status?.configured ?? false;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full border border-white/10 bg-black/80 px-4 py-3 text-sm font-medium text-white shadow-xl backdrop-blur hover:bg-black">
        <Settings2 className="size-4" />
        Data & Database
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-zinc-950 p-6 text-white shadow-2xl">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-lg font-semibold"><Database className="size-5" />Data & Database</div>
                <p className="mt-1 text-sm text-zinc-400">Choose where D-Predict stores its database.</p>
              </div>
              <button type="button" className="text-zinc-500 hover:text-white" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
              <div className="flex items-center gap-3">
                {status?.mode === "local_postgres" ? <HardDrive className="size-5" /> : <Database className="size-5" />}
                <div>
                  <div className="text-sm text-zinc-400">Current deployment</div>
                  <div className="font-medium">{configured && status?.mode ? modeLabel[status.mode] : "Not configured"}</div>
                </div>
              </div>
              {status?.dataRoot && <div className="mt-4 break-all rounded-lg bg-black/30 px-3 py-2 text-xs text-zinc-400">Local data: {status.dataRoot}</div>}
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <Button onClick={openSetup} disabled={busy}><Settings2 />{configured ? "Change database" : "Set up database"}</Button>
              <Button variant="outline" onClick={() => void refresh()} disabled={busy}><RefreshCw />Refresh</Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>
            </div>

            {message && <p className="mt-4 text-sm text-zinc-400">{message}</p>}
            <p className="mt-5 text-xs leading-5 text-zinc-500">Local PostgreSQL keeps database files in the drive you choose. Supabase Cloud and self-hosted Supabase use the connection you provide. D-Predict does not embed a paid database service.</p>
          </div>
        </div>
      )}
    </>
  );
}
