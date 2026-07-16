import * as trader from "../services/trader.service.js";
import { canTrade } from "../services/risk.service.js";

export async function placeOrder(req, res, next) {
  try {
    const { symbol, type, volume, sl, tp } = req.body;
    const positions = await trader.getPositions();
    const risk      = await canTrade(volume, positions.length);
    if (!risk.allowed) return res.status(403).json({ success: false, error: risk.reason });
    const result = await trader.placeOrder({ symbol, type, volume, sl, tp });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function getPositions(req, res, next) {
  try {
    const data = await trader.getPositions();
    res.json({ success: true, data });
  } catch (err) { next(err); }
}

export async function closePosition(req, res, next) {
  try {
    const result = await trader.closePosition(req.params.id);
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}

export async function closeAll(req, res, next) {
  try {
    const result = await trader.closeAllPositions();
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
}