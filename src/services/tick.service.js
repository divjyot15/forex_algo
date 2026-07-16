import pkg from "metaapi.cloud-sdk/node";
const { default: MetaApi } = pkg;

const SYMBOLS = ["XAUUSD", "GBPUSD", "EURUSD", "USDJPY"];
const listeners = [];

export function onTick(callback) {
  listeners.push(callback);
}

export async function startTickStream() {
  const token     = process.env.META_API_TOKEN;
  const accountId = process.env.META_API_ACCOUNT_ID;

  const api     = new MetaApi(token);
  const account = await api.metatraderAccountApi.getAccount(accountId);
  await account.waitConnected();

  const conn = account.getStreamingConnection();
  await conn.connect();
  await conn.waitSynchronized();

  for (const symbol of SYMBOLS) {
    await conn.subscribeToMarketData(symbol);
    console.log(`📡 Subscribed: ${symbol}`);
  }

  conn.addSynchronizationListener({
    onSymbolPriceUpdated(instanceIndex, price) {
      const tick = { symbol: price.symbol, bid: price.bid, ask: price.ask, time: price.time };
      listeners.forEach(fn => fn(tick));
    }
  });

  console.log("🔴 Tick stream live");
}