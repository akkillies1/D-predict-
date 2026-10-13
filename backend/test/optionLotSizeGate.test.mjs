import assert from "node:assert/strict";
import express from "express";
import { analyzeOptionChain } from "../dist/optionIntelligence.js";
import { calculateVerticalRisk, createShadowRouter, isOptionContractExpired, isOptionQuoteFresh } from "../dist/shadowRoutes.js";

const now = new Date("2026-10-03T10:00:00.000Z");
const leg = (strike, optionType, oi, bid, ask) => ({
  lotSize: null, expiryDate: "2026-10-30", strike, optionType,
  timestamp: now.toISOString(), ltp: (bid + ask) / 2, bid, ask,
  oi, oiChange: 0, iv: 14, volume: 1000,
});
const chain = [
  leg(25000, "CE", 2000, 150, 151),
  leg(25200, "CE", 500, 95, 96),
  leg(25000, "PE", 3500, 110, 111),
  leg(24800, "PE", 3000, 80, 81),
];

const result = analyzeOptionChain("NIFTY", chain, 25000, now);
assert.equal(result.gates.lotSizeAvailable, false);
assert.equal(result.status, "RESEARCH_ONLY");
assert.equal(result.recommendation.tradePlan, null);

console.log("option lot-size gate contract passed");

// The order/close route must enforce quote age even outside market hours.
const freshnessNow = new Date("2026-10-03T10:00:00.000Z");
assert.equal(isOptionQuoteFresh(new Date(freshnessNow.getTime() - 30_000), freshnessNow, 120_000), true);
assert.equal(isOptionQuoteFresh(new Date(freshnessNow.getTime() - 180_000), freshnessNow, 120_000), false);
assert.equal(isOptionQuoteFresh(new Date(freshnessNow.getTime() + 1_000), freshnessNow, 120_000), false);
assert.equal(isOptionQuoteFresh(new Date("invalid"), freshnessNow, 120_000), false);

// Debit verticals already pay their maximum loss as premium; do not reserve it again.
assert.deepEqual(calculateVerticalRisk(1000, 500), { maxProfit: 500, maxLoss: 500, marginReserved: 0 });
// Credit verticals reserve their defined maximum loss from paper cash.
assert.deepEqual(calculateVerticalRisk(1000, -300), { maxProfit: 300, maxLoss: 700, marginReserved: 700 });

// Vertical spreads must reject expired contracts just like single-leg orders.
const expiryNow = new Date("2026-10-03T10:00:00.000Z");
assert.equal(isOptionContractExpired("2026-10-02", expiryNow), true);
assert.equal(isOptionContractExpired("2026-10-03", expiryNow), false);
assert.equal(isOptionContractExpired("2026-10-30", expiryNow), false);
assert.equal(isOptionContractExpired("not-a-date", expiryNow), true);


// Endpoint-level regression: missing contract sizing must reject both order types
// and leave trade/ledger tables untouched.
{
  const RealDate = globalThis.Date;
  const fixedMillis = new RealDate("2026-10-13T04:30:00.000Z").getTime(); // Tuesday, 10:00 IST
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixedMillis])); }
    static now() { return fixedMillis; }
  }
  globalThis.Date = FixedDate;
  const clientSql = [];
  const poolSql = [];
  const client = {
    async query(sql) {
      clientSql.push(String(sql));
      if (String(sql).includes('from option_contracts oc join instruments i')) {
        return { rows: [{ contractId: "contract-1", expiryDate: "2026-10-30", strike: 25000, optionType: "CE", symbol: "NIFTY", lotSize: null }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(sql) { poolSql.push(String(sql)); return { rows: [] }; },
    async connect() { return client; },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/shadow", createShadowRouter(pool));
  const server = app.listen(0);
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}/api/shadow`;
    const single = await fetch(`${base}/paper-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "NIFTY", expiry: "2026-10-30", strike: 25000, optionType: "CE", side: "BUY", lots: 1 }),
    });
    assert.equal(single.status, 409);
    assert.equal((await single.json()).error, "OPTION_LOT_SIZE_MISSING");

    const vertical = await fetch(`${base}/paper-strategy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "NIFTY", strategy: "CALL_VERTICAL", legs: [
        { expiry: "2026-10-30", strike: 25000, optionType: "CE", side: "BUY", lots: 1 },
        { expiry: "2026-10-30", strike: 25200, optionType: "CE", side: "SELL", lots: 1 },
      ] }),
    });
    assert.equal(vertical.status, 409);
    assert.equal((await vertical.json()).error, "OPTION_LOT_SIZE_MISSING");
    assert.ok(clientSql.filter(sql => sql.toLowerCase() === "rollback").length >= 2);
    assert.equal(clientSql.some(sql => /insert into (option_paper_trades|paper_option_strategies|paper_option_cash_ledger)|update paper_accounts/i.test(sql)), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    globalThis.Date = RealDate;
  }
}


// Closing either leg of an open vertical closes every remaining leg in one transaction.
{
  const RealDate = globalThis.Date;
  const fixedMillis = new RealDate("2026-10-13T04:30:00.000Z").getTime();
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixedMillis])); }
    static now() { return fixedMillis; }
  }
  globalThis.Date = FixedDate;
  const clientSql = [];
  const legs = [
    { id: "trade-buy", strategy_id: "strategy-1", contract_id: "contract-buy", side: "BUY", quantity: 65, entry_price: 100, entry_fees: 20, margin_reserved: 0 },
    { id: "trade-sell", strategy_id: "strategy-1", contract_id: "contract-sell", side: "SELL", quantity: 65, entry_price: 60, entry_fees: 20, margin_reserved: 0 },
  ];
  const client = {
    async query(sql) {
      const text = String(sql);
      clientSql.push(text);
      if (text.includes("select * from option_paper_trades where id=$1 and status='OPEN' for update")) return { rows: [legs[0]] };
      if (text.includes("select * from option_paper_trades where strategy_id=$1 and status='OPEN'")) return { rows: legs };
      if (text.toLowerCase().includes("to_regclass")) return { rows: [{ name: "public.paper_accounts" }] };
      if (text.includes("select cash from paper_accounts where id=1 for update")) return { rows: [{ cash: 1_000_000 }] };
      return { rows: [] };
    },
    release() {},
  };
  const pool = {
    async query(sql, params = []) {
      if (String(sql).includes("select market_timestamp as timestamp,ltp,bid,ask from option_snapshots")) {
        return { rows: [{ timestamp: new RealDate(fixedMillis), ltp: 80, bid: params[0] === "contract-buy" ? 80 : 40, ask: params[0] === "contract-buy" ? 81 : 41 }] };
      }
      return { rows: [] };
    },
    async connect() { return client; },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/shadow", createShadowRouter(pool));
  const server = app.listen(0);
  try {
    await new Promise(resolve => server.once("listening", resolve));
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/shadow/paper-trades/trade-buy/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "MANUAL" }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify({ result, clientSql }));
    assert.equal(result.strategyId, "strategy-1");
    assert.equal(result.legs.length, 2);
    assert.equal(clientSql.filter(sql => /update option_paper_trades set status='CLOSED'/i.test(sql)).length, 2);
    assert.equal(clientSql.filter(sql => /insert into paper_option_cash_ledger/i.test(sql)).length, 2);
    assert.equal(clientSql.filter(sql => /update paper_option_strategies set status='CLOSED'/i.test(sql)).length, 1);
    assert.equal(clientSql.filter(sql => sql.toLowerCase() === "commit").length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    globalThis.Date = RealDate;
  }
}
