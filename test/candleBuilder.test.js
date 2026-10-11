import test from "node:test";
import assert from "node:assert/strict";
import { handleTick, onCandle } from "../src/services/candleBuilder.js";

test("handleTick waits for asynchronous processing of a completed M5 candle", async t => {
  let receivedCandle = null;
  let listenerFinished = false;
  const unsubscribe = onCandle(async (timeframe, candle) => {
    if (timeframe !== "M5") return;
    await new Promise(resolve => setTimeout(resolve, 5));
    receivedCandle = candle;
    listenerFinished = true;
  });
  t.after(unsubscribe);

  const tick = (brokerTime, bid) => handleTick({
    symbol: "XAUUSD",
    brokerTime,
    bid,
    ask: bid + 0.2
  });

  await tick("2026-09-01 00:01:00", 100);
  await tick("2026-09-01 00:06:04", 101);
  assert.equal(receivedCandle, null);

  await tick("2026-09-01 00:10:04", 102);
  assert.equal(listenerFinished, true);
  assert.equal(receivedCandle.time, "2026-09-01T00:05:00.000Z");
  assert.equal(receivedCandle.open, 101);
});