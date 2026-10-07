import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, Download, X } from "lucide-react";
import { getUpdateStatus, type UpdateStatus } from "@/lib/localApi";

// An installed copy only learns it is outdated if something asks. The local API
// answers that question; this banner is the one place it reaches the user, and it
// stays hidden unless a newer release has actually been confirmed. Installing is
// never automatic: the click hands off to the host updater, which shows its own
// progress and refuses to run an installer whose published checksum is missing.
const DISMISS_KEY = "dpredict:update-dismissed";
const RECHECK_MS = 6 * 60 * 60 * 1000;
const UPDATE_PROTOCOL_URL = "dpredict-update:apply";

function describeSize(sizeBytes: number | null): string | null {
  if (!sizeBytes || sizeBytes <= 0) return null;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB download`;
}

export default function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY));
  const [handedOff, setHandedOff] = useState(false);

  const check = useCallback(async (signal?: AbortSignal) => {
    try {
      setStatus(await getUpdateStatus(signal));
    } catch {
      // Offline, or a dev checkout with no API on the usual port: nothing to say.
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void check(controller.signal);
    const timer = setInterval(() => void check(), RECHECK_MS);
    return () => { controller.abort(); clearInterval(timer); };
  }, [check]);

  if (!status?.updateAvailable || !status.latest || status.latest === dismissed) return null;
  const size = describeSize(status.sizeBytes);

  return (
    <div title={status.disclaimer} className="border-b border-[#3c3218] bg-[#16130a]">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 text-[11px] lg:px-8">
        <span className="inline-flex items-center gap-1.5 font-semibold text-[#f0c674]">
          <ArrowUpCircle size={13} />
          D-Predict v{status.latest} is available — this install is v{status.current}.
        </span>
        {size && <span className="text-[#a89468]">{size}</span>}
        {status.sha256 && <span className="hidden font-mono-ui text-[10px] text-[#7d6f4d] md:inline">verified against sha256 {status.sha256.slice(0, 12)}…</span>}
        <button
          type="button"
          onClick={() => { setHandedOff(true); window.location.assign(UPDATE_PROTOCOL_URL); }}
          className="rounded-md border border-[#f0c674]/45 bg-[#f0c674]/10 px-3 py-1 font-semibold text-[#f6d68a] transition-colors hover:bg-[#f0c674]/20"
        >
          Update now
        </button>
        {status.downloadUrl && (
          <a href={status.downloadUrl} className="inline-flex items-center gap-1 text-[#a89468] transition-colors hover:text-[#f6d68a]">
            <Download size={11} />
            Download the setup
          </a>
        )}
        <button
          type="button"
          aria-label="Dismiss this update notice"
          className="ml-auto text-[#7d6f4d] transition-colors hover:text-[#d7e8d9]"
          onClick={() => { localStorage.setItem(DISMISS_KEY, status.latest ?? ""); setDismissed(status.latest); }}
        >
          <X size={13} />
        </button>
        {handedOff && (
          <span className="w-full text-[#a89468]">
            Windows should now open the D-Predict updater. It downloads the release, checks the published
            checksum, and only then runs setup — relaunch D-Predict when setup finishes to run the new
            version. If nothing appeared, your browser blocked the hand-off; use the download link above.
          </span>
        )}
      </div>
    </div>
  );
}
