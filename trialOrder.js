import { getConnection, getAccount, initConnection } from "./src/connection/metaapi.js";
let connection  = await initConnection();
import { placeOrder, getAccountInfo, getPrice, getPositions } from "./src/services/trader.service.js"; 
// update path according to your project

async function testGoldOrder() {
  try {
    console.log("🔌 Checking account...");

    const account = await getAccountInfo();
    console.log("ACCOUNT INFO:");
    console.log(account);


    console.log("\n🥇 Checking XAUUSD price...");

    const price = await getPrice("XAUUSD");
    console.log("PRICE:");
    console.log(price);

    const entry = price.ask;
    console.log("\n🚀 Placing GOLD BUY order...");

    const order = await placeOrder({
      symbol: "XAUUSD",
      type: "BUY",
      volume: 0.01,

      // example only, adjust according to current gold price
      // $10 stop
  sl: Number((entry - 10).toFixed(2)),

  // $20 target
  tp: Number((entry + 20).toFixed(2))
    });

    console.log("ORDER RESPONSE:");
    console.log(order);


    console.log("\n📌 Current positions:");

    const positions = await getPositions();
    console.log(positions);

  } catch (err) {
    console.error("❌ ERROR:");
    console.error(err.message || err);
  }
}


testGoldOrder();