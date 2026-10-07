import { useCallback, useEffect, useState } from "react";
import { Database, HardDrive, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type DatabaseStatus = {
  configured: boolean;
  mode: "local_postgres" | "supabase_cloud" | "supabase_self_hosted" | null;
  dataRoot: string | null;
  configPath: string | null;
};

const modeLabel: Record<NonNullable<DatabaseStatus["mode"]>, string> = {
  local_postgres: "Local PostgreSQL",
  supabase_cloud: "Supabase Cloud",
  supabase_self_hosted: "Self-hosted Supabase",
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
      <section className="mx-auto max-w-[1540px] px-4 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-[#29483d] bg-[#0c1b17] p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              {status?.mode === "local_postgres" ? <HardDrive className="mt-0.5 size-5 text-[#c8f169]" /> : <Database className="mt-0.5 size-5 text-[#c8f169]" />}
              <div>
                <div className="font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#789087]">Data & Database</div>
                <div className="mt-1 font-display text-lg font-semibold text-[#edf5e9]">{configured && status?.mode ? modeLabel[status.mode] : "Configuration not detected"}</div>
                <p className="mt-1 text-xs text-[#70887d]">
                  {status?.dataRoot ? `Local PostgreSQL data: ${status.dataRoot}` : "D-Predict uses the configured local or PostgreSQL-compatible deployment."}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button onClick={() => setOpen(true)} disabled={busy}><Settings2 />{configured ? "Manage database" : "Set up database"}</Button>
              <Button variant="outline" onClick={() => void refresh()} disabled={busy}><RefreshCw />Refresh</Button>
            </div>
          </div>
          {!configured && <div className="mt-4 rounded-lg border border-[#5a4530] bg-[#2a2116] px-3 py-2 text-xs text-[#d7b989]">The dashboard could not find the saved database state. Refresh after installation; if it remains missing, run Setup & Repair.</div>}
          {message && <p className="mt-3 text-xs text-[#8da59a]">{message}</p>}
        </div>
      </section>

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
