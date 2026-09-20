import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 4199;
const child = spawn(process.execPath, ["dist/server.js"], {
  env: { ...process.env, API_PORT: String(port), PORT: "3000", DATABASE_URL: "" },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("API did not start within 5 seconds")), 5000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("D-predict backend listening on 4199")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) console.error(message);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== null && code !== 0) reject(new Error(`API exited before becoming ready (code ${code})`));
    });
  });

  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.database, "not_configured");
  const readyResponse = await fetch(`http://127.0.0.1:${port}/ready`);
  assert.equal(readyResponse.status, 503);
  const readyPayload = await readyResponse.json();
  assert.equal(readyPayload.ok, false);
  assert.equal(readyPayload.marketData, "unavailable");
  const performanceResponse = await fetch(`http://127.0.0.1:${port}/api/predictions/performance?days=30`);
  assert.equal(performanceResponse.status, 503);
  const performancePayload = await performanceResponse.json();
  assert.equal(performancePayload.ok, false);
  assert.equal(performancePayload.error, "DATABASE_NOT_CONFIGURED");
  console.log("backend health smoke test passed");
} finally {
  child.kill("SIGTERM");
}
