
import pkg from "metaapi.cloud-sdk/node";

import {
  initStreamingConnection,
  closeStreamingConnection
} from "../connection/metaapi.js";

const { SynchronizationListener } = pkg;

const SYMBOL = process.env.METAAPI_SYMBOL || "XAUUSD";

// Adjust these for your broker and operating hours.
const NO_TICK_TIMEOUT_MS = 120_000;  // 2 minutes
const WATCHDOG_INTERVAL_MS = 15_000; // Check every 15 seconds
const RESUBSCRIBE_WAIT_MS = 30_000;  // Wait after resubscription
const RECOVERY_COOLDOWN_MS = 300_000; // 5 minutes

let streamingConnection = null;
let tickHandler = null;

let started = false;
let starting = false;
let recovering = false;

let watchdogTimer = null;
let lastTickAt = 0;
let lastRecoveryAt = 0;
let lastPriceKey = null;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function processPrice(price) {
  if (!price || price.symbol !== SYMBOL) {
    return;
  }

  // Avoid processing the same update through both callbacks.
  // If no timestamp is available, don't deduplicate by price alone.
  const timestamp =
    price.time ?? price.brokerTime ?? price.timeMsc;

  if (timestamp != null) {
    const key = [
      price.symbol,
      timestamp,
      price.bid,
      price.ask
    ].join("|");

    if (key === lastPriceKey) {
      return;
    }

    lastPriceKey = key;
  }

  // Record delivery before invoking strategy code.
  lastTickAt = Date.now();
  lastRecoveryAt = 0;

  if (typeof tickHandler !== "function") {
    return;
  }

  Promise.resolve(tickHandler(price)).catch((error) => {
    console.error("❌ Tick handler error:", error);
  });
}

class TickSynchronizationListener extends SynchronizationListener {
  async onConnected(instanceIndex, replicas) {
    console.log("🔗 MetaApi stream connected:", instanceIndex);
  }

  async onDisconnected(instanceIndex) {
    console.warn(
      "⚠️ MetaApi stream disconnected:",
      instanceIndex
    );
  }

  async onSynchronizationStarted(
    instanceIndex,
    specificationsHash,
    positionsHash,
    ordersHash,
    synchronizationId
  ) {
    console.log(
      "🔄 Stream synchronization started:",
      instanceIndex
    );
  }

  async onBrokerConnectionStatusChanged(
    instanceIndex,
    connected
  ) {
    console.log(
      `🔌 Broker connection: ${
        connected ? "CONNECTED" : "DISCONNECTED"
      }`
    );
  }

  async onHealthStatus(instanceIndex, status) {
    console.log("💓 MetaApi health:", status);
  }

  async onSymbolPriceUpdated(instanceIndex, price) {
    processPrice(price);
  }

  async onSymbolPricesUpdated(
    instanceIndex,
    prices
  ) {
    // Do not discard batch updates.
    const list = Array.isArray(prices)
      ? prices
      : prices && typeof prices === "object"
        ? Object.values(prices)
        : [];

    for (const price of list) {
      processPrice(price);
    }
  }
}

const synchronizationListener =
  new TickSynchronizationListener();

export function onTick(handler) {
  if (typeof handler !== "function") {
    throw new TypeError(
      "onTick(handler) requires a function."
    );
  }

  tickHandler = handler;
}

export async function startTickStream() {
  if (started) {
    console.log("⚠️ Tick stream already started.");
    return;
  }

  if (starting) {
    console.log("⚠️ Tick stream startup already in progress.");
    return;
  }

  if (typeof tickHandler !== "function") {
    throw new Error(
      "Register onTick(handler) before starting the stream."
    );
  }

  starting = true;

  try {
    // Listener is registered before connect/synchronization.
    streamingConnection = await initStreamingConnection(
      synchronizationListener
    );

    console.log(`⏳ Subscribing to ${SYMBOL}...`);

    await streamingConnection.subscribeToMarketData(SYMBOL);

    lastTickAt = Date.now();
    lastPriceKey = null;
    lastRecoveryAt = 0;

    started = true;

    watchdogTimer = setInterval(() => {
      checkTickHealth().catch((error) => {
        console.error("❌ Tick watchdog error:", error);
      });
    }, WATCHDOG_INTERVAL_MS);

    console.log(`✅ Subscribed to ${SYMBOL}`);
    console.log("🟢 Live tick stream running...");
  } catch (error) {
    console.error("❌ Tick stream startup failed:", error);

    started = false;
    streamingConnection = null;

    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }

    try {
      await closeStreamingConnection();
    } catch (closeError) {
      console.error(
        "⚠️ Streaming cleanup failed:",
        closeError.message
      );
    }

    throw error;
  } finally {
    starting = false;
  }
}

async function checkTickHealth() {
  if (!started || recovering || !streamingConnection) {
    return;
  }

  const silence = Date.now() - lastTickAt;

  if (silence < NO_TICK_TIMEOUT_MS) {
    return;
  }

  // Prevent repeated reconnection attempts during a quiet
  // market or while the broker is unavailable.
  if (
    Date.now() - lastRecoveryAt <
    RECOVERY_COOLDOWN_MS
  ) {
    return;
  }

  console.warn(
    `⚠️ No ${SYMBOL} ticks for ${Math.round(
      silence / 1000
    )} seconds. Starting recovery...`
  );

  await recoverTickStream();
}

async function recoverTickStream() {
  if (recovering || !started) {
    return;
  }

  recovering = true;
  lastRecoveryAt = Date.now();

  try {
    const current = streamingConnection;

    if (current) {
      // First attempt: restore the market-data subscription.
      try {
        console.log(`🔄 Resubscribing to ${SYMBOL}...`);

        await current.unsubscribeFromMarketData(SYMBOL);
        await current.subscribeToMarketData(SYMBOL);

        const recoveryStartedAt = Date.now();

        console.log(
          `⏳ Waiting for fresh ${SYMBOL} ticks...`
        );

        await sleep(RESUBSCRIBE_WAIT_MS);

        if (lastTickAt >= recoveryStartedAt) {
          console.log(
            `✅ ${SYMBOL} ticks resumed after resubscription`
          );
          return;
        }

        console.warn(
          "⚠️ Resubscription did not restore ticks."
        );
      } catch (error) {
        console.error(
          "⚠️ Resubscription failed:",
          error.message
        );
      }
    }

    // Second attempt: recreate the streaming connection.
    console.warn("🔄 Rebuilding streaming connection...");

    streamingConnection = null;

    try {
      await closeStreamingConnection();
    } catch (error) {
      console.error(
        "⚠️ Error closing old connection:",
        error.message
      );
    }

    if (!started) {
      return;
    }

    streamingConnection = await initStreamingConnection(
      synchronizationListener
    );

    await streamingConnection.subscribeToMarketData(SYMBOL);

    // Allow the watchdog to detect continued silence from
    // this new subscription.
    lastTickAt = Date.now();
    lastPriceKey = null;

    console.log(
      `✅ Reconnected and subscribed to ${SYMBOL}; waiting for ticks`
    );
  } catch (error) {
    console.error(
      "❌ Streaming recovery failed:",
      error
    );

    streamingConnection = null;

    try {
      await closeStreamingConnection();
    } catch (closeError) {
      console.error(
        "⚠️ Recovery cleanup failed:",
        closeError.message
      );
    }
  } finally {
    recovering = false;
  }
}

export function getTickStreamingConnection() {
  if (!streamingConnection) {
    throw new Error(
      "Tick streaming connection has not been started."
    );
  }

  return streamingConnection;
}

export async function stopTickStream() {
  started = false;

  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }

  streamingConnection = null;

  try {
    await closeStreamingConnection();
  } catch (error) {
    console.error(
      "⚠️ Error closing tick stream:",
      error
    );
  }

  console.log("🛑 Tick stream stopped");
}
