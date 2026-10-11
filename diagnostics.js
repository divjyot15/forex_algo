import dotenv from "dotenv";

dotenv.config();

import {
    initConnection,
    initStreamingConnection
} from "./src/connection/metaapi.js";


const connection =
    await initConnection();

const streamingConnection =
    await initStreamingConnection();


// =============================================================================
// CHECK XAUUSD SPECIFICATION
// =============================================================================

console.log("\n⏳ Getting XAUUSD specification...");

const specification =
    await connection.getSymbolSpecification("XAUUSD");

console.log("\nXAUUSD SPECIFICATION:");

console.dir(
    specification,
    { depth: null }
);


// =============================================================================
// CHECK XAUUSD PRICE
// =============================================================================

console.log("\n⏳ Getting XAUUSD price...");

const price =
    await connection.getSymbolPrice("XAUUSD");

console.log("\nXAUUSD PRICE:");

console.dir(
    price,
    { depth: null }
);


// =============================================================================
// STREAMING SUBSCRIPTION
// =============================================================================

console.log("\n⏳ Subscribing to XAUUSD...");

try {

    await streamingConnection.subscribeToMarketData(
        "XAUUSD"
    );

    console.log(
        "✅ XAUUSD streaming subscription successful"
    );

} catch (error) {

    console.error(
        "❌ XAUUSD streaming subscription failed"
    );

    console.error(
        error
    );
}


// =============================================================================
// CURRENT SUBSCRIPTIONS
// =============================================================================

console.log(
    "\nCurrent streaming subscriptions:"
);

console.log(
    streamingConnection.subscribedSymbols
);