import { getConnection } from "../connection/metaapi.js";

export async function getAccountInfo() {
  const info = await getConnection().getAccountInformation();
  return {
    balance   : info.balance,
    equity    : info.equity,
    margin    : info.margin,
    freeMargin: info.freeMargin,
    currency  : info.currency,
    leverage  : info.leverage,
  };
}

export async function getPrice(symbol) {
  const price = await getConnection().getSymbolPrice(symbol);
  return {
    symbol,
    bid   : price.bid,
    ask   : price.ask,
    spread: (price.ask - price.bid).toFixed(5),
  };
}

export async function placeOrder({ symbol, type, volume, sl, tp, comment = "forex-algo", clientId }) {

  const connection = getConnection();

  let result;

  if (type === "BUY") {

    result = await connection.createMarketBuyOrder(
      symbol,
      volume,
      sl || undefined,
      tp || undefined,
      {
        comment,
        clientId
      }
    );

  } else if (type === "SELL") {

    result = await connection.createMarketSellOrder(
      symbol,
      volume,
      sl || undefined,
      tp || undefined,
      {
        comment,
        clientId
      }
    );

  } else {
    throw new Error("Invalid order type. Use BUY or SELL");
  }


  return {
    success: true,
    orderId: result.orderId,
    positionId: result.positionId
  };
}

export async function getSymbolSpecification(symbol) {
  return getConnection().getSymbolSpecification(symbol);
}

export async function getPositions() {
  const positions = await getConnection().getPositions();
  return positions.map(p => ({
    id          : p.id,
    symbol      : p.symbol,
    type        : p.type,
    volume      : p.volume,
    openPrice   : p.openPrice,
    currentPrice: p.currentPrice,
    profit      : p.profit,
    sl          : p.stopLoss,
    tp          : p.takeProfit,
    openTime    : p.time,
    magic       : p.magic,
    comment     : p.comment,
    clientId    : p.clientId,
  }));
}

export async function closePosition(positionId) {
  await getConnection().closePosition(positionId);
  return { success: true };
}

export async function closePositionPartially(positionId, volume, comment = "forex-algo") {
  const result = await getConnection().closePositionPartially(positionId, volume, { comment });
  return {
    success: true,
    orderId: result.orderId,
    positionId: result.positionId
  };
}

export async function closeAllPositions() {
  const positions = await getPositions();
  const results   = await Promise.all(positions.map(p => closePosition(p.id)));
  return { success: true, closed: results.length };
}

export async function modifyPosition(positionId, { sl, tp }) {
  await getConnection().modifyPosition(positionId, sl, tp);
  return { success: true };
}