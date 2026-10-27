import dotenv from "dotenv";
dotenv.config();

import { initConnection } from "./src/connection/metaapi.js";
import { onStreamRecovery, onTick, startTickStream } from "./src/services/tick.service.js";
import { beginCandleRecovery, completeCandleRecovery, getStartupInitialBuckets, handleTick, onCandle } from "./src/services/candleBuilder.js";
import { initRiskManager } from "./src/services/risk.service.js";
import { startLiveStrategy } from "./src/services/liveStrategy.service.js";
import app from "./src/app.js";

const PORT = process.env.PORT || 5000;

async function bootstrap() {
  try {
    // 1. Connect to MT5 first
    await initConnection();

    // Initialize account risk baselines and warm strategy state without trading history.
    await initRiskManager();
    const strategy = await startLiveStrategy();
    let startupInitialBuckets = getStartupInitialBuckets();

    onStreamRecovery(async event => {
      if (event.type === "recovery-started") {
        beginCandleRecovery();
        startupInitialBuckets = getStartupInitialBuckets();
        strategy.setStartupInitialBuckets(startupInitialBuckets);
        strategy.beginRecovery();
        return false;
      }

      if (event.type !== "recovery-tick") return true;

      try {
        const result = await strategy.reconcileRecovery({ ...event, startupInitialBuckets });
        await completeCandleRecovery({
          fromTimestamp: result.lastBrokerTimestamp,
          resumeTimestamp: result.resumeTimestamp,
          repairedThrough: result.repairedThrough
        });
        return true;
      } catch (error) {
        strategy.beginRecovery();
        console.error("[recovery] Candle reconciliation remains pending:", error.message);
        return false;
      }
    });

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