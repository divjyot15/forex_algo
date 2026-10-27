import { getAccount } from "../connection/metaapi.js";
import { FVGTracker, MarketStructureEngine, zonesOverlap } from "../strategy/marketStructure.js";
import { FiveMinuteEntryWatcher } from "../strategy/fiveMinuteEntryWatcher.js";
import { sendDiscord } from "./discord.service.js";
import { LiveTradeManager } from "./liveTradeManager.service.js";
import {
  brokerTimestamp,
  completedBucketRange,
  sortCandleEvents,
  timeframeMilliseconds,
  validateHistoricalCoverage
} from "./candleReconciliation.js";

const SYMBOL = process.env.METAAPI_SYMBOL || "XAUUSD";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const CANDLE_FINALIZATION_DELAY_MS = 3000;
const RECOVERY_AUDIT_CANDLE_LIMIT = 20;

function candleCloseTime(candle, timeframe) {
  const openTime = new Date(candle.time).getTime();
  return openTime + (timeframe === "M5" ? FIVE_MINUTES_MS : FIFTEEN_MINUTES_MS);
}

function notifyDiscord(message) {
  void sendDiscord(message);
}

function logCandleAudit(title, candles) {
  console.info(`[recovery] ${title} (${candles.length} candle(s))`);
  for (const candle of candles) {
    console.info(
      `[recovery] ${candle.brokerTime ?? candle.time} ` +
      `O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close}`
    );
  }
}

export class LiveStrategyService {
  constructor({
    symbol = SYMBOL,
    zigzagLength = Number(process.env.STRATEGY_ZIGZAG_LENGTH || 5),
    warmupLimit = Number(process.env.STRATEGY_WARMUP_CANDLES || 1000),
    tradeManager = new LiveTradeManager({ symbol }),
    historicalCandleFetcher = (requestedSymbol, timeframe, startTime, limit) =>
      getAccount().getHistoricalCandles(requestedSymbol, timeframe, startTime, limit)
  } = {}) {
    this.symbol = symbol;
    this.warmupLimit = Math.min(1000, Math.max(100, warmupLimit));
    this.market = new MarketStructureEngine({ zigzagLength });
    this.fvg5m = new FVGTracker();
    this.watcher = new FiveMinuteEntryWatcher();
    this.tradeManager = tradeManager;
    this.historicalCandleFetcher = historicalCandleFetcher;
    this.fiveMinuteIndex = -1;
    this.initialized = false;
    this.processing = Promise.resolve();
    this.reconciliationPending = false;
    this.candleJournal = [];
    this.journalKeys = new Set();
    this.startupInitialBuckets = { M5: null, M15: null };
  }

  async initialize() {
    await this.tradeManager.initialize();
    // await this._warmup();
    this.initialized = true;
    console.info(`[strategy] Ready: ${this.symbol} M15 structure + M5 execution; waiting for completed live candles.`);
    notifyDiscord(`**Strategy ready**\nSymbol: ${this.symbol}\nOrder execution: ${this.tradeManager.tradingEnabled ? "ENABLED" : "DISABLED"}`);
  }

  _syncActiveParent() {
  const activeParent =
    this.market.obManager.orderBlocks.find(
      ob => ob.status === "active"
    ) ?? null;

  this.watcher.setActiveParent(activeParent);

  return activeParent;
}

  beginRecovery() {
    const wasPending = this.reconciliationPending;
    this.reconciliationPending = true;
    this.tradeManager.setEntriesEnabled?.(false, "stream recovery pending");
    if (!wasPending) console.warn("[strategy] New entries disabled until candle recovery is reconciled.");
  }

  setStartupInitialBuckets(initialBuckets) {
    this.startupInitialBuckets = { ...this.startupInitialBuckets, ...initialBuckets };
  }

  reconcileRecovery({ lastBrokerTimestamp, resumeTimestamp, startupInitialBuckets = this.startupInitialBuckets }) {
    this.beginRecovery();
    const work = this.processing.then(() =>
      this._reconcileRecovery(lastBrokerTimestamp, resumeTimestamp, startupInitialBuckets)
    );
    this.processing = work.catch(error => {
      console.error("[strategy] Historical candle reconciliation failed; entries remain disabled:", error);
    });
    return work;
  }

  async _reconcileRecovery(lastBrokerTimestamp, resumeTimestamp, startupInitialBuckets) {
    if (!this.initialized) throw new Error("Cannot reconcile before strategy initialization.");
    if (!Number.isFinite(resumeTimestamp)) {
      throw new Error("Recovery is missing a valid resumed broker timestamp.");
    }
    if (lastBrokerTimestamp == null && this.candleJournal.length === 0) {
      this.reconciliationPending = false;
      this.tradeManager.setEntriesEnabled?.(true);
      return { lastBrokerTimestamp: resumeTimestamp, resumeTimestamp, repairedThrough: {} };
    }
    if (!Number.isFinite(lastBrokerTimestamp) || resumeTimestamp < lastBrokerTimestamp) {
      throw new Error("Recovery is missing a valid, ordered broker timestamp interval.");
    }

    const repaired = [];
    const repairedThrough = {};
    for (const [timeframe, apiTimeframe] of [["M5", "5m"], ["M15", "15m"]]) {
      const range = completedBucketRange(lastBrokerTimestamp, resumeTimestamp, timeframe);
      const expected = range.expected.filter(timestamp => timestamp !== startupInitialBuckets?.[timeframe]);
      if (!expected.length) continue;
      if (expected.length > 995) {
        throw new Error(`${timeframe} recovery interval exceeds the 1000-candle MetaApi request limit.`);
      }

      const latestCandleOpen = expected.at(-1);
      const requestLimit = Math.min(1000, expected.length + 5);
      const raw = await this.historicalCandleFetcher(
        this.symbol,
        apiTimeframe,
        new Date(latestCandleOpen + timeframeMilliseconds(timeframe)),
        requestLimit
      );
      const verified = validateHistoricalCoverage(raw, timeframe, this.symbol, expected);
      repaired.push(...verified.map(candle => ({ timeframe, candle })));
      repairedThrough[timeframe] = latestCandleOpen;
    }

    if (!repaired.length) {
      this.reconciliationPending = false;
      this.tradeManager.setEntriesEnabled?.(true);
      console.info("[strategy] Recovery contained no completed M5/M15 buckets; affected partial candles will be discarded.");
      return { lastBrokerTimestamp, resumeTimestamp, repairedThrough };
    }

    console.info(`[recovery] Verified historical candles for ${this.symbol}:`);
    for (const timeframe of ["M5", "M15"]) {
      const timeframeCandles = sortCandleEvents(repaired)
        .filter(event => event.timeframe === timeframe)
        .map(event => event.candle);
      if (timeframeCandles.length) {
        logCandleAudit(`Recovered ${timeframe} bars`, timeframeCandles);
      }
    }

    const repairedByKey = new Map(repaired.map(event => [
      `${event.timeframe}:${event.candle.timestamp}`,
      event
    ]));
    const merged = new Map();
    for (const event of this.candleJournal) {
      const timestamp = event.candle.timestamp ?? brokerTimestamp(event.candle.time);
      if (!Number.isFinite(timestamp)) throw new Error(`Invalid timestamp in strategy journal: ${event.candle.time}`);
      const key = `${event.timeframe}:${timestamp}`;
      merged.set(key, repairedByKey.get(key) ?? {
        timeframe: event.timeframe,
        candle: { ...event.candle, timestamp }
      });
    }
    for (const [key, event] of repairedByKey) merged.set(key, event);

    const replay = sortCandleEvents([...merged.values()]);
    this.candleJournal = replay.map(event => ({
      timeframe: event.timeframe,
      candle: { ...event.candle }
    }));
    this.journalKeys = new Set(this.candleJournal.map(event =>
      `${event.timeframe}:${event.candle.timestamp}`
    ));

    this.market = new MarketStructureEngine({ zigzagLength: this.market.zigzag.length });
    this.fvg5m = new FVGTracker();
    this.watcher = new FiveMinuteEntryWatcher();
    this.fiveMinuteIndex = -1;
    for (const event of replay) {
      if (event.timeframe === "M5") await this._processM5(event.candle, false);
      else this._processM15(event.candle, false);
    }

    for (const timeframe of ["M5", "M15"]) {
      const latestCandles = this.candleJournal
        .filter(event => event.timeframe === timeframe)
        .slice(-RECOVERY_AUDIT_CANDLE_LIMIT)
        .map(event => event.candle);
      logCandleAudit(`Latest ${timeframe} candles after recovery`, latestCandles);
    }

    this.reconciliationPending = false;
    this.tradeManager.setEntriesEnabled?.(true);
    console.info(`[strategy] Reconciled ${repaired.length} authoritative candles and replayed ${replay.length} candles without trade execution.`);
    return { lastBrokerTimestamp, resumeTimestamp, repairedThrough };
  }

  handleClosedCandle(timeframe, candle) {
    const work = this.processing.then(async () => {
      if (!this.initialized) throw new Error("Live strategy received a candle before initialization completed.");
      if (timeframe !== "M5" && timeframe !== "M15") return;
      if (candle.symbol && candle.symbol !== this.symbol) return;
      if (this.reconciliationPending) throw new Error("Refusing to process a live candle while recovery reconciliation is pending.");
      const timestamp = candle.timestamp ?? brokerTimestamp(candle.time);
      const journalKey = `${timeframe}:${timestamp}`;
      if (!Number.isFinite(timestamp) || this.journalKeys.has(journalKey)) return;
      if (timeframe === "M5") await this._processM5(candle, true);
      else this._processM15(candle, true);
      this.journalKeys.add(journalKey);
      this.candleJournal.push({ timeframe, candle: { ...candle, timestamp } });
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
    if (live) {
      notifyDiscord(`**M15 candle closed: ${this.symbol}**\nTime: ${candle.time}\nO: ${candle.open} | H: ${candle.high} | L: ${candle.low} | C: ${candle.close}`);
    }
    if (live && result.swing) {
      console.info(`[strategy] ${result.swing.type} ${result.swing.classification ?? ""} ${result.swing.price} @ ${result.swing.swingTime}; confirmed ${result.swing.detectedAt}.`);
      notifyDiscord(`**M15 swing confirmed: ${this.symbol}**\n${result.swing.type} ${result.swing.classification ?? ""} at ${result.swing.price}\nSwing time: ${result.swing.swingTime}\nDetected: ${result.swing.detectedAt}`);
    }
    if (live && result.structureEvent) {
      console.info(`[strategy] ${result.structureEvent.kind} ${result.structureEvent.direction} @ ${result.structureEvent.time}.`);
      notifyDiscord(`**${result.structureEvent.kind}: ${result.structureEvent.direction}**\nSymbol: ${this.symbol}\nTime: ${result.structureEvent.time}\nBroken level: ${result.structureEvent.brokenPrice} | Close: ${result.structureEvent.breakClose}`);
    }
    if (live) {
      for (const ob of this.market.obManager.orderBlocks.slice(previousObCount)) {
        console.info(`[strategy] 15m ${ob.obType} OB #${ob.id} ${ob.low}-${ob.high} @ ${ob.time}; ${ob.discoverySource}.`);
        notifyDiscord(`**15M order block created: ${this.symbol}**\n${ob.obType} OB #${ob.id}: ${ob.low} - ${ob.high}\nStatus: ${ob.status}\nSource: ${ob.discoverySource}\nTime: ${ob.time}`);
      }
    }
    for (const alert of result.obAlerts) {
      if (live) console.info(`[strategy] 15m OB #${alert.ob.id} invalidated at ${candle.time}: ${alert.note}`);
      if (live) notifyDiscord(`**15M order block invalidated: ${this.symbol}**\nOB #${alert.ob.id} (${alert.ob.obType})\n${alert.note}\nTime: ${candle.time}`);
      this.watcher.invalidateZonesForParent(alert.ob.id);
    }

    const activeParent = this._syncActiveParent();    
    if (!activeParent) return;
    activeParent.overlapping5mOBs = this.fvg5m.confirmed.filter(fvg =>
      fvg.obType === activeParent.obType &&
      zonesOverlap(activeParent.low, activeParent.high, fvg.low, fvg.high)
    );
    const registeredZones = this.watcher.registerFromParent(activeParent);
    if (live) {
      for (const zone of registeredZones) {
        notifyDiscord(`**M5 zone linked to active 15M OB**\nSymbol: ${this.symbol}\nM5 ${zone.obType}: ${zone.low} - ${zone.high}\nParent OB #${zone.parentOBId}\nConfirmed: ${zone.confirmedAt}`);
      }
    }
  }

  async _processM5(candle, live) {
    const normalized = { ...candle, index: ++this.fiveMinuteIndex };
    const newFvgs = this.fvg5m.onCandle(normalized, normalized.index);
    if (live) {
      notifyDiscord(`**M5 candle closed: ${this.symbol}**\nTime: ${candle.time}\nO: ${candle.open} | H: ${candle.high} | L: ${candle.low} | C: ${candle.close}`);
    }
    if (live && newFvgs?.length) {
      for (const fvg of newFvgs) {
        notifyDiscord(`**M5 FVG confirmed: ${this.symbol}**\n${fvg.obType}: ${fvg.low} - ${fvg.high}\nFormed: ${fvg.time} | Confirmed: ${fvg.confirmedAt}`);
      }
    }
    if (newFvgs?.length) {
      const activeParent = this.market.obManager.orderBlocks.find(ob => ob.status === "active");
      if (activeParent) {
        const overlapping = newFvgs.filter(fvg =>
          fvg.obType === activeParent.obType &&
          zonesOverlap(activeParent.low, activeParent.high, fvg.low, fvg.high)
        );
        if (overlapping.length) {
          activeParent.overlapping5mOBs.push(...overlapping);
          const registeredZones = this.watcher.registerFromParent(activeParent);
          if (live) {
            for (const zone of registeredZones) {
              notifyDiscord(`**M5 zone linked to active 15M OB**\nSymbol: ${this.symbol}\nM5 ${zone.obType}: ${zone.low} - ${zone.high}\nParent OB #${zone.parentOBId}\nConfirmed: ${zone.confirmedAt}`);
            }
          }
        }
      }
    }

    this._syncActiveParent();
    const hadOpenTrade = Boolean(this.tradeManager.openTrade);
    const alerts = this.watcher.onCandle(normalized);
    if (live) {
      for (const alert of alerts) {
        if (alert.type === "touched") {
          console.info(`[strategy] ${alert.note} @ ${candle.time}; parent OB #${alert.zone.parentOBId}.`);
          notifyDiscord(`**M5 order block touched: ${this.symbol}**\n${alert.zone.obType}: ${alert.zone.low} - ${alert.zone.high}\nParent OB #${alert.zone.parentOBId}\nTime: ${candle.time}`);
        } else if (alert.type === "invalidated") {
          console.info(`[strategy] 5m zone invalidated @ ${candle.time}: ${alert.note}`);
          notifyDiscord(`**M5 zone invalidated: ${this.symbol}**\n${alert.note}\nZone: ${alert.zone.low} - ${alert.zone.high}\nTime: ${candle.time}`);
        } else if (alert.type === "BUY_SIGNAL" || alert.type === "SELL_SIGNAL") {
          notifyDiscord(`**${alert.type}: ${this.symbol}**\nPattern: ${alert.zone.pattern}\nZone: ${alert.zone.low} - ${alert.zone.high}\nParent OB #${alert.zone.parentOBId}\nTime: ${candle.time}`);
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