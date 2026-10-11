import dotenv from "dotenv";
dotenv.config();

import {
  getConnection,
  getAccount,
  initConnection
} from "./src/connection/metaapi.js";

let connection = await initConnection();


// =============================================================================
// HISTORICAL CANDLES
// =============================================================================

const getHistoricalCandles = async () => {
  try {
    console.log("⏳ Connecting to MT5 via MetaApi...");

    const account = getAccount();

    console.log("Connected");

    const from = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000
    );

    const candles = await account.getHistoricalCandles(
      "XAUUSD",
      "15m",
      from
    );

    console.log(`Received ${candles?.length ?? 0} candles`);

    return candles;

  } catch (err) {
    console.error(err.stack);
    return [];
  }
};


// =============================================================================
// TIME HELPERS
// =============================================================================

function toIST(date) {
  return new Date(date).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}


// =============================================================================
// 1) ZIGZAG SWING DETECTOR
// =============================================================================
//
// ZigZag is ONLY responsible for establishing swings.
//
// It does NOT decide:
// - BOS
// - CHOCH
// - market structure
//
// A swing is confirmed only when price reverses enough to establish the
// opposite leg.
//
// IMPORTANT:
// - One candle can NEVER contain both HIGH and LOW swings.
// - Duplicate swing indexes are ignored.
// =============================================================================

class ZigZagDetector {

  constructor(length = 9) {

    this.length = length;

    this.trend = 1;

    this.currentHigh = null;
    this.currentLow = null;

    this.window = [];
  }


  onCandle(candle, index) {

    const previousWindow = [...this.window];

    this.window.push({
      candle,
      index
    });

    if (this.window.length > this.length) {
      this.window.shift();
    }

    if (previousWindow.length < this.length - 1) {
      return null;
    }


    // =========================================================================
    // UPWARD LEG
    // =========================================================================

    if (this.trend === 1) {

      if (
        !this.currentHigh ||
        candle.high > this.currentHigh.candle.high
      ) {

        this.currentHigh = {
          candle,
          index
        };
      }


      const previousLowest =
        Math.min(
          ...previousWindow.map(
            item => item.candle.low
          )
        );


      const toDown =
        candle.low < previousLowest;


      if (
        toDown &&
        this.currentHigh
      ) {

        const swing = {

          type: "HIGH",

          price:
            this.currentHigh.candle.high,

          index:
            this.currentHigh.index,

          swingTime:
            this.currentHigh.candle.time,

          detectedAt:
            candle.time
        };


        this.trend = -1;

        this.currentLow = null;
        this.currentHigh = null;

        return swing;
      }


      return null;
    }


    // =========================================================================
    // DOWNWARD LEG
    // =========================================================================

    if (this.trend === -1) {

      if (
        !this.currentLow ||
        candle.low < this.currentLow.candle.low
      ) {

        this.currentLow = {
          candle,
          index
        };
      }


      const previousHighest =
        Math.max(
          ...previousWindow.map(
            item => item.candle.high
          )
        );


      const toUp =
        candle.high > previousHighest;


      if (
        toUp &&
        this.currentLow
      ) {

        const swing = {

          type: "LOW",

          price:
            this.currentLow.candle.low,

          index:
            this.currentLow.index,

          swingTime:
            this.currentLow.candle.time,

          detectedAt:
            candle.time
        };


        this.trend = 1;

        this.currentHigh = null;
        this.currentLow = null;

        return swing;
      }


      return null;
    }


    return null;
  }
}



// =============================================================================
// 2) STRUCTURE DETECTOR
// =============================================================================
//
// ZigZag establishes swings.
//
// StructureDetector classifies:
//
// HIGH -> HH / LH
// LOW  -> HL / LL
//
// BOS / CHOCH is NOT created when a swing is confirmed.
//
// BOS / CHOCH is created only when a CLOSED CANDLE closes beyond the
// protected structural level.
//
// WICK BREAKS DO NOT COUNT.
//
// IMPORTANT STRUCTURE RULE:
//
// Bullish structure:
//
//     HH
//      |
//     HL  <- protected low
//
// BOS bullish:
//
//     candle.close > protected HH
//
// CHOCH bearish:
//
//     candle.close < protected HL
//
// Bearish structure:
//
//     LH  <- protected high
//      |
//     LL
//
// BOS bearish:
//
//     candle.close < protected LL
//
// CHOCH bullish:
//
//     candle.close > protected LH
// =============================================================================

class StructureDetector {

  constructor() {

    this.swings = [];

    this.lastHigh = null;
    this.lastLow = null;

    this.lastHH = null;
    this.lastHL = null;

    this.lastLH = null;
    this.lastLL = null;

    this.structure = null;

    this.protectedHigh = null;
    this.protectedLow = null;

    this.lastEvent = null;

    this.brokenLevelIndex = null;

    this.eventSequence = 0;
  }


  // ===========================================================================
  // ADD CONFIRMED ZIGZAG SWING
  //
  // This DOES NOT create BOS / CHOCH.
  // ===========================================================================

  addSwing(swing) {

    if (!swing) {
      return null;
    }


    // -------------------------------------------------------------------------
    // Prevent duplicate swing index
    // -------------------------------------------------------------------------

    const alreadyExists =
      this.swings.some(
        s => s.index === swing.index
      );


    if (alreadyExists) {
      return null;
    }


    // -------------------------------------------------------------------------
    // HIGH and LOW cannot exist on same candle
    // -------------------------------------------------------------------------

    const sameCandle =
      this.swings.some(
        s =>
          s.index === swing.index &&
          s.type !== swing.type
      );


    if (sameCandle) {

      console.warn(
        `⚠️ Ignoring ${swing.type} swing at index ${swing.index} ` +
        `because another swing already exists on this candle.`
      );

      return null;
    }


    this.swings.push(swing);


    // =========================================================================
    // HIGH
    // =========================================================================

    if (swing.type === "HIGH") {

      return this._processHigh(swing);
    }


    // =========================================================================
    // LOW
    // =========================================================================

    if (swing.type === "LOW") {

      return this._processLow(swing);
    }


    return null;
  }



  // ===========================================================================
  // PROCESS HIGH
  // ===========================================================================

  _processHigh(swing) {

    let classification = "HIGH";

    const previousHigh =
      this.lastHigh;


    if (previousHigh) {

      if (
        swing.price >
        previousHigh.price
      ) {

        classification = "HH";

      } else {

        classification = "LH";
      }
    }


    swing.classification =
      classification;


    this.lastHigh =
      swing;


    // =========================================================================
    // HIGHER HIGH
    // =========================================================================

    if (
      classification === "HH"
    ) {

      this.lastHH =
        swing;


      if (this.lastHL) {

        this.structure =
          "bullish";


        // In bullish structure the latest HH is the level that can be
        // broken for bullish BOS.

        this.protectedHigh =
          swing;
      }
    }


    // =========================================================================
    // LOWER HIGH
    // =========================================================================

    else if (
      classification === "LH"
    ) {

      this.lastLH =
        swing;


      if (this.lastLL) {

        this.structure =
          "bearish";


        // In bearish structure the latest LH is the level that can be
        // broken for bullish CHOCH.

        this.protectedHigh =
          swing;
      }
    }


    return {

      type:
        "SWING_CLASSIFICATION",

      swing,

      classification,

      previousHigh,

      structure:
        this.structure
    };
  }



  // ===========================================================================
  // PROCESS LOW
  // ===========================================================================

  _processLow(swing) {

    let classification = "LOW";

    const previousLow =
      this.lastLow;


    if (previousLow) {

      if (
        swing.price >
        previousLow.price
      ) {

        classification = "HL";

      } else {

        classification = "LL";
      }
    }


    swing.classification =
      classification;


    this.lastLow =
      swing;


    // =========================================================================
    // HIGHER LOW
    // =========================================================================

    if (
      classification === "HL"
    ) {

      this.lastHL =
        swing;


      if (this.lastHH) {

        this.structure =
          "bullish";


        // In bullish structure the latest HL is the protected low.

        this.protectedLow =
          swing;
      }
    }


    // =========================================================================
    // LOWER LOW
    // =========================================================================

    else if (
      classification === "LL"
    ) {

      this.lastLL =
        swing;


      if (this.lastLH) {

        this.structure =
          "bearish";


        // In bearish structure the latest LL is the level that can be
        // broken for bearish BOS.

        this.protectedLow =
          swing;
      }
    }


    return {

      type:
        "SWING_CLASSIFICATION",

      swing,

      classification,

      previousLow,

      structure:
        this.structure
    };
  }



  // ===========================================================================
  // PROCESS EVERY CLOSED CANDLE
  //
  // BOS / CHOCH is based on CANDLE CLOSE.
  //
  // WICK THROUGH LEVEL DOES NOT COUNT.
  //
  // A single candle can create only ONE structure event.
  // ===========================================================================

  onCandle(candle, index) {

    const events = [];


    // =========================================================================
    // NO STRUCTURE YET
    // =========================================================================

    if (!this.structure) {
      return events;
    }



    // =========================================================================
    // BULLISH STRUCTURE
    // =========================================================================

    if (
      this.structure === "bullish"
    ) {

      // =======================================================================
      // BEARISH CHOCH
      //
      // Protected HL is broken by candle CLOSE.
      // =======================================================================

      if (
        this.protectedLow &&
        candle.close <
          this.protectedLow.price
      ) {

        if (
          this.brokenLevelIndex !==
          this.protectedLow.index
        ) {

          const brokenSwing =
            this.protectedLow;


          const event =
            this._createBreakEvent({

              kind:
                "CHOCH",

              direction:
                "bearish",

              brokenSwing,

              candle,

              index,

              obType:
                "bearish",

              previousStructure:
                "bullish"
            });


          events.push(event);

          this.lastEvent =
            event;

          this.eventSequence++;

          this.brokenLevelIndex =
            brokenSwing.index;


          // -------------------------------------------------------------------
          // Switch structure
          // -------------------------------------------------------------------

          this.structure =
            "bearish";


          // -------------------------------------------------------------------
          // Old bullish protected levels are consumed.
          //
          // New bearish protected levels must be established from subsequent
          // bearish structure.
          // -------------------------------------------------------------------

          this.protectedLow =
            null;

          this.protectedHigh =
            null;
        }


        return events;
      }



      // =======================================================================
      // BULLISH BOS
      //
      // Protected HH is broken by candle CLOSE.
      // =======================================================================

      if (
        this.protectedHigh &&
        candle.close >
          this.protectedHigh.price
      ) {

        if (
          this.brokenLevelIndex !==
          this.protectedHigh.index
        ) {

          const brokenSwing =
            this.protectedHigh;


          const event =
            this._createBreakEvent({

              kind:
                "BOS",

              direction:
                "bullish",

              brokenSwing,

              candle,

              index,

              obType:
                "bullish",

              previousStructure:
                "bullish"
            });


          events.push(event);

          this.lastEvent =
            event;

          this.eventSequence++;

          this.brokenLevelIndex =
            brokenSwing.index;


          // -------------------------------------------------------------------
          // Old HH has been consumed.
          //
          // Wait for a NEW HH before another bullish BOS can happen.
          // -------------------------------------------------------------------

          this.protectedHigh =
            null;
        }


        return events;
      }
    }



    // =========================================================================
    // BEARISH STRUCTURE
    // =========================================================================

    if (
      this.structure === "bearish"
    ) {

      // =======================================================================
      // BULLISH CHOCH
      //
      // Protected LH is broken by candle CLOSE.
      // =======================================================================

      if (
        this.protectedHigh &&
        candle.close >
          this.protectedHigh.price
      ) {

        if (
          this.brokenLevelIndex !==
          this.protectedHigh.index
        ) {

          const brokenSwing =
            this.protectedHigh;


          const event =
            this._createBreakEvent({

              kind:
                "CHOCH",

              direction:
                "bullish",

              brokenSwing,

              candle,

              index,

              obType:
                "bullish",

              previousStructure:
                "bearish"
            });


          events.push(event);

          this.lastEvent =
            event;

          this.eventSequence++;

          this.brokenLevelIndex =
            brokenSwing.index;


          // -------------------------------------------------------------------
          // Switch structure
          // -------------------------------------------------------------------

          this.structure =
            "bullish";


          // -------------------------------------------------------------------
          // Old bearish protected levels are consumed.
          // -------------------------------------------------------------------

          this.protectedHigh =
            null;

          this.protectedLow =
            null;
        }


        return events;
      }



      // =======================================================================
      // BEARISH BOS
      //
      // Protected LL is broken by candle CLOSE.
      // =======================================================================

      if (
        this.protectedLow &&
        candle.close <
          this.protectedLow.price
      ) {

        if (
          this.brokenLevelIndex !==
          this.protectedLow.index
        ) {

          const brokenSwing =
            this.protectedLow;


          const event =
            this._createBreakEvent({

              kind:
                "BOS",

              direction:
                "bearish",

              brokenSwing,

              candle,

              index,

              obType:
                "bearish",

              previousStructure:
                "bearish"
            });


          events.push(event);

          this.lastEvent =
            event;

          this.eventSequence++;

          this.brokenLevelIndex =
            brokenSwing.index;


          // -------------------------------------------------------------------
          // Old LL consumed.
          // -------------------------------------------------------------------

          this.protectedLow =
            null;
        }


        return events;
      }
    }


    return events;
  }



  // ===========================================================================
  // CREATE BOS / CHOCH EVENT
  // ===========================================================================

  _createBreakEvent({

    kind,

    direction,

    brokenSwing,

    candle,

    index,

    obType,

    previousStructure

  }) {

    return {

      kind,

      direction,


      // -----------------------------------------------------------------------
      // Actual break candle time
      // -----------------------------------------------------------------------

      time:
        candle.time,

      breakTime:
        candle.time,


      // -----------------------------------------------------------------------
      // Actual break candle
      // -----------------------------------------------------------------------

      breakCandleIndex:
        index,

      breakPrice:
        candle.close,

      breakOpen:
        candle.open,

      breakHigh:
        candle.high,

      breakLow:
        candle.low,

      breakClose:
        candle.close,


      // -----------------------------------------------------------------------
      // Broken structural swing
      // -----------------------------------------------------------------------

      brokenSwingIndex:
        brokenSwing.index,

      brokenSwingType:
        brokenSwing.type,

      brokenPrice:
        brokenSwing.price,

      brokenSwingTime:
        brokenSwing.swingTime,

      brokenSwingDetectedAt:
        brokenSwing.detectedAt,


      // -----------------------------------------------------------------------
      // Structure
      // -----------------------------------------------------------------------

      previousStructure,


      // -----------------------------------------------------------------------
      // OB direction
      // -----------------------------------------------------------------------

      obType,


      // -----------------------------------------------------------------------
      // OB search range
      // -----------------------------------------------------------------------

      obRange: {

        from:
          brokenSwing.index,

        to:
          index
      }
    };
  }



  // ===========================================================================
  // STATE
  // ===========================================================================

  getState() {

    return {

      structure:
        this.structure,

      lastHigh:
        this.lastHigh,

      lastLow:
        this.lastLow,

      lastHH:
        this.lastHH,

      lastHL:
        this.lastHL,

      lastLH:
        this.lastLH,

      lastLL:
        this.lastLL,

      protectedHigh:
        this.protectedHigh,

      protectedLow:
        this.protectedLow,

      brokenLevelIndex:
        this.brokenLevelIndex,

      lastEvent:
        this.lastEvent
    };
  }
}



// =============================================================================
// 3) FVG TRACKER
// =============================================================================

function isBearishCandle(c) {
  return c.close < c.open;
}


function isBullishCandle(c) {
  return c.close > c.open;
}



class FVGTracker {

  constructor(maxPoolSize = 2000) {

    this.window = [];

    this.confirmed = [];

    this.maxPoolSize = maxPoolSize;
  }


  onCandle(candle, index) {

    this.window.push({
      candle,
      index
    });


    if (this.window.length > 3) {
      this.window.shift();
    }


    if (this.window.length < 3) {
      return null;
    }


    const [
      c0,
      ,
      c2
    ] = this.window;


    const found = [];


    // =========================================================================
    // BULLISH FVG
    // =========================================================================

    if (
      c2.candle.low >
      c0.candle.high
    ) {

      found.push(
        this._makeCandidate(
          c0,
          "bullish"
        )
      );
    }


    // =========================================================================
    // BEARISH FVG
    // =========================================================================

    if (
      c2.candle.high <
      c0.candle.low
    ) {

      found.push(
        this._makeCandidate(
          c0,
          "bearish"
        )
      );
    }


    if (found.length) {

      this.confirmed.push(
        ...found
      );


      if (
        this.confirmed.length >
        this.maxPoolSize
      ) {

        this.confirmed.splice(
          0,
          this.confirmed.length -
          this.maxPoolSize
        );
      }
    }


    return found.length
      ? found
      : null;
  }


  _makeCandidate(
    { candle, index },
    obType
  ) {

    return {

      index,

      high:
        candle.high,

      low:
        candle.low,

      time:
        candle.time,

      obType,

      candleColor:
        isBullishCandle(candle)
          ? "bullish"
          : isBearishCandle(candle)
            ? "bearish"
            : "doji"
    };
  }


  findInRange(
    fromIndex,
    toIndex,
    obType
  ) {

    if (
      fromIndex == null ||
      toIndex == null
    ) {

      return [];
    }


    const lo =
      Math.min(
        fromIndex,
        toIndex
      );


    const hi =
      Math.max(
        fromIndex,
        toIndex
      );


    return this.confirmed.filter(
      c =>
        c.obType === obType &&
        c.index >= lo &&
        c.index <= hi
    );
  }
}



// =============================================================================
// 4) CANDLESTICK REVERSAL PATTERNS
// =============================================================================

function isBullishEngulfing(
  prev,
  curr
) {

  const prevBearish =
    prev.close < prev.open;

  const currBullish =
    curr.close > curr.open;


  if (
    !prevBearish ||
    !currBullish
  ) {
    return false;
  }


  return (
    curr.open <= prev.close &&
    curr.close >= prev.open
  );
}



function isBearishEngulfing(
  prev,
  curr
) {

  const prevBullish =
    prev.close > prev.open;

  const currBearish =
    curr.close < curr.open;


  if (
    !prevBullish ||
    !currBearish
  ) {
    return false;
  }


  return (
    curr.open >= prev.close &&
    curr.close <= prev.open
  );
}



function isMorningStar(
  c1,
  c2,
  c3
) {

  const c1Bearish =
    c1.close < c1.open;

  const c3Bullish =
    c3.close > c3.open;


  if (
    !c1Bearish ||
    !c3Bullish
  ) {
    return false;
  }


  const c1Body =
    Math.abs(
      c1.open - c1.close
    );


  const c2Body =
    Math.abs(
      c2.open - c2.close
    );


  const smallStar =
    c2Body < c1Body * 0.5;


  const c1Mid =
    (c1.open + c1.close) / 2;


  const closesIntoC1 =
    c3.close > c1Mid;


  return (
    smallStar &&
    closesIntoC1
  );
}



function isEveningStar(
  c1,
  c2,
  c3
) {

  const c1Bullish =
    c1.close > c1.open;

  const c3Bearish =
    c3.close < c3.open;


  if (
    !c1Bullish ||
    !c3Bearish
  ) {
    return false;
  }


  const c1Body =
    Math.abs(
      c1.open - c1.close
    );


  const c2Body =
    Math.abs(
      c2.open - c2.close
    );


  const smallStar =
    c2Body < c1Body * 0.5;


  const c1Mid =
    (c1.open + c1.close) / 2;


  const closesIntoC1 =
    c3.close < c1Mid;


  return (
    smallStar &&
    closesIntoC1
  );
}



// =============================================================================
// 5) ORDER BLOCK MANAGER
// =============================================================================
//
// OB is ACTIVE immediately after BOS / CHOCH.
//
// IMPORTANT:
//
// The BOS / CHOCH candle itself CANNOT touch or trigger the newly-created OB.
//
// The OB becomes available starting from the NEXT candle.
//
// States:
//
// active
// touched
// signal
// invalidated
// waiting
// =============================================================================

class OrderBlockManager {

  constructor() {

    this.orderBlocks = [];

    this.recentCandles = [];

    this.skipCandleIndex = null;
  }


  // ===========================================================================
  // REGISTER NEW BOS / CHOCH
  // ===========================================================================

  register(
    candidates,
    label,
    triggerPrice,
    breakCandleIndex = null
  ) {

    // -------------------------------------------------------------------------
    // New structure event resets previous OB context.
    // -------------------------------------------------------------------------

    this.orderBlocks = [];


    // -------------------------------------------------------------------------
    // Prevent the BOS/CHOCH candle itself from touching the new OB.
    // -------------------------------------------------------------------------

    this.skipCandleIndex =
      breakCandleIndex;


    if (
      !candidates ||
      candidates.length === 0
    ) {

      return [];
    }


    // -------------------------------------------------------------------------
    // Newest first
    // -------------------------------------------------------------------------

    candidates.sort(
      (a, b) =>
        b.index - a.index
    );


    const registered =
      candidates.map(
        (candidate, idx) => ({

          ...candidate,

          label,

          triggerPrice,

          // Immediately active

          status:
            idx === 0
              ? "active"
              : "waiting",

          touchedAt: null,

          signalAt: null,

          pattern: null
        })
      );


    this.orderBlocks =
      registered;


    return registered;
  }


  // ===========================================================================
  // ACTIVATE NEXT WAITING OB
  // ===========================================================================

  _activateNextOB() {

    const next =
      this.orderBlocks.find(
        ob =>
          ob.status === "waiting"
      );


    if (next) {
      next.status = "active";
    }
  }


  // ===========================================================================
  // PROCESS ONE CANDLE
  // ===========================================================================

  onCandle(candle) {

    this.recentCandles.push(
      candle
    );


    if (
      this.recentCandles.length > 3
    ) {

      this.recentCandles.shift();
    }


    const alerts = [];


    // =========================================================================
    // NEWLY CREATED OB MUST NOT PROCESS THE BOS/CHOCH CANDLE
    // =========================================================================

    if (
      this.skipCandleIndex !== null &&
      candle.index === this.skipCandleIndex
    ) {

      return alerts;
    }


    // Once the next candle has arrived, the restriction is no longer needed.

    if (
      this.skipCandleIndex !== null &&
      candle.index > this.skipCandleIndex
    ) {

      this.skipCandleIndex = null;
    }


    const ob =
      this.orderBlocks.find(
        ob =>
          ob.status === "active" ||
          ob.status === "touched"
      );


    if (!ob) {
      return alerts;
    }


    // =========================================================================
    // BULLISH OB
    // =========================================================================

    if (
      ob.obType === "bullish"
    ) {

      // -----------------------------------------------------------------------
      // INVALIDATION
      // -----------------------------------------------------------------------

      if (
        candle.close < ob.low
      ) {

        ob.status =
          "invalidated";


        alerts.push({

          ob,

          type:
            "invalidated",

          note:
            "Closed below bullish OB."
        });


        this._activateNextOB();

        return alerts;
      }


      // -----------------------------------------------------------------------
      // TOUCH
      // -----------------------------------------------------------------------

      if (
        ob.status === "active" &&
        candle.low <= ob.high
      ) {

        ob.status =
          "touched";


        ob.touchedAt =
          candle.time;


        alerts.push({

          ob,

          type:
            "touched",

          note:
            "Price touched bullish OB."
        });
      }


      // -----------------------------------------------------------------------
      // ENTRY PATTERN
      // -----------------------------------------------------------------------

      if (
        ob.status === "touched"
      ) {

        const pattern =
          this._detectBullishPattern();


        if (pattern) {

          ob.status =
            "signal";


          ob.signalAt =
            candle.time;


          ob.pattern =
            pattern;


          alerts.push({

            ob,

            type:
              "BUY_SIGNAL",

            note:
              `${pattern} confirmed.`
          });
        }
      }
    }



    // =========================================================================
    // BEARISH OB
    // =========================================================================

    else {

      // -----------------------------------------------------------------------
      // INVALIDATION
      // -----------------------------------------------------------------------

      if (
        candle.close > ob.high
      ) {

        ob.status =
          "invalidated";


        alerts.push({

          ob,

          type:
            "invalidated",

          note:
            "Closed above bearish OB."
        });


        this._activateNextOB();

        return alerts;
      }


      // -----------------------------------------------------------------------
      // TOUCH
      // -----------------------------------------------------------------------

      if (
        ob.status === "active" &&
        candle.high >= ob.low
      ) {

        ob.status =
          "touched";


        ob.touchedAt =
          candle.time;


        alerts.push({

          ob,

          type:
            "touched",

          note:
            "Price touched bearish OB."
        });
      }


      // -----------------------------------------------------------------------
      // ENTRY PATTERN
      // -----------------------------------------------------------------------

      if (
        ob.status === "touched"
      ) {

        const pattern =
          this._detectBearishPattern();


        if (pattern) {

          ob.status =
            "signal";


          ob.signalAt =
            candle.time;


          ob.pattern =
            pattern;


          alerts.push({

            ob,

            type:
              "SELL_SIGNAL",

            note:
              `${pattern} confirmed.`
          });
        }
      }
    }


    return alerts;
  }



  // ===========================================================================
  // BULLISH PATTERNS
  // ===========================================================================

  _detectBullishPattern() {

    const n =
      this.recentCandles.length;


    // -------------------------------------------------------------------------
    // BULLISH ENGULFING
    // -------------------------------------------------------------------------

    if (n >= 2) {

      const [
        prev,
        curr
      ] =
        this.recentCandles.slice(-2);


      if (
        isBullishEngulfing(
          prev,
          curr
        )
      ) {

        return "Bullish Engulfing";
      }
    }


    // -------------------------------------------------------------------------
    // MORNING STAR
    // -------------------------------------------------------------------------

    if (n >= 3) {

      const [
        c1,
        c2,
        c3
      ] =
        this.recentCandles.slice(-3);


      if (
        isMorningStar(
          c1,
          c2,
          c3
        )
      ) {

        return "Morning Star";
      }
    }


    return null;
  }



  // ===========================================================================
  // BEARISH PATTERNS
  // ===========================================================================

  _detectBearishPattern() {

    const n =
      this.recentCandles.length;


    // -------------------------------------------------------------------------
    // BEARISH ENGULFING
    // -------------------------------------------------------------------------

    if (n >= 2) {

      const [
        prev,
        curr
      ] =
        this.recentCandles.slice(-2);


      if (
        isBearishEngulfing(
          prev,
          curr
        )
      ) {

        return "Bearish Engulfing";
      }
    }


    // -------------------------------------------------------------------------
    // EVENING STAR
    // -------------------------------------------------------------------------

    if (n >= 3) {

      const [
        c1,
        c2,
        c3
      ] =
        this.recentCandles.slice(-3);


      if (
        isEveningStar(
          c1,
          c2,
          c3
        )
      ) {

        return "Evening Star";
      }
    }


    return null;
  }
}



// =============================================================================
// 6) MARKET STRUCTURE ENGINE
// =============================================================================

class MarketStructureEngine {

  constructor({
    zigzagLength = 9
  } = {}) {

    this.zigzag =
      new ZigZagDetector(
        zigzagLength
      );


    this.structure =
      new StructureDetector();


    this.fvg =
      new FVGTracker();


    this.obManager =
      new OrderBlockManager();


    this.index = -1;
  }



  onCandle(candle) {

    this.index += 1;

    const index =
      this.index;


    // =========================================================================
    // Normalize candle
    // =========================================================================

    const normalizedCandle = {
      ...candle,
      index
    };


    // =========================================================================
    // 1. STRUCTURE BREAK CHECK
    //
    // IMPORTANT:
    //
    // This happens BEFORE the newly confirmed ZigZag swing is added.
    //
    // Therefore the current candle can only break structure that already
    // existed before this candle.
    // =========================================================================

    const structureEvents =
      this.structure.onCandle(
        normalizedCandle,
        index
      );


    let structureEvent =
      structureEvents.length > 0
        ? structureEvents[0]
        : null;


    let newOB =
      null;


    // =========================================================================
    // 2. FVG
    // =========================================================================

    this.fvg.onCandle(
      normalizedCandle,
      index
    );


    // =========================================================================
    // 3. BOS / CHOCH -> OB
    //
    // OB is created immediately after BOS / CHOCH.
    //
    // The BOS/CHOCH candle itself is NOT allowed to touch the OB.
    // =========================================================================

    if (structureEvent) {

      const candidates =
        this.fvg.findInRange(

          structureEvent.obRange.from,

          structureEvent.obRange.to,

          structureEvent.obType
        );


      const label =
        `${structureEvent.kind}-${structureEvent.obType === "bullish"
          ? "Bu-OB"
          : "Be-OB"}`;


      newOB =
        this.obManager.register(

          candidates,

          label,

          structureEvent.brokenPrice,

          structureEvent.breakCandleIndex
        );
    }


    // =========================================================================
    // 4. ZIGZAG
    //
    // IMPORTANT:
    //
    // This happens AFTER structure-break detection.
    //
    // A newly confirmed swing therefore cannot itself become the BOS/CHOCH
    // trigger for the same candle.
    // =========================================================================

    const swing =
      this.zigzag.onCandle(
        normalizedCandle,
        index
      );


    let swingClassification =
      null;


    if (swing) {

      swingClassification =
        this.structure.addSwing(
          swing
        );
    }


    // =========================================================================
    // 5. OB PROCESSING
    //
    // The newly-created OB cannot be touched by the BOS/CHOCH candle itself.
    //
    // It becomes available for the NEXT candle's retracement.
    // =========================================================================

    const obAlerts =
      this.obManager.onCandle(
        normalizedCandle
      );


    return {

      index,

      candle:
        normalizedCandle,

      swing,

      swingClassification,

      structureEvent,

      newOB,

      obAlerts
    };
  }
}



// =============================================================================
// 7) REPLAY LOOP
// =============================================================================

async function main() {

  const engine =
    new MarketStructureEngine({

      zigzagLength: 5
    });


  const candles =
    await getHistoricalCandles();


  if (
    !candles ||
    candles.length === 0
  ) {

    console.log(
      "No candles received."
    );

    return;
  }


  const swings = [];

  const structureEvents = [];

  const signals = [];


  // ===========================================================================
  // SORT CHRONOLOGICALLY
  // ===========================================================================

  candles.sort(
    (a, b) =>
      new Date(a.time) -
      new Date(b.time)
  );


  console.log(
    `\n📊 Processing ${candles.length} candles chronologically...`
  );


  // ===========================================================================
  // PROCESS CANDLES
  // ===========================================================================

  for (
    const candle of candles
  ) {

    const {
      swing,
      swingClassification,
      structureEvent,
      newOB,
      obAlerts
    } =
      engine.onCandle(
        candle
      );


    // =========================================================================
    // SWING LOG
    // =========================================================================

    if (swing) {

      swings.push(
        swing
      );


      console.log(

        `🔹 ${swing.type} ` +

        `${swing.classification ?? ""} ` +

        `${swing.price} ` +

        `@ ${toIST(
          swing.swingTime
        )} ` +

        `(confirmed ${toIST(
          swing.detectedAt
        )})`
      );
    }


    // =========================================================================
    // STRUCTURE EVENT LOG
    // =========================================================================

    if (structureEvent) {

      const label =

        structureEvent.kind ===
        "CHOCH"

          ?

          structureEvent.direction ===
          "bullish"

            ? "CHOCH ↑ (bullish)"

            : "CHOCH ↓ (bearish)"

          :

          structureEvent.direction ===
          "bullish"

            ? "BOS ↑ (bullish)"

            : "BOS ↓ (bearish)";


      structureEvents.push({

        ...structureEvent,

        label,

        time:
          toIST(
            structureEvent.time
          ),

        breakTime:
          toIST(
            structureEvent.breakTime
          ),

        brokenSwingTime:
          toIST(
            structureEvent.brokenSwingTime
          )
      });


      console.log(

        `⚡ ${label} @ ${toIST(
          structureEvent.time
        )}`

      );  


      console.log(

        `   Broken swing: ` +

        `${structureEvent.brokenSwingType} ` +

        `#${structureEvent.brokenSwingIndex} ` +

        `@ ${structureEvent.brokenPrice}`
      );


      console.log(

        `   Break candle: ` +

        `#${structureEvent.breakCandleIndex} ` +

        `close=${structureEvent.breakClose}`
      );


      // =======================================================================
      // NEW OB LOG
      // =======================================================================

      if (
        newOB &&
        newOB.length > 0
      ) {

        newOB.forEach(
          (ob, index) => {

            console.log(

              `   📦 OB ${index + 1}/${newOB.length}: ` +

              `${ob.label} ` +

              `zone: ${ob.low} - ${ob.high} ` +

              `(candle @ ${toIST(ob.time)}) ` +

              `— status: ${ob.status}`
            );
          }
        );

      } else {

        console.log(
          "   (no valid FVG-confirmed OB found in this leg)"
        );
      }
    }


    // =========================================================================
    // OB ALERTS
    // =========================================================================

    for (
      const a of obAlerts
    ) {

      const marker =

        a.type === "BUY_SIGNAL"

          ? "🟢"

          : a.type === "SELL_SIGNAL"

            ? "🔴"

            : a.type === "invalidated"

              ? "⚫"

              : "🔔";


      console.log(

        `   ${marker} ` +

        `${a.ob.label} ` +

        `[${a.type}]: ` +

        `${a.note} ` +

        `— ${toIST(candle.time)}`
      );


      // -----------------------------------------------------------------------
      // STORE TRADE SIGNAL
      // -----------------------------------------------------------------------

      if (
        a.type === "BUY_SIGNAL" ||
        a.type === "SELL_SIGNAL"
      ) {

        signals.push({

          ...a.ob,

          alertType:
            a.type,

          time:
            toIST(
              candle.time
            )
        });
      }
    }
  }



  // ===========================================================================
  // FINAL SWINGS
  // ===========================================================================

  console.log(
    "\n--- Swings ---"
  );


  console.table(

    swings.map(
      s => ({

        ...s,

        swingTime:
          toIST(
            s.swingTime
          ),

        detectedAt:
          toIST(
            s.detectedAt
          )
      })
    )
  );



  // ===========================================================================
  // STRUCTURE EVENTS
  // ===========================================================================

  console.log(
    "\n--- Structure Events (CHOCH / BOS) ---"
  );


  console.table(
    structureEvents
  );



  // ===========================================================================
  // FINAL ORDER BLOCKS
  // ===========================================================================

  console.log(
    "\n--- Order Blocks ---"
  );


  console.table(

    engine.obManager.orderBlocks.map(
      ob => ({

        label:
          ob.label,

        obType:
          ob.obType,

        low:
          ob.low,

        high:
          ob.high,

        triggerPrice:
          ob.triggerPrice,

        status:
          ob.status,

        touchedAt:
          ob.touchedAt
            ? toIST(
                ob.touchedAt
              )
            : "-",

        pattern:
          ob.pattern ?? "-",

        signalAt:
          ob.signalAt
            ? toIST(
                ob.signalAt
              )
            : "-"
      })
    )
  );



  // ===========================================================================
  // TRADE SIGNALS
  // ===========================================================================

  console.log(
    "\n--- 🎯 Trade Signals ---"
  );


  console.table(

    signals.map(
      s => ({

        label:
          s.label,

        alertType:
          s.alertType,

        zone:
          `${s.low} - ${s.high}`,

        pattern:
          s.pattern,

        time:
          s.time
      })
    )
  );
}



// =============================================================================
// START
// =============================================================================

main();