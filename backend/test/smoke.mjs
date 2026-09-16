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
  console.log("backend health smoke test passed");
} finally {
  child.kill("SIGTERM");
}
