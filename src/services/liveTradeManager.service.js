import {
  closePositionPartially,
  getAccountInfo,
  getPrice,
  getPositions,
  getSymbolSpecification,
  modifyPosition,
  placeOrder
} from "./trader.service.js";
import { canTrade } from "./risk.service.js";

const SYMBOL = process.env.METAAPI_SYMBOL || "XAUUSD";
const STRATEGY_COMMENT = "strat";

function floorToStep(value, step) {
  const precision = Math.max(0, (String(step).split(".")[1] || "").length);
  return Number((Math.floor((value + Number.EPSILON) / step) * step).toFixed(precision));
}

function roundToTick(price, tickSize, direction, role) {
  const scaled = price / tickSize;
  const roundDown = role === "stop" ? direction === "BUY" : direction === "SELL";
  const rounded = roundDown ? Math.floor(scaled) : Math.ceil(scaled);
  return Number((rounded * tickSize).toFixed(8));
}

function isBuyPosition(position) {
  return String(position.type).toUpperCase().includes("BUY");
}

export class LiveTradeManager {
  constructor({
    symbol = SYMBOL,
    riskPercent = Number(process.env.STRATEGY_RISK_PERCENT || 0.75),
    pipSize = Number(process.env.STRATEGY_PIP_SIZE || 0.10),
    stopBuffer = Number(process.env.STRATEGY_SL_BUFFER_PRICE || 0.50),
    tp1Pips = Number(process.env.STRATEGY_TP1_PIPS || 95),
    tp2Pips = Number(process.env.STRATEGY_TP2_PIPS || 120),
    maxLots = Number(process.env.STRATEGY_MAX_LOTS || 1)
  } = {}) {
    this.symbol = symbol;
    this.riskPercent = riskPercent;
    this.pipSize = pipSize;
    this.stopBuffer = stopBuffer;
    this.tp1Pips = tp1Pips;
    this.tp2Pips = tp2Pips;
    this.maxLots = maxLots;
    this.tradingEnabled = process.env.LIVE_STRATEGY_TRADING_ENABLED === "true";
    this.specification = null;
    this.openTrade = null;
  }

  async initialize() {
    if (![this.riskPercent, this.pipSize, this.stopBuffer, this.tp1Pips, this.tp2Pips, this.maxLots].every(Number.isFinite) ||
      this.riskPercent <= 0 || this.riskPercent > 4.5 || this.pipSize <= 0 || this.stopBuffer < 0 ||
      this.tp1Pips <= 0 || this.tp2Pips <= this.tp1Pips || this.maxLots <= 0) {
      throw new Error("Invalid live strategy risk, stop, target, or volume configuration.");
    }

    this.specification = await getSymbolSpecification(this.symbol);
    if (!this.specification?.contractSize || !this.specification?.volumeStep || !this.specification?.tickSize) {
      throw new Error(`Incomplete MetaApi symbol specification for ${this.symbol}`);
    }

    if (this.tradingEnabled) await this._restoreOpenTrade();
    console.info(`[strategy] Live trade manager ready for ${this.symbol}; order execution ${this.tradingEnabled ? "ENABLED" : "DISABLED"}.`);
  }

  async onSignal(signal, candle) {
    const direction = signal.obType === "bullish" ? "BUY" : "SELL";
    console.info(`[strategy] ${direction} signal ${signal.pattern} at ${candle.close}; zone ${signal.low}-${signal.high}; parent OB #${signal.parentOBId}.`);

    if (!this.tradingEnabled) {
      console.info("[strategy] Signal observed only; set LIVE_STRATEGY_TRADING_ENABLED=true to place orders.");
      return null;
    }
    if (this.openTrade) {
      console.warn(`[strategy] Signal ignored; managed position ${this.openTrade.positionId ?? "pending"} is still open.`);
      return null;
    }

    const quote = await getPrice(this.symbol);
    const entryEstimate = Number(direction === "BUY" ? quote.ask : quote.bid);
    const stop = direction === "BUY"
      ? Number(signal.low) - this.stopBuffer
      : Number(signal.high) + this.stopBuffer;
    if (!Number.isFinite(entryEstimate) || !Number.isFinite(stop) || (direction === "BUY" ? stop >= entryEstimate : stop <= entryEstimate)) {
      console.warn(`[strategy] ${direction} signal rejected because its stop is not on the protective side of the close.`);
      return null;
    }

    const stopDistance = Math.abs(entryEstimate - stop);
    const account = await getAccountInfo();
    const profitCurrency = this.specification.currencyProfit || process.env.STRATEGY_PROFIT_CURRENCY || "USD";
    if (account.currency !== profitCurrency) {
      console.warn(`[strategy] Signal rejected: risk sizing assumes ${profitCurrency} profit currency, account currency is ${account.currency}.`);
      return null;
    }
    const riskAmount = account.balance * this.riskPercent / 100;
    const riskPerLot = stopDistance * this.specification.contractSize;
    const rawLots = riskAmount / riskPerLot;
    const cap = Math.min(this.maxLots, this.specification.maxVolume);
    const volume = floorToStep(Math.min(rawLots, cap), this.specification.volumeStep);
    if (!Number.isFinite(volume) || volume < this.specification.minVolume) {
      console.warn(`[strategy] Signal rejected: calculated volume ${volume} is below broker minimum ${this.specification.minVolume}.`);
      return null;
    }

    const partialVolume = floorToStep(volume * 0.5, this.specification.volumeStep);
    const remainingVolume = Number((volume - partialVolume).toFixed(8));
    if (partialVolume < this.specification.minVolume || remainingVolume < this.specification.minVolume) {
      console.warn(`[strategy] Signal rejected: ${volume} lots cannot be split into two broker-valid partial exits.`);
      return null;
    }

    const positions = await getPositions();
    const existingStrategyPosition = positions.find(position =>
      position.symbol === this.symbol && position.comment === STRATEGY_COMMENT
    );
    if (existingStrategyPosition) {
      console.error(`[strategy] Existing strategy position ${existingStrategyPosition.id} was not reconciled; refusing a second order.`);
      return null;
    }
    const permission = await canTrade(volume, positions.length);
    if (!permission.allowed) {
      console.warn(`[strategy] Signal rejected by risk manager: ${permission.reason}.`);
      return null;
    }

    const target2Estimate = entryEstimate + (direction === "BUY" ? 1 : -1) * this.tp2Pips * this.pipSize;
    const stopLoss = roundToTick(stop, this.specification.tickSize, direction, "stop");
    const target2 = roundToTick(target2Estimate, this.specification.tickSize, direction, "target");
    const clientId = `LS${Date.now().toString(36)}`;

    const response = await placeOrder({
      symbol: this.symbol,
      type: direction,
      volume,
      sl: stopLoss,
      tp: target2,
      comment: STRATEGY_COMMENT,
      clientId
    });

    const trade = {
      clientId,
      positionId: response.positionId ? String(response.positionId) : null,
      direction,
      entry: entryEstimate,
      volume,
      partialVolume,
      remainingVolume,
      stopLoss,
      target1: null,
      target2,
      tp1Hit: false,
      signalTime: signal.signalAt,
      parentOBId: signal.parentOBId
    };
    this.openTrade = trade;
    await this._syncFillDetails(trade);

    console.info(`[strategy] Opened ${direction} ${volume} ${this.symbol}; position ${trade.positionId ?? "unresolved"}; SL ${trade.stopLoss}; TP2 ${trade.target2}; risk about ${riskAmount.toFixed(2)} ${account.currency}.`);
    return trade;
  }

  async onClosedM5Candle(candle) {
    const trade = this.openTrade;
    if (!trade || !this.tradingEnabled) return;

    if (!trade.target1 || !trade.positionId) {
      await this._syncFillDetails(trade);
      if (!trade.target1 || !trade.positionId) return;
    }

    const positions = await getPositions();
    const position = positions.find(item =>
      (trade.positionId && String(item.id) === trade.positionId) || item.clientId === trade.clientId
    );
    if (!position) {
      console.info(`[strategy] Managed position ${trade.positionId ?? trade.clientId} is no longer open; broker SL/TP or manual close completed it.`);
      this.openTrade = null;
      return;
    }
    trade.positionId = String(position.id);

    if (trade.tp1Hit) return;
    const stopWasHit = trade.direction === "BUY"
      ? candle.low <= trade.stopLoss
      : candle.high >= trade.stopLoss;
    const targetWasHit = trade.direction === "BUY"
      ? candle.high >= trade.target1
      : candle.low <= trade.target1;

    if (stopWasHit) {
      console.warn(`[strategy] M5 candle crossed the active stop for position ${trade.positionId}; broker-side SL remains authoritative.`);
      return;
    }
    if (!targetWasHit) return;

    await modifyPosition(id, { sl: trade.entry, tp: trade.target2 })
    trade.tp1Hit = true;    
    try {
      await closePositionPartially(trade.positionId, trade.partialVolume, STRATEGY_COMMENT);
      console.info(`[strategy] TP1 reached for position ${trade.positionId}; closed ${trade.partialVolume} lots and moved SL to entry ${trade.entry}.`);
    } catch (error) {
      console.error(`[strategy] TP1 partial close failed for position ${trade.positionId}; the remaining position is protected at breakeven:`, error);
    }
  }

  async _syncFillDetails(trade) {
    const positions = await getPositions();
    const position = positions.find(item =>
      (trade.positionId && String(item.id) === trade.positionId) || item.clientId === trade.clientId
    );
    if (!position) {
      console.error(`[strategy] Could not resolve broker position for ${trade.clientId}; submitted SL/TP remain in place, but automated TP1 management is unavailable.`);
      return;
    }

    trade.positionId = String(position.id);
    trade.entry = Number(position.openPrice);
    trade.stopLoss = Number(position.sl ?? trade.stopLoss);
    trade.target2 = Number(position.tp ?? trade.target2);
    trade.target1 = roundToTick(
      trade.entry + (trade.direction === "BUY" ? 1 : -1) * this.tp1Pips * this.pipSize,
      this.specification.tickSize,
      trade.direction,
      "target"
    );
    const breakeven = Math.abs(trade.stopLoss - trade.entry) <= this.specification.tickSize / 2;
    if (breakeven) trade.tp1Hit = true;

    const target2 = roundToTick(
      trade.entry + (trade.direction === "BUY" ? 1 : -1) * this.tp2Pips * this.pipSize,
      this.specification.tickSize,
      trade.direction,
      "target"
    );
    if (Math.abs(target2 - trade.target2) > this.specification.tickSize / 2) {
      await modifyPosition(trade.positionId, { sl: trade.stopLoss, tp: target2 });
      trade.target2 = target2;
    }
  }

  async _restoreOpenTrade() {
    const positions = await getPositions();
    const position = positions.find(item => item.symbol === this.symbol && item.comment === STRATEGY_COMMENT && item.clientId?.startsWith("LS"));
    if (!position) return;
    if (!Number.isFinite(Number(position.openPrice)) || !Number.isFinite(Number(position.sl)) || !Number.isFinite(Number(position.tp))) {
      throw new Error(`Managed position ${position.id} is missing broker-side entry, stop-loss, or take-profit data.`);
    }

    const direction = isBuyPosition(position) ? "BUY" : "SELL";
    const volume = Number(position.volume);
    this.openTrade = {
      clientId: position.clientId,
      positionId: String(position.id),
      direction,
      entry: Number(position.openPrice),
      volume,
      partialVolume: floorToStep(volume * 0.5, this.specification.volumeStep),
      remainingVolume: Number((volume - floorToStep(volume * 0.5, this.specification.volumeStep)).toFixed(8)),
      stopLoss: Number(position.sl),
      target1: null,
      target2: Number(position.tp),
      tp1Hit: Math.abs(Number(position.sl) - Number(position.openPrice)) <= this.specification.tickSize / 2
    };
    this.openTrade.target1 = roundToTick(
      this.openTrade.entry + (direction === "BUY" ? 1 : -1) * this.tp1Pips * this.pipSize,
      this.specification.tickSize,
      direction,
      "target"
    );
    console.warn(`[strategy] Restored managed ${direction} position ${position.id}; TP1 state ${this.openTrade.tp1Hit ? "already reached" : "pending"}.`);
  }
}

export const liveStrategyTradingEnabled = process.env.LIVE_STRATEGY_TRADING_ENABLED === "true";