import pkg from "metaapi.cloud-sdk/node";
import dotenv from "dotenv";
dotenv.config();
let account = null;
const { default: MetaApi } = pkg;

let connection = null;
let streamingConnection = null;

export async function initConnection() {
  const token     = process.env.META_API_TOKEN;
  const accountId = process.env.META_API_ACCOUNT_ID;
  console.log("DEBUG VERSION:", process.env.METAAPI_DEBUG_VERSION);

  console.log("⏳ Connecting to MT5 via MetaApi...");

  const api     = new MetaApi(token);
  account = await api.metatraderAccountApi.getAccount(accountId);

  await account.waitConnected();
  console.log("✅ Broker connected");

  connection = account.getRPCConnection();
  await connection.connect();
  await connection.waitSynchronized();
  console.log("✅ Synchronized and ready");

  return connection;
}

export function getConnection() {
  if (!connection) throw new Error("MT5 not connected yet.");
  return connection;
}

export function getAccount() {
  if (!account) throw new Error("MT5 not connected yet.");
  return account;
}



// =============================================================================
// INIT STREAMING CONNECTION
// =============================================================================

export async function initStreamingConnection(listener) {
  if (!account) {
    throw new Error("MT5 not connected yet.");
  }

  if (streamingConnection) {
    return streamingConnection;
  }

  console.log("⏳ Creating MT5 streaming connection...");

  const newConnection = account.getStreamingConnection();
  streamingConnection = newConnection;

  try {
    // Register before connecting and synchronizing.
    if (listener) {
      newConnection.addSynchronizationListener(listener);
    }

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

  // Clear the shared reference even if closing fails.
  streamingConnection = null;

  if (current) {
    await current.close();
    console.log("🔌 Streaming connection closed");
  }
}
