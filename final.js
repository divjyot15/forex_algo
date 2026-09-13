import dotenv from "dotenv";
dotenv.config();

import {
    getAccount,
    initConnection
} from "./src/connection/metaapi.js";


// =============================================================================
// CONNECTION
// =============================================================================

let connection = await initConnection();


// =============================================================================
// HISTORICAL CANDLES
// =============================================================================

const getHistoricalCandles = async (timeframe = "15m") => {

    try {

        console.log(`⏳ Fetching ${timeframe} candles via MetaApi...`);

        const account = getAccount();

        const from = new Date(
            Date.now() - 2 * 24 * 60 * 60 * 1000
        );

        const candles =
            await account.getHistoricalCandles(
                "XAUUSD",
                timeframe,
                from
            );

        console.log(
            `Received ${candles?.length ?? 0} ${timeframe} candles`
        );

        return candles;

    } catch (err) {

        console.error(err.stack);

        return [];
    }
};


// =============================================================================
// TIME HELPERS
// =============================================================================

function toIST(date) {

    return new Date(date).toLocaleString(
        "en-IN",
        {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
        }
    );
}


function istParts(date) {

    const parts =
        new Intl.DateTimeFormat(
            "en-IN",
            {
                timeZone: "Asia/Kolkata",
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false
            }
        ).formatToParts(new Date(date));

    const get = type =>
        parts.find(
            p => p.type === type
        )?.value ?? "";

    return {

        date:
            `${get("day")}/${get("month")}/${get("year")}`,

        time:
            `${get("hour")}:${get("minute")}`,

        full:
            `${get("day")}/${get("month")}/${get("year")} ` +
            `${get("hour")}:${get("minute")}:${get("second")}`
    };
}


// =============================================================================
// DEBUG HELPERS
// =============================================================================

const DEBUG_TARGET_DATE = "14/08/2026";
const DEBUG_TARGET_TIME = "05:30";


function isDebugTargetCandle(candle) {

    if (!candle || !candle.time) {
        return false;
    }

    const p = istParts(candle.time);

    return (
        p.date === DEBUG_TARGET_DATE &&
        p.time === DEBUG_TARGET_TIME
    );
}


function debugCandle(
    candle,
    label = ""
) {

    if (!candle) {
        return null;
    }

    return {

        label,

        index:
            candle.index,

        timeIST:
            istParts(candle.time).full,

        open:
            candle.open,

        high:
            candle.high,

        low:
            candle.low,

        close:
            candle.close
    };
}


// =============================================================================
// 1) ZIGZAG SWING DETECTOR (15M)
// =============================================================================

class ZigZagDetector {

    constructor(length = 9) {

        this.length = length;

        this.trend = 1;

        this.currentHigh = null;

        this.currentLow = null;

        this.window = [];
    }


    onCandle(
        candle,
        index
    ) {

        const previousWindow =
            [...this.window];

        this.window.push({
            candle,
            index
        });

        if (
            this.window.length >
            this.length
        ) {

            this.window.shift();
        }

        if (
            previousWindow.length <
            this.length - 1
        ) {

            return null;
        }


        // =========================================================================
        // UPWARD LEG
        // =========================================================================

        if (
            this.trend === 1
        ) {

            if (
                !this.currentHigh ||
                candle.high >
                this.currentHigh.candle.high
            ) {

                this.currentHigh = {
                    candle,
                    index
                };
            }


            const previousLowest =
                Math.min(
                    ...previousWindow.map(
                        item =>
                            item.candle.low
                    )
                );


            const toDown =
                candle.low <
                previousLowest;


            if (
                toDown &&
                this.currentHigh
            ) {

                const swing = {

                    type:
                        "HIGH",

                    price:
                        this.currentHigh.candle.high,

                    index:
                        this.currentHigh.index,

                    swingTime:
                        this.currentHigh.candle.time,

                    detectedAt:
                        candle.time
                };


                this.trend = -1;

                this.currentLow = null;

                this.currentHigh = null;

                return swing;
            }


            return null;
        }


        // =========================================================================
        // DOWNWARD LEG
        // =========================================================================

        if (
            this.trend === -1
        ) {

            if (
                !this.currentLow ||
                candle.low <
                this.currentLow.candle.low
            ) {

                this.currentLow = {
                    candle,
                    index
                };
            }


            const previousHighest =
                Math.max(
                    ...previousWindow.map(
                        item =>
                            item.candle.high
                    )
                );


            const toUp =
                candle.high >
                previousHighest;


            if (
                toUp &&
                this.currentLow
            ) {

                const swing = {

                    type:
                        "LOW",

                    price:
                        this.currentLow.candle.low,

                    index:
                        this.currentLow.index,

                    swingTime:
                        this.currentLow.candle.time,

                    detectedAt:
                        candle.time
                };


                this.trend = 1;

                this.currentHigh = null;

                this.currentLow = null;

                return swing;
            }


            return null;
        }


        return null;
    }
}


// =============================================================================
// 2) STRUCTURE DETECTOR (15M)
// =============================================================================

class StructureDetector {

    constructor() {

        this.swings = [];

        this.lastHigh = null;

        this.lastLow = null;

        this.lastHH = null;

        this.lastHL = null;

        this.lastLH = null;

        this.lastLL = null;

        this.structure = null;

        this.protectedHigh = null;

        this.protectedLow = null;

        this.lastEvent = null;

        this.brokenLevelIndex = null;

        this.eventSequence = 0;
    }


    addSwing(swing) {

        if (!swing) {
            return null;
        }


        const alreadyExists =
            this.swings.some(
                s =>
                    s.index ===
                    swing.index
            );


        if (alreadyExists) {
            return null;
        }


        const sameCandle =
            this.swings.some(
                s =>
                    s.index === swing.index &&
                    s.type !== swing.type
            );


        if (sameCandle) {

            console.warn(
                `⚠️ Ignoring ${swing.type} swing at index ${swing.index}`
            );

            return null;
        }


        this.swings.push(swing);


        if (
            swing.type === "HIGH"
        ) {

            return this._processHigh(
                swing
            );
        }


        if (
            swing.type === "LOW"
        ) {

            return this._processLow(
                swing
            );
        }


        return null;
    }


    _processHigh(swing) {

        let classification = "HIGH";

        const previousHigh =
            this.lastHigh;


        if (previousHigh) {

            if (
                swing.price >
                previousHigh.price
            ) {

                classification = "HH";

            } else {

                classification = "LH";
            }
        }


        swing.classification =
            classification;


        this.lastHigh =
            swing;


        if (
            classification === "HH"
        ) {

            this.lastHH =
                swing;


            if (this.lastHL) {

                this.structure =
                    "bullish";

                this.protectedHigh =
                    swing;
            }
        }


        else if (
            classification === "LH"
        ) {

            this.lastLH =
                swing;


            if (this.lastLL) {

                this.structure =
                    "bearish";

                this.protectedHigh =
                    swing;
            }
        }


        return {

            type:
                "SWING_CLASSIFICATION",

            swing,

            classification,

            previousHigh,

            structure:
                this.structure
        };
    }


    _processLow(swing) {

        let classification = "LOW";

        const previousLow =
            this.lastLow;


        if (previousLow) {

            if (
                swing.price >
                previousLow.price
            ) {

                classification = "HL";

            } else {

                classification = "LL";
            }
        }


        swing.classification =
            classification;


        this.lastLow =
            swing;


        if (
            classification === "HL"
        ) {

            this.lastHL =
                swing;


            if (this.lastHH) {

                this.structure =
                    "bullish";

                this.protectedLow =
                    swing;
            }
        }


        else if (
            classification === "LL"
        ) {

            this.lastLL =
                swing;


            if (this.lastLH) {

                this.structure =
                    "bearish";

                this.protectedLow =
                    swing;
            }
        }


        return {

            type:
                "SWING_CLASSIFICATION",

            swing,

            classification,

            previousLow,

            structure:
                this.structure
        };
    }


    onCandle(
        candle,
        index
    ) {

        const events = [];


        if (!this.structure) {
            return events;
        }


        // =========================================================================
        // BULLISH STRUCTURE
        // =========================================================================

        if (
            this.structure === "bullish"
        ) {

            // =======================================================================
            // BEARISH CHOCH
            // =======================================================================

            if (
                this.protectedLow &&
                candle.close <
                this.protectedLow.price
            ) {

                if (
                    this.brokenLevelIndex !==
                    this.protectedLow.index
                ) {

                    const brokenSwing =
                        this.protectedLow;


                    const event =
                        this._createBreakEvent({

                            kind:
                                "CHOCH",

                            direction:
                                "bearish",

                            brokenSwing,

                            candle,

                            index,

                            obType:
                                "bearish",

                            previousStructure:
                                "bullish"
                        });


                    events.push(event);

                    this.lastEvent =
                        event;

                    this.eventSequence++;

                    this.brokenLevelIndex =
                        brokenSwing.index;


                    this.structure =
                        "bearish";

                    this.protectedLow =
                        null;

                    this.protectedHigh =
                        null;
                }


                return events;
            }


            // =======================================================================
            // BULLISH BOS
            // =======================================================================

            if (
                this.protectedHigh &&
                candle.close >
                this.protectedHigh.price
            ) {

                if (
                    this.brokenLevelIndex !==
                    this.protectedHigh.index
                ) {

                    const brokenSwing =
                        this.protectedHigh;


                    const event =
                        this._createBreakEvent({

                            kind:
                                "BOS",

                            direction:
                                "bullish",

                            brokenSwing,

                            candle,

                            index,

                            obType:
                                "bullish",

                            previousStructure:
                                "bullish"
                        });


                    events.push(event);

                    this.lastEvent =
                        event;

                    this.eventSequence++;

                    this.brokenLevelIndex =
                        brokenSwing.index;

                    this.protectedHigh =
                        null;
                }


                return events;
            }
        }


        // =========================================================================
        // BEARISH STRUCTURE
        // =========================================================================

        if (
            this.structure === "bearish"
        ) {

            // =======================================================================
            // BULLISH CHOCH
            // =======================================================================

            if (
                this.protectedHigh &&
                candle.close >
                this.protectedHigh.price
            ) {

                if (
                    this.brokenLevelIndex !==
                    this.protectedHigh.index
                ) {

                    const brokenSwing =
                        this.protectedHigh;


                    const event =
                        this._createBreakEvent({

                            kind:
                                "CHOCH",

                            direction:
                                "bullish",

                            brokenSwing,

                            candle,

                            index,

                            obType:
                                "bullish",

                            previousStructure:
                                "bearish"
                        });


                    events.push(event);

                    this.lastEvent =
                        event;

                    this.eventSequence++;

                    this.brokenLevelIndex =
                        brokenSwing.index;

                    this.structure =
                        "bullish";

                    this.protectedHigh =
                        null;

                    this.protectedLow =
                        null;
                }


                return events;
            }


            // =======================================================================
            // BEARISH BOS
            // =======================================================================

            if (
                this.protectedLow &&
                candle.close <
                this.protectedLow.price
            ) {

                if (
                    this.brokenLevelIndex !==
                    this.protectedLow.index
                ) {

                    const brokenSwing =
                        this.protectedLow;


                    const event =
                        this._createBreakEvent({

                            kind:
                                "BOS",

                            direction:
                                "bearish",

                            brokenSwing,

                            candle,

                            index,

                            obType:
                                "bearish",

                            previousStructure:
                                "bearish"
                        });


                    events.push(event);

                    this.lastEvent =
                        event;

                    this.eventSequence++;

                    this.brokenLevelIndex =
                        brokenSwing.index;

                    this.protectedLow =
                        null;
                }


                return events;
            }
        }


        return events;
    }


    _createBreakEvent({

        kind,

        direction,

        brokenSwing,

        candle,

        index,

        obType,

        previousStructure

    }) {

        return {

            kind,

            direction,

            time:
                candle.time,

            breakTime:
                candle.time,

            breakCandleIndex:
                index,

            breakPrice:
                candle.close,

            breakOpen:
                candle.open,

            breakHigh:
                candle.high,

            breakLow:
                candle.low,

            breakClose:
                candle.close,

            brokenSwingIndex:
                brokenSwing.index,

            brokenSwingType:
                brokenSwing.type,

            brokenPrice:
                brokenSwing.price,

            brokenSwingTime:
                brokenSwing.swingTime,

            brokenSwingDetectedAt:
                brokenSwing.detectedAt,

            previousStructure,

            obType,

            obRange: {

                from:
                    brokenSwing.index,

                to:
                    index
            }
        };
    }
}


// =============================================================================
// 3) FVG TRACKER (used for BOTH 15m internal OB search AND raw 5m pool)
// =============================================================================

function isBearishCandle(c) {

    return c.close < c.open;
}


function isBullishCandle(c) {

    return c.close > c.open;
}


class FVGTracker {

    constructor(
        maxPoolSize = 2000
    ) {

        this.window = [];

        this.confirmed = [];

        this.maxPoolSize =
            maxPoolSize;
    }


    onCandle(
        candle,
        index
    ) {

        this.window.push({

            candle,

            index
        });


        if (
            this.window.length > 3
        ) {

            this.window.shift();
        }


        if (
            this.window.length < 3
        ) {

            return null;
        }


        const [
            c0,
            c1,
            c2
        ] =
            this.window;


        // =========================================================================
        // TARGET DEBUG
        // =========================================================================

        if (
            isDebugTargetCandle(
                c0.candle
            )
        ) {

            const bullishGap =
                c2.candle.low >
                c0.candle.high;


            const bearishGap =
                c2.candle.high <
                c0.candle.low;


            console.log(
                "\n🧪 TARGET 05:30 FVG DEBUG — " +
                `bullish=${bullishGap} bearish=${bearishGap} ` +
                `confirm@${toIST(c2.candle.time)}`
            );
        }


        const found = [];


        // =========================================================================
        // BULLISH FVG
        // =========================================================================

        if (
            c2.candle.low >
            c0.candle.high
        ) {

            found.push(
                this._makeCandidate(
                    c0,
                    "bullish",
                    c2
                )
            );
        }


        // =========================================================================
        // BEARISH FVG
        // =========================================================================

        if (
            c2.candle.high <
            c0.candle.low
        ) {

            found.push(
                this._makeCandidate(
                    c0,
                    "bearish",
                    c2
                )
            );
        }


        if (
            found.length
        ) {

            this.confirmed.push(
                ...found
            );


            if (
                this.confirmed.length >
                this.maxPoolSize
            ) {

                this.confirmed.splice(
                    0,
                    this.confirmed.length -
                    this.maxPoolSize
                );
            }
        }


        return found.length
            ? found
            : null;
    }


    _makeCandidate(
        {
            candle,
            index
        },
        obType,
        confirmationCandle
    ) {

        return {

            index,

            high:
                candle.high,

            low:
                candle.low,

            time:
                candle.time,

            obType,

            candleColor:
                isBullishCandle(candle)
                    ? "bullish"
                    : isBearishCandle(candle)
                        ? "bearish"
                        : "doji",

            confirmedAt:
                confirmationCandle?.candle?.time ??
                null,

            confirmationIndex:
                confirmationCandle?.index ??
                null
        };
    }


    findInRange(
        fromIndex,
        toIndex,
        obType
    ) {

        if (
            fromIndex == null ||
            toIndex == null
        ) {

            return [];
        }


        const lo =
            Math.min(
                fromIndex,
                toIndex
            );


        const hi =
            Math.max(
                fromIndex,
                toIndex
            );


        return this.confirmed.filter(
            c =>
                c.obType === obType &&
                c.index >= lo &&
                c.index <= hi
        );
    }
}


// =============================================================================
// 3B) PRICE ZONE OVERLAP
//
// Two zones overlap if they share ANY price, regardless of time.
// =============================================================================

function zonesOverlap(
    aLow,
    aHigh,
    bLow,
    bHigh
) {

    return (
        aLow <= bHigh &&
        bLow <= aHigh
    );
}


// =============================================================================
// 4) CANDLESTICK PATTERNS (used only by the 5M entry watcher now)
// =============================================================================

function isBullishEngulfing(
    prev,
    curr
) {

    const prevBearish =
        prev.close < prev.open;

    const currBullish =
        curr.close > curr.open;


    if (
        !prevBearish ||
        !currBullish
    ) {

        return false;
    }


    return (

        curr.open <=
        prev.close &&

        curr.close >=
        prev.open
    );
}


function isBearishEngulfing(
    prev,
    curr
) {

    const prevBullish =
        prev.close > prev.open;

    const currBearish =
        curr.close < curr.open;


    if (
        !prevBullish ||
        !currBearish
    ) {

        return false;
    }


    return (

        curr.open >=
        prev.close &&

        curr.close <=
        prev.open
    );
}


function isMorningStar(
    c1,
    c2,
    c3
) {

    const c1Bearish =
        c1.close < c1.open;

    const c3Bullish =
        c3.close > c3.open;


    if (
        !c1Bearish ||
        !c3Bullish
    ) {

        return false;
    }


    const c1Body =
        Math.abs(
            c1.open -
            c1.close
        );


    const c2Body =
        Math.abs(
            c2.open -
            c2.close
        );


    const smallStar =
        c2Body <
        c1Body * 0.5;


    const c1Mid =
        (
            c1.open +
            c1.close
        ) / 2;


    const closesIntoC1 =
        c3.close >
        c1Mid;


    return (
        smallStar &&
        closesIntoC1
    );
}


function isEveningStar(
    c1,
    c2,
    c3
) {

    const c1Bullish =
        c1.close > c1.open;

    const c3Bearish =
        c3.close < c3.open;


    if (
        !c1Bullish ||
        !c3Bearish
    ) {

        return false;
    }


    const c1Body =
        Math.abs(
            c1.open -
            c1.close
        );


    const c2Body =
        Math.abs(
            c2.open -
            c2.close
        );


    const smallStar =
        c2Body <
        c1Body * 0.5;


    const c1Mid =
        (
            c1.open +
            c1.close
        ) / 2;


    const closesIntoC1 =
        c3.close <
        c1Mid;


    return (
        smallStar &&
        closesIntoC1
    );
}


// =============================================================================
// 5) ORDER BLOCK MANAGER (15M) — ZONE OF INTEREST ONLY
// =============================================================================
//
// IMPORTANT — CHANGED BEHAVIOR:
//
// This class NO LONGER generates trade signals. It only:
//
//     1) collects swing-based OB candidates (LH→LL / LL→HH), exactly as before
//     2) tracks each OB's lifecycle: waiting -> active -> invalidated
//
// "touched", "pattern", "signal" have been REMOVED from this class.
// The actual entry trigger now lives entirely in FiveMinuteEntryWatcher,
// which operates on 5m candles against 5m OBs that overlap an ACTIVE 15m OB.
//
// Bearish swing:      LH ======================= LL
// Bullish swing:      LL ======================= HH
//
// BOS / CHOCH NEVER CLOSES THE SWING. The swing closes ONLY at:
//     bearish -> LL
//     bullish -> HH
// =============================================================================

class OrderBlockManager {

    constructor() {

        this.orderBlocks = [];

        this.activeSwing = null;

        this.currentStructureEvents = [];

        this.nextObId = 1;
    }


    // =========================================================================
    // START NEW BEARISH SWING
    // =========================================================================

    startBearishSwing(
        swing,
        fvgTracker
    ) {

        if (
            !swing ||
            swing.type !== "HIGH" ||
            swing.classification !== "LH"
        ) {

            return;
        }


        this.activeSwing = {

            direction:
                "bearish",

            startType:
                "LH",

            startIndex:
                swing.index,

            startPrice:
                swing.price,

            startTime:
                swing.swingTime,

            endType:
                "LL",

            endIndex:
                null,

            endPrice:
                null,

            endTime:
                null,

            closed:
                false,

            bosOccurred:
                false,

            chochOccurred:
                false,

            bosEvents:
                [],

            obIds:
                []
        };


        console.log(
            `\n🟠 NEW BEARISH OB SWING — LH @ ${toIST(swing.swingTime)} ` +
            `(index ${swing.index}, price ${swing.price}). ` +
            `Collection range: LH → LL. BOS/CHOCH will NOT close this swing.`
        );


        // =========================================================================
        // CARRY OVER THE SINGLE CLOSEST VALID OB FROM BEFORE THIS PIVOT
        //
        // A clean bearish FVG can legitimately confirm 1-2 candles BEFORE the
        // ZigZag actually confirms the LH pivot (ZigZag confirmation always
        // lags). Without this, that OB would be silently dropped since it sits
        // just outside [swing.startIndex, ...]. We seed at most ONE such OB —
        // the closest one before the pivot — tagged distinctly so it's clear
        // it did not form inside this swing's own range.
        // =========================================================================

        if (
            fvgTracker
        ) {

            this._addCarryoverOB(
                fvgTracker,
                "bearish"
            );
        }
    }


    // =========================================================================
    // START NEW BULLISH SWING
    // =========================================================================

    startBullishSwing(
        swing,
        fvgTracker
    ) {

        if (
            !swing ||
            swing.type !== "LOW" ||
            swing.classification !== "LL"
        ) {

            return;
        }


        this.activeSwing = {

            direction:
                "bullish",

            startType:
                "LL",

            startIndex:
                swing.index,

            startPrice:
                swing.price,

            startTime:
                swing.swingTime,

            endType:
                "HH",

            endIndex:
                null,

            endPrice:
                null,

            endTime:
                null,

            closed:
                false,

            bosOccurred:
                false,

            chochOccurred:
                false,

            bosEvents:
                [],

            obIds:
                []
        };


        console.log(
            `\n🟢 NEW BULLISH OB SWING — LL @ ${toIST(swing.swingTime)} ` +
            `(index ${swing.index}, price ${swing.price}). ` +
            `Collection range: LL → HH. BOS/CHOCH will NOT close this swing.`
        );


        // =========================================================================
        // CARRY OVER THE SINGLE CLOSEST VALID OB FROM BEFORE THIS PIVOT
        //
        // Same reasoning as the bearish case: a clean bullish FVG can confirm
        // just before the ZigZag actually confirms the LL pivot. Seed at most
        // ONE such OB — the closest one before the pivot.
        // =========================================================================

        if (
            fvgTracker
        ) {

            this._addCarryoverOB(
                fvgTracker,
                "bullish"
            );
        }
    }


    // =========================================================================
    // HANDLE STRUCTURE EVENT (BOS/CHOCH is only a marker, not a swing-closer)
    // =========================================================================

    onStructureEvent(
        structureEvent
    ) {

        if (
            !structureEvent
        ) {

            return;
        }


        this.currentStructureEvents.push(
            structureEvent
        );


        if (
            !this.activeSwing
        ) {

            return;
        }


        if (
            structureEvent.kind ===
            "BOS"
        ) {

            this.activeSwing.bosOccurred =
                true;

            this.activeSwing.bosEvents.push(
                structureEvent
            );
        }


        if (
            structureEvent.kind ===
            "CHOCH"
        ) {

            this.activeSwing.chochOccurred =
                true;

            this.activeSwing.bosEvents.push(
                structureEvent
            );
        }
    }


    // =========================================================================
    // CLOSE BEARISH SWING AT LL
    // =========================================================================

    closeBearishSwing(
        swing,
        fvgTracker
    ) {

        if (
            !this.activeSwing ||
            this.activeSwing.direction !== "bearish" ||
            this.activeSwing.closed
        ) {

            return;
        }


        if (
            !swing ||
            swing.classification !== "LL"
        ) {

            return;
        }


        this.activeSwing.endIndex =
            swing.index;


        this.activeSwing.endPrice =
            swing.price;


        this.activeSwing.endTime =
            swing.swingTime;


        const candidates =
            fvgTracker.findInRange(

                this.activeSwing.startIndex,

                this.activeSwing.endIndex,

                "bearish"
            );


        for (
            const fvg of candidates
        ) {

            this.addConfirmedFVG(
                fvg,
                this.activeSwing.endIndex,
                "FINAL_SWING_SWEEP"
            );
        }


        this.activeSwing.closed =
            true;


        console.log(
            `\n🔴 BEARISH OB SWING CLOSED — LH ${toIST(this.activeSwing.startTime)} ` +
            `→ LL ${toIST(this.activeSwing.endTime)}. ` +
            `Total OBs: ${this.activeSwing.obIds.length}`
        );
    }


    // =========================================================================
    // CLOSE BULLISH SWING AT HH
    // =========================================================================

    closeBullishSwing(
        swing,
        fvgTracker
    ) {

        if (
            !this.activeSwing ||
            this.activeSwing.direction !== "bullish" ||
            this.activeSwing.closed
        ) {

            return;
        }


        if (
            !swing ||
            swing.classification !== "HH"
        ) {

            return;
        }


        this.activeSwing.endIndex =
            swing.index;


        this.activeSwing.endPrice =
            swing.price;


        this.activeSwing.endTime =
            swing.swingTime;


        const candidates =
            fvgTracker.findInRange(

                this.activeSwing.startIndex,

                this.activeSwing.endIndex,

                "bullish"
            );


        for (
            const fvg of candidates
        ) {

            this.addConfirmedFVG(
                fvg,
                this.activeSwing.endIndex,
                "FINAL_SWING_SWEEP"
            );
        }


        this.activeSwing.closed =
            true;


        console.log(
            `\n🔵 BULLISH OB SWING CLOSED — LL ${toIST(this.activeSwing.startTime)} ` +
            `→ HH ${toIST(this.activeSwing.endTime)}. ` +
            `Total OBs: ${this.activeSwing.obIds.length}`
        );
    }


    // =========================================================================
    // ADD CONFIRMED FVG AS A 15M OB CANDIDATE
    // =========================================================================

    addConfirmedFVG(
        fvg,
        currentIndex,
        source = "LIVE"
    ) {

        if (
            !fvg ||
            !this.activeSwing
        ) {

            return null;
        }


        const swing =
            this.activeSwing;


        if (
            fvg.obType !==
            swing.direction
        ) {

            return null;
        }


        const startIndex =
            swing.startIndex;


        const endIndex =
            swing.closed
                ? swing.endIndex
                : currentIndex;


        if (
            fvg.index <
            startIndex ||
            fvg.index >
            endIndex
        ) {

            return null;
        }


        const alreadyAdded =
            this.orderBlocks.some(
                ob =>
                    ob.index ===
                        fvg.index &&

                    ob.obType ===
                        fvg.obType &&

                    ob.swingStartIndex ===
                        swing.startIndex
            );


        if (
            alreadyAdded
        ) {

            return null;
        }


        const discoveredAfterBOS =
            swing.bosOccurred;


        const discoveredAfterCHOCH =
            swing.chochOccurred;


        const ob = {

            id:
                this.nextObId++,

            ...fvg,

            label:
                swing.direction ===
                "bullish"

                    ? "Swing-Bu-OB"

                    : "Swing-Be-OB",

            swingDirection:
                swing.direction,

            swingStartType:
                swing.startType,

            swingStartIndex:
                swing.startIndex,

            swingStartPrice:
                swing.startPrice,

            swingStartTime:
                swing.startTime,

            swingEndType:
                swing.endType,

            swingEndIndex:
                swing.endIndex,

            swingEndPrice:
                swing.endPrice,

            swingEndTime:
                swing.endTime,

            discoveredAtIndex:
                currentIndex,

            discoveredAfterBOS,

            discoveredAfterCHOCH,

            discoverySource:
                source,

            // Lifecycle: waiting -> active -> invalidated (NO touch/pattern/signal here)

            status:
                "waiting",

            // Populated live, in chronological order, by the merged replay loop.

            overlapping5mOBs:
                []
        };


        this.orderBlocks.push(
            ob
        );


        swing.obIds.push(
            ob.id
        );


        console.log(
            `\n📦 NEW 15m OB #${ob.id} [${ob.obType}] ` +
            `${ob.low} - ${ob.high} @ ${toIST(ob.time)} ` +
            `(swing ${ob.swingStartType} → ${ob.swingEndType}, ` +
            `${discoveredAfterBOS ? "AFTER BOS" : "before BOS"})`
        );


        return ob;
    }


    // =========================================================================
    // CARRY OVER THE SINGLE CLOSEST VALID OB FROM BEFORE THE SWING'S PIVOT
    // =========================================================================
    //
    // Called once, right when a new swing opens (startBearishSwing /
    // startBullishSwing). Looks BACKWARD from the pivot (swing.startIndex)
    // for the nearest confirmed FVG matching this swing's direction that
    // sits BEFORE the pivot — i.e. it belongs, strictly by index, to the
    // swing that just ended, not this new one.
    //
    // At most ONE such OB is carried over — the single closest to the pivot.
    // It is tagged discoverySource: "PREVIOUS_SWING_CARRYOVER" so it stays
    // distinguishable from OBs discovered live inside this swing's own range.
    //
    // Because its index is always < swing.startIndex, it will only ever be
    // promoted to "active" by refreshActiveStatuses() when it is the ONLY
    // OB registered so far in this swing — the moment a fresh, live OB is
    // found inside the swing's own range, that live OB (higher index) takes
    // over as "active" and the carryover falls back to "waiting".
    // =========================================================================

    _addCarryoverOB(
        fvgTracker,
        direction
    ) {

        if (
            !this.activeSwing ||
            this.activeSwing.direction !== direction
        ) {

            return null;
        }


        const pivotIndex =
            this.activeSwing.startIndex;


        const candidates =
            fvgTracker.confirmed.filter(
                fvg =>
                    fvg.obType === direction &&
                    fvg.index < pivotIndex
            );


        if (
            candidates.length === 0
        ) {

            return null;
        }


        // Closest to the pivot = highest index among those still before it.

        candidates.sort(
            (a, b) =>
                b.index -
                a.index
        );


        const closest =
            candidates[0];


        const alreadyAdded =
            this.orderBlocks.some(
                ob =>
                    ob.index === closest.index &&
                    ob.obType === closest.obType &&
                    ob.swingStartIndex === pivotIndex
            );


        if (
            alreadyAdded
        ) {

            return null;
        }


        const swing =
            this.activeSwing;


        const ob = {

            id:
                this.nextObId++,

            ...closest,

            label:
                direction === "bullish"
                    ? "Swing-Bu-OB"
                    : "Swing-Be-OB",

            swingDirection:
                direction,

            swingStartType:
                swing.startType,

            swingStartIndex:
                swing.startIndex,

            swingStartPrice:
                swing.startPrice,

            swingStartTime:
                swing.startTime,

            swingEndType:
                swing.endType,

            swingEndIndex:
                swing.endIndex,

            swingEndPrice:
                swing.endPrice,

            swingEndTime:
                swing.endTime,

            discoveredAtIndex:
                pivotIndex,

            discoveredAfterBOS:
                false,

            discoveredAfterCHOCH:
                false,

            discoverySource:
                "PREVIOUS_SWING_CARRYOVER",

            status:
                "waiting",

            overlapping5mOBs:
                []
        };


        this.orderBlocks.push(
            ob
        );


        swing.obIds.push(
            ob.id
        );


        console.log(
            `\n↩️  CARRYOVER 15m OB #${ob.id} [${ob.obType}] ` +
            `${ob.low} - ${ob.high} @ ${toIST(ob.time)} ` +
            `— closest valid OB found BEFORE pivot index ${pivotIndex} ` +
            `(swing ${swing.startType} → ${swing.endType})`
        );


        this.refreshActiveStatuses();


        return ob;
    }


    // =========================================================================
    // REFRESH ACTIVE STATUSES — newest non-invalidated OB is "active"
    // =========================================================================

    refreshActiveStatuses() {

        const openOBs =
            this.orderBlocks.filter(
                ob =>
                    ob.status !==
                        "invalidated"
            );


        if (
            openOBs.length === 0
        ) {

            return;
        }


        openOBs.sort(
            (a, b) =>
                b.index -
                a.index
        );


        openOBs.forEach(
            (ob, index) => {

                if (
                    index === 0
                ) {

                    if (
                        ob.status ===
                        "waiting"
                    ) {

                        ob.status =
                            "active";
                    }

                } else {

                    if (
                        ob.status ===
                        "active"
                    ) {

                        ob.status =
                            "waiting";
                    }
                }
            }
        );
    }


    // =========================================================================
    // CANDLE PROCESSING — INVALIDATION ONLY
    // =========================================================================

    onCandle(
        candle
    ) {

        const alerts = [];


        const activeOB =
            this.orderBlocks.find(
                ob =>
                    ob.status ===
                    "active"
            );


        if (
            !activeOB
        ) {

            return alerts;
        }


        if (
            activeOB.obType ===
            "bullish"
        ) {

            if (
                candle.close <
                activeOB.low
            ) {

                activeOB.status =
                    "invalidated";


                alerts.push({

                    ob:
                        activeOB,

                    type:
                        "invalidated",

                    note:
                        "Closed below bullish OB."
                });


                this.refreshActiveStatuses();
            }

        } else {

            if (
                candle.close >
                activeOB.high
            ) {

                activeOB.status =
                    "invalidated";


                alerts.push({

                    ob:
                        activeOB,

                    type:
                        "invalidated",

                    note:
                        "Closed above bearish OB."
                });


                this.refreshActiveStatuses();
            }
        }


        return alerts;
    }
}

// =============================================================================
// 5B) 5-MINUTE ENTRY WATCHER — THE ONLY SOURCE OF TRADE SIGNALS
// =============================================================================
//
// A 15m OB only tells us WHERE to look.
//
// The actual trade trigger is:
//
//     1) an overlapping 5m OB gets TOUCHED by 5m price
//     2) a reversal pattern CONFIRMS on the SAME 5m OB
//
// Each watched zone remembers which 15m OB it came from.
//
// IMPORTANT — TIMING:
//
// Zones are registered ONLY at the exact chronological moment their parent
// 15m OB is active AND the 5m FVG has already been confirmed by that point
// in simulated time. Because the replay loop processes candles in true
// chronological order (see main()), this class never gets tested against
// candles from before the zone existed.
// =============================================================================

class FiveMinuteEntryWatcher {

    constructor() {

        this.zones = [];

        this.recentCandles = [];

        // =========================================================================
        // ONE TRADE EVENT PER 15M SETUP
        //
        // Once any 5m zone belonging to a 15m parent OB generates a BUY/SELL
        // signal, that parent setup is locked and no other 5m child zone
        // belonging to the same 15m OB can generate another trade signal.
        // =========================================================================

        this.signalledParents =
            new Set();
    }


    // =========================================================================
    // REGISTER A 15M OB'S CURRENTLY-KNOWN OVERLAPPING 5M ZONES
    // =========================================================================

    registerFromParent(parentOB) {

        if (
            !parentOB ||
            parentOB.status !== "active" ||
            !parentOB.overlapping5mOBs ||
            parentOB.overlapping5mOBs.length === 0
        ) {

            return;
        }


        for (
            const fvg of parentOB.overlapping5mOBs
        ) {

            const alreadyWatching =
                this.zones.some(
                    z =>
                        z.index === fvg.index &&
                        z.obType === fvg.obType &&
                        z.parentOBId === parentOB.id
                );


            if (
                alreadyWatching
            ) {

                continue;
            }


            this.zones.push({

                ...fvg,

                parentOBId:
                    parentOB.id,

                parentLabel:
                    parentOB.label,

                parentZone: {

                    low:
                        parentOB.low,

                    high:
                        parentOB.high
                },

                status:
                    "active",

                touchedAt:
                    null,

                signalAt:
                    null,

                pattern:
                    null
            });


            console.log(
                `\n👁️ Watching 5m ${fvg.obType} OB @ ${toIST(fvg.time)} ` +
                `zone ${fvg.low} - ${fvg.high} ` +
                `(parent: 15m ${parentOB.label} #${parentOB.id})`
            );
        }
    }


    // =========================================================================
    // PARENT 15M OB INVALIDATED -> RETIRE ITS STILL-OPEN CHILD ZONES
    // =========================================================================

    invalidateZonesForParent(parentOBId) {

        for (
            const zone of this.zones
        ) {

            if (
                zone.parentOBId === parentOBId &&
                (
                    zone.status === "active" ||
                    zone.status === "touched"
                )
            ) {

                zone.status =
                    "invalidated";


                console.log(
                    `\n⚫ [5m] Zone ${zone.low} - ${zone.high} retired — ` +
                    `parent 15m OB #${parentOBId} was invalidated.`
                );
            }
        }
    }


    // =========================================================================
    // PROCESS ONE LIVE 5M CANDLE
    // =========================================================================

    onCandle(candle) {

        this.recentCandles.push(
            candle
        );


        if (
            this.recentCandles.length > 3
        ) {

            this.recentCandles.shift();
        }


        const alerts = [];


        for (
            const zone of this.zones
        ) {

            if (
                zone.status === "invalidated" ||
                zone.status === "signal"
            ) {

                continue;
            }


            // =========================================================================
            // ONE TRADE PER 15M SETUP
            //
            // If another 5m child zone belonging to this same 15m parent
            // already generated a signal, this zone cannot generate another.
            // =========================================================================

            if (
                this.signalledParents.has(
                    zone.parentOBId
                )
            ) {

                continue;
            }


            // =====================================================================
            // BULLISH 5M OB
            // =====================================================================

            if (
                zone.obType === "bullish"
            ) {

                // -----------------------------------------------------------------
                // INVALIDATION
                // -----------------------------------------------------------------

                if (
                    candle.close < zone.low
                ) {

                    zone.status =
                        "invalidated";

                    alerts.push({

                        zone,

                        type:
                            "invalidated",

                        note:
                            "Closed below 5m bullish OB."
                    });

                    continue;
                }


                // -----------------------------------------------------------------
                // TOUCH
                // -----------------------------------------------------------------

                if (
                    zone.status === "active" &&
                    candle.low <= zone.high
                ) {

                    zone.status =
                        "touched";

                    zone.touchedAt =
                        candle.time;

                    alerts.push({

                        zone,

                        type:
                            "touched",

                        note:
                            "Price touched 5m bullish OB."
                    });
                }


                // -----------------------------------------------------------------
                // BULLISH ENTRY PATTERN
                // -----------------------------------------------------------------

                if (
                    zone.status === "touched"
                ) {

                    const pattern =
                        this._detectBullishPattern();


                    if (
                        pattern
                    ) {

                        // =========================================================
                        // LOCK THE ENTIRE 15M SETUP
                        // =========================================================

                        this.signalledParents.add(
                            zone.parentOBId
                        );


                        zone.status =
                            "signal";

                        zone.signalAt =
                            candle.time;

                        zone.pattern =
                            pattern;

                        alerts.push({

                            zone,

                            type:
                                "BUY_SIGNAL",

                            note:
                                `${pattern} confirmed on 5m OB ` +
                                `(parent: 15m ${zone.parentLabel} #${zone.parentOBId}).`
                        });
                    }
                }
            }


            // =====================================================================
            // BEARISH 5M OB
            // =====================================================================

            else {

                // -----------------------------------------------------------------
                // INVALIDATION
                // -----------------------------------------------------------------

                if (
                    candle.close > zone.high
                ) {

                    zone.status =
                        "invalidated";

                    alerts.push({

                        zone,

                        type:
                            "invalidated",

                        note:
                            "Closed above 5m bearish OB."
                    });

                    continue;
                }


                // -----------------------------------------------------------------
                // TOUCH
                // -----------------------------------------------------------------

                if (
                    zone.status === "active" &&
                    candle.high >= zone.low
                ) {

                    zone.status =
                        "touched";

                    zone.touchedAt =
                        candle.time;

                    alerts.push({

                        zone,

                        type:
                            "touched",

                        note:
                            "Price touched 5m bearish OB."
                    });
                }


                // -----------------------------------------------------------------
                // BEARISH ENTRY PATTERN
                // -----------------------------------------------------------------

                if (
                    zone.status === "touched"
                ) {

                    const pattern =
                        this._detectBearishPattern();


                    if (
                        pattern
                    ) {

                        // =========================================================
                        // LOCK THE ENTIRE 15M SETUP
                        // =========================================================

                        this.signalledParents.add(
                            zone.parentOBId
                        );


                        zone.status =
                            "signal";

                        zone.signalAt =
                            candle.time;

                        zone.pattern =
                            pattern;

                        alerts.push({

                            zone,

                            type:
                                "SELL_SIGNAL",

                            note:
                                `${pattern} confirmed on 5m OB ` +
                                `(parent: 15m ${zone.parentLabel} #${zone.parentOBId}).`
                        });
                    }
                }
            }
        }


        return alerts;
    }


    // =========================================================================
    // PATTERN DETECTION
    // =========================================================================

    _detectBullishPattern() {

        const n =
            this.recentCandles.length;


        if (
            n >= 2
        ) {

            const [
                prev,
                curr
            ] =
                this.recentCandles.slice(-2);


            if (
                isBullishEngulfing(
                    prev,
                    curr
                )
            ) {

                return "Bullish Engulfing";
            }
        }


        if (
            n >= 3
        ) {

            const [
                c1,
                c2,
                c3
            ] =
                this.recentCandles.slice(-3);


            if (
                isMorningStar(
                    c1,
                    c2,
                    c3
                )
            ) {

                return "Morning Star";
            }
        }


        return null;
    }


    _detectBearishPattern() {

        const n =
            this.recentCandles.length;


        if (
            n >= 2
        ) {

            const [
                prev,
                curr
            ] =
                this.recentCandles.slice(-2);


            if (
                isBearishEngulfing(
                    prev,
                    curr
                )
            ) {

                return "Bearish Engulfing";
            }
        }


        if (
            n >= 3
        ) {

            const [
                c1,
                c2,
                c3
            ] =
                this.recentCandles.slice(-3);


            if (
                isEveningStar(
                    c1,
                    c2,
                    c3
                )
            ) {

                return "Evening Star";
            }
        }


        return null;
    }
}




// =============================================================================
// 6) MARKET STRUCTURE ENGINE (15M)
// =============================================================================

class MarketStructureEngine {

    constructor({
        zigzagLength = 9
    } = {}) {

        this.zigzag =
            new ZigZagDetector(
                zigzagLength
            );


        this.structure =
            new StructureDetector();


        this.fvg =
            new FVGTracker();


        this.obManager =
            new OrderBlockManager();


        this.index =
            -1;
    }


    onCandle(
        candle
    ) {

        this.index += 1;


        const index =
            this.index;


        const normalizedCandle = {

            ...candle,

            index
        };


        // =========================================================================
        // 1. STRUCTURE EVENTS
        // =========================================================================

        const structureEvents =
            this.structure.onCandle(
                normalizedCandle,
                index
            );


        const structureEvent =
            structureEvents.length > 0
                ? structureEvents[0]
                : null;


        // =========================================================================
        // 2. FVG (15m internal pool, used to build swing-based OB candidates)
        // =========================================================================

        const newFVGs =
            this.fvg.onCandle(
                normalizedCandle,
                index
            );


        // =========================================================================
        // 3. HANDLE STRUCTURE EVENT (marker only, does not close swing)
        // =========================================================================

        if (
            structureEvent
        ) {

            this.obManager.onStructureEvent(
                structureEvent
            );
        }


        // =========================================================================
        // 4. ZIGZAG
        // =========================================================================

        const swing =
            this.zigzag.onCandle(
                normalizedCandle,
                index
            );


        let swingClassification =
            null;


        if (
            swing
        ) {
            swingClassification =
                this.structure.addSwing(
                    swing
                );
        }


        // =========================================================================
        // 5. SWING LIFECYCLE
        // =========================================================================

        if (
            swing &&
            swingClassification
        ) {

            const classification =
                swingClassification.classification;


            if (
                classification ===
                "LL"
            ) {

                if (
                    this.obManager.activeSwing &&
                    this.obManager.activeSwing.direction ===
                        "bearish"
                ) {

                    this.obManager.closeBearishSwing(
                        swing,
                        this.fvg
                    );
                }


                this.obManager.startBullishSwing(
                    swing,
                    this.fvg
                );
            }


            if (
                classification ===
                "HH"
            ) {

                if (
                    this.obManager.activeSwing &&
                    this.obManager.activeSwing.direction ===
                        "bullish"
                ) {

                    this.obManager.closeBullishSwing(
                        swing,
                        this.fvg
                    );
                }
            }


            if (
                classification ===
                "LH"
            ) {

                this.obManager.startBearishSwing(
                    swing,
                    this.fvg
                );
            }
        }


        // =========================================================================
        // 6. PROCESS NEW FVGs AS OB CANDIDATES
        // =========================================================================

        if (
            newFVGs &&
            newFVGs.length > 0
        ) {

            for (
                const fvg of newFVGs
            ) {

                this.obManager.addConfirmedFVG(
                    fvg,
                    index,
                    "LIVE"
                );
            }


            this.obManager.refreshActiveStatuses();
        }


        // =========================================================================
        // 7. OB LIFECYCLE (invalidation only)
        // =========================================================================

        const obAlerts =
            this.obManager.onCandle(
                normalizedCandle
            );


        return {

            index,

            candle:
                normalizedCandle,

            swing,

            swingClassification,

            structureEvent,

            newOB:
                newFVGs,

            obAlerts
        };
    }
}



// =============================================================================
// 7) MERGED CHRONOLOGICAL REPLAY
// =============================================================================
//
// 15m candles and 5m candles are merged into ONE timeline, ordered by CLOSE
// time (open time + timeframe length). At equal close time, the 5m candle
// is processed first, since a 15m bar's close coincides with its 3rd 5m
// sub-candle's close — the 5m information "exists" at that instant too.
//
// This guarantees:
//
//     - a 5m zone is only ever tested against 5m candles that come AFTER
//       its own confirmation time (no lookahead)
//     - a 15m OB's overlapping 5m zones are registered with the watcher
//       at the exact moment the 15m OB becomes ACTIVE, using only 5m FVGs
//       confirmed by that point in simulated time
//     - new 5m FVGs that form WHILE a 15m OB is still active are picked up
//       and registered too, as they are confirmed
// =============================================================================

async function main() {

    const engine =
        new MarketStructureEngine({

            zigzagLength: 5
        });


    const fvg5m =
        new FVGTracker();


    const watcher =
        new FiveMinuteEntryWatcher();


    // =========================================================================
    // FETCH BOTH TIMEFRAMES
    // =========================================================================

    const candles15mRaw =
        await getHistoricalCandles("15m");


    const candles5mRaw =
        await getHistoricalCandles("5m");


    if (
        !candles15mRaw ||
        candles15mRaw.length === 0 ||
        !candles5mRaw ||
        candles5mRaw.length === 0
    ) {

        console.log(
            "No candles received."
        );

        return;
    }


    candles15mRaw.sort(
        (a, b) =>
            new Date(a.time) -
            new Date(b.time)
    );


    candles5mRaw.sort(
        (a, b) =>
            new Date(a.time) -
            new Date(b.time)
    );


    // =========================================================================
    // BUILD UNIFIED TIMELINE BY CLOSE TIME
    //
    // START POINT:
    // The simulation begins at the close of the FIRST available 5m candle.
    //
    // Any 15m candle that closed BEFORE that point is ignored.
    // This prevents old 15m candles from appearing before the 5m simulation
    // has actually started.
    // =========================================================================

    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    const FIVE_MIN_MS = 5 * 60 * 1000;

    const timeline = [];


    // ========================================================================
    // FIRST 5M CLOSE = SIMULATION START
    // ========================================================================

    const first5mCandle =
        candles5mRaw[0];

    const simulationStartTime =
        new Date(first5mCandle.time).getTime() +
        FIVE_MIN_MS;


    // ========================================================================
    // ADD 15M CANDLES
    //
    // Ignore any 15m candle whose CLOSE happened before the first 5m close.
    // ========================================================================

    candles15mRaw.forEach(
        candle => {

            const closeTime =
                new Date(candle.time).getTime() +
                FIFTEEN_MIN_MS;

            if (
                closeTime < simulationStartTime
            ) {

                return;
            }

            timeline.push({

                kind:
                    "15m",

                candle,

                closeTime
            });
        }
    );


    // ========================================================================
    // ADD 5M CANDLES
    //
    // Ignore 5m candles before the simulation start as well.
    // Normally this only matters if the data contains anything unexpected.
    // ========================================================================

    candles5mRaw.forEach(
        candle => {

            const closeTime =
                new Date(candle.time).getTime() +
                FIVE_MIN_MS;

            if (
                closeTime < simulationStartTime
            ) {

                return;
            }

            timeline.push({

                kind:
                    "5m",

                candle,

                closeTime
            });
        }
    );


    // ========================================================================
    // SORT CHRONOLOGICALLY
    // ========================================================================

    timeline.sort(
        (a, b) => {

            if (
                a.closeTime !==
                b.closeTime
            ) {

                return a.closeTime -
                    b.closeTime;
            }


            // Same close time:
            // 5m candle resolves first.

            if (
                a.kind === b.kind
            ) {

                return 0;
            }


            return a.kind === "5m"
                ? -1
                : 1;
        }
    );

    console.log(
        `\n📊 Merged timeline: ${candles15mRaw.length} × 15m + ` +
        `${candles5mRaw.length} × 5m = ${timeline.length} events, ` +
        `processed chronologically...\n`
    );
    console.log(timeline)


    // =========================================================================
    // REPLAY
    // =========================================================================

    const swings = [];

    const structureEvents = [];

    const entrySignals = [];

    let fvg5mIndex = -1;


    for (
        const event of timeline
    ) {

        // =====================================================================
        // 15M EVENT
        // =====================================================================

        if (
            event.kind === "15m"
        ) {

            const result =
                engine.onCandle(
                    event.candle
                );


            const {
                swing,
                structureEvent,
                obAlerts
            } =
                result;


            if (
                swing
            ) {

                swings.push(
                    swing
                );


                console.log(

                    `🔹 ${swing.type} ` +

                    `${swing.classification ?? ""} ` +

                    `${swing.price} ` +

                    `@ ${toIST(
                        swing.swingTime
                    )} ` +

                    `(confirmed ${toIST(
                        swing.detectedAt
                    )})`
                );
            }


            if (
                structureEvent
            ) {

                structureEvents.push({

                    ...structureEvent,

                    label:
                        `${structureEvent.kind}-` +
                        `${structureEvent.direction}`,

                    time:
                        toIST(
                            structureEvent.time
                        )
                });


                console.log(

                    `⚡ ${structureEvent.kind} ` +

                    `${structureEvent.direction} ` +

                    `@ ${toIST(
                        structureEvent.time
                    )}`
                );
            }


            // =====================================================================
            // 15M INVALIDATION -> RETIRE MATCHING 5M ZONES
            // =====================================================================

            for (
                const alert of obAlerts
            ) {

                console.log(

                    `\n⚫ [15m] ${alert.ob.label} #${alert.ob.id} ` +
                    `${alert.note} — ${toIST(event.candle.time)}`
                );


                watcher.invalidateZonesForParent(
                    alert.ob.id
                );
            }


            // =====================================================================
            // REGISTER OVERLAPPING 5M ZONES FOR THE CURRENTLY ACTIVE 15M OB
            //
            // Uses ONLY 5m FVGs confirmed up to THIS point in simulated time.
            // =====================================================================

            const activeOB15m =
                engine.obManager.orderBlocks.find(
                    ob =>
                        ob.status === "active"
                );


            if (
                activeOB15m
            ) {

                const overlaps =
                    fvg5m.confirmed.filter(
                        fvg =>
                            fvg.obType ===
                            activeOB15m.obType &&

                            zonesOverlap(
                                activeOB15m.low,
                                activeOB15m.high,
                                fvg.low,
                                fvg.high
                            )
                    );


                activeOB15m.overlapping5mOBs =
                    overlaps;


                watcher.registerFromParent(
                    activeOB15m
                );
            }
        }


        // =====================================================================
        // 5M EVENT
        // =====================================================================

        else {

            fvg5mIndex += 1;


            const normalized5m = {

                ...event.candle,

                index:
                    fvg5mIndex
            };


            const newFVGs5m =
                fvg5m.onCandle(
                    normalized5m,
                    fvg5mIndex
                );


            // =====================================================================
            // A NEW 5M FVG JUST CONFIRMED -> CHECK AGAINST THE CURRENTLY ACTIVE
            // 15M OB AND REGISTER IT IF IT OVERLAPS.
            // =====================================================================

            if (
                newFVGs5m &&
                newFVGs5m.length > 0
            ) {

                const activeOB15m =
                    engine.obManager.orderBlocks.find(
                        ob =>
                            ob.status === "active"
                    );


                if (
                    activeOB15m
                ) {

                    const overlapping =
                        newFVGs5m.filter(
                            fvg =>
                                fvg.obType ===
                                activeOB15m.obType &&

                                zonesOverlap(
                                    activeOB15m.low,
                                    activeOB15m.high,
                                    fvg.low,
                                    fvg.high
                                )
                        );


                    if (
                        overlapping.length > 0
                    ) {

                        activeOB15m.overlapping5mOBs =
                            [
                                ...(activeOB15m.overlapping5mOBs || []),
                                ...overlapping
                            ];


                        watcher.registerFromParent(
                            activeOB15m
                        );
                    }
                }
            }


            // =====================================================================
            // FEED THE 5M CANDLE TO THE WATCHER — THIS IS THE ONLY PLACE
            // ENTRY SIGNALS ARE PRODUCED.
            // =====================================================================

            const alerts =
                watcher.onCandle(
                    event.candle
                );


            for (
                const alert of alerts
            ) {

                const marker =

                    alert.type === "BUY_SIGNAL"
                        ? "🟢"

                        : alert.type === "SELL_SIGNAL"
                            ? "🔴"

                            : alert.type === "invalidated"
                                ? "⚫"

                                : "🔔";


                console.log(

                    `   ${marker} [5m] ` +
                    `${alert.note} ` +
                    `— ${toIST(event.candle.time)}`
                );


                if (
                    alert.type === "BUY_SIGNAL" ||
                    alert.type === "SELL_SIGNAL"
                ) {

                    entrySignals.push({

                        ...alert.zone,

                        alertType:
                            alert.type,

                        entryTime:
                            toIST(event.candle.time)
                    });
                }
            }
        }
    }


    // =========================================================================
    // FINAL SWINGS
    // =========================================================================

    console.log(
        "\n\n=================================================="
    );

    console.log(
        "FINAL SWINGS (15M)"
    );

    console.log(
        "=================================================="
    );


    console.table(

        swings.map(
            s => ({

                type:
                    s.type,

                classification:
                    s.classification,

                price:
                    s.price,

                swingTime:
                    toIST(
                        s.swingTime
                    ),

                detectedAt:
                    toIST(
                        s.detectedAt
                    )
            })
        )
    );


    // =========================================================================
    // FINAL STRUCTURE EVENTS
    // =========================================================================

    console.log(
        "\n=================================================="
    );

    console.log(
        "FINAL BOS / CHOCH (15M)"
    );

    console.log(
        "=================================================="
    );


    console.table(
        structureEvents
    );


    // =========================================================================
    // ALL 15M ORDER BLOCKS (ZONE OF INTEREST — NO SIGNALS HERE)
    // =========================================================================

    console.log(
        "\n=================================================="
    );

    console.log(
        "ALL 15M ORDER BLOCKS (ZONE OF INTEREST ONLY)"
    );

    console.log(
        "=================================================="
    );


    console.table(

        engine.obManager.orderBlocks
            .slice()
            .sort(
                (a, b) =>
                    a.index -
                    b.index
            )
            .map(
                ob => ({

                    ID:
                        ob.id,

                    OB_CANDLE:
                        toIST(
                            ob.time
                        ),

                    TYPE:
                        ob.obType,

                    ZONE:
                        `${ob.low} - ${ob.high}`,

                    SWING:
                        `${ob.swingStartType} → ` +
                        `${ob.swingEndType}`,

                    STATUS:
                        ob.status,

                    DISCOVERY:
                        ob.discoverySource ===
                            "PREVIOUS_SWING_CARRYOVER"
                            ? "CARRYOVER"
                            : ob.discoverySource,

                    "5M_ZONES_FOUND":
                        ob.overlapping5mOBs
                            ? ob.overlapping5mOBs.length
                            : 0
                })
            )
    );


    // =========================================================================
    // FINAL 5M ENTRY SIGNALS — THE ONLY REAL TRADE SIGNALS
    // =========================================================================

    console.log(
        "\n=================================================="
    );

    console.log(
        "FINAL 5M ENTRY SIGNALS (ONLY SOURCE OF TRADES)"
    );

    console.log(
        "=================================================="
    );


    console.table(

        entrySignals.map(
            s => ({

                alertType:
                    s.alertType,

                zone:
                    `${s.low} - ${s.high}`,

                obType:
                    s.obType,

                parentOB:
                    `15m ${s.parentLabel} #${s.parentOBId}`,

                pattern:
                    s.pattern,

                entryTime:
                    s.entryTime
            })
        )
    );


    // =========================================================================
    // SPECIFIC 14 AUG 05:30 DEBUG
    // =========================================================================

    console.log(
        "\n=================================================="
    );

    console.log(
        "14 AUG 05:30 TARGET OB CHECK"
    );

    console.log(
        "=================================================="
    );


    const targetOBs =
        engine.obManager.orderBlocks.filter(
            ob => {

                const p =
                    istParts(
                        ob.time
                    );

                return (
                    p.date ===
                    "14/08/2026" &&

                    p.time ===
                    "05:30"
                );
            }
        );


    if (
        targetOBs.length === 0
    ) {

        console.log(
            "❌ 05:30 OB NOT FOUND"
        );

    } else {

        console.log(
            "✅ 05:30 OB FOUND"
        );


        console.table(

            targetOBs.map(
                ob => ({

                    id:
                        ob.id,

                    time:
                        toIST(
                            ob.time
                        ),

                    type:
                        ob.obType,

                    low:
                        ob.low,

                    high:
                        ob.high,

                    swing:
                        `${ob.swingStartType} → ` +
                        `${ob.swingEndType}`,

                    status:
                        ob.status
                })
            )
        );
    }
}


// =============================================================================
// START
// =============================================================================

main();