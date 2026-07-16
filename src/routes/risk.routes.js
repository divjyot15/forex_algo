import { Router } from "express";
import { riskStatus } from "../controllers/risk.controller.js";
const router = Router();
router.get("/", riskStatus);
export default router;