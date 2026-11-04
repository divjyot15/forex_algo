
import "dotenv/config";
import pkg from "metaapi.cloud-sdk/node";

import {
  initStreamingConnection,
  closeStreamingConnection
} from "../connection/metaapi.js";
import { brokerTimestamp, isNewerBrokerTimestamp } from "./candleReconciliation.js";

const { SynchronizationListener } = pkg;

const SYMBOL = process.env.METAAPI_SYMBOL || "XAUUSD";

const NO_TICK_TIMEOUT_MS = 120_000;
const WATCHDOG_INTERVAL_MS = 15_000;
const RESUBSCRIBE_WAIT_MS = 30_000;
const RECOVERY_COOLDOWN_MS = 300_000;
const TICK_LOG_INTERVAL_MS = 30_000;
const START_RETRY_BASE_MS = 5_000;
const START_RETRY_MAX_MS = 60_000;

let streamingConnection = null;
let tickHandler = null;
const recoveryListeners = new Set();

let started = false;
let starting = false;
let recovering = false;
let recoveryPending = false;
let recoveryFromBrokerTimestamp = null;
let priceProcessing = Promise.resolve();

let watchdogTimer = null;

// Only processPrice() updates lastTickAt.
let lastTickAt = 0;

// Time at which the current subscription was established.
// This is not proof that a tick was received.
let subscriptionStartedAt = 0;

let lastRecoveryAt = 0;
let lastPriceKey = null;
let lastTickLogAt = 0;
let lastKnownBrokerTimestamp = null;
let freshTickSequence = 0;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function startupRetryDelay(attempt) {
  return Math.min(START_RETRY_BASE_MS * (2 ** Math.max(0, attempt)), START_RETRY_MAX_MS);
}

function enqueuePrice(price) {
  const work = priceProcessing.then(() => processPrice(price));
  priceProcessing = work.catch(error => {
    console.error("❌ Price processing failed:", error);
  });
  return work;
}

async function processPrice(price) {
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
  const brokerTime = brokerTimestamp(price.brokerTime ?? price.time ?? price.timeMsc);

  if (!recoveryPending && lastTickAt && now - lastTickAt >= NO_TICK_TIMEOUT_MS) {
    await beginRecovery("tick-gap");
  }

  const isFreshAfterRecovery = recoveryPending &&
    isNewerBrokerTimestamp(brokerTime, recoveryFromBrokerTimestamp);
  const advancesKnownTime = isNewerBrokerTimestamp(brokerTime, lastKnownBrokerTimestamp);

  if (recoveryPending && !isFreshAfterRecovery) {
    console.warn(
      `[tick] Ignoring stale recovery quote; broker timestamp ${brokerTime ?? "invalid"} ` +
      `is not newer than recovery baseline ${recoveryFromBrokerTimestamp ?? "unknown"}.`
    );
    return;
  }

  if (advancesKnownTime) {
    lastKnownBrokerTimestamp = brokerTime;
    freshTickSequence += 1;
  }

  // Only a strictly advancing broker timestamp proves feed progress.
  if (advancesKnownTime) {
    lastTickAt = now;
  }

  // Avoid printing every tick and filling PM2 logs.
  if (now - lastTickLogAt >= TICK_LOG_INTERVAL_MS) {
    console.log(`📈 ${SYMBOL} tick received`, {
      bid: price.bid,
      ask: price.ask,
      time: timestamp ?? "unavailable"
    });

    lastTickLogAt = now;
  }

  if (recoveryPending) {
    if (brokerTime === null) {
      console.error("❌ Cannot reconcile recovered stream: tick has no valid broker timestamp.");
      return;
    }
    const reconciled = await notifyRecoveryListeners({
      type: "recovery-tick",
      reason: "fresh-market-data",
      lastBrokerTimestamp: recoveryFromBrokerTimestamp,
      resumeTimestamp: brokerTime,
      price
    });
    if (!reconciled) return;
    recoveryPending = false;
    recoveryFromBrokerTimestamp = null;
    console.info(`[tick] Recovery reconciliation confirmed through ${new Date(brokerTime).toISOString()}.`);
  }

  if (typeof tickHandler === "function") await tickHandler(price);
}

async function notifyRecoveryListeners(event) {
  let allSucceeded = true;
  for (const listener of recoveryListeners) {
    try {
      const result = await listener(event);
      if (event.type === "recovery-tick" && result !== true) allSucceeded = false;
    } catch (error) {
      allSucceeded = false;
      console.error("❌ Stream recovery listener failed:", error);
    }
  }
  return allSucceeded;
}

async function beginRecovery(reason) {
  if (recoveryPending) return;
  recoveryPending = true;
  recoveryFromBrokerTimestamp = lastKnownBrokerTimestamp;
  console.warn(`[tick] Market-data recovery started (${reason}) at ${new Date().toISOString()}; candle processing is quarantined.`);
  await notifyRecoveryListeners({
    type: "recovery-started",
    reason,
    lastBrokerTimestamp: recoveryFromBrokerTimestamp,
    startedAt: lastRecoveryAt
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
    if (started || lastTickAt) await beginRecovery("stream-disconnected");
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
    // A replica resync is not proof that symbol prices stopped. Let the
    // tick watchdog decide whether the overall feed is actually stale.
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
    if (!connected && started) await beginRecovery("broker-disconnected");
  }

  async onHealthStatus(instanceIndex, status) {
    console.log("💓 MetaApi health:", status);
  }

  async onSymbolPriceUpdated(instanceIndex, price) {
    await enqueuePrice(price);
  }

  async onSymbolPricesUpdated(instanceIndex, prices) {
    const list = Array.isArray(prices)
      ? prices
      : prices && typeof prices === "object"
        ? Object.values(prices)
        : [];

    for (const price of list) {
      await enqueuePrice(price);
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

export function onStreamRecovery(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("onStreamRecovery(listener) requires a function.");
  }
  recoveryListeners.add(listener);
  return () => recoveryListeners.delete(listener);
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
  let attempt = 0;

  while (!started) {
    try {
      await startTickStreamAttempt();
      attempt = 0;
    } catch (error) {
      started = false;
      streamingConnection = null;

      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }

      try {
        await closeStreamingConnection();
      } catch (closeError) {
        console.error("⚠️ Streaming cleanup failed:", closeError.message);
      }

      const delay = startupRetryDelay(attempt++);
      console.error(`❌ Tick stream startup failed: ${error.message}`);
      console.warn(`[tick] Will retry streaming startup in ${Math.round(delay / 1000)} seconds.`);
      await sleep(delay);
    }
  }

  starting = false;
}

async function startTickStreamAttempt() {
  streamingConnection = await initStreamingConnection(synchronizationListener);
  console.log(`⏳ Subscribing to ${SYMBOL}...`);

  const sequenceAtSubscription = freshTickSequence;
  await streamingConnection.subscribeToMarketData(
    SYMBOL,
    [{ type: "quotes" }],
    RESUBSCRIBE_WAIT_MS / 1000,
    false
  );

  subscriptionStartedAt = Date.now();
  started = true;
  watchdogTimer = setInterval(() => {
    checkTickHealth().catch(error => console.error("❌ Tick watchdog error:", error));
  }, WATCHDOG_INTERVAL_MS);

  console.log(`[tick] Quote subscription accepted for ${SYMBOL}; waiting for an actual fresh broker tick.`);
  await sleep(RESUBSCRIBE_WAIT_MS);
  if (!started) throw new Error("Tick stream was stopped while waiting for the first quote.");
  if (freshTickSequence === sequenceAtSubscription) {
    throw new Error(`No fresh ${SYMBOL} broker quote received within ${RESUBSCRIBE_WAIT_MS / 1000} seconds.`);
  }

  lastRecoveryAt = 0;
  lastTickLogAt = 0;
  console.log(`✅ Fresh ${SYMBOL} broker quote received; live tick stream is active.`);
}

async function checkTickHealth() {
  if (
    !started ||
    starting ||
    recovering
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
  await beginRecovery("watchdog-timeout");

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

        const freshTickSequenceAtSubscribe = freshTickSequence;
        await current.subscribeToMarketData(SYMBOL, [{ type: "quotes" }], RESUBSCRIBE_WAIT_MS / 1000, false);

        subscriptionStartedAt = Date.now();

        console.log(
          `⏳ Waiting up to ${
            RESUBSCRIBE_WAIT_MS / 1000
          } seconds for fresh ${SYMBOL} ticks...`
        );

        await sleep(RESUBSCRIBE_WAIT_MS);

        if (!started) {
          return;
        }

        if (freshTickSequence > freshTickSequenceAtSubscribe) {
          console.log(
            `✅ Fresh ${SYMBOL} broker tick received after resubscription; recovery reconciliation ${recoveryPending ? "still pending" : "complete"}.`
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

    const freshTickSequenceAtSubscribe = freshTickSequence;
    await streamingConnection.subscribeToMarketData(
      SYMBOL,
      [{ type: "quotes" }],
      RESUBSCRIBE_WAIT_MS / 1000,
      false
    );

    // Reset the subscription baseline, not the last actual
    // tick timestamp or recovery cooldown.
    subscriptionStartedAt = Date.now();

    console.log(`[tick] Quote subscription request accepted for ${SYMBOL}; waiting for a fresh broker timestamp.`);

    await sleep(RESUBSCRIBE_WAIT_MS);
    if (freshTickSequence > freshTickSequenceAtSubscribe) {
      console.log(`[tick] Fresh ${SYMBOL} broker tick arrived on rebuilt connection; reconciliation ${recoveryPending ? "pending" : "complete"}.`);
    } else {
      console.error(`[tick] No fresh ${SYMBOL} broker tick arrived after rebuilding the streaming connection.`);
    }
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
  lastKnownBrokerTimestamp = null;
  freshTickSequence = 0;
  freshTickSequence = 0;
  recoveryFromBrokerTimestamp = null;
  recoveryPending = false;
  priceProcessing = Promise.resolve();

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
