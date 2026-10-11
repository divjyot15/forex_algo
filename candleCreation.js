import dotenv from "dotenv";

dotenv.config();

import {
    initConnection,
    initStreamingConnection
} from "./src/connection/metaapi.js";


// =============================================================================
// CONFIG
// =============================================================================

const SYMBOL = "XAUUSD";


// =============================================================================
// TIMEFRAMES
// =============================================================================

const TIMEFRAMES = {

    M1: 1,

    M5: 5,

    M15: 15

};


// =============================================================================
// CANDLE STORAGE
// =============================================================================

const candles = {

    M1: new Map(),

    M5: new Map(),

    M15: new Map()

};


// =============================================================================
// FIRST LIVE BUCKETS
// =============================================================================
//
// These are the candle buckets that were already in progress when
// the application started.
//
// They must NOT be emitted as completed candles.
//

const initialBuckets = {

    M1: null,

    M5: null,

    M15: null

};


// =============================================================================
// FIRST TICK RECEIVED
// =============================================================================

let firstTickTimestamp = null;


// =============================================================================
// LATEST BROKER TIMESTAMP
// =============================================================================

let latestBrokerTimestamp = 0;


// =============================================================================
// DUPLICATE TICKS
// =============================================================================

const processedTicks =
    new Set();


// =============================================================================
// GET BROKER TIMESTAMP
// =============================================================================

function getBrokerTimestamp(brokerTime) {

    if (!brokerTime) {

        return null;

    }


    const match =
        brokerTime.match(
            /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
        );


    if (!match) {

        return null;

    }


    const [

        ,
        year,
        month,
        day,
        hour,
        minute,
        second,
        milliseconds = "0"

    ] = match;


    return Date.UTC(

        Number(year),

        Number(month) - 1,

        Number(day),

        Number(hour),

        Number(minute),

        Number(second),

        Number(
            milliseconds.padEnd(
                3,
                "0"
            )
        )

    );

}


// =============================================================================
// GET CANDLE BUCKET
// =============================================================================

function getCandleBucket(
    timestamp,
    timeframeMinutes
) {

    const timeframeMs =
        timeframeMinutes *
        60 *
        1000;


    return (
        Math.floor(
            timestamp / timeframeMs
        ) * timeframeMs
    );

}


// =============================================================================
// FORMAT BROKER TIME
// =============================================================================

function formatBrokerTime(timestamp) {

    const date =
        new Date(timestamp);


    const year =
        date.getUTCFullYear();


    const month =
        String(
            date.getUTCMonth() + 1
        ).padStart(
            2,
            "0"
        );


    const day =
        String(
            date.getUTCDate()
        ).padStart(
            2,
            "0"
        );


    const hour =
        String(
            date.getUTCHours()
        ).padStart(
            2,
            "0"
        );


    const minute =
        String(
            date.getUTCMinutes()
        ).padStart(
            2,
            "0"
        );


    const second =
        String(
            date.getUTCSeconds()
        ).padStart(
            2,
            "0"
        );


    return (
        `${year}-${month}-${day} ` +
        `${hour}:${minute}:${second}`
    );

}


// =============================================================================
// INITIALIZE FIRST BUCKETS
// =============================================================================

function initializeFirstBuckets(
    timestamp
) {

    if (
        firstTickTimestamp !== null
    ) {

        return;

    }


    firstTickTimestamp =
        timestamp;


    initialBuckets.M1 =
        getCandleBucket(
            timestamp,
            TIMEFRAMES.M1
        );


    initialBuckets.M5 =
        getCandleBucket(
            timestamp,
            TIMEFRAMES.M5
        );


    initialBuckets.M15 =
        getCandleBucket(
            timestamp,
            TIMEFRAMES.M15
        );


    console.log(
        "\n🟡 Initial live buckets:"
    );


    console.log(
        "M1 :",
        formatBrokerTime(
            initialBuckets.M1
        )
    );


    console.log(
        "M5 :",
        formatBrokerTime(
            initialBuckets.M5
        )
    );


    console.log(
        "M15:",
        formatBrokerTime(
            initialBuckets.M15
        )
    );


    console.log(
        ""
    );

}


// =============================================================================
// CREATE CANDLE
// =============================================================================

function createCandle(
    timestamp,
    tickTimestamp,
    price
) {

    return {

        timestamp,

        firstTickTimestamp:
            tickTimestamp,

        lastTickTimestamp:
            tickTimestamp,

        open:
            price,

        high:
            price,

        low:
            price,

        close:
            price,

        tickCount:
            1

    };

}


// =============================================================================
// UPDATE CANDLE
// =============================================================================

function updateCandle(
    candle,
    tickTimestamp,
    price
) {

    // =========================================================================
    // HIGH
    // =========================================================================

    candle.high =
        Math.max(
            candle.high,
            price
        );


    // =========================================================================
    // LOW
    // =========================================================================

    candle.low =
        Math.min(
            candle.low,
            price
        );


    // =========================================================================
    // EARLIEST TICK = OPEN
    // =========================================================================

    if (
        tickTimestamp <
        candle.firstTickTimestamp
    ) {

        candle.firstTickTimestamp =
            tickTimestamp;

        candle.open =
            price;

    }


    // =========================================================================
    // LATEST TICK = CLOSE
    // =========================================================================

    if (
        tickTimestamp >
        candle.lastTickTimestamp
    ) {

        candle.lastTickTimestamp =
            tickTimestamp;

        candle.close =
            price;

    }


    // =========================================================================
    // TICK COUNT
    // =========================================================================

    candle.tickCount++;

}


// =============================================================================
// PROCESS TICK FOR TIMEFRAME
// =============================================================================

function processTickForTimeframe(
    timeframeName,
    timeframeMinutes,
    tickTimestamp,
    price
) {

    const bucket =
        getCandleBucket(
            tickTimestamp,
            timeframeMinutes
        );


    // =========================================================================
    // GET TIMEFRAME STORAGE
    // =========================================================================

    const timeframeCandles =
        candles[
            timeframeName
        ];


    // =========================================================================
    // GET EXISTING CANDLE
    // =========================================================================

    let candle =
        timeframeCandles.get(
            bucket
        );


    // =========================================================================
    // CREATE CANDLE
    // =========================================================================

    if (!candle) {

        candle =
            createCandle(
                bucket,
                tickTimestamp,
                price
            );


        timeframeCandles.set(
            bucket,
            candle
        );

    }


    // =========================================================================
    // UPDATE CANDLE
    // =========================================================================

    else {

        updateCandle(
            candle,
            tickTimestamp,
            price
        );

    }

}


// =============================================================================
// PROCESS TICK
// =============================================================================

function processTick(price) {

    if (!price) {

        return;

    }


    if (
        price.symbol !==
        SYMBOL
    ) {

        return;

    }


    if (!price.brokerTime) {

        return;

    }


    // =========================================================================
    // BID
    // =========================================================================

    const bid =
        Number(
            price.bid
        );


    if (
        !Number.isFinite(
            bid
        )
    ) {

        return;

    }


    // =========================================================================
    // BROKER TIMESTAMP
    // =========================================================================

    const tickTimestamp =
        getBrokerTimestamp(
            price.brokerTime
        );


    if (
        tickTimestamp ===
        null
    ) {

        console.log(
            "⚠️ Invalid brokerTime:",
            price.brokerTime
        );

        return;

    }


    // =========================================================================
    // INITIALIZE FIRST BUCKETS
    // =========================================================================

    initializeFirstBuckets(
        tickTimestamp
    );


    // =========================================================================
    // DUPLICATE CHECK
    // =========================================================================

    const tickId =
        [

            price.symbol,

            price.brokerTime,

            price.bid,

            price.ask

        ].join("|");


    if (
        processedTicks.has(
            tickId
        )
    ) {

        return;

    }


    processedTicks.add(
        tickId
    );


    // =========================================================================
    // LATEST BROKER TIMESTAMP
    // =========================================================================

    if (
        tickTimestamp >
        latestBrokerTimestamp
    ) {

        latestBrokerTimestamp =
            tickTimestamp;

    }


    // =========================================================================
    // M1
    // =========================================================================

    processTickForTimeframe(

        "M1",

        TIMEFRAMES.M1,

        tickTimestamp,

        bid

    );


    // =========================================================================
    // M5
    // =========================================================================

    processTickForTimeframe(

        "M5",

        TIMEFRAMES.M5,

        tickTimestamp,

        bid

    );


    // =========================================================================
    // M15
    // =========================================================================

    processTickForTimeframe(

        "M15",

        TIMEFRAMES.M15,

        tickTimestamp,

        bid

    );


    // =========================================================================
    // CLOSE COMPLETED CANDLES
    // =========================================================================

    closeCompletedCandles();

}


// =============================================================================
// CLOSE COMPLETED CANDLES
// =============================================================================

function closeCompletedCandles() {

    if (
        !latestBrokerTimestamp
    ) {

        return;

    }


    // =========================================================================
    // ALLOW 3 SECONDS FOR LATE TICKS
    // =========================================================================

    const cutoff =
        latestBrokerTimestamp -
        3000;


    // =========================================================================
    // M1
    // =========================================================================

    closeTimeframeCandles(

        "M1",

        TIMEFRAMES.M1,

        cutoff

    );


    // =========================================================================
    // M5
    // =========================================================================

    closeTimeframeCandles(

        "M5",

        TIMEFRAMES.M5,

        cutoff

    );


    // =========================================================================
    // M15
    // =========================================================================

    closeTimeframeCandles(

        "M15",

        TIMEFRAMES.M15,

        cutoff

    );

}


// =============================================================================
// CLOSE TIMEFRAME CANDLES
// =============================================================================

function closeTimeframeCandles(

    timeframeName,

    timeframeMinutes,

    cutoff

) {

    const timeframeCandles =
        candles[
            timeframeName
        ];


    const timeframeMs =
        timeframeMinutes *
        60 *
        1000;


    const timestamps =
        [
            ...timeframeCandles.keys()
        ]
        .sort(
            (a, b) => a - b
        );


    for (
        const timestamp
        of timestamps
    ) {

        const candleEnd =
            timestamp +
            timeframeMs;


        // =====================================================================
        // CANDLE NOT FINISHED
        // =====================================================================

        if (
            candleEnd >
            cutoff
        ) {

            continue;

        }


        const candle =
            timeframeCandles.get(
                timestamp
            );


        if (!candle) {

            continue;

        }


        // =====================================================================
        // INITIAL PARTIAL CANDLE
        // =====================================================================
        //
        // If this is the bucket in which the application started,
        // we did not observe the beginning of that candle.
        //
        // Therefore it must NEVER be emitted as a completed candle.
        //

        if (
            timestamp ===
            initialBuckets[
                timeframeName
            ]
        ) {

            timeframeCandles.delete(
                timestamp
            );


            console.log(
                `⚠️ Ignoring initial partial ${timeframeName} candle:`,
                formatBrokerTime(
                    timestamp
                )
            );


            continue;

        }


        // =====================================================================
        // CLOSE VALID CANDLE
        // =====================================================================

        timeframeCandles.delete(
            timestamp
        );


        printCandle(

            timeframeName,

            candle

        );

    }

}


// =============================================================================
// PRINT CANDLE
// =============================================================================

function printCandle(
    timeframeName,
    candle
) {

    console.log(
        "\n================================================"
    );


    console.log(
        `             ${timeframeName} CANDLE CLOSED`
    );


    console.log(
        "================================================"
    );


    console.log(
        "Candle:",
        formatBrokerTime(
            candle.timestamp
        )
    );


    console.log(
        "First Tick:",
        formatBrokerTime(
            candle.firstTickTimestamp
        )
    );


    console.log(
        "Last Tick:",
        formatBrokerTime(
            candle.lastTickTimestamp
        )
    );


    console.log(
        "Open:",
        candle.open
    );


    console.log(
        "High:",
        candle.high
    );


    console.log(
        "Low:",
        candle.low
    );


    console.log(
        "Close:",
        candle.close
    );


    console.log(
        "Ticks:",
        candle.tickCount
    );


    console.log(
        "================================================\n"
    );

}


// =============================================================================
// CLEAN DUPLICATE TICK STORAGE
// =============================================================================

setInterval(

    () => {

        if (
            processedTicks.size >
            10000
        ) {

            processedTicks.clear();

        }

    },

    60 * 60 * 1000

);


// =============================================================================
// MAIN
// =============================================================================

async function main() {

    // =========================================================================
    // RPC
    // =========================================================================

    await initConnection();


    // =========================================================================
    // STREAMING
    // =========================================================================

    const streamingConnection =
        await initStreamingConnection();


    // =========================================================================
    // SUBSCRIBE
    // =========================================================================

    console.log(
        `\n⏳ Subscribing to ${SYMBOL}...`
    );


    await streamingConnection.subscribeToMarketData(
        SYMBOL
    );


    console.log(
        `\n✅ Subscribed to ${SYMBOL}`
    );


    // =========================================================================
    // LISTENER
    // =========================================================================

    streamingConnection.addSynchronizationListener({

        // ---------------------------------------------------------------------
        // SINGLE PRICE UPDATE
        // ---------------------------------------------------------------------

        async onSymbolPriceUpdated(
            instanceIndex,
            price
        ) {

            processTick(
                price
            );

        },


        // ---------------------------------------------------------------------
        // BATCH PRICE UPDATE
        // ---------------------------------------------------------------------

        async onSymbolPricesUpdated(
            instanceIndex,
            prices
        ) {

            // Intentionally ignored.

        },


        // ---------------------------------------------------------------------
        // SYMBOL SPECIFICATION
        // ---------------------------------------------------------------------

        async onSymbolSpecificationUpdated(
            instanceIndex,
            specification
        ) {

            // Nothing required.

        },


        // ---------------------------------------------------------------------
        // SYMBOL SPECIFICATIONS
        // ---------------------------------------------------------------------

        async onSymbolSpecificationsUpdated(
            instanceIndex,
            specifications
        ) {

            // Nothing required.

        },


        // ---------------------------------------------------------------------
        // BROKER CONNECTION
        // ---------------------------------------------------------------------

        async onBrokerConnectionStatusChanged(
            instanceIndex,
            connected
        ) {

            console.log(
                `🔌 Broker connection: ${
                    connected
                        ? "CONNECTED"
                        : "DISCONNECTED"
                }`
            );

        },


        // ---------------------------------------------------------------------
        // HEALTH
        // ---------------------------------------------------------------------

        async onHealthStatus(
            instanceIndex,
            status
        ) {

            // Nothing required.

        }

    });


    // =========================================================================
    // READY
    // =========================================================================

    console.log(
        "\n🟢 1m + 5m + 15m candle builder running...\n"
    );

}


// =============================================================================
// START
// =============================================================================

main().catch(

    error => {

        console.error(
            "\n❌ Candle builder failed:"
        );

        console.error(
            error
        );

        process.exit(1);

    }

);