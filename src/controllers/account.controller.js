import { getAccountInfo } from "../services/trader.service.js";

export async function account(req, res, next) {
  try {
    const info = await getAccountInfo();
    res.json({ success: true, data: info });
  } catch (err) { next(err); }
}