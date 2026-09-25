import type { Server } from "node:http";
import type { Pool } from "pg";
import { WebSocketServer, WebSocket } from "ws";
import { buildPaperState, matchRestingOrders, symbolQuote } from "./paperRoutes.js";

const PUSH_INTERVAL_MS = 4000;

// Push the paper desk over a WebSocket so the browser stops polling. Every cycle the hub
// advances resting orders against the live market (matchRestingOrders) whether or not any
// client is connected — so an order queued after hours fills at the next session's open
// even with the dashboard closed — and then broadcasts the resulting state plus a fresh
// quote for each watched symbol. When the feed is not live nothing new is produced.
export function attachLiveHub(server: Server, pool: Pool | null): void {
  if (!pool) return;
  const wss = new WebSocketServer({ server, path: "/live" });
  const watched = new Map<WebSocket, Set<string>>();

  const send = (socket: WebSocket, payload: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };

  wss.on("connection", (socket) => {
    watched.set(socket, new Set());
    socket.on("message", async (raw) => {
      try {
        const message = JSON.parse(String(raw));
        if (message?.type === "watch" && typeof message.symbol === "string") {
          const symbols = watched.get(socket) ?? new Set<string>();
          symbols.add(message.symbol.trim().toUpperCase());
          watched.set(socket, symbols);
          send(socket, { type: "quote", symbol: message.symbol, quote: await symbolQuote(pool, message.symbol) });
          send(socket, { type: "state", state: await buildPaperState(pool) });
        }
      } catch { /* ignore malformed frames */ }
    });
    socket.on("close", () => watched.delete(socket));
    socket.on("error", () => watched.delete(socket));
  });

  // Runs whether or not a client is connected: this is what makes an after-hours order fill
  // at the next session's open with the dashboard closed. buildPaperState is now read-only.
  const timer = setInterval(async () => {
    try {
      await matchRestingOrders(pool);
      if (wss.clients.size === 0) return;
      const state = await buildPaperState(pool);
      const quoteCache = new Map<string, unknown>();
      for (const [socket, symbols] of watched) {
        send(socket, { type: "state", state });
        for (const symbol of symbols) {
          if (!quoteCache.has(symbol)) quoteCache.set(symbol, await symbolQuote(pool, symbol));
          send(socket, { type: "quote", symbol, quote: quoteCache.get(symbol) });
        }
      }
    } catch { /* keep the hub alive across transient query errors */ }
  }, PUSH_INTERVAL_MS);
  timer.unref?.();

  wss.on("close", () => clearInterval(timer));
}
