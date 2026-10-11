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

export async function initStreamingConnection() {

    if (!account) {

        throw new Error(
            "MT5 not connected yet."
        );
    }

    if (streamingConnection) {

        return streamingConnection;
    }

    console.log(
        "⏳ Creating MT5 streaming connection..."
    );

    streamingConnection =
        account.getStreamingConnection();

    await streamingConnection.connect();

    console.log(
        "✅ Streaming connection connected"
    );

    console.log(
        "⏳ Waiting for streaming synchronization..."
    );

    await streamingConnection.waitSynchronized();

    console.log(
        "✅ Streaming connection synchronized"
    );

    return streamingConnection;
}


// =============================================================================
// GET STREAMING CONNECTION
// =============================================================================

export function getStreamingConnection() {

    if (!streamingConnection) {

        throw new Error(
            "MT5 streaming connection not initialized yet."
        );
    }

    return streamingConnection;
}