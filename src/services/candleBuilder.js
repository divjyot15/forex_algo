const CANDLE_MINUTES = 15;
const MAX_CANDLES = 200;

// Store candles & current forming candle per symbol
const candleStore = {};      // { XAUUSD: [...completed candles] }
const currentCandles = {};   // { XAUUSD: { time, open, high, low, close } }

const closeListeners = [];   // callbacks for when a candle closes

export function onCandleClose(callback) {
  closeListeners.push(callback);
}

function getBucket(timestamp) {
  const ms = CANDLE_MINUTES * 60 * 1000;
  return Math.floor(new Date(timestamp).getTime() / ms) * ms;
}

function getCandleColor(candle) {
  return candle.close >= candle.open ? 'green' : 'red';
}

function detectSwings(candles) {
  const swingHighs = [];
  const swingLows  = [];

  for (let i = 4; i < candles.length; i++) {
    const c      = candles.slice(i - 4, i + 1);
    const colors = c.map(getCandleColor);

    const isSwingHigh =
      (colors[0] === 'green' && colors[1] === 'green' && colors[2] === 'green' && colors[3] === 'red' && colors[4] === 'red') ||
      (colors[0] === 'green' && colors[1] === 'green' && colors[2] === 'red'   && colors[3] === 'red' && colors[4] === 'red');

    const isSwingLow =
      (colors[0] === 'red' && colors[1] === 'red' && colors[2] === 'red'   && colors[3] === 'green' && colors[4] === 'green') ||
      (colors[0] === 'red' && colors[1] === 'red' && colors[2] === 'green' && colors[3] === 'green' && colors[4] === 'green');

    if (isSwingHigh) {
      const greenCount = colors[2] === 'green' ? 3 : 2;
      const greenCandles = c.slice(0, greenCount);
      const peak = greenCandles.reduce((max, cur) => cur.high > max.high ? cur : max);
      swingHighs.push({ time: peak.time, price: peak.high, pattern: colors.join('+') });
    }

    if (isSwingLow) {
      const redCount = colors[2] === 'red' ? 3 : 2;
      const redCandles = c.slice(0, redCount);
      const trough = redCandles.reduce((min, cur) => cur.low < min.low ? cur : min);
      swingLows.push({ time: trough.time, price: trough.low, pattern: colors.join('+') });
    }
  }

  return { swingHighs, swingLows };
}

function onCandleClosed(symbol, candle, allCandles) {
  console.log(`✅ [${symbol}] Candle closed: O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close}`);

  if (allCandles.length < 5) return;

  const { swingHighs, swingLows } = detectSwings(allCandles);

  const lastHigh = swingHighs.at(-1);
  const lastLow  = swingLows.at(-1);

  if (lastHigh) console.log(`📈 [${symbol}] Swing HIGH: ${lastHigh.price} | ${lastHigh.pattern}`);
  if (lastLow)  console.log(`📉 [${symbol}] Swing LOW:  ${lastLow.price}  | ${lastLow.pattern}`);

  // Fire all registered onCandleClose listeners
  closeListeners.forEach(fn => fn({ symbol, candle, candles: allCandles, swingHighs, swingLows }));
}

// This is what you plug into your existing onTick
export function handleTick(tick) {
  const { symbol, bid, ask, time } = tick;
  const price  = (bid + ask) / 2;
  const bucket = getBucket(time);

  if (!candleStore[symbol])   candleStore[symbol]   = [];
  if (!currentCandles[symbol]) currentCandles[symbol] = null;

  const current = currentCandles[symbol];

  if (!current) {
    // First tick for this symbol
    currentCandles[symbol] = { time: new Date(bucket), open: price, high: price, low: price, close: price };

  } else if (bucket === current.time.getTime()) {
    // Same candle — update
    current.high  = Math.max(current.high, price);
    current.low   = Math.min(current.low, price);
    current.close = price;

  } else {
    // New bucket — close the current candle
    const completed = { ...current };
    candleStore[symbol].push(completed);
    if (candleStore[symbol].length > MAX_CANDLES) candleStore[symbol].shift();

    onCandleClosed(symbol, completed, [...candleStore[symbol]]);

    // Start fresh candle
    currentCandles[symbol] = { time: new Date(bucket), open: price, high: price, low: price, close: price };
  }
}