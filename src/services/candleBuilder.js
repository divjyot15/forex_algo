// =============================================================================
// CONFIG
// =============================================================================

const SYMBOL =
    process.env.METAAPI_SYMBOL || "XAUUSD";


// =============================================================================
// CANDLE CONFIGURATION
// =============================================================================

const TIMEFRAMES = {

    M5: 5,

    M15: 15

};


// =============================================================================
// LATE TICK BUFFER
// =============================================================================
//
// We wait until the broker timestamp has moved at least 3 seconds beyond
// a candle's end before declaring that candle closed.
//
// This gives delayed/out-of-order ticks a small window to arrive.
//

const CANDLE_DELAY_MS = 3000;


// =============================================================================
// CANDLE STORAGE
// =============================================================================
//
// M5:
//     timestamp -> candle
//
// M15:
//     timestamp -> candle
//

const candles = {

    M5: new Map(),

    M15: new Map()

};


// =============================================================================
// INITIAL PARTIAL BUCKETS
// =============================================================================
//
// The first tick may arrive in the middle of a candle.
//
// Example:
//
// Bot starts:
// 19:04:12
//
// M5 bucket:
// 19:00
//
// We did NOT observe 19:00 → 19:04:11.
//
// Therefore that M5 candle cannot be used by the live strategy.
//

const initialBuckets = {

    M5: null,

    M15: null

};


// =============================================================================
// FIRST TICK
// =============================================================================

let firstTickTimestamp = null;


// =============================================================================
// LATEST BROKER TIMESTAMP
// =============================================================================

let latestBrokerTimestamp = 0;


// =============================================================================
// LAST CLOSED CANDLE
// =============================================================================
//
// Used to reject a very late tick that arrives after its candle has already
// been emitted to the strategy.
//

const lastClosedTimestamp = {

    M5: null,

    M15: null

};


// =============================================================================
// DUPLICATE TICKS
// =============================================================================

const processedTicks =
    new Set();


// =============================================================================
// CANDLE LISTENERS
// =============================================================================

const candleListeners =
    new Set();


// =============================================================================
// REGISTER CANDLE LISTENER
// =============================================================================
//
// Example:
//
// onCandle((timeframe, candle) => {
//
//     if (timeframe === "M5") {
//         ...
//     }
//
// });
//

export function onCandle(listener) {

    if (
        typeof listener !== "function"
    ) {

        throw new TypeError(
            "onCandle(listener) requires a function."
        );

    }


    candleListeners.add(
        listener
    );


    // Return unsubscribe function.
    return () => {

        candleListeners.delete(
            listener
        );

    };

}


// =============================================================================
// EMIT CANDLE
// =============================================================================

async function emitCandle(
    timeframe,
    candle
) {

    for (
        const listener
        of candleListeners
    ) {

        try {

            await listener(
                timeframe,
                candle
            );

        } catch (error) {

            console.error(
                `❌ ${timeframe} candle listener error:`,
                error
            );

        }

    }

}


// =============================================================================
// GET BROKER TIMESTAMP
// =============================================================================

function getBrokerTimestamp(
    brokerTime
) {

    if (!brokerTime) {

        return null;

    }


    /*
        Example:

        2026-09-24 19:05:42.123
    */


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
            timestamp /
            timeframeMs
        ) *
        timeframeMs
    );

}


// =============================================================================
// FORMAT BROKER TIME
// =============================================================================

function formatBrokerTime(
    timestamp
) {

    const date =
        new Date(
            timestamp
        );


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
        "\n🟡 Candle builder initial buckets:"
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

        symbol: SYMBOL,

        timeframe: null,

        time: new Date(
            timestamp
        ).toISOString(),

        brokerTime:
            formatBrokerTime(
                timestamp
            ),

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
    // ALREADY CLOSED?
    // =========================================================================
    //
    // If a very late tick arrives for a candle that we already emitted,
    // we cannot modify the candle that the strategy already consumed.
    //

    if (
        lastClosedTimestamp[
            timeframeName
        ] !== null &&
        bucket <=
        lastClosedTimestamp[
            timeframeName
        ]
    ) {

        console.log(
            `⚠️ Late ${timeframeName} tick ignored:`,
            formatBrokerTime(
                tickTimestamp
            )
        );

        return;

    }


    // =========================================================================
    // STORAGE
    // =========================================================================

    const timeframeCandles =
        candles[
            timeframeName
        ];


    // =========================================================================
    // EXISTING CANDLE
    // =========================================================================

    let candle =
        timeframeCandles.get(
            bucket
        );


    // =========================================================================
    // CREATE
    // =========================================================================

    if (!candle) {

        candle =
            createCandle(
                bucket,
                tickTimestamp,
                price
            );


        candle.timeframe =
            timeframeName;


        timeframeCandles.set(
            bucket,
            candle
        );

    }


    // =========================================================================
    // UPDATE
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
// HANDLE TICK
// =============================================================================
//
// This is the function imported by bootstrap:
//
// onTick(handleTick);
//

export async function handleTick(
    price
) {

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
    // INITIAL BUCKETS
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
    // LATEST BROKER TIME
    // =========================================================================

    if (
        tickTimestamp >
        latestBrokerTimestamp
    ) {

        latestBrokerTimestamp =
            tickTimestamp;

    }


    // =========================================================================
    // BUILD M5
    // =========================================================================

    processTickForTimeframe(

        "M5",

        TIMEFRAMES.M5,

        tickTimestamp,

        bid

    );


    // =========================================================================
    // BUILD M15
    // =========================================================================

    processTickForTimeframe(

        "M15",

        TIMEFRAMES.M15,

        tickTimestamp,

        bid

    );


    // =========================================================================
    // CLOSE MATURE CANDLES
    // =========================================================================

    await closeCompletedCandles();

}


// =============================================================================
// CLOSE COMPLETED CANDLES
// =============================================================================

async function closeCompletedCandles() {

    if (
        !latestBrokerTimestamp
    ) {

        return;

    }


    const cutoff =
        latestBrokerTimestamp -
        CANDLE_DELAY_MS;


    await closeTimeframeCandles(

        "M5",

        TIMEFRAMES.M5,

        cutoff

    );


    await closeTimeframeCandles(

        "M15",

        TIMEFRAMES.M15,

        cutoff

    );

}


// =============================================================================
// CLOSE TIMEFRAME CANDLES
// =============================================================================

async function closeTimeframeCandles(

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
        // NOT FINISHED
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


        timeframeCandles.delete(
            timestamp
        );


        // =====================================================================
        // INITIAL PARTIAL CANDLE
        // =====================================================================

        if (
            timestamp ===
            initialBuckets[
                timeframeName
            ]
        ) {

            console.log(
                `⚠️ Ignoring initial partial ${timeframeName} candle:`,
                formatBrokerTime(
                    timestamp
                )
            );


            lastClosedTimestamp[
                timeframeName
            ] =
                timestamp;


            continue;

        }


        // =====================================================================
        // VALID COMPLETED CANDLE
        // =====================================================================

        lastClosedTimestamp[
            timeframeName
        ] =
            timestamp;


        console.log(
            `\n🕯️ ${timeframeName} CLOSED`
        );


        console.log(
            `Time: ${candle.brokerTime}`
        );


        console.log(
            `O: ${candle.open} ` +
            `H: ${candle.high} ` +
            `L: ${candle.low} ` +
            `C: ${candle.close}`
        );


        console.log(
            `Ticks: ${candle.tickCount}`
        );


        // =====================================================================
        // SEND TO LIVE ALGO
        // =====================================================================

        await emitCandle(

            timeframeName,

            candle

        );

    }

}


// =============================================================================
// GET CURRENT CANDLE
// =============================================================================

export function getCurrentCandle(
    timeframe
) {

    const timeframeCandles =
        candles[
            timeframe
        ];


    if (!timeframeCandles) {

        return null;

    }


    const timestamps =
        [
            ...timeframeCandles.keys()
        ]
        .sort(
            (a, b) => b - a
        );


    if (
        timestamps.length === 0
    ) {

        return null;

    }


    return timeframeCandles.get(
        timestamps[0]
    );

}


// =============================================================================
// GET ALL ACTIVE CANDLES
// =============================================================================

export function getActiveCandles() {

    return {

        M5: [
            ...candles.M5.values()
        ],

        M15: [
            ...candles.M15.values()
        ]

    };

}


// =============================================================================
// CLEAR DUPLICATE CACHE PERIODICALLY
// =============================================================================

const duplicateCleanupTimer = setInterval(

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

duplicateCleanupTimer.unref?.();