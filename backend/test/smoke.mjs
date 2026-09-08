import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const port = 4199;
const child = spawn(process.execPath, ["dist/server.js"], { env: { ...process.env, API_PORT: String(port), DATABASE_URL: "" }, stdio: ["ignore", "pipe", "pipe"] });
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("API did not start within 5 seconds")), 5000);
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("D-predict local API listening")) { clearTimeout(timer); resolve(); } });
    child.on("error", reject);
  });
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.database, "not_configured");
  console.log("backend health smoke test passed");
} finally {
  child.kill("SIGTERM");
}
