
import "dotenv/config";
import pkg from "metaapi.cloud-sdk/node";

import {
  initStreamingConnection,
  closeStreamingConnection
} from "../connection/metaapi.js";

const { SynchronizationListener } = pkg;

const SYMBOL = process.env.METAAPI_SYMBOL || "XAUUSD";

const NO_TICK_TIMEOUT_MS = 120_000;
const WATCHDOG_INTERVAL_MS = 15_000;
const RESUBSCRIBE_WAIT_MS = 30_000;
const RECOVERY_COOLDOWN_MS = 300_000;
const TICK_LOG_INTERVAL_MS = 30_000;

let streamingConnection = null;
let tickHandler = null;

let started = false;
let starting = false;
let recovering = false;

let watchdogTimer = null;

// Only processPrice() updates lastTickAt.
let lastTickAt = 0;

// Time at which the current subscription was established.
// This is not proof that a tick was received.
let subscriptionStartedAt = 0;

let lastRecoveryAt = 0;
let lastPriceKey = null;
let lastTickLogAt = 0;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function processPrice(price) {
  if (!price || price.symbol !== SYMBOL) {
    return;
  }

  // Avoid duplicate delivery through single-price and
  // batch-price callbacks.
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

  const now = Date.now();

  // A genuine price callback is the only thing that
  // proves market-data delivery has resumed.
  lastTickAt = now;
  lastRecoveryAt = 0;

  // Avoid printing every tick and filling PM2 logs.
  if (now - lastTickLogAt >= TICK_LOG_INTERVAL_MS) {
    console.log(`📈 ${SYMBOL} tick received`, {
      bid: price.bid,
      ask: price.ask,
      time: timestamp ?? "unavailable"
    });

    lastTickLogAt = now;
  }

  if (typeof tickHandler !== "function") {
    return;
  }

  Promise.resolve(tickHandler(price)).catch((error) => {
    console.error("❌ Tick handler error:", error);
  });
}

class TickSynchronizationListener extends SynchronizationListener {
  async onConnected(instanceIndex, replicas) {
    console.log(
      "🔗 MetaApi stream connected:",
      instanceIndex
    );
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

  async onSymbolPricesUpdated(instanceIndex, prices) {
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
    console.log(
      "⚠️ Tick stream startup already in progress."
    );
    return;
  }

  if (typeof tickHandler !== "function") {
    throw new Error(
      "Register onTick(handler) before starting the stream."
    );
  }

  starting = true;

  try {
    streamingConnection = await initStreamingConnection(
      synchronizationListener
    );

    console.log(`⏳ Subscribing to ${SYMBOL}...`);

    await streamingConnection.subscribeToMarketData(SYMBOL);

    // Do not set lastTickAt here. A subscription resolving
    // does not prove that a price has been delivered.
    subscriptionStartedAt = Date.now();
    lastPriceKey = null;
    lastRecoveryAt = 0;
    lastTickLogAt = 0;

    started = true;

    watchdogTimer = setInterval(() => {
      checkTickHealth().catch((error) => {
        console.error("❌ Tick watchdog error:", error);
      });
    }, WATCHDOG_INTERVAL_MS);

    console.log(`✅ Subscribed to ${SYMBOL}`);
    console.log(
      "🟢 Live tick stream running; waiting for actual prices..."
    );
  } catch (error) {
    console.error(
      "❌ Tick stream startup failed:",
      error
    );

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
  if (
    !started ||
    starting ||
    recovering ||
    !streamingConnection
  ) {
    return;
  }

  // Use the subscription start only until the first tick.
  // Afterwards, measure silence from the actual last tick.
  const healthBaseline = Math.max(
    lastTickAt,
    subscriptionStartedAt
  );

  const silence = Date.now() - healthBaseline;

  if (silence < NO_TICK_TIMEOUT_MS) {
    return;
  }

  if (
    lastRecoveryAt &&
    Date.now() - lastRecoveryAt < RECOVERY_COOLDOWN_MS
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

    // Attempt 1: refresh the subscription on the current
    // connection.
    if (current) {
      try {
        console.log(`🔄 Resubscribing to ${SYMBOL}...`);

        await current.unsubscribeFromMarketData(SYMBOL);

        if (!started) {
          return;
        }

        await current.subscribeToMarketData(SYMBOL);

        const recoveryStartedAt = Date.now();

        subscriptionStartedAt = recoveryStartedAt;

        console.log(
          `⏳ Waiting up to ${
            RESUBSCRIBE_WAIT_MS / 1000
          } seconds for fresh ${SYMBOL} ticks...`
        );

        await sleep(RESUBSCRIBE_WAIT_MS);

        if (!started) {
          return;
        }

        if (lastTickAt >= recoveryStartedAt) {
          console.log(
            `✅ ${SYMBOL} ticks resumed after resubscription`
          );

          return;
        }

        console.warn(
          `⚠️ No fresh ${SYMBOL} tick after resubscription.`
        );
      } catch (error) {
        console.error(
          "⚠️ Resubscription failed:",
          error.message
        );
      }
    }

    // Attempt 2: close the shared connection and create a
    // genuinely new connection.
    if (!started) {
      return;
    }

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

    if (!started) {
      await closeStreamingConnection();
      streamingConnection = null;
      return;
    }

    await streamingConnection.subscribeToMarketData(SYMBOL);

    // Reset the subscription baseline, not the last actual
    // tick timestamp.
    subscriptionStartedAt = Date.now();
    lastPriceKey = null;

    console.log(
      `✅ Reconnected and subscribed to ${SYMBOL}; waiting for actual ticks`
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
  subscriptionStartedAt = 0;
  lastTickAt = 0;
  lastPriceKey = null;
  lastRecoveryAt = 0;
  lastTickLogAt = 0;

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
