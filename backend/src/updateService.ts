// D-Predict ships as an Inno Setup bootstrapper, so an installed copy can drift
// far behind the public release without anyone noticing. This module only
// ANSWERS the question "is there a newer version?" — it never installs
// anything, because the api container has no host access. Applying an update is
// a separate, explicit action handled on the host by update-dpredict.ps1.

const RELEASES_API = "https://api.github.com/repos/akkillies1/D-predict-/releases/latest";
const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
// Generous because this runs on an 8 GB desktop whose DNS/TLS can stall for seconds
// under memory pressure; a check that times out is only retried after five minutes.
const FETCH_TIMEOUT_MS = 15000;

// Read at call time so a test can point the check at a local stub instead of the
// real release list.
function releasesUrl(): string {
  return String(process.env.D_PREDICT_RELEASES_URL ?? "").trim() || RELEASES_API;
}

export type UpdateState =
  | "CURRENT"
  | "UPDATE_AVAILABLE"
  | "UNKNOWN_VERSION"
  | "DISABLED"
  | "CHECK_FAILED";

export type UpdateStatus = {
  ok: boolean;
  enabled: boolean;
  state: UpdateState;
  current: string | null;
  latest: string | null;
  /** Only true when a newer release was actually confirmed. */
  updateAvailable: boolean;
  downloadUrl: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  sizeBytes: number | null;
  /** The digest GitHub publishes for that asset, hex without the prefix. */
  sha256: string | null;
  checkedAt: string | null;
  /** Set whenever state is CHECK_FAILED so the UI can say why. */
  reason: string | null;
  disclaimer: string;
};

export const UPDATE_DISCLAIMER =
  "Update check reads the public GitHub release list. Nothing is downloaded or installed until you choose to update.";

export function currentVersion(): string | null {
  const raw = String(process.env.D_PREDICT_VERSION ?? "").trim();
  if (!raw) return null;
  return parseVersion(raw) ? raw.replace(/^v/i, "") : null;
}

export function updateCheckEnabled(): boolean {
  if (String(process.env.D_PREDICT_UPDATE_CHECK ?? "").trim() === "0") return false;
  return true;
}

function parseVersion(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Positive when `a` is newer than `b`. Unparseable input is never treated as
 * newer — an unknown version must not trigger an auto-update narrative. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return Number.NaN;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

type CachedRelease = {
  at: number;
  /** When the next status call may hit the network again. */
  expiresAt: number;
  payload: Omit<UpdateStatus, "ok" | "enabled" | "state" | "current" | "updateAvailable" | "disclaimer"> | null;
  reason: string | null;
};
let cache: CachedRelease | null = null;

export function resetUpdateCache() {
  cache = null;
}

async function fetchLatestRelease(signal?: AbortSignal) {
  const response = await fetch(releasesUrl(), {
    headers: { accept: "application/vnd.github+json", "user-agent": "D-Predict-local-updater" },
    signal,
  });
  if (!response.ok) throw new Error(`release service returned ${response.status}`);
  const body = (await response.json()) as {
    tag_name?: unknown;
    html_url?: unknown;
    published_at?: unknown;
    assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown; digest?: unknown }>;
  };
  const tag = typeof body.tag_name === "string" ? body.tag_name : null;
  const assets = Array.isArray(body.assets) ? body.assets : [];
  // The versioned setup EXE is the authoritative artifact; the unversioned
  // D-Predict-Setup.exe is a convenience copy of the same bytes.
  const installer = assets.find((asset) => typeof asset.name === "string" && /^D-Predict-Setup-v[\d.]+\.exe$/i.test(asset.name))
    ?? assets.find((asset) => typeof asset.name === "string" && /\.exe$/i.test(asset.name));
  const digest = typeof installer?.digest === "string" ? installer.digest : null;
  return {
    latest: tag ? tag.replace(/^v/i, "") : null,
    downloadUrl: typeof installer?.browser_download_url === "string" ? installer.browser_download_url : null,
    releaseUrl: typeof body.html_url === "string" ? body.html_url : null,
    publishedAt: typeof body.published_at === "string" ? body.published_at : null,
    sizeBytes: Number.isFinite(Number(installer?.size)) && Number(installer?.size) > 0 ? Number(installer?.size) : null,
    sha256: digest ? digest.replace(/^sha256:/i, "").toLowerCase() : null,
    checkedAt: new Date().toISOString(),
    reason: null,
  };
}

/** Node reports a connect failure as the bare string "fetch failed"; the real
 * reason sits on `cause`, and the banner is the only place a user can see it. */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "release check failed");
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
  return cause ? `${message}: ${cause}` : message;
}

async function loadRelease(): Promise<CachedRelease> {
  if (cache && Date.now() < cache.expiresAt) return cache;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const payload = await fetchLatestRelease(controller.signal);
    cache = { at: Date.now(), expiresAt: Date.now() + CHECK_TTL_MS, payload, reason: null };
  } catch (error) {
    // A failed check is retried within five minutes instead of being cached for
    // the full six hours, so a transient network blip does not silence the banner.
    cache = { at: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000, payload: null, reason: describeError(error) };
  } finally {
    clearTimeout(timer);
  }
  return cache;
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  const current = currentVersion();
  const enabled = updateCheckEnabled();
  const base = { ok: true, enabled, current, latest: null as string | null, downloadUrl: null, releaseUrl: null, publishedAt: null, sizeBytes: null, sha256: null, checkedAt: null, reason: null as string | null, disclaimer: UPDATE_DISCLAIMER };

  if (!enabled) return { ...base, state: "DISABLED", updateAvailable: false, reason: "Update checks are disabled on this installation." };
  if (!current) return { ...base, state: "UNKNOWN_VERSION", updateAvailable: false, reason: "This installation does not record its own version, so it cannot be compared with the public release." };

  const entry = await loadRelease();
  if (!entry.payload) {
    return { ...base, state: "CHECK_FAILED", updateAvailable: false, checkedAt: new Date(entry.at).toISOString(), reason: entry.reason ?? "The release service could not be reached." };
  }
  const { latest, ...release } = entry.payload;
  if (!latest) {
    return { ...base, ...release, state: "CHECK_FAILED", updateAvailable: false, reason: "The release service returned no version tag." };
  }
  const comparison = compareVersions(latest, current);
  if (Number.isNaN(comparison)) {
    return { ...base, ...release, latest, state: "CHECK_FAILED", updateAvailable: false, reason: `The published version "${latest}" is not a recognisable release number.` };
  }
  return {
    ...base,
    ...release,
    latest,
    state: comparison > 0 ? "UPDATE_AVAILABLE" : "CURRENT",
    updateAvailable: comparison > 0,
  };
}
