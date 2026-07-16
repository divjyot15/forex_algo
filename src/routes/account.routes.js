import { Router } from "express";
import { account } from "../controllers/account.controller.js";
const router = Router();
router.get("/", account);
export default router;