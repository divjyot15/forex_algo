import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAccountInfo } from "./trader.service.js";

const RULES = {
  maxDailyLossPercent: 4.5,
  maxTotalDrawdown: 9,
  maxPositions: 5,
  maxLotSize: 1.0
};

const stateFile = path.resolve(process.env.RISK_STATE_FILE || "data/risk-state.json");
const accountId = process.env.META_API_ACCOUNT_ID || null;
let startOfDayEquity = null;
let initialBalance = null;
let riskDay = null;

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

async function saveRiskState() {
  const state = { riskDay, startOfDayEquity, initialBalance, accountId };
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporaryFile = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(state, null, 2), "utf8");
  await rename(temporaryFile, stateFile);
}

async function ensureRiskState(info) {
  if (!Number.isFinite(info.balance) || info.balance <= 0 || !Number.isFinite(info.equity) || info.equity <= 0) {
    throw new Error("Cannot initialize risk limits from invalid account balance or equity.");
  }

  const today = utcDay();
  let changed = false;
  if (initialBalance === null) {
    try {
      const saved = JSON.parse(await readFile(stateFile, "utf8"));
      if (saved.accountId === accountId) {
        if (!Number.isFinite(saved.initialBalance) || saved.initialBalance <= 0) {
          throw new Error("Persisted risk state has an invalid initial balance.");
        }
        initialBalance = saved.initialBalance;
        if (saved.riskDay === today && Number.isFinite(saved.startOfDayEquity) && saved.startOfDayEquity > 0) {
          riskDay = today;
          startOfDayEquity = saved.startOfDayEquity;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  if (initialBalance === null) {
    initialBalance = info.balance;
    changed = true;
  }
  if (riskDay !== today || startOfDayEquity === null) {
    riskDay = today;
    startOfDayEquity = info.equity;
    changed = true;
  }
  if (changed) await saveRiskState();
}

async function getInitializedAccountInfo() {
  const info = await getAccountInfo();
  await ensureRiskState(info);
  return info;
}

export async function initRiskManager() {
  const info = await getAccountInfo();
  await ensureRiskState(info);
  console.info(`[risk] Ready; balance ${info.balance} ${info.currency}, daily baseline ${startOfDayEquity}, total baseline ${initialBalance}.`);
}

export async function canTrade(volume, openPositionsCount) {
  const info = await getInitializedAccountInfo();
  if (!Number.isFinite(volume) || volume <= 0) return { allowed: false, reason: "Invalid order volume" };
  if (volume > RULES.maxLotSize) return { allowed: false, reason: `Lot size ${volume} exceeds max ${RULES.maxLotSize}` };
  if (openPositionsCount >= RULES.maxPositions) return { allowed: false, reason: "Max open positions reached" };

  const dailyLossPct = ((startOfDayEquity - info.equity) / startOfDayEquity) * 100;
  if (dailyLossPct >= RULES.maxDailyLossPercent) return { allowed: false, reason: `Daily loss limit hit: ${dailyLossPct.toFixed(2)}%` };

  const totalDDPct = ((initialBalance - info.equity) / initialBalance) * 100;
  if (totalDDPct >= RULES.maxTotalDrawdown) return { allowed: false, reason: `Total drawdown limit hit: ${totalDDPct.toFixed(2)}%` };
  return { allowed: true };
}

export async function getRiskStatus() {
  const info = await getInitializedAccountInfo();
  const dailyLossPct = ((startOfDayEquity - info.equity) / startOfDayEquity) * 100;
  const totalDDPct = ((initialBalance - info.equity) / initialBalance) * 100;
  return {
    balance: info.balance,
    equity: info.equity,
    dailyLossPct: dailyLossPct.toFixed(2),
    totalDrawdownPct: totalDDPct.toFixed(2),
    dailyLimit: RULES.maxDailyLossPercent,
    totalLimit: RULES.maxTotalDrawdown,
    safeToTrade: dailyLossPct < RULES.maxDailyLossPercent && totalDDPct < RULES.maxTotalDrawdown
  };
}