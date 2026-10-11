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
// PROCESS TICK
// =============================================================================

function processTick(price) {

    if (!price || price.symbol !== SYMBOL) {
        return;
    }

    console.log(
        "\n================ TICK ================"
    );

    console.log(
        "Symbol:",
        price.symbol
    );

    console.log(
        "Bid:",
        price.bid
    );

    console.log(
        "Ask:",
        price.ask
    );

    console.log(
        "Time:",
        price.time
    );

    console.log(
        "Broker Time:",
        price.brokerTime
    );

    console.log(
        "======================================"
    );
}


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
    // SUBSCRIBE TO MARKET DATA
    // =========================================================================

    console.log(
        `\n⏳ Subscribing to ${SYMBOL}...`
    );

    await streamingConnection.subscribeToMarketData(
        SYMBOL
    );

    console.log(
        `✅ Subscribed to ${SYMBOL}`
    );


    // =========================================================================
    // SYNCHRONIZATION LISTENER
    // =========================================================================

  streamingConnection.addSynchronizationListener({

    // =====================================================================
    // SINGLE SYMBOL PRICE UPDATE
    // =====================================================================

    async onSymbolPriceUpdated(
        instanceIndex,
        price
    ) {

        processTick(price);
    },


    // =====================================================================
    // MULTIPLE SYMBOL PRICE UPDATES
    // =====================================================================

    async onSymbolPricesUpdated(
        instanceIndex,
        prices
    ) {

        // Intentionally ignored.
        //
        // The SDK is already delivering the same XAUUSD
        // price updates through onSymbolPriceUpdated().
        //
        // Processing both callbacks would duplicate ticks.

    },


    // =====================================================================
    // SYMBOL SPECIFICATION UPDATED
    // =====================================================================

    async onSymbolSpecificationUpdated(
        instanceIndex,
        specification
    ) {

        // Nothing required.

    },


    // =====================================================================
    // SYMBOL SPECIFICATIONS UPDATED
    // =====================================================================

    async onSymbolSpecificationsUpdated(
        instanceIndex,
        specifications
    ) {

        // Nothing required.

    },


    // =====================================================================
    // BROKER CONNECTION STATUS
    // =====================================================================

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


    // =====================================================================
    // HEALTH STATUS
    // =====================================================================

    async onHealthStatus(
        instanceIndex,
        status
    ) {

        // Nothing required.

    }

});

    // =========================================================================
    // KEEP PROCESS ALIVE
    // =========================================================================

    console.log(
        "\n🟢 Live tick listener running...\n"
    );
}


// =============================================================================
// START
// =============================================================================

main().catch(error => {

    console.error(
        "\n❌ Tick test failed:"
    );

    console.error(
        error
    );

    process.exit(1);

});