export const TIMEFRAME_MINUTES = Object.freeze({ M5: 5, M15: 15 });
export const CANDLE_DELAY_MS = 3000;

export function brokerTimestamp(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const brokerTime = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
  if (brokerTime) {
    const [, year, month, day, hour, minute, second, milliseconds = "0"] = brokerTime;
    return Date.UTC(
      Number(year), Number(month) - 1, Number(day), Number(hour),
      Number(minute), Number(second), Number(milliseconds.padEnd(3, "0"))
    );
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function timeframeMilliseconds(timeframe) {
  const minutes = TIMEFRAME_MINUTES[timeframe];
  if (!minutes) throw new Error(`Unsupported timeframe: ${timeframe}`);
  return minutes * 60 * 1000;
}

export function bucketStart(timestamp, timeframe) {
  const duration = timeframeMilliseconds(timeframe);
  return Math.floor(timestamp / duration) * duration;
}

export function completedBucketRange(fromTimestamp, throughTimestamp, timeframe) {
  const duration = timeframeMilliseconds(timeframe);
  const first = bucketStart(fromTimestamp, timeframe);
  const cutoff = throughTimestamp - CANDLE_DELAY_MS;
  const last = Math.floor(cutoff / duration) * duration - duration;
  if (last < first) return { first, last, expected: [] };

  const expected = [];
  for (let timestamp = first; timestamp <= last; timestamp += duration) {
    expected.push(timestamp);
  }
  return { first, last, expected };
}

export function normalizeHistoricalCandle(raw, timeframe, symbol) {
  if (!raw || typeof raw !== "object") throw new Error(`Malformed ${timeframe} historical candle.`);
  const timestamp = brokerTimestamp(raw.brokerTime ?? raw.time ?? raw.timestamp);
  if (timestamp === null || timestamp % timeframeMilliseconds(timeframe) !== 0) {
    throw new Error(`Invalid or misaligned ${timeframe} historical candle timestamp.`);
  }

  const open = Number(raw.open);
  const high = Number(raw.high);
  const low = Number(raw.low);
  const close = Number(raw.close);
  if (![open, high, low, close].every(Number.isFinite) ||
    high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
    throw new Error(`Invalid OHLC values in ${timeframe} historical candle at ${new Date(timestamp).toISOString()}.`);
  }

  return {
    symbol,
    timeframe,
    time: new Date(timestamp).toISOString(),
    brokerTime: new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", ""),
    timestamp,
    open,
    high,
    low,
    close,
    tickCount: Number(raw.tickVolume ?? raw.volume ?? raw.tickCount ?? 0)
  };
}

export function validateHistoricalCoverage(rawCandles, timeframe, symbol, expectedTimestamps) {
  if (!Array.isArray(rawCandles)) throw new Error(`MetaApi returned no ${timeframe} candle array.`);
  const normalized = rawCandles.map(candle => normalizeHistoricalCandle(candle, timeframe, symbol));
  const byTimestamp = new Map(normalized.map(candle => [candle.timestamp, candle]));
  const missing = expectedTimestamps.filter(timestamp => !byTimestamp.has(timestamp));
  if (missing.length) {
    const sample = missing.slice(0, 5).map(timestamp => new Date(timestamp).toISOString()).join(", ");
    throw new Error(`Historical ${timeframe} data is missing ${missing.length} required candle(s): ${sample}`);
  }
  return expectedTimestamps.map(timestamp => byTimestamp.get(timestamp));
}

export function sortCandleEvents(events) {
  return [...events].sort((left, right) => {
    const leftDuration = timeframeMilliseconds(left.timeframe);
    const rightDuration = timeframeMilliseconds(right.timeframe);
    const leftClose = left.candle.timestamp + leftDuration;
    const rightClose = right.candle.timestamp + rightDuration;
    if (leftClose !== rightClose) return leftClose - rightClose;
    if (left.timeframe === right.timeframe) return left.candle.timestamp - right.candle.timestamp;
    return left.timeframe === "M5" ? -1 : 1;
  });
}