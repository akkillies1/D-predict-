import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";
import { clearAiConfig, getAiModels, getAiStatus, saveAiConfig, type AiModelsResult, type AiStatus } from "@/lib/localApi";

/** Any component can raise this to open the panel (keeps one modal instance). */
export const OPEN_AI_SETTINGS_EVENT = "dpredict:open-ai-settings";

export function openAiSettings() {
  window.dispatchEvent(new CustomEvent(OPEN_AI_SETTINGS_EVENT));
}

export default function AiSettings() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<AiModelsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad" | "info"; text: string } | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const payload = await getAiStatus();
      setStatus(payload);
      setBaseUrl(payload.baseUrl);
      setModel(payload.model ?? "");
      setEnabled(payload.enabled);
    } catch (error) {
      setMessage({ tone: "bad", text: error instanceof Error ? error.message : "Assistant settings are unreachable — is the local API running?" });
    }
  }, []);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(OPEN_AI_SETTINGS_EVENT, handler);
    return () => window.removeEventListener(OPEN_AI_SETTINGS_EVENT, handler);
  }, []);

  const loadModels = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await getAiModels();
      setModels(result);
      if (!result.ok) setMessage({ tone: "bad", text: result.message ?? "Could not read the model list." });
      else if (!result.models.length) setMessage({ tone: "bad", text: "Your key returned no models. Check that the key is active at build.nvidia.com." });
      else setMessage({ tone: "ok", text: `${result.models.length} models available to your key.` });
    } catch (error) {
      setMessage({ tone: "bad", text: error instanceof Error ? error.message : "Could not read the model list." });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const payload = await saveAiConfig({
        ...(keyInput.trim() ? { apiKey: keyInput.trim() } : {}),
        baseUrl: baseUrl.trim(),
        model: model.trim() || null,
        enabled,
      });
      setStatus(payload);
      setKeyInput("");
      setShowKey(false);
      setMessage({ tone: "ok", text: keyInput.trim() ? "Key saved in your local database. It is never sent back to the browser in full." : "Settings saved." });
    } catch (error) {
      setMessage({ tone: "bad", text: error instanceof Error ? error.message : "Could not save assistant settings." });
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    setBusy(true);
    try {
      const payload = await clearAiConfig();
      setStatus(payload);
      setKeyInput("");
      setModels(null);
      setMessage({ tone: "info", text: payload.note ?? "Saved key removed from this machine's database." });
    } catch (error) {
      setMessage({ tone: "bad", text: error instanceof Error ? error.message : "Could not remove the key." });
    } finally {
      setBusy(false);
    }
  };

  const suggestions = models?.ok ? (models.nemotron.length ? [...models.nemotron, ...models.models.filter((id) => !models.nemotron.includes(id))] : models.models) : [];

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950 p-6 text-white shadow-2xl">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-lg font-semibold"><Sparkles className="size-5 text-[#c8f169]" />AI Assistant settings</div>
                <p className="mt-1 text-sm text-zinc-400">Bring your own key. D-Predict stores it only in the database on this machine and calls the provider straight from here.</p>
              </div>
              <button type="button" className="text-zinc-500 hover:text-white" onClick={() => setOpen(false)} aria-label="Close">×</button>
            </div>

            <div className="mb-5 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2 py-0.5 font-semibold ${status?.configured ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-zinc-600 text-zinc-400"}`}>
                  {status?.configured ? "READY" : "NOT CONFIGURED"}
                </span>
                {status?.source && <span className="text-zinc-400">key from {status.source === "env" ? "NVIDIA_API_KEY environment" : "local database"}</span>}
                {status?.maskedKey && <span className="font-mono text-zinc-400">{status.maskedKey}</span>}
                {status?.looksLikeNvidiaKey === false && <span className="text-amber-300">not an nvapi- key — fine for a self-hosted endpoint, wrong for build.nvidia.com</span>}
              </div>
              {status?.model && <div className="mt-2 font-mono text-[11px] text-zinc-300">{status.model}</div>}
              <p className="mt-3 leading-5 text-zinc-500">{status?.disclaimer ?? "Loading assistant status…"}</p>
            </div>

            <label className="mb-1 block text-[10px] uppercase tracking-[0.18em] text-zinc-500" htmlFor="ai-key">API key</label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-zinc-500" />
                <input
                  id="ai-key"
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(event) => setKeyInput(event.target.value)}
                  placeholder={status?.maskedKey ? "paste a new key to replace it" : "nvapi-… (from build.nvidia.com)"}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-white/10 bg-black/40 py-2 pl-9 pr-10 font-mono text-sm outline-none focus:border-[#c8f169]/60"
                />
                <button type="button" onClick={() => setShowKey((value) => !value)} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-white" aria-label={showKey ? "Hide key" : "Show key"}>
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">Leave blank to keep the stored key. NVIDIA issues a free signed-up key at build.nvidia.com; free-tier credits are limited and rate-limited.</p>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-[0.18em] text-zinc-500" htmlFor="ai-base">Endpoint</label>
                <input id="ai-base" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://integrate.api.nvidia.com/v1" className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs outline-none focus:border-[#c8f169]/60" />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-[0.18em] text-zinc-500" htmlFor="ai-model">Model</label>
                {suggestions.length ? (
                  <select id="ai-model" value={model} onChange={(event) => setModel(event.target.value)} className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-2 font-mono text-xs outline-none focus:border-[#c8f169]/60">
                    {!model && <option value="">— choose a model —</option>}
                    {model && !suggestions.includes(model) && <option value={model}>{model}</option>}
                    {suggestions.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                ) : (
                  <input id="ai-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="nvidia/…-nemotron-…" className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-xs outline-none focus:border-[#c8f169]/60" />
                )}
              </div>
            </div>

            <label className="mt-4 flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 accent-[#c8f169]" />
              Assistant enabled
            </label>

            <div className="mt-5 flex flex-wrap gap-2">
              <button type="button" onClick={() => void save()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-[#c8f169] px-4 py-2 text-sm font-semibold text-black disabled:opacity-50"><Save className="size-4" />Save</button>
              <button type="button" onClick={() => void loadModels()} disabled={busy || !status?.configured} className="inline-flex items-center gap-2 rounded-lg border border-white/15 px-4 py-2 text-sm disabled:opacity-40"><RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />List models for my key</button>
              {status?.maskedKey && <button type="button" onClick={() => void removeKey()} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-300 disabled:opacity-40"><Trash2 className="size-4" />Remove key</button>}
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:text-white">Close</button>
            </div>

            {message && <p className={`mt-4 text-sm ${message.tone === "bad" ? "text-red-300" : message.tone === "ok" ? "text-emerald-300" : "text-zinc-400"}`}>{message.text}</p>}
            <p className="mt-5 text-xs leading-5 text-zinc-500">The assistant only re-explains numbers D-Predict already computed from your persisted market data. It cannot fetch prices, and its text is commentary — not a prediction, signal, or investment advice.</p>
          </div>
        </div>
      )}
    </>
  );
}
