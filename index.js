import dotenv from "dotenv";
dotenv.config();

import { initConnection } from "./src/connection/metaapi.js";
import { onTick, startTickStream } from "./src/services/tick.service.js";
import { handleTick, onCandle } from "./src/services/candleBuilder.js";
import { initRiskManager } from "./src/services/risk.service.js";
import { startLiveStrategy } from "./src/services/liveStrategy.service.js";
import app from "./src/app.js";

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  try {
    // 1. Connect to MT5 first
    await initConnection();

    // Initialize account risk baselines and warm strategy state without trading history.
    await initRiskManager();
    const strategy = await startLiveStrategy();

    // Consume only fully completed candles from the live tick-built feed.
    onCandle((timeframe, candle) => strategy.handleClosedCandle(timeframe, candle));

    // Build both 5-minute and 15-minute candles from the live tick stream.
    onTick(handleTick);
    await startTickStream();

    // 2. Start Express server
    app.listen(PORT, () => {
      console.log(`🚀 Server running at http://localhost:${PORT}`);
    });

  } catch (err) {
    console.error("❌ Failed to start:", err.message);
    process.exit(1);
  }
}

bootstrap();