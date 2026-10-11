import dotenv from "dotenv";
dotenv.config();
import { getConnection, getAccount, initConnection } from "./src/connection/metaapi.js";

let connection = await initConnection();

const getHistoricalCandles = async () => {
  try {
    console.log("⏳ Connecting to MT5 via MetaApi...");
    const account = getAccount();
    console.log("Connected");
    const candles = await account.getHistoricalCandles(
      "XAUUSD",
      "15m",
      new Date(),
    );
    console.log("candles", candles);
    return candles;
  } catch (err) {
    console.error(err.stack);
  }
};

function toIST(date) {
  return new Date(date).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

// =============================================================================
// LIVE-SIMULATION ARCHITECTURE
//
// Every detector below exposes a single `onCandle(candle, index)` method and
// keeps only the small rolling state it actually needs. None of them ever
// reach forward into candles that haven't "arrived" yet, so the exact same
// code path works for backtesting (loop over history) and live trading
// (call onCandle() from your feed callback the instant a candle closes).
// =============================================================================

// ---------------------------------------------------------------------------
// 1) ZigZag swing detector — streaming version
// ---------------------------------------------------------------------------
class ZigZagDetector {
  constructor(length = 9) {
    this.length = length;
    this.trend = 1;
    this.currentHigh = null; // { candle, index }
    this.currentLow = null;  // { candle, index }
    this.window = [];        // rolling buffer, max size = length
  }

  onCandle(candle, index) {
    this.window.push(candle);
    if (this.window.length > this.length) this.window.shift();
    if (this.window.length < this.length) return null; // not enough history yet

    if (!this.currentHigh || candle.high > this.currentHigh.candle.high) {
      this.currentHigh = { candle, index };
    }
    if (!this.currentLow || candle.low < this.currentLow.candle.low) {
      this.currentLow = { candle, index };
    }

    const highest = Math.max(...this.window.map((c) => c.high));
    const lowest = Math.min(...this.window.map((c) => c.low));

    const toUp = candle.high >= highest;
    const toDown = candle.low <= lowest;

    // UP trend ended -> confirmed swing HIGH
    if (this.trend === 1 && toDown) {
      const swing = {
        type: "HIGH",
        price: this.currentHigh.candle.high,
        index: this.currentHigh.index,
        swingTime: this.currentHigh.candle.time,
        detectedAt: candle.time,
      };
      this.trend = -1;
      this.currentLow = { candle, index };
      this.currentHigh = null;
      return swing;
    }

    // DOWN trend ended -> confirmed swing LOW
    if (this.trend === -1 && toUp) {
      const swing = {
        type: "LOW",
        price: this.currentLow.candle.low,
        index: this.currentLow.index,
        swingTime: this.currentLow.candle.time,
        detectedAt: candle.time,
      };
      this.trend = 1;
      this.currentHigh = { candle, index };
      this.currentLow = null;
      return swing;
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// 2) Structure detector — CHOCH + BOS
//    Now also reports `triggerSwingIndex` — the index of the swing (h0/l0)
//    that actually caused the break. This is what "wait for the next high"
//    gets measured against downstream, NOT the OB candle's own index.
// ---------------------------------------------------------------------------
class StructureDetector {
  constructor(fibFactor = 0.33) {
    this.fibFactor = fibFactor;
    this.market = 1; // 1 = bullish structure, -1 = bearish structure
    this.highs = [];
    this.lows = [];
  }

  addSwing(swing) {
    if (swing.type === "HIGH") this.highs.push(swing);
    else this.lows.push(swing);
    return this._evaluate(swing);
  }

  _evaluate(newSwing) {
    const h0 = this.highs.at(-1);
    const h1 = this.highs.at(-2);
    const l0 = this.lows.at(-1);
    const l1 = this.lows.at(-2);
    if (!h0 || !h1 || !l0 || !l1) return null;

    if (this.market === 1) {
      const range = Math.abs(h0.price - l1.price);
      const brokeDown = l0.price < l1.price && l0.price < l1.price - range * this.fibFactor;
      if (newSwing.type === "LOW") {
        if (brokeDown) {
          this.market = -1;
          return this._event("CHOCH", "bearish", l1, h0, "bearish");
        }
      }
      if (newSwing.type === "HIGH") {
        if (h0.price > h1.price) {
          return this._event("BOS", "bullish", l0, h0, "bullish");
        }
      }
    } else {
      const range = Math.abs(h1.price - l0.price);
      const brokeUp = h0.price > h1.price && h0.price > h1.price + range * this.fibFactor;
      if (newSwing.type === "HIGH") {
        if (brokeUp) {
          this.market = 1;
          return this._event("CHOCH", "bullish", h1, l0, "bullish");
        }
      }
      if (newSwing.type === "LOW") {
        if (l0.price < l1.price) {
          return this._event("BOS", "bearish", h0, l0, "bearish");
        }
      }
    }

    return null;
  }

  _event(kind, direction, fromSwing, toSwing, obType) {
    return {
      kind,                         // "CHOCH" | "BOS"
      direction,                    // "bullish" | "bearish"
      time: toSwing.swingTime,
      obRange: { from: fromSwing.index, to: toSwing.index },
      obType,                       // "bullish" (demand) | "bearish" (supply)
      triggerSwingIndex: toSwing.index, // the h0/l0 that CAUSED this event
      triggerPrice: toSwing.price,      // the h0/l0 PRICE LEVEL — used for live arming, see OrderBlockManager
    };
  }
}

// ---------------------------------------------------------------------------
// 3) FVG tracker — streaming Fair Value Gap detection (causal, no lookahead)
// ---------------------------------------------------------------------------
function isBearishCandle(c) {
  return c.close < c.open;
}
function isBullishCandle(c) {
  return c.close > c.open;
}

class FVGTracker {
  constructor(maxPoolSize = 2000) {
    this.window = [];       // rolling last 3 candles
    this.confirmed = [];    // growing pool of confirmed FVG/OB candidates
    this.maxPoolSize = maxPoolSize;
  }

  onCandle(candle, index) {
    this.window.push({ candle, index });
    if (this.window.length > 3) this.window.shift();
    if (this.window.length < 3) return null;

    const [c0, , c2] = this.window; // c0 = OB candidate, c2 = confirmation candle
    const found = [];

    if (c2.candle.low > c0.candle.high) found.push(this._makeCandidate(c0, "bullish"));
    if (c2.candle.high < c0.candle.low) found.push(this._makeCandidate(c0, "bearish"));

    if (found.length) {
      this.confirmed.push(...found);
      if (this.confirmed.length > this.maxPoolSize) {
        this.confirmed.splice(0, this.confirmed.length - this.maxPoolSize);
      }
    }

    return found.length ? found : null;
  }

  _makeCandidate({ candle, index }, obType) {
    return {
      index,
      high: candle.high,
      low: candle.low,
      time: candle.time,
      obType,
      candleColor: isBullishCandle(candle) ? "bullish" : isBearishCandle(candle) ? "bearish" : "doji",
    };
  }

  findInRange(fromIndex, toIndex, obType) {
    const lo = Math.min(fromIndex, toIndex);
    const hi = Math.max(fromIndex, toIndex);
    let best = null;
    return this.confirmed.filter(c =>
      c.obType === obType &&
      c.index >= lo &&
      c.index <= hi
    );
  }
}

// ---------------------------------------------------------------------------
// 4) Candlestick reversal patterns
//
//    Classic morning/evening star definitions require a price GAP around the
//    middle "star" candle. XAUUSD / FX markets trade near-continuously on
//    15m candles, so true gaps are rare — we use the practical substitute
//    every SMC/price-action indicator uses instead: a small-bodied middle
//    candle, followed by a candle that closes deep into (past the midpoint
//    of) the first candle's body. Swap in a strict gap check if you trade
//    an instrument that actually gaps (stocks, indices at the open, etc).
// ---------------------------------------------------------------------------
function isBullishEngulfing(prev, curr) {
  const prevBearish = prev.close < prev.open;
  const currBullish = curr.close > curr.open;
  if (!prevBearish || !currBullish) return false;
  return curr.open <= prev.close && curr.close >= prev.open;
}

function isBearishEngulfing(prev, curr) {
  const prevBullish = prev.close > prev.open;
  const currBearish = curr.close < curr.open;
  if (!prevBullish || !currBearish) return false;
  return curr.open >= prev.close && curr.close <= prev.open;
}

function isMorningStar(c1, c2, c3) {
  const c1Bearish = c1.close < c1.open;
  const c3Bullish = c3.close > c3.open;
  if (!c1Bearish || !c3Bullish) return false;
  const c1Body = Math.abs(c1.open - c1.close);
  const c2Body = Math.abs(c2.open - c2.close);
  const smallStar = c2Body < c1Body * 0.5;
  const c1Mid = (c1.open + c1.close) / 2;
  const closesIntoC1 = c3.close > c1Mid;
  return smallStar && closesIntoC1;
}

function isEveningStar(c1, c2, c3) {
  const c1Bullish = c1.close > c1.open;
  const c3Bearish = c3.close < c3.open;
  if (!c1Bullish || !c3Bearish) return false;
  const c1Body = Math.abs(c1.open - c1.close);
  const c2Body = Math.abs(c2.open - c2.close);
  const smallStar = c2Body < c1Body * 0.5;
  const c1Mid = (c1.open + c1.close) / 2;
  const closesIntoC1 = c3.close < c1Mid;
  return smallStar && closesIntoC1;
}

// ---------------------------------------------------------------------------
// 5) Order block manager — the full strategy state machine
//
//        active  --(live price clears the trigger level)-->  armed
//        armed   --(price wicks back into the zone)-->        touched
//        touched --(reversal pattern confirms)-->              signal  <-- BUY/SELL trigger
//        (any of the above) --(close breaks clean through)--> invalidated
//
//    "active"  : OB just created, but continuation hasn't been confirmed
//                yet — we are NOT watching for touches at this stage.
//    "armed"   : price has traded beyond the level that created this OB
//                (candle.high > the h0 price for a bullish OB, or
//                candle.low < the l0 price for a bearish OB). This is your
//                "wait for the next high" condition.
//
//                IMPORTANT: this is checked against RAW PRICE on every
//                candle, not against the zigzag's confirmed swing. The
//                zigzag only confirms a swing HIGH once price later breaks
//                a 9-candle low (`toDown`) — that confirmation can lag many
//                candles behind the actual high. If arming waited for that
//                confirmation, price could already have touched the OB and
//                moved on *before* the swing was ever confirmed, and the
//                touch would be silently missed. Using the live price
//                instead means arming fires the SAME candle price clears
//                the level — no lag, no missed entries.
//    "touched" : price has wicked back into the OB while armed. Now we
//                watch every new candle for a reversal pattern.
//    "signal"  : a Morning Star or Bullish Engulfing (bullish OB) / Evening
//                Star or Bearish Engulfing (bearish OB) has completed while
//                touched. This is the actual trade trigger.
//    "invalidated": at ANY stage, price closes clean through the zone the
//                wrong way -> the setup is dead, no further alerts.
// ---------------------------------------------------------------------------
class OrderBlockManager {
  constructor() {
    this.orderBlocks = [];
    this.recentCandles = [];
  }

  /**
   * Called whenever a NEW BOS/CHoCH is confirmed.
   * Starts a fresh trading context.
   */
  register(candidates, label, triggerPrice) {
    // New structure = old OBs are irrelevant
    this.orderBlocks = [];

    if (!candidates || candidates.length === 0)
      return [];

    // Newest first
    candidates.sort((a, b) => b.index - a.index);

    const registered = candidates.map((candidate, idx) => ({
      ...candidate,
      label,
      triggerPrice,

      // only newest is active
      status: idx === 0 ? "active" : "waiting",

      armedAt: null,
      touchedAt: null,
      signalAt: null,
      pattern: null
    }));

    this.orderBlocks = registered;

    return registered;
  }

  /**
   * Promote next waiting OB after invalidation.
   */
  _activateNextOB() {
    const next = this.orderBlocks.find(
      ob => ob.status === "waiting"
    );

    if (next) {
      next.status = "active";
    }
  }

  onCandle(candle) {
    this.recentCandles.push(candle);

    if (this.recentCandles.length > 3)
      this.recentCandles.shift();

    const alerts = [];

    // Only ONE OB is evaluated
    const ob = this.orderBlocks.find(ob =>
      ob.status === "active" ||
      ob.status === "armed" ||
      ob.status === "touched"
    );

    if (!ob)
      return alerts;

    if (ob.obType === "bullish") {

      //--------------------------------------
      // INVALIDATION
      //--------------------------------------

      if (candle.close < ob.low) {

        ob.status = "invalidated";

        alerts.push({
          ob,
          type: "invalidated",
          note: "Closed below bullish OB."
        });

        this._activateNextOB();

        return alerts;
      }

      //--------------------------------------
      // ARM
      //--------------------------------------

      if (
        ob.status === "active" &&
        candle.high > ob.triggerPrice
      ) {

        ob.status = "armed";

        ob.armedAt = candle.time;

        alerts.push({
          ob,
          type: "armed",
          note: `Price cleared prior high (${ob.triggerPrice}).`
        });
      }

      //--------------------------------------
      // TOUCH
      //--------------------------------------

      if (
        ob.status === "armed" &&
        candle.low <= ob.high
      ) {

        ob.status = "touched";

        ob.touchedAt = candle.time;

        alerts.push({
          ob,
          type: "touched",
          note: "Returned to bullish OB."
        });
      }

      //--------------------------------------
      // SIGNAL
      //--------------------------------------

      if (ob.status === "touched") {

        const pattern = this._detectBullishPattern();

        if (pattern) {

          ob.status = "signal";

          ob.signalAt = candle.time;

          ob.pattern = pattern;

          alerts.push({
            ob,
            type: "BUY_SIGNAL",
            note: `${pattern} confirmed.`
          });
        }
      }

    } else {

      //--------------------------------------
      // INVALIDATION
      //--------------------------------------

      if (candle.close > ob.high) {

        ob.status = "invalidated";

        alerts.push({
          ob,
          type: "invalidated",
          note: "Closed above bearish OB."
        });

        this._activateNextOB();

        return alerts;
      }

      //--------------------------------------
      // ARM
      //--------------------------------------

      if (
        ob.status === "active" &&
        candle.low < ob.triggerPrice
      ) {

        ob.status = "armed";

        ob.armedAt = candle.time;

        alerts.push({
          ob,
          type: "armed",
          note: `Price cleared prior low (${ob.triggerPrice}).`
        });
      }

      //--------------------------------------
      // TOUCH
      //--------------------------------------

      if (
        ob.status === "armed" &&
        candle.high >= ob.low
      ) {

        ob.status = "touched";

        ob.touchedAt = candle.time;

        alerts.push({
          ob,
          type: "touched",
          note: "Returned to bearish OB."
        });
      }

      //--------------------------------------
      // SIGNAL
      //--------------------------------------

      if (ob.status === "touched") {

        const pattern = this._detectBearishPattern();

        if (pattern) {

          ob.status = "signal";

          ob.signalAt = candle.time;

          ob.pattern = pattern;

          alerts.push({
            ob,
            type: "SELL_SIGNAL",
            note: `${pattern} confirmed.`
          });
        }
      }
    }

    return alerts;
  }

  _detectBullishPattern() {
    const n = this.recentCandles.length;

    if (n >= 2) {
      const [prev, curr] = this.recentCandles.slice(-2);

      if (isBullishEngulfing(prev, curr))
        return "Bullish Engulfing";
    }

    if (n >= 3) {
      const [c1, c2, c3] = this.recentCandles.slice(-3);

      if (isMorningStar(c1, c2, c3))
        return "Morning Star";
    }

    return null;
  }

  _detectBearishPattern() {
    const n = this.recentCandles.length;

    if (n >= 2) {
      const [prev, curr] = this.recentCandles.slice(-2);

      if (isBearishEngulfing(prev, curr))
        return "Bearish Engulfing";
    }

    if (n >= 3) {
      const [c1, c2, c3] = this.recentCandles.slice(-3);

      if (isEveningStar(c1, c2, c3))
        return "Evening Star";
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// 6) Engine — the single entry point for "one candle at a time"
// ---------------------------------------------------------------------------
class MarketStructureEngine {
  constructor({ zigzagLength = 9, fibFactor = 0.33 } = {}) {
    this.zigzag = new ZigZagDetector(zigzagLength);
    this.structure = new StructureDetector(fibFactor);
    this.fvg = new FVGTracker();
    this.obManager = new OrderBlockManager();
    this.index = -1;
  }

  onCandle(candle) {
    this.index += 1;
    const index = this.index;

    this.fvg.onCandle(candle, index);
    const swing = this.zigzag.onCandle(candle, index);

    let structureEvent = null;
    let newOB = null;

    if (swing) {
      structureEvent = this.structure.addSwing(swing);
      if (structureEvent) {
        const candidates = this.fvg.findInRange(
          structureEvent.obRange.from,
          structureEvent.obRange.to,
          structureEvent.obType,
        );

        const label = `${structureEvent.kind}-${structureEvent.obType === "bullish" ? "Bu-OB" : "Be-OB"}`;

        newOB = this.obManager.register(
          candidates,
          label,
          structureEvent.triggerPrice
        );
      }
    }

    const obAlerts = this.obManager.onCandle(candle);

    return { index, swing, structureEvent, newOB, obAlerts };
  }
}

// ---------------------------------------------------------------------------
// 7) Replay loop (swap this for a live feed callback and nothing above changes)
// ---------------------------------------------------------------------------
async function main() {
  const engine = new MarketStructureEngine({ zigzagLength: 5, fibFactor: 0.33 });

  const candles = await getHistoricalCandles();

  const swings = [];
  const structureEvents = [];
  const signals = [];

  for (const candle of candles) {
    // --- in a live system, this whole block IS your feed's "on candle" handler ---
    const { swing, structureEvent, newOB, obAlerts } = engine.onCandle(candle);

    if (swing) {
      swings.push(swing);
      console.log(swing.type, swing.price, toIST(swing.swingTime), toIST(swing.detectedAt));
    }

    if (structureEvent) {
      const label =
        structureEvent.kind === "CHOCH"
          ? structureEvent.direction=== "bullish" ? "CHOCH ↑ (bullish)" : "CHOCH ↓ (bearish)"
          : structureEvent.direction === "bullish" ? "BOS ↑ (bullish)" : "BOS ↓ (bearish)";

      structureEvents.push({ ...structureEvent, label, time: toIST(structureEvent.time) });
      console.log(`⚡ ${label} @ ${toIST(structureEvent.time)}`);

     if (newOB.length > 0) {

        newOB.forEach((ob, index) => {
          console.log(
            `   📦 OB ${index + 1}/${newOB.length}: ${ob.label} zone: ${ob.low} - ${ob.high} (candle @ ${toIST(ob.time)}) — status: ${ob.status}`
          );
        });

      } else {
        console.log(`   (no valid FVG-confirmed OB found in this leg)`);
      }
    }

    for (const a of obAlerts) {
      const marker =
        a.type === "BUY_SIGNAL" ? "🟢" :
        a.type === "SELL_SIGNAL" ? "🔴" :
        a.type === "invalidated" ? "⚫" :
        a.type === "armed" ? "🟡" : "🔔";
      console.log(`   ${marker} ${a.ob.label} [${a.type}]: ${a.note} — ${toIST(candle.time)}`);
      if (a.type === "BUY_SIGNAL" || a.type === "SELL_SIGNAL") signals.push({ ...a.ob, alertType: a.type, time: toIST(candle.time) });
    }
    // --- end of live-handler-equivalent block ---
  }

  console.log("\n--- Swings ---");
  console.table(swings.map((s) => ({ ...s, swingTime: toIST(s.swingTime), detectedAt: toIST(s.detectedAt) })));

  console.log("\n--- Structure Events (CHOCH / BOS) ---");
  console.table(structureEvents);

  console.log("\n--- Order Blocks ---");
  console.table(
    engine.obManager.orderBlocks.map((ob) => ({
      label: ob.label,
      obType: ob.obType,
      low: ob.low,
      high: ob.high,
      triggerPrice: ob.triggerPrice,
      status: ob.status,
      armedAt: ob.armedAt ? toIST(ob.armedAt) : "-",
      touchedAt: ob.touchedAt ? toIST(ob.touchedAt) : "-",
      pattern: ob.pattern ?? "-",
      signalAt: ob.signalAt ? toIST(ob.signalAt) : "-",
    })),
  );

  console.log("\n--- 🎯 Trade Signals ---");
  console.table(signals.map((s) => ({ label: s.label, alertType: s.alertType, zone: `${s.low} - ${s.high}`, pattern: s.pattern, time: s.time })));
}

main();