import { Router } from "express";
import { placeOrder, getPositions, closePosition, closeAll } from "../controllers/trade.controller.js";
const router = Router();
router.post("/order",        placeOrder);
router.get("/positions",     getPositions);
router.delete("/position/:id", closePosition);
router.delete("/positions",  closeAll);
export default router;