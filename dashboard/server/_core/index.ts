import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) if (await isPortAvailable(port)) return port;
  throw new Error(`No available port found starting from ${startPort}`);
}

function databaseStatePath() {
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "D-Predict", "database.json");
}

function databaseStatus() {
  const statePath = databaseStatePath();
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { configured: true, mode: state.mode ?? null, dataRoot: state.dataRoot ?? null, configPath: statePath };
  } catch {
    return { configured: false, mode: null, dataRoot: null, configPath: statePath };
  }
}

function databaseSetupScript() {
  const candidates = [
    path.resolve(process.cwd(), "database-setup.ps1"),
    path.resolve(process.cwd(), "..", "database-setup.ps1"),
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  app.get("/api/system/database", (_req, res) => res.json(databaseStatus()));
  app.post("/api/system/database/setup", (_req, res) => {
    if (process.platform !== "win32") return res.status(501).json({ ok: false, error: "DATABASE_SETUP_WINDOWS_ONLY" });
    const script = databaseSetupScript();
    if (!script) return res.status(404).json({ ok: false, error: "DATABASE_SETUP_SCRIPT_NOT_FOUND" });
    try {
      const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
        cwd: path.dirname(script),
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();
      return res.json({ ok: true, launched: true });
    } catch (error) {
      return res.status(500).json({ ok: false, error: "DATABASE_SETUP_LAUNCH_FAILED", message: error instanceof Error ? error.message : "launch_failed" });
    }
  });

  registerStorageProxy(app);
  registerOAuthRoutes(app);
  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));

  const development = process.env.NODE_ENV !== "production";
  if (development) await setupVite(app, server);
  else serveStatic(app);

  const preferredPort = parseInt(process.env.PORT || "3000", 10);
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  server.listen(port, () => console.log(`Dashboard running on http://127.0.0.1:${port}/`));
}

startServer().catch(error => { console.error(error); process.exitCode = 1; });
