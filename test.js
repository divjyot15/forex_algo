import dotenv from "dotenv";
dotenv.config();

import pkg from "metaapi.cloud-sdk/node";
const { default: MetaApi } = pkg;

const token     = process.env.META_API_TOKEN;
const accountId = process.env.META_API_ACCOUNT_ID;

async function test() {
  console.log("Connecting to MT5...");

  const api     = new MetaApi(token);
  const account = await api.metatraderAccountApi.getAccount(accountId);

  await account.waitConnected();
  console.log("✅ Broker connected");

  const connection = account.getRPCConnection();
  await connection.connect();
  await connection.waitSynchronized();
  console.log("✅ Synchronized");

  const info = await connection.getAccountInformation();
  console.log("Balance:", info.balance);
  console.log("Equity:", info.equity);
  console.log("Currency:", info.currency);

  process.exit(0);
}

test().catch(err => {
  console.error("❌ Error:", err.message);
  process.exit(1);
});