function isBullishEngulfing(previous, current) {
  return previous.close < previous.open &&
    current.close > current.open &&
    current.open <= previous.close &&
    current.close >= previous.open;
}

function isBearishEngulfing(previous, current) {
  return previous.close > previous.open &&
    current.close < current.open &&
    current.open >= previous.close &&
    current.close <= previous.open;
}

function isMorningStar(first, middle, last) {
  const firstBody = Math.abs(first.open - first.close);
  const middleBody = Math.abs(middle.open - middle.close);
  const firstMidpoint = (first.open + first.close) / 2;
  return first.close < first.open &&
    last.close > last.open &&
    middleBody < firstBody * 0.5 &&
    last.close > firstMidpoint;
}

function isEveningStar(first, middle, last) {
  const firstBody = Math.abs(first.open - first.close);
  const middleBody = Math.abs(middle.open - middle.close);
  const firstMidpoint = (first.open + first.close) / 2;
  return first.close > first.open &&
    last.close < last.open &&
    middleBody < firstBody * 0.5 &&
    last.close < firstMidpoint;
}

export class FiveMinuteEntryWatcher {
  constructor() {
    this.zones = [];
    this.recentCandles = [];
    this.signalledParents = new Set();

    // NEW: currently selected active 15M parent OB
    this.activeParentOBId = null;
  }

  // NEW: call whenever the active 15M parent changes
  setActiveParent(parentOB) {
    this.activeParentOBId =
      parentOB?.status === "active" ? parentOB.id : null;
  }

  registerFromParent(parentOB) {
    if (
      !parentOB ||
      parentOB.status !== "active" ||
      !parentOB.overlapping5mOBs?.length
    ) {
      return [];
    }

    const registered = [];

    for (const fvg of parentOB.overlapping5mOBs) {
      if (
        this.zones.some(
          zone =>
            zone.index === fvg.index &&
            zone.obType === fvg.obType &&
            zone.parentOBId === parentOB.id
        )
      ) {
        continue;
      }

      const zone = {
        ...fvg,
        parentOBId: parentOB.id,
        parentLabel: parentOB.label,
        parentZone: {
          low: parentOB.low,
          high: parentOB.high
        },
        status: "active",
        touchedAt: null,
        touchedIndex: null, // NEW
        signalAt: null,
        pattern: null
      };

      this.zones.push(zone);
      registered.push(zone);

      console.info(
        `[strategy] Watching ${fvg.obType} M5 zone ` +
        `${fvg.low}-${fvg.high}; parent ${parentOB.label} #${parentOB.id}`
      );
    }

    return registered;
  }

  // Price-based invalidation for a specific parent
  invalidateZonesForParent(parentOBId) {
    for (const zone of this.zones) {
      if (
        zone.parentOBId === parentOBId &&
        (zone.status === "active" || zone.status === "touched")
      ) {
        zone.status = "invalidated";
      }
    }
  }

  onCandle(candle) {
    this.recentCandles.push(candle);

    if (this.recentCandles.length > 3) {
      this.recentCandles.shift();
    }

    const alerts = [];

    for (const zone of this.zones) {
      if (
        zone.status === "invalidated" ||
        zone.status === "signal"
      ) {
        continue;
      }

      // NEW: ignore M5 OBs whose 15M parent is not active/selected
      if (
        this.activeParentOBId == null ||
        zone.parentOBId !== this.activeParentOBId
      ) {
        continue;
      }

      if (this.signalledParents.has(zone.parentOBId)) {
        continue;
      }

      if (
        zone.confirmationIndex != null &&
        candle.index <= zone.confirmationIndex
      ) {
        continue;
      }

      const bullish = zone.obType === "bullish";

      // Existing price-based invalidation logic — unchanged
      if (
        bullish
          ? candle.close < zone.low
          : candle.close > zone.high
      ) {
        zone.status = "invalidated";

        alerts.push({
          zone,
          type: "invalidated",
          note: `Closed beyond 5m ${zone.obType} OB.`
        });

        continue;
      }

      const touched = bullish
        ? candle.low <= zone.high
        : candle.high >= zone.low;

      if (zone.status === "active" && touched) {
        zone.status = "touched";
        zone.touchedAt = candle.time;
        zone.touchedIndex = candle.index; // NEW

        alerts.push({
          zone,
          type: "touched",
          note: `Price touched 5m ${zone.obType} OB.`
        });
      }

      if (zone.status !== "touched") {
        continue;
      }

      // Pattern detection call is unchanged
      const pattern = this._detectPattern(bullish);

      if (!pattern) {
        continue;
      }

      this.signalledParents.add(zone.parentOBId);
      zone.status = "signal";
      zone.signalAt = candle.time;
      zone.pattern = pattern;

      alerts.push({
        zone,
        type: bullish ? "BUY_SIGNAL" : "SELL_SIGNAL",
        note:
          `${pattern} confirmed on 5m OB ` +
          `(parent: 15m ${zone.parentLabel} #${zone.parentOBId}).`
      });
    }

    return alerts;
  }

  // UNCHANGED: your original pattern detection logic
  _detectPattern(bullish) {
    const count = this.recentCandles.length;
    if (count >= 2) {
      const [previous, current] = this.recentCandles.slice(-2);

      if (
        bullish
          ? isBullishEngulfing(previous, current)
          : isBearishEngulfing(previous, current)
      ) {
        return bullish
          ? "Bullish Engulfing"
          : "Bearish Engulfing";
      }
    }

    if (count >= 3) {
      const [first, middle, last] =
        this.recentCandles.slice(-3);

      if (
        bullish
          ? isMorningStar(first, middle, last)
          : isEveningStar(first, middle, last)
      ) {
        return bullish ? "Morning Star" : "Evening Star";
      }
    }

    return null;
  }
}
