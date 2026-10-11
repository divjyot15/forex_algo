import {
    initStreamingConnection
} from "../connection/metaapi.js";


// =============================================================================
// CONFIG
// =============================================================================

const SYMBOL =
    process.env.METAAPI_SYMBOL || "XAUUSD";


// =============================================================================
// INTERNAL STATE
// =============================================================================

let streamingConnection = null;

let tickHandler = null;

let started = false;


// =============================================================================
// REGISTER TICK HANDLER
// =============================================================================

export function onTick(handler) {

    if (
        typeof handler !== "function"
    ) {

        throw new TypeError(
            "onTick(handler) requires a function."
        );

    }


    tickHandler =
        handler;

}


// =============================================================================
// START TICK STREAM
// =============================================================================

export async function startTickStream() {

    if (started) {

        console.log(
            "⚠️ Tick stream already started."
        );

        return;

    }


    if (
        typeof tickHandler !== "function"
    ) {

        throw new Error(
            "No tick handler registered. " +
            "Call onTick(handler) before startTickStream()."
        );

    }


    // =========================================================================
    // CREATE STREAMING CONNECTION
    // =========================================================================

    streamingConnection =
        await initStreamingConnection();


    // =========================================================================
    // SUBSCRIBE TO SYMBOL
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

            try {

                if (
                    !price ||
                    price.symbol !== SYMBOL
                ) {

                    return;

                }


                await tickHandler(
                    price
                );

            } catch (error) {

                console.error(
                    "❌ Tick handler error:",
                    error
                );

            }

        },


        // ---------------------------------------------------------------------
        // BATCH PRICE UPDATE
        // ---------------------------------------------------------------------
        //
        // We intentionally do not process this callback.
        //
        // Your MetaApi stream has already shown that the same price updates
        // can arrive through both callbacks.
        //
        // Processing both would create duplicate ticks/candle updates.
        //

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

            // Not required by the candle service.

        },


        // ---------------------------------------------------------------------
        // SYMBOL SPECIFICATIONS
        // ---------------------------------------------------------------------

        async onSymbolSpecificationsUpdated(
            instanceIndex,
            specifications
        ) {

            // Not required by the candle service.

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


    started = true;


    console.log(
        "\n🟢 Live tick stream running..."
    );

}


// =============================================================================
// GET STREAMING CONNECTION
// =============================================================================

export function getTickStreamingConnection() {

    if (!streamingConnection) {

        throw new Error(
            "Tick streaming connection has not been started."
        );

    }


    return streamingConnection;

}


// =============================================================================
// STOP TICK STREAM
// =============================================================================

export async function stopTickStream() {

    if (!streamingConnection) {

        return;

    }


    try {

        if (
            typeof streamingConnection.close ===
            "function"
        ) {

            await streamingConnection.close();

        }

    } catch (error) {

        console.error(
            "⚠️ Error closing tick stream:",
            error
        );

    }


    streamingConnection = null;

    started = false;

}