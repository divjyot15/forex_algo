import { getRiskStatus } from "../services/risk.service.js";

export async function riskStatus(req, res, next) {
  try {
    const data = await getRiskStatus();
    res.json({ success: true, data });
  } catch (err) { next(err); }
}