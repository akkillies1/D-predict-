// Paper desk + shadow ledger availability contract.
//
// The desk polls these routes every few seconds, so a response shape is a user-facing
// promise: a database that is merely starting up must read as retryable unavailability (never a
// 500, never "empty"), a real fault must stay visible with its own code, and no route may echo
// connection internals into the browser. The stub pool below is a stand-in for the local
// database, so every query the routes emit is checked for placeholder/parameter agreement —
// the class of bug that broke the desk once a research fund existed.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import express from "express";

// Each case loads its own module instances: the route modules memoize their one-shot schema
// migration, and a test must not inherit another case's cached promise.
let caseId = 0;
async function loadRouters() {
  caseId += 1;
  const paper = await import(`../dist/paperRoutes.js?case=${caseId}`);
  const shadow = await import(`../dist/shadowRoutes.js?case=${caseId}`);
  return { createPaperRouter: paper.createPaperRouter, createShadowRouter: shadow.createShadowRouter, databaseUnavailable: paper.databaseUnavailable, attachPoolAvailabilityHandler: paper.attachPoolAvailabilityHandler };
}

function unavailableError(host = "172.19.0.3") {
  return Object.assign(new Error(`connect ECONNREFUSED ${host}:5432`), { code: "ECONNREFUSED" });
}

// A stand-in for node-postgres: rules pick rows per statement, health can be flipped mid-test,
// and every call is recorded for the structural assertions.
function makePool(rules = [], { healthy = true } = {}) {
  const calls = [];
  const state = { healthy, failure: unavailableError() };
  const run = (sql, params) => {
    if (typeof sql !== "string") throw new TypeError("pool.query(sql, params) must receive a string");
    calls.push({ sql, params });
    if (!state.healthy) throw state.failure;
    for (const rule of rules) if (rule.match.test(sql)) return { rows: typeof rule.rows === "function" ? rule.rows(sql, params) : rule.rows };
    return { rows: [] };
  };
  const client = { query: async (sql, params) => run(sql, params), release: () => {} };
  return {
    calls,
    state,
    setHealthy(healthy) { state.healthy = healthy; },
    setFailure(error) { state.failure = error; },
    connect: async () => client,
    query: async (sql, params) => { const result = run(sql, params); return { rows: result.rows, rowCount: result.rows.length }; },
  };
}

async function serve({ createPaperRouter, createShadowRouter }, pool) {
  const app = express();
  app.use(express.json());
  app.use("/api/paper", createPaperRouter(pool));
  app.use("/api/shadow", createShadowRouter(pool));
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, init) => {
    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 120) }; }
    return { status: response.status, body };
  };
  return { request, close: () => new Promise((resolve) => server.close(resolve)) };
}

const post = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// Every paper route, as the desk and its buttons call them.
const PAPER_REQUESTS = [
  ["GET", "/api/paper/state", undefined],
  ["GET", "/api/paper/analytics", undefined],
  ["GET", "/api/paper/export.csv", undefined],
  ["POST", "/api/paper/account", { startingCapital: 100_000 }],
  ["POST", "/api/paper/deposit", { amount: 5_000 }],
  ["POST", "/api/paper/reset", { mode: "trades" }],
  ["POST", "/api/paper/orders", { symbol: "TCS.NS", side: "BUY", product: "CNC", quantity: 10, orderType: "MARKET" }],
  ["POST", "/api/paper/orders/2f7f4a2e-6a3f-4b02-9f0c-8d9d3f5b1a11/cancel", {}],
];
const SHADOW_REQUESTS = [
  ["GET", "/api/shadow/portfolio", undefined],
  ["GET", "/api/shadow/blotter", undefined],
  ["GET", "/api/shadow/stats", undefined],
  ["GET", "/api/shadow/equity-curve", undefined],
  ["GET", "/api/shadow/paper-trades", undefined],
  ["GET", "/api/shadow/paper/unified", undefined],
];

function assertOutageResponse(label, result) {
  assert.equal(result.status, 503, `${label} must report an outage as retryable unavailability, got ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error, "DATABASE_UNAVAILABLE", `${label} must use the stable outage code`);
  assert.equal(result.body.retryable, true, `${label} outage must be retryable`);
  const text = JSON.stringify(result.body);
  // Useful to the log, useless (and sensitive) to the browser: host, port and driver wording stay server-side.
  for (const leak of ["ECONNREFUSED", "172.19.0.3", "5432", "pg", "Pool"]) {
    assert.ok(!text.includes(leak), `${label} outage response must not expose ${leak}`);
  }
}

async function testOutageIsUnavailableNotFailure() {
  const routers = await loadRouters();
  const pool = makePool([], { healthy: false });
  const { request, close } = await serve(routers, pool);
  try {
    for (const [method, path, body] of [...PAPER_REQUESTS, ...SHADOW_REQUESTS]) {
      const result = await request(path, method === "GET" ? undefined : post(body ?? {}));
      assertOutageResponse(`${method} ${path}`, result);
    }
  } finally { await close(); }

  // The same routes must answer normally once the database is back, without restarting the API.
  const again = await serve(routers, pool);
  try {
    pool.setHealthy(true);
    const state = await again.request("/api/paper/state");
    assert.equal(state.status, 200, `paper state must recover on its own once postgres is back: ${JSON.stringify(state.body)}`);
    const blotter = await again.request("/api/shadow/blotter");
    assert.equal(blotter.status, 200, `shadow blotter must recover too: ${JSON.stringify(blotter.body)}`);
  } finally { await again.close(); }
}

async function testSchemaFailureStaysVisible() {
  const routers = await loadRouters();
  // A schema problem is not transient: it must stay a 500 with its own code so the user is
  // never told "no data" while the ledger table is actually broken.
  const pool = makePool([{ match: /from paper_accounts/, rows: () => { throw Object.assign(new Error('column paper_accounts.starting_capital does not exist'), { code: "42703" }); } }]);
  const { request, close } = await serve(routers, pool);
  try {
    const result = await request("/api/paper/state");
    assert.equal(result.status, 500);
    assert.equal(result.body.error, "PAPER_STATE_FAILED");
    assert.equal(result.body.retryable, false);
    assert.match(result.body.message, /does not exist/, "the real fault stays readable");
  } finally { await close(); }
}

const ACCOUNT_RULES = [
  { match: /^create table if not exists paper_accounts|alter table paper_orders add column/, rows: [] },
  { match: /from paper_accounts where id=\$1/, rows: [{ id: 1, starting_capital: "100000.00", cash: "80000.00", realized_pnl: "1200.00", total_costs: "300.00", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] },
  { match: /to_regclass\('public\.option_paper_trades'\)/, rows: [{ name: null, strategies: null }] },
  { match: /from paper_positions where account_id=\$1 order by/, rows: [] },
  { match: /from paper_orders where account_id=\$1 order by created_at desc limit 200/, rows: [] },
  { match: /from paper_orders where account_id=\$1 and created_at/, rows: [{ actions: 0, trades: 0, winning_trades: 0, realized_pnl: "0", notional: "0", costs: "0" }] },
];

async function testFirstLaunchAndFundedAccount() {
  const routers = await loadRouters();

  // First launch: the ledger tables do not exist yet, so the desk must show the fund-creation
  // state — not a 500 from a missing relation.
  const fresh = makePool([{ match: /from paper_accounts where id=\$1/, rows: [] }]);
  const freshServer = await serve(routers, fresh);
  try {
    const result = await freshServer.request("/api/paper/state");
    assert.equal(result.status, 200, `first launch must not be an error: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.account, null, "no account yet is an empty state, not a fake one");
    assert.deepEqual(result.body.positions, []);
    assert.equal(fresh.calls.some(call => /create table if not exists paper_accounts/.test(call.sql)), true, "the desk must reconcile its own schema on read");
  } finally { await freshServer.close(); }

  // Funded account: cash and equity come from the row, and the outage fix must not hide it.
  const funded = makePool(ACCOUNT_RULES);
  const fundedServer = await serve(routers, funded);
  try {
    const result = await fundedServer.request("/api/paper/state");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.account.cash, 80_000);
    assert.equal(result.body.account.startingCapital, 100_000);
    assert.equal(result.body.account.equity, 80_000, "equity is cash + marks, never an invented number");
  } finally { await fundedServer.close(); }

  // No database configured at all is a permanent configuration state, not a retry.
  const none = await serve(routers, null);
  try {
    const state = await none.request("/api/paper/state");
    assert.equal(state.status, 503);
    assert.equal(state.body.error, "DATABASE_NOT_CONFIGURED");
    assert.equal(state.body.retryable, false);
    const portfolio = await none.request("/api/shadow/portfolio");
    assert.equal(portfolio.body.error, "DATABASE_NOT_CONFIGURED");
    assert.equal(portfolio.body.retryable, false);
  } finally { await none.close(); }
}

async function testPlaceholderParameterArityAndAccountScoping() {
  const routers = await loadRouters();
  const live = new Date().toISOString();
  const pool = makePool([
    ...ACCOUNT_RULES,
    { match: /select cash from paper_accounts where id=\$1 for update/, rows: [{ cash: "100000.00" }] },
    { match: /select starting_capital from paper_accounts where id=\$1 for update/, rows: [{ starting_capital: "100000.00" }] },
    { match: /from paper_positions where account_id=\$1 and symbol=\$2 and product=\$3 for update/, rows: [] },
    { match: /pb\.timeframe='1m'/, rows: [{ close: "3000.00", market_timestamp: live }] },
    { match: /from signal_decisions/, rows: [] },
    { match: /insert into paper_orders/, rows: [{ id: "6f0f9d2f-1c2b-4a5f-9c7d-1a2b3c4d5e6f", created_at: live }] },
    { match: /update paper_accounts set/, rows: [{ starting_capital: "105000.00", cash: "105000.00" }] },
    { match: /update paper_orders set status='CANCELLED'/, rows: [{ id: "2f7f4a2e-6a3f-4b02-9f0c-8d9d3f5b1a11" }] },
    { match: /select count\(\*\)::int as actions/, rows: [{ actions: 0, trades: 0, winning_trades: 0, realized_pnl: "0", notional: "0", costs: "0" }] },
    { match: /group by symbol order by realized_pnl desc/, rows: [] },
    { match: /group by side order by side/, rows: [] },
    { match: /group by 1 order by realized_pnl desc/, rows: [] },
  ]);
  const { request, close } = await serve(routers, pool);
  try {
    for (const [method, path, body] of PAPER_REQUESTS) await request(path, method === "GET" ? undefined : post(body ?? {}));
  } finally { await close(); }

  assert.ok(pool.calls.length > 8, `expected the routes to talk to the database, saw ${pool.calls.length} queries`);
  for (const { sql, params } of pool.calls) {
    const used = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    if (!used.length) continue;
    const highest = Math.max(...used);
    const supplied = Array.isArray(params) ? params.length : 0;
    assert.ok(highest <= supplied, `query binds $${highest} but supplied ${supplied} parameters: ${sql.slice(0, 140)}`);
    for (let position = 1; position <= highest; position += 1) {
      assert.ok(used.includes(position), `query skips $${position}: ${sql.slice(0, 140)}`);
    }
    // The ledger is single-account by constraint; a statement must never read another account's
    // rows by forgetting its scope.
    const scoped = /\b(?:from|update)\s+paper_(?:orders|positions|accounts)\b/i.test(sql) && !/\bcreate\b|\binsert\b|\balter\b/i.test(sql);
    if (scoped) {
      const account = sql.match(/account_id\s*=\s*\$(\d+)/i);
      const byId = /\bwhere id\s*=\s*\$(\d+)/i.exec(sql);
      assert.ok(account || byId, `statement on the paper ledger has no account scope: ${sql.slice(0, 140)}`);
      const index = Number((account ?? byId)[1]) - 1;
      assert.equal(params[index], 1, `paper ledger must be scoped to the single research account: ${sql.slice(0, 140)}`);
    }
  }
}

async function testShadowCapitalStaysUnconfigured() {
  const routers = await loadRouters();
  const previous = process.env.SHADOW_STARTING_CAPITAL;
  delete process.env.SHADOW_STARTING_CAPITAL;
  const pool = makePool([
    { match: /from shadow_trades/, rows: [] },
    { match: /from shadow_equity_snapshots/, rows: [] },
  ]);
  const { request, close } = await serve(routers, pool);
  try {
    // No snapshot and no configured capital: honest 503 with the remedy named. It must not be
    // converted into a 200 with a made-up balance just to quiet the console.
    const result = await request("/api/shadow/portfolio");
    assert.equal(result.status, 503);
    assert.equal(result.body.error, "SHADOW_CAPITAL_NOT_CONFIGURED");
    assert.equal(result.body.retryable, false);
    assert.match(result.body.message ?? "", /SHADOW_STARTING_CAPITAL/, "the answer must say how to fix it");
    assert.ok(!/startingCapital["']?\s*:\s*\d/.test(JSON.stringify(result.body)), "no fabricated capital in the payload");

    // Configure it and the same route answers from the configured value only.
    process.env.SHADOW_STARTING_CAPITAL = "250000";
    const configured = await request("/api/shadow/portfolio");
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    assert.equal(configured.body.summary.startingCapital, 250_000);
    assert.equal(configured.body.summary.equity, 250_000, "with no snapshot the curve starts at the configured capital");
  } finally {
    if (previous === undefined) delete process.env.SHADOW_STARTING_CAPITAL; else process.env.SHADOW_STARTING_CAPITAL = previous;
    await close();
  }
}

async function testOutageClassifier() {
  const { databaseUnavailable } = await loadRouters();
  const unavailable = [
    unavailableError(),
    Object.assign(new Error("the database system is starting up"), { code: "57P03" }),
    Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }),
    Object.assign(new Error("sorry, number of connections already at maximum"), { code: "53300" }),
    Object.assign(new Error("connection terminated"), { code: "08006" }),
    Object.assign(new Error("timeout exceeded when trying to connect"), { code: "PooledTimeout" }),
    // What node-postgres raises when the Pool's own connect timeout elapses against a database
    // that is gone. It carries no SQLSTATE, so a text match is the only thing that keeps it a
    // retryable 503 rather than a 500 — and it is also what silenced the live hub in testing.
    new Error("Connection terminated due to connection timeout"),
    new Error("Connection terminated unexpectedly"),
    Object.assign(new Error("getaddrinfo ENOTFOUND postgres"), { code: "ENOTFOUND" }),
    new Error("getaddrinfo EAI_AGAIN postgres"),
    Object.assign(new Error("Server closed the connection unexpectedly"), { sqlState: "58000" }),
  ];
  for (const error of unavailable) assert.equal(databaseUnavailable(error), true, `${error.message} is transient`);
  const realFaults = [
    Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    Object.assign(new Error('column "lot_size" does not exist'), { code: "42701" }),
    Object.assign(new Error("INSUFFICIENT_PAPER_CASH")),
    new Error("Relation does not exist because migration failed"),
  ];
  for (const error of realFaults) assert.equal(databaseUnavailable(error), false, `${error.message} is not a transient outage`);
}

async function testPoolIdleErrorKeepsTheApiAlive() {
  const { attachPoolAvailabilityHandler } = await loadRouters();
  // Reproduces the crash seen on the dev stack: stopping PostgreSQL answers 57P01 on every
  // idle client, pg-pool re-emits it on the Pool, and an unhandled "error" event is fatal for
  // the Node process — which is what turned one database restart into a run of desk 500s.
  const pool = new EventEmitter();
  assert.throws(() => pool.emit("error", unavailableError()), /ECONNREFUSED/, "an unlistened pool error escapes the event loop and stops the process");
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(" "));
  try {
    attachPoolAvailabilityHandler(pool);
    assert.doesNotThrow(() => pool.emit("error", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" })));
    attachPoolAvailabilityHandler(null);
  } finally { console.error = original; }
  const logged = lines.join("\n");
  assert.match(logged, /DATABASE_UNAVAILABLE/, "the dropped connection is still reported, not swallowed");
  assert.match(logged, /57P01/);
  assert.doesNotMatch(logged, /172\.19|:\d{4}|\bpg\b|Pool\b/);
}

async function testHubAnnouncesOutage() {
  // The desk does not poll while the live socket is open, so a hub that silently stops pushing
  // would leave a stale equity number on screen with no error state at all.
  const http = await import("node:http");
  const WebSocket = (await import("ws")).default;
  caseId += 1;
  const { attachLiveHub } = await import(`../dist/liveHub.js?case=${caseId}`);
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  attachLiveHub(server, makePool([], { healthy: false }));
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/live`);
  try {
    const message = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the hub pushed nothing for 15s")), 15_000);
      socket.on("message", (data) => { clearTimeout(timer); resolve(JSON.parse(String(data))); });
      socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
    assert.equal(message.type, "unavailable", "a hub that cannot read the database says so");
    assert.match(message.message, /database/i);
  } finally { socket.close(); server.close(); }
}

async function testPaperAccountIsPostOnly() {
  const routers = await loadRouters();
  const { request, close } = await serve(routers, makePool(ACCOUNT_RULES));
  try {
    // The desk creates a fund with POST and reads it through /state. A GET on /account has never
    // existed, so a reported 500 there can only be a 404 from a stale caller — asserted so the
    // contract cannot silently drift.
    const result = await request("/api/paper/account");
    assert.equal(result.status, 404, "GET /api/paper/account is not a route; the ledger is read from /state");
  } finally { await close(); }
}

await testOutageClassifier();
await testOutageIsUnavailableNotFailure();
await testSchemaFailureStaysVisible();
await testFirstLaunchAndFundedAccount();
await testPlaceholderParameterArityAndAccountScoping();
await testShadowCapitalStaysUnconfigured();
await testPoolIdleErrorKeepsTheApiAlive();
await testHubAnnouncesOutage();
await testPaperAccountIsPostOnly();

console.log("paper/shadow availability test passed");
