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

// How much broker-time delay we allow for late/out-of-order ticks.
const CANDLE_DELAY_MS = 3000;


// =============================================================================
// ACTIVE CANDLES
// =============================================================================

// Map:
// minute timestamp -> candle
//
// We keep more than one candle here because ticks can arrive out of order.

const candles = new Map();


// =============================================================================
// DUPLICATE TICKS
// =============================================================================

const processedTicks = new Set();


// =============================================================================
// LAST BROKER TICK TIME
// =============================================================================

let latestBrokerTimestamp = 0;


// =============================================================================
// GET BROKER TIMESTAMP
// =============================================================================

function getBrokerTimestamp(brokerTime) {

    if (!brokerTime) {
        return null;
    }

    /*
        Example:

        2026-09-24 18:38:42.123

        IMPORTANT:
        We are NOT converting this into UTC.

        We only need a consistent numerical timeline for
        comparing broker timestamps with each other.
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
        Number(milliseconds.padEnd(3, "0"))
    );
}


// =============================================================================
// GET 1-MINUTE BUCKET
// =============================================================================

function getMinuteBucket(timestamp) {

    return (
        Math.floor(
            timestamp / 60000
        ) * 60000
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
        ).padStart(2, "0");

    const day =
        String(
            date.getUTCDate()
        ).padStart(2, "0");

    const hour =
        String(
            date.getUTCHours()
        ).padStart(2, "0");

    const minute =
        String(
            date.getUTCMinutes()
        ).padStart(2, "0");

    const second =
        String(
            date.getUTCSeconds()
        ).padStart(2, "0");

    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}


// =============================================================================
// CREATE CANDLE
// =============================================================================

function createCandle(
    minuteTimestamp,
    tickTimestamp,
    price
) {

    return {

        timestamp: minuteTimestamp,

        firstTickTimestamp: tickTimestamp,

        lastTickTimestamp: tickTimestamp,

        open: price,

        high: price,

        low: price,

        close: price,

        tickCount: 1

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
    // HIGH / LOW
    // =========================================================================

    candle.high =
        Math.max(
            candle.high,
            price
        );

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
// PROCESS TICK
// =============================================================================

function processTick(price) {

    if (!price) {
        return;
    }

    if (price.symbol !== SYMBOL) {
        return;
    }

    if (!price.brokerTime) {
        return;
    }


    // =========================================================================
    // PRICE
    // =========================================================================

    const bid =
        Number(price.bid);

    if (!Number.isFinite(bid)) {
        return;
    }


    // =========================================================================
    // BROKER TIMESTAMP
    // =========================================================================

    const tickTimestamp =
        getBrokerTimestamp(
            price.brokerTime
        );

    if (tickTimestamp === null) {

        console.log(
            "⚠️ Invalid brokerTime:",
            price.brokerTime
        );

        return;
    }


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
    // UPDATE LATEST BROKER TIME
    // =========================================================================

    if (
        tickTimestamp >
        latestBrokerTimestamp
    ) {

        latestBrokerTimestamp =
            tickTimestamp;
    }


    // =========================================================================
    // FIND 1-MINUTE BUCKET
    // =========================================================================

    const minuteTimestamp =
        getMinuteBucket(
            tickTimestamp
        );


    // =========================================================================
    // GET / CREATE CANDLE
    // =========================================================================

    let candle =
        candles.get(
            minuteTimestamp
        );


    if (!candle) {

        candle =
            createCandle(
                minuteTimestamp,
                tickTimestamp,
                bid
            );

        candles.set(
            minuteTimestamp,
            candle
        );

    } else {

        updateCandle(
            candle,
            tickTimestamp,
            bid
        );
    }


    // =========================================================================
    // CLOSE MATURE CANDLES
    // =========================================================================

    closeCompletedCandles();
}


// =============================================================================
// CLOSE COMPLETED CANDLES
// =============================================================================

function closeCompletedCandles() {

    if (!latestBrokerTimestamp) {
        return;
    }


    const cutoff =
        latestBrokerTimestamp -
        CANDLE_DELAY_MS;


    const timestamps =
        [...candles.keys()]
            .sort(
                (a, b) => a - b
            );


    for (
        const timestamp
        of timestamps
    ) {

        const candleEnd =
            timestamp + 60000;


        // Candle is not mature yet.
        if (
            candleEnd >
            cutoff
        ) {

            continue;
        }


        const candle =
            candles.get(
                timestamp
            );


        if (!candle) {
            continue;
        }


        candles.delete(
            timestamp
        );


        printCandle(
            candle
        );
    }
}


// =============================================================================
// PRINT COMPLETED CANDLE
// =============================================================================

function printCandle(candle) {

    console.log(
        "\n=========================================="
    );

    console.log(
        "        1 MINUTE CANDLE CLOSED"
    );

    console.log(
        "=========================================="
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
        "==========================================\n"
    );
}


// =============================================================================
// PERIODIC CLEANUP OF DUPLICATE IDS
// =============================================================================

setInterval(() => {

    if (
        processedTicks.size >
        10000
    ) {

        processedTicks.clear();

    }

}, 60 * 60 * 1000);


// =============================================================================
// MAIN
// =============================================================================

async function main() {

    // =========================================================================
    // RPC CONNECTION
    // =========================================================================

    await initConnection();


    // =========================================================================
    // STREAMING CONNECTION
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
            //
            // We use onSymbolPriceUpdated only because your SDK was observed
            // delivering the same updates through both callbacks.
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
        // HEALTH STATUS
        // ---------------------------------------------------------------------

        async onHealthStatus(
            instanceIndex,
            status
        ) {

            // Nothing required.
        }

    });


    console.log(
        "\n🟢 1-minute candle builder running...\n"
    );
}


// =============================================================================
// START
// =============================================================================

main().catch(error => {

    console.error(
        "\n❌ Candle builder failed:"
    );

    console.error(
        error
    );

    process.exit(1);

});