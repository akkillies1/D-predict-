import assert from "node:assert/strict";
import { orderOptionStrategyLegs } from "../dist/shadowRoutes.js";

const long = { id: "long", side: "BUY" };
const short = { id: "short", side: "SELL" };

for (const requestOrder of [[long, short], [short, long]]) {
  const ordered = orderOptionStrategyLegs(requestOrder);
  assert.deepEqual(ordered.map((leg) => leg.side), ["SELL", "BUY"]);
  assert.deepEqual(ordered.map((leg) => leg.id), ["short", "long"]);
  // Sorting must not mutate the client/request order used for the response.
  assert.deepEqual(requestOrder.map((leg) => leg.id), requestOrder[0].id === "long" ? ["long", "short"] : ["short", "long"]);
}

console.log("option spread cash-order tests passed");
