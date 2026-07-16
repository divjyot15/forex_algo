import { getAccountInfo } from "./trader.service.js";

const RULES = {
  maxDailyLossPercent: 4.5,
  maxTotalDrawdown   : 9,
  maxPositions       : 5,
  maxLotSize         : 1.0,
};

let startOfDayBalance = null;
let initialBalance    = null;

export async function initRiskManager() {
  const info        = await getAccountInfo();
  startOfDayBalance = info.balance;
  initialBalance    = info.balance;
  console.log(`📊 Risk Manager ready — Balance: ${info.balance} ${info.currency}`);
}

export async function canTrade(volume, openPositionsCount) {
  const info = await getAccountInfo();

  if (volume > RULES.maxLotSize)
    return { allowed: false, reason: `Lot size ${volume} exceeds max ${RULES.maxLotSize}` };

  if (openPositionsCount >= RULES.maxPositions)
    return { allowed: false, reason: "Max open positions reached" };

  const dailyLossPct = ((startOfDayBalance - info.equity) / startOfDayBalance) * 100;
  if (dailyLossPct >= RULES.maxDailyLossPercent)
    return { allowed: false, reason: `Daily loss limit hit: ${dailyLossPct.toFixed(2)}%` };

  const totalDDPct = ((initialBalance - info.equity) / initialBalance) * 100;
  if (totalDDPct >= RULES.maxTotalDrawdown)
    return { allowed: false, reason: `Total drawdown limit hit: ${totalDDPct.toFixed(2)}%` };

  return { allowed: true };
}

export async function getRiskStatus() {
  const info         = await getAccountInfo();
  const dailyLossPct = ((startOfDayBalance - info.equity) / startOfDayBalance) * 100;
  const totalDDPct   = ((initialBalance    - info.equity) / initialBalance)    * 100;

  return {
    balance         : info.balance,
    equity          : info.equity,
    dailyLossPct    : dailyLossPct.toFixed(2),
    totalDrawdownPct: totalDDPct.toFixed(2),
    dailyLimit      : RULES.maxDailyLossPercent,
    totalLimit      : RULES.maxTotalDrawdown,
    safeToTrade     : dailyLossPct < RULES.maxDailyLossPercent && totalDDPct < RULES.maxTotalDrawdown,
  };
}