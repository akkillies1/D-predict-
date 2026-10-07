// The update check is the only place D-Predict talks to the public internet, so
// these tests drive it against a local stub release list rather than GitHub.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { compareVersions, getUpdateStatus, resetUpdateCache } from "../dist/updateService.js";

let responses = [];
let requests = 0;
const server = createServer((req, res) => {
  requests += 1;
  const next = responses.shift();
  if (!next) { res.writeHead(500, { "content-type": "application/json" }); res.end("{}"); return; }
  res.writeHead(next.status ?? 200, { "content-type": "application/json" });
  res.end(JSON.stringify(next.body));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const releasesUrl = `http://127.0.0.1:${server.address().port}/releases/latest`;
process.env.D_PREDICT_RELEASES_URL = releasesUrl;

const asset = (name, size, digest) => ({ name, browser_download_url: `https://example.invalid/${name}`, size, digest });
const release = (tag, assets) => ({ status: 200, body: { tag_name: tag, html_url: `https://github.com/akkillies1/D-predict-/releases/tag/${tag}`, published_at: "2026-10-01T09:30:00Z", assets } });
const publishedRelease = release("v2.2.0", [
  asset("D-Predict-Windows-v2.2.0.zip", 4096, undefined),
  asset("D-Predict-Setup-v2.2.0.exe", 2110771, "sha256:ABCDEF0123456789"),
  asset("D-Predict-Setup.exe", 2110771, "sha256:FFEEDDCC"),
]);

function installed(version) {
  if (version === null) delete process.env.D_PREDICT_VERSION;
  else process.env.D_PREDICT_VERSION = version;
  delete process.env.D_PREDICT_UPDATE_CHECK;
  resetUpdateCache();
  responses = [structuredClone(publishedRelease)];
  requests = 0;
}

// Ordering must be exact: equal is 0, newer is positive, and junk is never "newer".
assert.equal(compareVersions("2.2.0", "2.1.4"), 1);
assert.equal(compareVersions("2.1.4", "2.2.0"), -1);
assert.equal(compareVersions("2.1.4", "2.1.4"), 0);
assert.equal(compareVersions("10.0.0", "9.9.9"), 1);
assert.ok(Number.isNaN(compareVersions("2.1", "2.1.4")));
assert.ok(Number.isNaN(compareVersions("nightly", "2.1.4")));

installed("2.1.4");
const available = await getUpdateStatus();
assert.equal(available.state, "UPDATE_AVAILABLE");
assert.equal(available.updateAvailable, true);
assert.equal(available.current, "2.1.4");
assert.equal(available.latest, "2.2.0");
// The versioned setup EXE is the authoritative artifact, not the convenience copy.
assert.equal(available.downloadUrl, "https://example.invalid/D-Predict-Setup-v2.2.0.exe");
assert.equal(available.sizeBytes, 2110771);
assert.equal(available.sha256, "abcdef0123456789");
assert.match(available.disclaimer, /Nothing is downloaded or installed/i);

installed("2.2.0");
assert.equal((await getUpdateStatus()).state, "CURRENT");
installed("2.3.0");
const ahead = await getUpdateStatus();
assert.equal(ahead.state, "CURRENT");
assert.equal(ahead.updateAvailable, false);

// One check per six hours: a second status call must reuse the cached release.
installed("2.1.4");
responses = [structuredClone(publishedRelease), structuredClone(publishedRelease)];
await getUpdateStatus();
await getUpdateStatus();
assert.equal(requests, 1);

// An installation that does not record its version, or that opted out, must say so
// rather than inventing a comparison.
installed(null);
const unknownVersion = await getUpdateStatus();
assert.equal(unknownVersion.state, "UNKNOWN_VERSION");
assert.equal(unknownVersion.updateAvailable, false);
assert.ok(unknownVersion.reason);
assert.equal(requests, 0);
installed("2.1.4");
process.env.D_PREDICT_UPDATE_CHECK = "0";
const disabled = await getUpdateStatus();
assert.equal(disabled.state, "DISABLED");
assert.equal(disabled.enabled, false);
assert.equal(disabled.updateAvailable, false);

// A failed check is never reported as "up to date" — that is how a user would keep
// running an outdated build in silence.
installed("2.1.4");
responses = [{ status: 503, body: { message: "rate limited" } }];
const failed = await getUpdateStatus();
assert.equal(failed.state, "CHECK_FAILED");
assert.equal(failed.updateAvailable, false);
assert.match(failed.reason, /503/);
// Failures are retried soon instead of being cached for the full six hours.
responses = [structuredClone(publishedRelease)];
resetUpdateCache();
assert.equal((await getUpdateStatus()).state, "UPDATE_AVAILABLE");

// A release list without a recognisable stable tag cannot be compared either.
installed("2.1.4");
responses = [release("v2.2.0-beta.1", [asset("D-Predict-Setup-v2.2.0-beta.1.exe", 1, "sha256:00")])];
const oddTag = await getUpdateStatus();
assert.equal(oddTag.state, "CHECK_FAILED");
assert.equal(oddTag.updateAvailable, false);

server.close();
console.log("updates.test.mjs: all assertions passed");
