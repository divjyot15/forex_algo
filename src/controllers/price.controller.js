import { getPrice } from "../services/trader.service.js";

export async function price(req, res, next) {
  try {
    const data = await getPrice(req.query.symbol || "XAUUSD");
    res.json({ success: true, data });
  } catch (err) { next(err); }
}