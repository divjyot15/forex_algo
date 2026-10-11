import { getAccount } from "../connection/metaapi.js";
import { FVGTracker, MarketStructureEngine, zonesOverlap } from "../strategy/marketStructure.js";
import { FiveMinuteEntryWatcher } from "../strategy/fiveMinuteEntryWatcher.js";
import { LiveTradeManager } from "./liveTradeManager.service.js";

const SYMBOL = process.env.METAAPI_SYMBOL || "XAUUSD";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const CANDLE_FINALIZATION_DELAY_MS = 3000;

function candleCloseTime(candle, timeframe) {
  const openTime = new Date(candle.time).getTime();
  return openTime + (timeframe === "M5" ? FIVE_MINUTES_MS : FIFTEEN_MINUTES_MS);
}

export class LiveStrategyService {
  constructor({
    symbol = SYMBOL,
    zigzagLength = Number(process.env.STRATEGY_ZIGZAG_LENGTH || 5),
    warmupLimit = Number(process.env.STRATEGY_WARMUP_CANDLES || 1000),
    tradeManager = new LiveTradeManager({ symbol })
  } = {}) {
    this.symbol = symbol;
    this.warmupLimit = Math.min(1000, Math.max(100, warmupLimit));
    this.market = new MarketStructureEngine({ zigzagLength });
    this.fvg5m = new FVGTracker();
    this.watcher = new FiveMinuteEntryWatcher();
    this.tradeManager = tradeManager;
    this.fiveMinuteIndex = -1;
    this.initialized = false;
    this.processing = Promise.resolve();
  }

  async initialize() {
    await this.tradeManager.initialize();
    // await this._warmup();
    this.initialized = true;
    console.info(`[strategy] Ready: ${this.symbol} M15 structure + M5 execution; waiting for completed live candles.`);
  }

  handleClosedCandle(timeframe, candle) {
    const work = this.processing.then(async () => {
      if (!this.initialized) throw new Error("Live strategy received a candle before initialization completed.");
      if (timeframe !== "M5" && timeframe !== "M15") return;
      if (candle.symbol && candle.symbol !== this.symbol) return;
      if (timeframe === "M5") await this._processM5(candle, true);
      else this._processM15(candle, true);
    });
    this.processing = work.catch(error => {
      console.error(`[strategy] Failed processing ${timeframe} candle ${candle?.time}:`, error);
    });
    return work;
  }

//   async _warmup() {
//     const account = getAccount();
//     const now = Date.now();
//     const limit = this.warmupLimit;
//     const [candles15m, candles5m] = await Promise.all([
//       account.getHistoricalCandles(this.symbol, "15m", new Date(now), limit),
//       account.getHistoricalCandles(this.symbol, "5m", new Date(now), limit)
//     ]);
//     const history = [];

//     for (const candle of candles15m || []) {
//       if (candleCloseTime(candle, "M15") <= now - CANDLE_FINALIZATION_DELAY_MS) {
//         history.push({ timeframe: "M15", candle, closeTime: candleCloseTime(candle, "M15") });
//       }
//     }
//     for (const candle of candles5m || []) {
//       if (candleCloseTime(candle, "M5") <= now - CANDLE_FINALIZATION_DELAY_MS) {
//         history.push({ timeframe: "M5", candle, closeTime: candleCloseTime(candle, "M5") });
//       }
//     }

//     history.sort((left, right) => {
//       if (left.closeTime !== right.closeTime) return left.closeTime - right.closeTime;
//       return left.timeframe === "M5" ? -1 : 1;
//     });

//     for (const event of history) {
//       if (event.timeframe === "M5") await this._processM5(event.candle, false);
//       else this._processM15(event.candle, false);
//     }
//     console.info(`[strategy] Warmed up from ${history.filter(event => event.timeframe === "M15").length} completed M15 and ${history.filter(event => event.timeframe === "M5").length} completed M5 candles; historical signals were not traded.`);
//   }

  _processM15(candle, live) {
    const previousObCount = this.market.obManager.orderBlocks.length;
    const result = this.market.onCandle(candle);
    if (live && result.swing) {
      console.info(`[strategy] ${result.swing.type} ${result.swing.classification ?? ""} ${result.swing.price} @ ${result.swing.swingTime}; confirmed ${result.swing.detectedAt}.`);
    }
    if (live && result.structureEvent) {
      console.info(`[strategy] ${result.structureEvent.kind} ${result.structureEvent.direction} @ ${result.structureEvent.time}.`);
    }
    if (live) {
      for (const ob of this.market.obManager.orderBlocks.slice(previousObCount)) {
        console.info(`[strategy] 15m ${ob.obType} OB #${ob.id} ${ob.low}-${ob.high} @ ${ob.time}; ${ob.discoverySource}.`);
      }
    }
    for (const alert of result.obAlerts) {
      if (live) console.info(`[strategy] 15m OB #${alert.ob.id} invalidated at ${candle.time}: ${alert.note}`);
      this.watcher.invalidateZonesForParent(alert.ob.id);
    }

    const activeParent = this.market.obManager.orderBlocks.find(ob => ob.status === "active");
    if (!activeParent) return;
    activeParent.overlapping5mOBs = this.fvg5m.confirmed.filter(fvg =>
      fvg.obType === activeParent.obType &&
      zonesOverlap(activeParent.low, activeParent.high, fvg.low, fvg.high)
    );
    this.watcher.registerFromParent(activeParent);
  }

  async _processM5(candle, live) {
    const normalized = { ...candle, index: ++this.fiveMinuteIndex };
    const newFvgs = this.fvg5m.onCandle(normalized, normalized.index);
    if (newFvgs?.length) {
      const activeParent = this.market.obManager.orderBlocks.find(ob => ob.status === "active");
      if (activeParent) {
        const overlapping = newFvgs.filter(fvg =>
          fvg.obType === activeParent.obType &&
          zonesOverlap(activeParent.low, activeParent.high, fvg.low, fvg.high)
        );
        if (overlapping.length) {
          activeParent.overlapping5mOBs.push(...overlapping);
          this.watcher.registerFromParent(activeParent);
        }
      }
    }

    const hadOpenTrade = Boolean(this.tradeManager.openTrade);
    const alerts = this.watcher.onCandle(normalized);
    if (live) {
      for (const alert of alerts) {
        if (alert.type === "touched") {
          console.info(`[strategy] ${alert.note} @ ${candle.time}; parent OB #${alert.zone.parentOBId}.`);
        } else if (alert.type === "invalidated") {
          console.info(`[strategy] 5m zone invalidated @ ${candle.time}: ${alert.note}`);
        } else if (alert.type === "BUY_SIGNAL" || alert.type === "SELL_SIGNAL") {
          await this.tradeManager.onSignal({ ...alert.zone, signalAt: candle.time }, candle);
        }
      }
      if (hadOpenTrade) await this.tradeManager.onClosedM5Candle(candle);
    }
  }
}

let liveStrategy = null;

export async function startLiveStrategy(options) {
  if (liveStrategy) return liveStrategy;
  liveStrategy = new LiveStrategyService(options);
  await liveStrategy.initialize();
  return liveStrategy;
}

export function getLiveStrategy() {
  return liveStrategy;
}