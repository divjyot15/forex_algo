import ExcelJS from "exceljs";
import path from "path";
import fs from "fs";

// =============================================================================
// EXCEL EXPORT — writes the full backtest run to a single .xlsx workbook
// =============================================================================
//
// Sheets produced:
//   1) Summary            -> final statistics (balance, win rate, etc.)
//   2) Trades              -> every individual trade with entry/exit/PNL
//   3) Order Blocks (15m)  -> full lifecycle of every 15m OB
//   4) Swings (15m)        -> every ZigZag swing (HH/HL/LH/LL)
//   5) Structure Events    -> every BOS / CHOCH
//   6) Entry Signals (5m)  -> every actual BUY/SELL trigger
//
// Usage (inside backtest.js):
//
//   import { exportBacktestToExcel } from "./exportBacktestToExcel.js";
//   ...
//   await exportBacktestToExcel({
//       statistics,
//       trades: backtester.trades,
//       orderBlocks: engine.obManager.orderBlocks,
//       swings,
//       structureEvents,
//       entrySignals,
//       toIST
//   });
//
// =============================================================================

function autoFitColumns(sheet) {
    sheet.columns.forEach(column => {
        let maxLength = 10;

        column.eachCell({ includeEmpty: true }, cell => {
            const len = cell.value ? String(cell.value).length : 0;
            if (len > maxLength) maxLength = len;
        });

        column.width = Math.min(maxLength + 2, 40);
    });
}

function styleHeaderRow(sheet) {
    const headerRow = sheet.getRow(1);

    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1F4E78" }
    };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };
    headerRow.height = 20;

    sheet.views = [{ state: "frozen", ySplit: 1 }];
}

export async function exportBacktestToExcel({
    statistics,
    trades = [],
    orderBlocks = [],
    swings = [],
    structureEvents = [],
    entrySignals = [],
    toIST,
    outputDir = "./backtest_results",
    fileName
}) {

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "XAUUSD Backtest Engine";
    workbook.created = new Date();

    // =========================================================================
    // 1) SUMMARY
    // =========================================================================

    const summarySheet = workbook.addWorksheet("Summary");

    summarySheet.columns = [
        { header: "Metric", key: "metric" },
        { header: "Value", key: "value" }
    ];

    const summaryRows = [
        ["Initial Balance", `$${statistics.initialBalance.toFixed(2)}`],
        ["Final Balance", `$${statistics.finalBalance.toFixed(2)}`],
        ["Total P/L", `$${statistics.totalPnL.toFixed(2)}`],
        ["Return %", `${statistics.returnPercent.toFixed(2)}%`],
        ["Total Trades", statistics.totalTrades],
        ["Winning Trades", statistics.winningTrades],
        ["Losing Trades", statistics.losingTrades],
        ["Breakeven Trades", statistics.breakevenTrades],
        ["Win Rate", `${statistics.winRate.toFixed(2)}%`],
        ["Gross Profit", `$${statistics.grossProfit.toFixed(2)}`],
        ["Gross Loss", `$${statistics.grossLoss.toFixed(2)}`],
        [
            "Profit Factor",
            Number.isFinite(statistics.profitFactor)
                ? statistics.profitFactor.toFixed(2)
                : "Infinity"
        ]
    ];

    summaryRows.forEach(([metric, value]) =>
        summarySheet.addRow({ metric, value })
    );

    styleHeaderRow(summarySheet);
    autoFitColumns(summarySheet);

    // Color the Total P/L and Return rows green/red based on sign.
    const pnlRow = summarySheet.getRow(3);
    const returnRow = summarySheet.getRow(4);

    [pnlRow, returnRow].forEach(row => {
        const isNegative = statistics.totalPnL < 0;
        row.getCell(2).font = {
            bold: true,
            color: { argb: isNegative ? "FFC00000" : "FF008000" }
        };
    });

    // =========================================================================
    // 2) TRADES
    // =========================================================================

    const tradesSheet = workbook.addWorksheet("Trades");

    tradesSheet.columns = [
        { header: "Trade #", key: "tradeId", width: 10 },
        { header: "Direction", key: "direction", width: 12 },
        { header: "Parent OB", key: "parentOBId", width: 12 },
        { header: "Pattern", key: "pattern", width: 20 },
        { header: "Entry", key: "entry", width: 12 },
        { header: "Stop Loss", key: "stopLoss", width: 12 },
        { header: "TP1", key: "target1", width: 12 },
        { header: "TP2", key: "target2", width: 12 },
        { header: "Lots", key: "lots", width: 10 },
        { header: "TP1 Hit", key: "tp1Hit", width: 10 },
        { header: "TP2 Hit", key: "tp2Hit", width: 10 },
        { header: "Exit Price", key: "exitPrice", width: 12 },
        { header: "Exit Reason", key: "exitReason", width: 20 },
        { header: "P/L ($)", key: "pnl", width: 14 },
        { header: "Entry Time (IST)", key: "entryTime", width: 22 },
        { header: "Exit Time (IST)", key: "exitTime", width: 22 }
    ];

    trades.forEach(t => {
        const row = tradesSheet.addRow({
            tradeId: t.tradeId,
            direction: t.direction,
            parentOBId: `#${t.parentOBId}`,
            pattern: t.pattern,
            entry: t.entry,
            stopLoss: t.originalStopLoss,
            target1: t.target1,
            target2: t.target2,
            lots: Number(t.initialLotSize.toFixed(4)),
            tp1Hit: t.tp1Hit ? "YES" : "NO",
            tp2Hit: t.tp2Hit ? "YES" : "NO",
            exitPrice: t.exitPrice,
            exitReason: t.exitReason,
            pnl: Number(t.realizedPnL.toFixed(2)),
            entryTime: toIST ? toIST(t.entryTime) : t.entryTime,
            exitTime: t.exitTime ? (toIST ? toIST(t.exitTime) : t.exitTime) : ""
        });

        const pnlCell = row.getCell("pnl");
        pnlCell.font = {
            bold: true,
            color: { argb: t.realizedPnL < 0 ? "FFC00000" : "FF008000" }
        };
    });

    styleHeaderRow(tradesSheet);
    autoFitColumns(tradesSheet);

    // =========================================================================
    // 3) ORDER BLOCKS (15M)
    // =========================================================================

    const obSheet = workbook.addWorksheet("Order Blocks (15m)");

    obSheet.columns = [
        { header: "ID", key: "id", width: 8 },
        { header: "OB Candle (IST)", key: "obCandle", width: 22 },
        { header: "Type", key: "type", width: 10 },
        { header: "Zone Low", key: "low", width: 12 },
        { header: "Zone High", key: "high", width: 12 },
        { header: "Swing", key: "swing", width: 16 },
        { header: "Status", key: "status", width: 14 },
        { header: "Discovery", key: "discovery", width: 24 },
        { header: "5m Zones Found", key: "zonesFound", width: 16 }
    ];

    orderBlocks
        .slice()
        .sort((a, b) => a.index - b.index)
        .forEach(ob => {
            obSheet.addRow({
                id: ob.id,
                obCandle: toIST ? toIST(ob.time) : ob.time,
                type: ob.obType,
                low: ob.low,
                high: ob.high,
                swing: `${ob.swingStartType} → ${ob.swingEndType}`,
                status: ob.status,
                discovery:
                    ob.discoverySource === "PREVIOUS_SWING_CARRYOVER"
                        ? "CARRYOVER"
                        : ob.discoverySource,
                zonesFound: ob.overlapping5mOBs ? ob.overlapping5mOBs.length : 0
            });
        });

    styleHeaderRow(obSheet);
    autoFitColumns(obSheet);

    // =========================================================================
    // 4) SWINGS (15M)
    // =========================================================================

    const swingsSheet = workbook.addWorksheet("Swings (15m)");

    swingsSheet.columns = [
        { header: "Type", key: "type", width: 10 },
        { header: "Classification", key: "classification", width: 16 },
        { header: "Price", key: "price", width: 12 },
        { header: "Swing Time (IST)", key: "swingTime", width: 22 },
        { header: "Detected At (IST)", key: "detectedAt", width: 22 }
    ];

    swings.forEach(s => {
        swingsSheet.addRow({
            type: s.type,
            classification: s.classification,
            price: s.price,
            swingTime: toIST ? toIST(s.swingTime) : s.swingTime,
            detectedAt: toIST ? toIST(s.detectedAt) : s.detectedAt
        });
    });

    styleHeaderRow(swingsSheet);
    autoFitColumns(swingsSheet);

    // =========================================================================
    // 5) STRUCTURE EVENTS (BOS / CHOCH)
    // =========================================================================

    const structureSheet = workbook.addWorksheet("Structure Events");

    structureSheet.columns = [
        { header: "Kind", key: "kind", width: 10 },
        { header: "Direction", key: "direction", width: 12 },
        { header: "Time (IST)", key: "time", width: 22 },
        { header: "Break Price", key: "breakPrice", width: 14 },
        { header: "Broken Swing Type", key: "brokenSwingType", width: 18 },
        { header: "Broken Price", key: "brokenPrice", width: 14 },
        { header: "Previous Structure", key: "previousStructure", width: 18 }
    ];

    structureEvents.forEach(e => {
        structureSheet.addRow({
            kind: e.kind,
            direction: e.direction,
            time: e.time, // already IST-formatted string upstream
            breakPrice: e.breakPrice,
            brokenSwingType: e.brokenSwingType,
            brokenPrice: e.brokenPrice,
            previousStructure: e.previousStructure
        });
    });

    styleHeaderRow(structureSheet);
    autoFitColumns(structureSheet);

    // =========================================================================
    // 6) ENTRY SIGNALS (5M)
    // =========================================================================

    const signalsSheet = workbook.addWorksheet("Entry Signals (5m)");

    signalsSheet.columns = [
        { header: "Alert Type", key: "alertType", width: 14 },
        { header: "Zone", key: "zone", width: 20 },
        { header: "OB Type", key: "obType", width: 12 },
        { header: "Parent OB", key: "parentOB", width: 20 },
        { header: "Pattern", key: "pattern", width: 20 },
        { header: "Entry Time (IST)", key: "entryTime", width: 22 }
    ];

    entrySignals.forEach(s => {
        signalsSheet.addRow({
            alertType: s.alertType,
            zone: `${s.low} - ${s.high}`,
            obType: s.obType,
            parentOB: `15m ${s.parentLabel} #${s.parentOBId}`,
            pattern: s.pattern,
            entryTime: s.entryTime // already IST-formatted string upstream
        });
    });

    styleHeaderRow(signalsSheet);
    autoFitColumns(signalsSheet);

    // =========================================================================
    // WRITE FILE
    // =========================================================================

    const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-");

    const finalFileName = fileName || `backtest_${timestamp}.xlsx`;
    const filePath = path.join(outputDir, finalFileName);

    await workbook.xlsx.writeFile(filePath);

    console.log(`\n📊 Excel report saved: ${filePath}`);

    return filePath;
}