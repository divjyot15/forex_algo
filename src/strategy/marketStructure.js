function isBullishCandle(candle) {
  return candle.close > candle.open;
}

function isBearishCandle(candle) {
  return candle.close < candle.open;
}

export function zonesOverlap(aLow, aHigh, bLow, bHigh) {
  return aLow <= bHigh && bLow <= aHigh;
}

export class ZigZagDetector {
  constructor(length = 5) {
    this.length = length;
    this.trend = 1;
    this.currentHigh = null;
    this.currentLow = null;
    this.window = [];
  }

  onCandle(candle, index) {
    const previousWindow = [...this.window];
    this.window.push({ candle, index });
    if (this.window.length > this.length) this.window.shift();
    if (previousWindow.length < this.length - 1) return null;

    if (this.trend === 1) {
      if (!this.currentHigh || candle.high > this.currentHigh.candle.high) {
        this.currentHigh = { candle, index };
      }

      const previousLowest = Math.min(...previousWindow.map(item => item.candle.low));
      if (candle.low < previousLowest && this.currentHigh) {
        const swing = {
          type: "HIGH",
          price: this.currentHigh.candle.high,
          index: this.currentHigh.index,
          swingTime: this.currentHigh.candle.time,
          detectedAt: candle.time
        };
        this.trend = -1;
        this.currentLow = null;
        this.currentHigh = null;
        return swing;
      }
      return null;
    }

    if (!this.currentLow || candle.low < this.currentLow.candle.low) {
      this.currentLow = { candle, index };
    }

    const previousHighest = Math.max(...previousWindow.map(item => item.candle.high));
    if (candle.high > previousHighest && this.currentLow) {
      const swing = {
        type: "LOW",
        price: this.currentLow.candle.low,
        index: this.currentLow.index,
        swingTime: this.currentLow.candle.time,
        detectedAt: candle.time
      };
      this.trend = 1;
      this.currentHigh = null;
      this.currentLow = null;
      return swing;
    }
    return null;
  }
}

export class StructureDetector {
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

  addSwing(swing) {
    if (!swing || this.swings.some(item => item.index === swing.index)) return null;
    if (this.swings.some(item => item.index === swing.index && item.type !== swing.type)) return null;
    this.swings.push(swing);
    return swing.type === "HIGH" ? this._processHigh(swing) : this._processLow(swing);
  }

  _processHigh(swing) {
    const previousHigh = this.lastHigh;
    const classification = !previousHigh ? "HIGH" : swing.price > previousHigh.price ? "HH" : "LH";
    swing.classification = classification;
    this.lastHigh = swing;

    if (classification === "HH") {
      this.lastHH = swing;
      if (this.lastHL) {
        this.structure = "bullish";
        this.protectedHigh = swing;
      }
    } else if (classification === "LH") {
      this.lastLH = swing;
      if (this.lastLL) {
        this.structure = "bearish";
        this.protectedHigh = swing;
      }
    }

    return { type: "SWING_CLASSIFICATION", swing, classification, previousHigh, structure: this.structure };
  }

  _processLow(swing) {
    const previousLow = this.lastLow;
    const classification = !previousLow ? "LOW" : swing.price > previousLow.price ? "HL" : "LL";
    swing.classification = classification;
    this.lastLow = swing;

    if (classification === "HL") {
      this.lastHL = swing;
      if (this.lastHH) {
        this.structure = "bullish";
        this.protectedLow = swing;
      }
    } else if (classification === "LL") {
      this.lastLL = swing;
      if (this.lastLH) {
        this.structure = "bearish";
        this.protectedLow = swing;
      }
    }

    return { type: "SWING_CLASSIFICATION", swing, classification, previousLow, structure: this.structure };
  }

  onCandle(candle, index) {
    if (!this.structure) return [];

    if (this.structure === "bullish") {
      if (this.protectedLow && candle.close < this.protectedLow.price) {
        if (this.brokenLevelIndex === this.protectedLow.index) return [];
        const event = this._createBreakEvent("CHOCH", "bearish", this.protectedLow, candle, index, "bearish", "bullish");
        this._recordBreak(event, this.protectedLow.index);
        this.structure = "bearish";
        this.protectedLow = null;
        this.protectedHigh = null;
        return [event];
      }
      if (this.protectedHigh && candle.close > this.protectedHigh.price) {
        if (this.brokenLevelIndex === this.protectedHigh.index) return [];
        const event = this._createBreakEvent("BOS", "bullish", this.protectedHigh, candle, index, "bullish", "bullish");
        this._recordBreak(event, this.protectedHigh.index);
        this.protectedHigh = null;
        return [event];
      }
    }

    if (this.structure === "bearish") {
      if (this.protectedHigh && candle.close > this.protectedHigh.price) {
        if (this.brokenLevelIndex === this.protectedHigh.index) return [];
        const event = this._createBreakEvent("CHOCH", "bullish", this.protectedHigh, candle, index, "bullish", "bearish");
        this._recordBreak(event, this.protectedHigh.index);
        this.structure = "bullish";
        this.protectedHigh = null;
        this.protectedLow = null;
        return [event];
      }
      if (this.protectedLow && candle.close < this.protectedLow.price) {
        if (this.brokenLevelIndex === this.protectedLow.index) return [];
        const event = this._createBreakEvent("BOS", "bearish", this.protectedLow, candle, index, "bearish", "bearish");
        this._recordBreak(event, this.protectedLow.index);
        this.protectedLow = null;
        return [event];
      }
    }

    return [];
  }

  _recordBreak(event, brokenIndex) {
    this.lastEvent = event;
    this.eventSequence += 1;
    this.brokenLevelIndex = brokenIndex;
  }

  _createBreakEvent(kind, direction, brokenSwing, candle, index, obType, previousStructure) {
    return {
      kind,
      direction,
      time: candle.time,
      breakTime: candle.time,
      breakCandleIndex: index,
      breakPrice: candle.close,
      breakOpen: candle.open,
      breakHigh: candle.high,
      breakLow: candle.low,
      breakClose: candle.close,
      brokenSwingIndex: brokenSwing.index,
      brokenSwingType: brokenSwing.type,
      brokenPrice: brokenSwing.price,
      brokenSwingTime: brokenSwing.swingTime,
      brokenSwingDetectedAt: brokenSwing.detectedAt,
      previousStructure,
      obType,
      obRange: { from: brokenSwing.index, to: index }
    };
  }
}

export class FVGTracker {
  constructor(maxPoolSize = 2000) {
    this.window = [];
    this.confirmed = [];
    this.maxPoolSize = maxPoolSize;
  }

  onCandle(candle, index) {
    this.window.push({ candle, index });
    if (this.window.length > 3) this.window.shift();
    if (this.window.length < 3) return null;

    const [first, , confirmation] = this.window;
    const found = [];
    if (confirmation.candle.low > first.candle.high) found.push(this._makeCandidate(first, "bullish", confirmation));
    if (confirmation.candle.high < first.candle.low) found.push(this._makeCandidate(first, "bearish", confirmation));

    if (found.length) {
      this.confirmed.push(...found);
      if (this.confirmed.length > this.maxPoolSize) {
        this.confirmed.splice(0, this.confirmed.length - this.maxPoolSize);
      }
    }
    return found.length ? found : null;
  }

  _makeCandidate({ candle, index }, obType, confirmation) {
    return {
      index,
      high: candle.high,
      low: candle.low,
      time: candle.time,
      obType,
      candleColor: isBullishCandle(candle) ? "bullish" : isBearishCandle(candle) ? "bearish" : "doji",
      confirmedAt: confirmation?.candle?.time ?? null,
      confirmationIndex: confirmation?.index ?? null
    };
  }

  findInRange(fromIndex, toIndex, obType) {
    if (fromIndex == null || toIndex == null) return [];
    const low = Math.min(fromIndex, toIndex);
    const high = Math.max(fromIndex, toIndex);
    return this.confirmed.filter(item => item.obType === obType && item.index >= low && item.index <= high);
  }
}

export class OrderBlockManager {
  constructor() {
    this.orderBlocks = [];
    this.activeSwing = null;
    this.nextObId = 1;
  }

  startBearishSwing(swing, fvgTracker) {
    if (!swing || swing.type !== "HIGH" || swing.classification !== "LH") return;
    this.activeSwing = this._makeSwing("bearish", "LH", "LL", swing);
    this._addCarryoverOB(fvgTracker, "bearish");
  }

  startBullishSwing(swing, fvgTracker) {
    if (!swing || swing.type !== "LOW" || swing.classification !== "LL") return;
    this.activeSwing = this._makeSwing("bullish", "LL", "HH", swing);
    this._addCarryoverOB(fvgTracker, "bullish");
  }

  _makeSwing(direction, startType, endType, swing) {
    return {
      direction,
      startType,
      startIndex: swing.index,
      startPrice: swing.price,
      startTime: swing.swingTime,
      endType,
      endIndex: null,
      endPrice: null,
      endTime: null,
      closed: false,
      bosOccurred: false,
      chochOccurred: false,
      bosEvents: [],
      obIds: []
    };
  }

  onStructureEvent(event) {
    if (!event || !this.activeSwing) return;
    if (event.kind === "BOS") this.activeSwing.bosOccurred = true;
    if (event.kind === "CHOCH") this.activeSwing.chochOccurred = true;
    if (event.kind === "BOS" || event.kind === "CHOCH") this.activeSwing.bosEvents.push(event);
  }

  closeBearishSwing(swing, fvgTracker) {
    if (!this.activeSwing || this.activeSwing.direction !== "bearish" || this.activeSwing.closed || swing?.classification !== "LL") return;
    this._closeSwing(swing, fvgTracker, "bearish");
  }

  closeBullishSwing(swing, fvgTracker) {
    if (!this.activeSwing || this.activeSwing.direction !== "bullish" || this.activeSwing.closed || swing?.classification !== "HH") return;
    this._closeSwing(swing, fvgTracker, "bullish");
  }

  _closeSwing(swing, fvgTracker, direction) {
    Object.assign(this.activeSwing, {
      endIndex: swing.index,
      endPrice: swing.price,
      endTime: swing.swingTime
    });
    for (const fvg of fvgTracker.findInRange(this.activeSwing.startIndex, swing.index, direction)) {
      this.addConfirmedFVG(fvg, swing.index, "FINAL_SWING_SWEEP");
    }
    this.activeSwing.closed = true;
  }

  addConfirmedFVG(fvg, currentIndex, source = "LIVE") {
    const swing = this.activeSwing;
    if (!fvg || !swing || fvg.obType !== swing.direction) return null;
    const endIndex = swing.closed ? swing.endIndex : currentIndex;
    if (fvg.index < swing.startIndex || fvg.index > endIndex) return null;
    if (this.orderBlocks.some(ob => ob.index === fvg.index && ob.obType === fvg.obType && ob.swingStartIndex === swing.startIndex)) return null;

    const ob = this._makeOrderBlock(fvg, swing, currentIndex, source);
    this.orderBlocks.push(ob);
    swing.obIds.push(ob.id);
    return ob;
  }

  _addCarryoverOB(fvgTracker, direction) {
    const swing = this.activeSwing;
    if (!swing || swing.direction !== direction) return null;
    const closest = fvgTracker.confirmed
      .filter(fvg => fvg.obType === direction && fvg.index < swing.startIndex)
      .sort((a, b) => b.index - a.index)[0];
    if (!closest || this.orderBlocks.some(ob => ob.index === closest.index && ob.obType === direction && ob.swingStartIndex === swing.startIndex)) return null;
    const ob = this._makeOrderBlock(closest, swing, swing.startIndex, "PREVIOUS_SWING_CARRYOVER");
    this.orderBlocks.push(ob);
    swing.obIds.push(ob.id);
    this.refreshActiveStatuses();
    return ob;
  }

  _makeOrderBlock(fvg, swing, currentIndex, source) {
    return {
      id: this.nextObId++,
      ...fvg,
      label: swing.direction === "bullish" ? "Swing-Bu-OB" : "Swing-Be-OB",
      swingDirection: swing.direction,
      swingStartType: swing.startType,
      swingStartIndex: swing.startIndex,
      swingStartPrice: swing.startPrice,
      swingStartTime: swing.startTime,
      swingEndType: swing.endType,
      swingEndIndex: swing.endIndex,
      swingEndPrice: swing.endPrice,
      swingEndTime: swing.endTime,
      discoveredAtIndex: currentIndex,
      discoveredAfterBOS: swing.bosOccurred,
      discoveredAfterCHOCH: swing.chochOccurred,
      discoverySource: source,
      status: "waiting",
      overlapping5mOBs: []
    };
  }

  refreshActiveStatuses() {
    const open = this.orderBlocks.filter(ob => ob.status !== "invalidated").sort((a, b) => b.index - a.index);
    open.forEach((ob, index) => {
      if (index === 0 && ob.status === "waiting") ob.status = "active";
      else if (index > 0 && ob.status === "active") ob.status = "waiting";
    });
  }

  onCandle(candle) {
    const active = this.orderBlocks.find(ob => ob.status === "active");
    if (!active) return [];
    const invalid = active.obType === "bullish" ? candle.close < active.low : candle.close > active.high;
    if (!invalid) return [];
    active.status = "invalidated";
    this.refreshActiveStatuses();
    return [{ ob: active, type: "invalidated", note: `Closed beyond ${active.obType} 15m OB.` }];
  }
}

export class MarketStructureEngine {
  constructor({ zigzagLength = 5 } = {}) {
    this.zigzag = new ZigZagDetector(zigzagLength);
    this.structure = new StructureDetector();
    this.fvg = new FVGTracker();
    this.obManager = new OrderBlockManager();
    this.index = -1;
  }

  onCandle(candle) {
    const index = ++this.index;
    const normalizedCandle = { ...candle, index };
    const structureEvents = this.structure.onCandle(normalizedCandle, index);
    const structureEvent = structureEvents[0] ?? null;
    const newFVGs = this.fvg.onCandle(normalizedCandle, index);
    if (structureEvent) this.obManager.onStructureEvent(structureEvent);

    const swing = this.zigzag.onCandle(normalizedCandle, index);
    const swingClassification = swing ? this.structure.addSwing(swing) : null;
    if (swing && swingClassification) {
      if (swingClassification.classification === "LL") {
        if (this.obManager.activeSwing?.direction === "bearish") this.obManager.closeBearishSwing(swing, this.fvg);
        this.obManager.startBullishSwing(swing, this.fvg);
      }
      if (swingClassification.classification === "HH" && this.obManager.activeSwing?.direction === "bullish") {
        this.obManager.closeBullishSwing(swing, this.fvg);
      }
      if (swingClassification.classification === "LH") this.obManager.startBearishSwing(swing, this.fvg);
    }

    if (newFVGs) {
      for (const fvg of newFVGs) this.obManager.addConfirmedFVG(fvg, index, "LIVE");
      this.obManager.refreshActiveStatuses();
    }

    return {
      index,
      candle: normalizedCandle,
      swing,
      swingClassification,
      structureEvent,
      newOB: newFVGs,
      obAlerts: this.obManager.onCandle(normalizedCandle)
    };
  }
}