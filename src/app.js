import express from "express";
import cors from "cors";

import accountRoutes from "./routes/account.routes.js";
import tradeRoutes   from "./routes/trade.routes.js";
import priceRoutes   from "./routes/price.routes.js";
import riskRoutes    from "./routes/risk.routes.js";
import errorHandler  from "./middleware/errorHandler.js";

const app = express();

app.use(cors());
app.use(express.json());

// ─── Health check ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "running", message: "Forex Algo API is live" });
});

// ─── Routes ───────────────────────────────────────────────────
app.use("/account", accountRoutes);
app.use("/trade",   tradeRoutes);
app.use("/price",   priceRoutes);
app.use("/risk",    riskRoutes);

// ─── Global error handler ─────────────────────────────────────
app.use(errorHandler);

export default app;