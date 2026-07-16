import { Router } from "express";
import { price } from "../controllers/price.controller.js";
const router = Router();
router.get("/", price);
export default router;