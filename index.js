import dotenv from "dotenv";
dotenv.config();

import { initConnection } from "./src/connection/metaapi.js";
import app from "./src/app.js";

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  try {
    // 1. Connect to MT5 first
    await initConnection();

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