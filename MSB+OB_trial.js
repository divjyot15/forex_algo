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

// ---------------------------------------------------------------------------
// 1) ZigZag swing detector (yours, unchanged in behavior — only addition is
//    that each swing now also carries the candle `index`, since we need that
//    to know *where* a swing happened for structure/OB scanning).
// ---------------------------------------------------------------------------
class ZigZagDetector {
  constructor(length = 9) {
    this.length = length;
    this.trend = 1;
    this.currentHigh = null; // { candle, index }
    this.currentLow = null;  // { candle, index }
  }

  process(candles, index) {
    if (candles.length < this.length) return null;

    const current = candles.at(-1);

    if (!this.currentHigh || current.high > this.currentHigh.candle.high) {
      this.currentHigh = { candle: current, index };
    }
    if (!this.currentLow || current.low < this.currentLow.candle.low) {
      this.currentLow = { candle: current, index };
    }

    const recent = candles.slice(-this.length);
    const highest = Math.max(...recent.map((c) => c.high));
    const lowest = Math.min(...recent.map((c) => c.low));

    const toUp = current.high >= highest;
    const toDown = current.low <= lowest;

    // UP trend ended -> confirmed swing HIGH
    if (this.trend === 1 && toDown) {
      const swing = {
        type: "HIGH",
        price: this.currentHigh.candle.high,
        index: this.currentHigh.index,
        swingTime: this.currentHigh.candle.time,
        detectedAt: current.time,
      };
      this.trend = -1;
      this.currentLow = { candle: current, index };
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
        detectedAt: current.time,
      };
      this.trend = 1;
      this.currentHigh = { candle: current, index };
      this.currentLow = null;
      return swing;
    }

    return null;
  }
}

// ---------------------------------------------------------------------------
// 2) Structure detector — CHOCH + BOS
//
//    Mirrors the Pine script's `market` state machine:
//      - keeps the last two confirmed highs (h0 = latest, h1 = previous)
//      - keeps the last two confirmed lows  (l0 = latest, l1 = previous)
//      - a break is only "confirmed" once it clears the opposite swing by
//        `fibFactor * range` (same as the Pine `fib_factor` input)
//
//    CHOCH = swing breaks AGAINST current bias by more than the threshold
//            (this is the only case the original Pine script detects,
//             labelled "MSB" there)
//    BOS   = swing extends WITH current bias (new higher high in an
//            uptrend / new lower low in a downtrend) — continuation
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
    return this._evaluate();
  }

  _evaluate() {
    const h0 = this.highs.at(-1);
    const h1 = this.highs.at(-2);
    const l0 = this.lows.at(-1);
    const l1 = this.lows.at(-2);
    if (!h0 || !h1 || !l0 || !l1) return null;

    if (this.market === 1) {
      // currently bullish structure
      const range = Math.abs(h0.price - l1.price);
      const brokeDown = l0.price < l1.price && l0.price < l1.price - range * this.fibFactor;

      if (brokeDown) {
        this.market = -1;
        return this._event("CHOCH", "bearish", l1, h0, "bearish"); // Be-OB: l1->h0, want last bullish candle
      }
      if (h0.price > h1.price) {
        return this._event("BOS", "bullish", l0, h0, "bullish"); // Bu-OB: l0->h0, want last bearish candle
      }
    } else {
      // currently bearish structure
      const range = Math.abs(h1.price - l0.price);
      const brokeUp = h0.price > h1.price && h0.price > h1.price + range * this.fibFactor;

      if (brokeUp) {
        this.market = 1;
        return this._event("CHOCH", "bullish", h1, l0, "bullish"); // Bu-OB: h1->l0, want last bearish candle
      }
      if (l0.price < l1.price) {
        return this._event("BOS", "bearish", h0, l0, "bearish"); // Be-OB: h0->l0, want last bullish candle
      }
    }

    return null;
  }

  // obType: "bullish" (demand zone, built from a bearish candle) or
  //         "bearish" (supply zone, built from a bullish candle)
  _event(kind, direction, fromSwing, toSwing, obType) {
    return {
      kind,       // "CHOCH" | "BOS"
      direction,  // "bullish" | "bearish"
      time: toSwing.swingTime,
      obRange: { from: fromSwing.index, to: toSwing.index },
      obType,
    };
  }
}

// ---------------------------------------------------------------------------
// 3) Order block manager
//
//    For a bullish OB, scan the leg for the LAST bearish (red) candle —
//    that candle's high/low is the demand zone.
//    For a bearish OB, scan the leg for the LAST bullish (green) candle —
//    that candle's high/low is the supply zone.
//    (Same idea as the Pine `bu_ob_index` / `be_ob_index` for-loops.)
//
//    Mitigation rules mirror the Pine box loops at the bottom of the script:
//      - price closes fully through the zone      -> invalidated
//      - price closes back inside the zone         -> mitigated (alert)
//      - otherwise                                  -> zone stays active
// ---------------------------------------------------------------------------
class OrderBlockManager {
  constructor() {
    this.orderBlocks = [];
  }

  create(candles, fromIndex, toIndex, obType, label) {
    const lo = Math.min(fromIndex, toIndex);
    const hi = Math.max(fromIndex, toIndex);
    const wantBearishCandle = obType === "bullish"; // demand zone <- red candle

    let found = null;
    for (let i = lo; i <= hi; i++) {
      const c = candles[i];
      if (!c) continue;
      const isBearishCandle = c.close < c.open;
      const isBullishCandle = c.close > c.open;
      if (wantBearishCandle && isBearishCandle) found = c;
      if (!wantBearishCandle && isBullishCandle) found = c;
    }
    if (!found) return null;

    const ob = {
      label,
      obType, // "bullish" | "bearish"
      high: found.high,
      low: found.low,
      time: found.time,
      active: true,
      mitigated: false,
    };
    this.orderBlocks.push(ob);
    return ob;
  }

  update(candle) {
    const alerts = [];
    for (const ob of this.orderBlocks) {
      if (!ob.active) continue;

      if (ob.obType === "bullish") {
        if (candle.close < ob.low) {
          ob.active = false;
          alerts.push({ ob, type: "invalidated" });
        } else if (candle.close < ob.high) {
          ob.mitigated = true;
          alerts.push({ ob, type: "price in bullish OB zone" });
        }
      } else {
        if (candle.close > ob.high) {
          ob.active = false;
          alerts.push({ ob, type: "invalidated" });
        } else if (candle.close > ob.low) {
          ob.mitigated = true;
          alerts.push({ ob, type: "price in bearish OB zone" });
        }
      }
    }
    return alerts;
  }
}

// ---------------------------------------------------------------------------
// 4) Wire it all together
// ---------------------------------------------------------------------------
async function main() {
  const zigzag = new ZigZagDetector(9);
  const structure = new StructureDetector(0.33);
  const obManager = new OrderBlockManager();

  const candles = await getHistoricalCandles();

  const swings = [];
  const structureEvents = [];

  for (let i = 0; i < candles.length; i++) {
    const history = candles.slice(0, i + 1);

    // 1) swing detection
    const swing = zigzag.process(history, i);
    if (swing) {
      swings.push(swing);
      console.log(
        swing.type,
        swing.price,
        toIST(swing.swingTime),
        toIST(swing.detectedAt),
      );

      // 2) structure detection (CHOCH / BOS)
      const event = structure.addSwing(swing);
      if (event) {
        const label =
          event.kind === "CHOCH"
            ? event.direction === "bullish"
              ? "CHOCH ↑ (bullish)"
              : "CHOCH ↓ (bearish)"
            : event.direction === "bullish"
              ? "BOS ↑ (bullish)"
              : "BOS ↓ (bearish)";

        structureEvents.push({
          ...event,
          label,
          time: toIST(event.time),
        });

        console.log(`⚡ ${label} @ ${toIST(event.time)}`);

        // 3) order block creation on the leg that produced this event
        const ob = obManager.create(
          candles,
          event.obRange.from,
          event.obRange.to,
          event.obType,
          `${event.kind}-${event.obType === "bullish" ? "Bu-OB" : "Be-OB"}`,
        );
        if (ob) {
          console.log(
            `   📦 ${ob.label} zone: ${ob.low} - ${ob.high} (candle @ ${toIST(ob.time)})`,
          );
        }
      }
    }

    // 4) check mitigation / invalidation of active order blocks every bar
    const alerts = obManager.update(candles[i]);
    for (const a of alerts) {
      console.log(`   🔔 ${a.ob.label}: ${a.type} at ${toIST(candles[i].time)}`);
    }
  }

  console.log("\n--- Swings ---");
  console.table(swings.map((s) => ({ ...s, swingTime: toIST(s.swingTime), detectedAt: toIST(s.detectedAt) })));

  console.log("\n--- Structure Events (CHOCH / BOS) ---");
  console.table(structureEvents);

  console.log("\n--- Order Blocks ---");
  console.table(
    obManager.orderBlocks.map((ob) => ({
      label: ob.label,
      obType: ob.obType,
      low: ob.low,
      high: ob.high,
      time: toIST(ob.time),
      active: ob.active,
      mitigated: ob.mitigated,
    })),
  );
}

main();