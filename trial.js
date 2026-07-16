import dotenv from "dotenv";
dotenv.config();

import { getConnection, getAccount, initConnection } from "./src/connection/metaapi.js";
let connection  = await initConnection();

const getHistoricalCandles = async () =>{
try {
    console.log("⏳ Connecting to MT5 via MetaApi...");

    const account =  getAccount();

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

  console.log("Swing Highs:", swingHighs);
  console.log("Swing Lows:", swingLows);
  return { swingHighs, swingLows };
}


let lastSwingType = null; // "HIGH" | "LOW" | null

export function detectLatestSwing(candles) {

    if (candles.length < 5) return null;

    const c = candles.slice(-5);
    const colors = c.map(getCandleColor);

    // ----------------------------
    // Swing HIGH
    // ----------------------------

    const isSwingHigh =
        (colors.join(",") === "green,green,green,red,red") ||
        (colors.join(",") === "green,green,red,red,red");

    if (isSwingHigh && lastSwingType !== "HIGH") {

        const greenCount = colors[2] === "green" ? 3 : 2;

        const peak = c
            .slice(0, greenCount)
            .reduce((max, cur) =>
                cur.high > max.high ? cur : max
            );

        lastSwingType = "HIGH";

        return {
            type: "HIGH",
            swingTime: peak.time,
            detectedAt: c[4].time,
            price: peak.high,
            pattern: colors.join("+")
        };
    }

    // ----------------------------
    // Swing LOW
    // ----------------------------

    const isSwingLow =
        (colors.join(",") === "red,red,red,green,green") ||
        (colors.join(",") === "red,red,green,green,green");

    if (isSwingLow && lastSwingType !== "LOW") {

        const redCount = colors[2] === "red" ? 3 : 2;

        const trough = c
            .slice(0, redCount)
            .reduce((min, cur) =>
                cur.low < min.low ? cur : min
            );

        lastSwingType = "LOW";

        return {
            type: "LOW",
            swingTime: trough.time,
            detectedAt: c[4].time,
            price: trough.low,
            pattern: colors.join("+")
        };
    }

    return null;
}

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

async function main() {

    let historicalCandles = await getHistoricalCandles();

    if (historicalCandles) {
        const swings = [];

        for (let i = 4; i < historicalCandles.length; i++) {

            const history = historicalCandles.slice(0, i + 1);

            const swing = detectLatestSwing(history);

            if (swing) {
                swings.push(swing);

                console.log(
                    swing.type,
                    swing.price,
                    toIST(swing.swingTime),
                    toIST(swing.detectedAt)
                );
            }
        }

        console.table(swings);
    }
}

main();