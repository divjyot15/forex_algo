
import "dotenv/config";
import pkg from "metaapi.cloud-sdk/node";

const { default: MetaApi } = pkg;

let account = null;
let api = null;
let connection = null;
let streamingConnection = null;

// Prevent registering the same listener more than once
// on the same streaming connection.
const listenersByConnection = new WeakMap();

export async function initConnection() {
  const token = process.env.META_API_TOKEN;
  const accountId = process.env.META_API_ACCOUNT_ID;

  if (!token || !accountId) {
    throw new Error(
      "META_API_TOKEN or META_API_ACCOUNT_ID is missing."
    );
  }

  if (connection && account) {
    return connection;
  }

  console.log(
    "DEBUG VERSION:",
    process.env.METAAPI_DEBUG_VERSION
  );

  console.log("⏳ Connecting to MT5 via MetaApi...");

  api = new MetaApi(token);

  account = await api.metatraderAccountApi.getAccount(
    accountId
  );

  await account.waitConnected();

  console.log("✅ Broker connected");

  connection = account.getRPCConnection();

  await connection.connect();
  await connection.waitSynchronized();

  console.log("✅ Synchronized and ready");

  return connection;
}

export function getConnection() {
  if (!connection) {
    throw new Error("MT5 not connected yet.");
  }

  return connection;
}

export function getAccount() {
  if (!account) {
    throw new Error("MT5 not connected yet.");
  }

  return account;
}

// Register a synchronization listener only once per connection.
function registerListener(targetConnection, listener) {
  if (!listener) {
    return;
  }

  let registered = listenersByConnection.get(
    targetConnection
  );

  if (!registered) {
    registered = new Set();
    listenersByConnection.set(
      targetConnection,
      registered
    );
  }

  if (registered.has(listener)) {
    return;
  }

  targetConnection.addSynchronizationListener(listener);
  registered.add(listener);
}

// Initialize the streaming connection.
export async function initStreamingConnection(listener) {
  if (!account) {
    throw new Error(
      "MT5 not connected yet. Call initConnection() first."
    );
  }

  // Reuse the existing connection, but make sure the
  // requested listener is attached.
  if (streamingConnection) {
    registerListener(streamingConnection, listener);
    return streamingConnection;
  }

  console.log("⏳ Creating MT5 streaming connection...");

  const newConnection = account.getStreamingConnection();

  // Assign the shared reference before connecting so all
  // cleanup paths can access the same connection.
  streamingConnection = newConnection;

  try {
    // Register before connect/synchronization.
    registerListener(newConnection, listener);

    await newConnection.connect();

    console.log("✅ Streaming connection connected");

    await newConnection.waitSynchronized();

    console.log("✅ Streaming connection synchronized");

    return newConnection;
  } catch (error) {
    if (streamingConnection === newConnection) {
      streamingConnection = null;
    }

    try {
      await newConnection.close();
    } catch (closeError) {
      console.error(
        "⚠️ Failed connection cleanup:",
        closeError.message
      );
    }

    throw error;
  }
}

export function getStreamingConnection() {
  if (!streamingConnection) {
    throw new Error(
      "MT5 streaming connection not initialized yet."
    );
  }

  return streamingConnection;
}

export async function closeStreamingConnection() {
  const current = streamingConnection;

  // Clear the shared reference before closing so a failed
  // close cannot leave a stale connection available.
  streamingConnection = null;

  if (!current) {
    return;
  }

  await current.close();

  console.log("🔌 Streaming connection closed");
}
