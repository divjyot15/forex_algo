import dotenv from "dotenv";
dotenv.config();

import {
    getAccount,
    initConnection
} from "./src/connection/metaapi.js";


// =============================================================================
// CONNECTION
// =============================================================================

let connection = await initConnection();


// =============================================================================
// HISTORICAL CANDLES
// =============================================================================

// =============================================================================
// HISTORICAL CANDLES
// =============================================================================

const getHistoricalCandles = async (timeframe = "15m") => {

    try {

        console.log(
            `⏳ Fetching full August 2026 ${timeframe} candles via MetaApi...`
        );

        const account = getAccount();

        // ================================================================
        // TARGET BACKTEST RANGE
        // ================================================================

        const startDate = new Date(
            "2026-08-01T00:00:00.000Z"
        );

        const endDate = new Date(
            "2026-09-01T00:00:00.000Z"
        );

        const LIMIT = 1000;

        let currentEnd = endDate;
        let allCandles = [];

        // ================================================================
        // PAGINATE BACKWARDS
        // ================================================================

        while (currentEnd > startDate) {

            console.log(
                `\n📥 ${timeframe}: requesting candles before ` +
                `${currentEnd.toISOString()}`
            );

            const candles =
                await account.getHistoricalCandles(
                    "XAUUSD",
                    timeframe,
                    currentEnd,
                    LIMIT
                );

            if (!candles || candles.length === 0) {

                console.log(
                    `⚠️ ${timeframe}: MetaApi returned no candles.`
                );

                break;
            }

            console.log(
                `   Received: ${candles.length} candles`
            );

            console.log(
                `   First: ${candles[0].time}`
            );

            console.log(
                `   Last:  ${candles[candles.length - 1].time}`
            );

            // ============================================================
            // ADD BATCH
            // ============================================================

            allCandles.push(...candles);

            // ============================================================
            // FIND OLDEST CANDLE IN THIS BATCH
            // ============================================================

            let oldestCandle = candles[0];

            for (const candle of candles) {

                if (
                    new Date(candle.time).getTime() <
                    new Date(oldestCandle.time).getTime()
                ) {
                    oldestCandle = candle;
                }
            }

            const oldestTime =
                new Date(oldestCandle.time);

            console.log(
                `   Oldest in batch: ${oldestTime.toISOString()}`
            );

            // ============================================================
            // WE HAVE REACHED THE START OF AUGUST
            // ============================================================

            if (oldestTime <= startDate) {
                break;
            }

            // ============================================================
            // MOVE PAGINATION WINDOW BACKWARD
            // ============================================================

            currentEnd = oldestTime;

            // ============================================================
            // SAFETY CHECK
            // ============================================================

            if (currentEnd >= endDate) {

                console.log(
                    "⚠️ Pagination did not move backwards."
                );

                break;
            }
        }

        // ================================================================
        // FILTER TO EXACT AUGUST RANGE
        // ================================================================

        allCandles = allCandles.filter(candle => {

            const time = new Date(candle.time);

            return (
                time >= startDate &&
                time < endDate
            );
        });

        // ================================================================
        // REMOVE DUPLICATE CANDLES
        // ================================================================

        const uniqueCandles = new Map();

        for (const candle of allCandles) {

            const timestamp =
                new Date(candle.time).getTime();

            uniqueCandles.set(timestamp, candle);
        }

        allCandles =
            Array.from(uniqueCandles.values());

        // ================================================================
        // SORT OLDEST → NEWEST
        // ================================================================

        allCandles.sort(
            (a, b) =>
                new Date(a.time).getTime() -
                new Date(b.time).getTime()
        );

        // ================================================================
        // FINAL RESULT
        // ================================================================

        console.log(
            `\n==================================================`
        );

        console.log(
            `FINAL ${timeframe} DATASET`
        );

        console.log(
            `==================================================`
        );

        console.log(
            `Total candles: ${allCandles.length}`
        );

        if (allCandles.length > 0) {

            console.log(
                `FIRST: ${allCandles[0].time}`
            );

            console.log(
                `LAST:  ${
                    allCandles[allCandles.length - 1].time
                }`
            );
        }

        console.log(
            `==================================================\n`
        );

        return allCandles;

    } catch (err) {

        console.error(
            `❌ Failed fetching ${timeframe} candles`
        );

        console.error(err.stack);

        return [];
    }
};

await getHistoricalCandles("15m");
await getHistoricalCandles("5m");