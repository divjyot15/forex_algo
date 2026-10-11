import test from "node:test";
import assert from "node:assert/strict";
import { FVGTracker, StructureDetector } from "../src/strategy/marketStructure.js";
import { FiveMinuteEntryWatcher } from "../src/strategy/fiveMinuteEntryWatcher.js";

test("FVG tracker confirms a bullish gap only after the third candle", () => {
  const tracker = new FVGTracker();
  const candles = [
    { time: "2026-09-01T00:00:00.000Z", open: 100, high: 105, low: 98, close: 102 },
    { time: "2026-09-01T00:05:00.000Z", open: 103, high: 110, low: 102, close: 108 },
    { time: "2026-09-01T00:10:00.000Z", open: 109, high: 114, low: 107, close: 112 }
  ];

  assert.equal(tracker.onCandle(candles[0], 0), null);
  assert.equal(tracker.onCandle(candles[1], 1), null);
  const confirmed = tracker.onCandle(candles[2], 2);

  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].obType, "bullish");
  assert.equal(confirmed[0].index, 0);
  assert.equal(confirmed[0].confirmationIndex, 2);
});

test("structure detector classifies lower highs and lower lows as bearish", () => {
  const detector = new StructureDetector();
  const add = (type, price, index) => detector.addSwing({ type, price, index, swingTime: `${index}`, detectedAt: `${index}` });

  assert.equal(add("HIGH", 110, 0).classification, "HIGH");
  assert.equal(add("LOW", 100, 1).classification, "LOW");
  assert.equal(add("HIGH", 105, 2).classification, "LH");
  assert.equal(add("LOW", 95, 3).classification, "LL");
  assert.equal(detector.structure, "bearish");
});

test("entry watcher waits past FVG confirmation and signals once per parent", () => {
  const watcher = new FiveMinuteEntryWatcher();
  const parent = {
    id: 7,
    label: "Swing-Bu-OB",
    status: "active",
    low: 99,
    high: 110,
    overlapping5mOBs: [
      { index: 0, confirmationIndex: 3, obType: "bullish", low: 100, high: 105, time: "t0" },
      { index: 1, confirmationIndex: 3, obType: "bullish", low: 101, high: 106, time: "t1" }
    ]
  };
  watcher.registerFromParent(parent);

  watcher.onCandle({ index: 3, time: "t3", open: 108, high: 109, low: 104, close: 106 });
  assert.equal(watcher.zones[0].status, "active");

  const alerts = watcher.onCandle({ index: 4, time: "t4", open: 105, high: 110, low: 104, close: 109 });
  const signals = alerts.filter(alert => alert.type === "BUY_SIGNAL");
  assert.equal(signals.length, 1);
  assert.equal(signals[0].zone.parentOBId, 7);
  assert.equal(signals[0].zone.pattern, "Bullish Engulfing");
});