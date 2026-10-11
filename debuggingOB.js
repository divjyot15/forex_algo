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

const getHistoricalCandles = async () => {

    try {

        console.log("⏳ Connecting to MT5 via MetaApi...");

        const account = getAccount();

        console.log("Connected");

        const from = new Date(
            Date.now() - 2 * 24 * 60 * 60 * 1000
        );

        const candles =
            await account.getHistoricalCandles(
                "XAUUSD",
                "15m",
                from
            );

        console.log(
            `Received ${candles?.length ?? 0} candles`
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
//
// TARGET:
//
// 14/08/2026 05:30 IST
//
// SUSPECTED BOS:
//
// 14/08/2026 05:45 IST
//
// These functions ONLY print information.
// They do NOT modify the strategy.
// =============================================================================

const DEBUG_TARGET_DATE = "14/08/2026";
const DEBUG_TARGET_TIME = "05:30";

const DEBUG_BOS_DATE = "14/08/2026";
const DEBUG_BOS_TIME = "05:45";


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


function isDebugBOSCandle(candle) {

    if (!candle || !candle.time) {
        return false;
    }

    const p = istParts(candle.time);

    return (
        p.date === DEBUG_BOS_DATE &&
        p.time === DEBUG_BOS_TIME
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
// 1) ZIGZAG SWING DETECTOR
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
// 2) STRUCTURE DETECTOR
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


    getRecentLegs() {

        const n =
            this.swings.length;


        if (n < 2) {

            return {

                latestLeg: null,

                previousLeg: null
            };
        }


        const latestLeg = {

            from:
                this.swings[n - 2].index,

            to:
                this.swings[n - 1].index
        };


        const previousLeg =
            n >= 3
                ? {

                    from:
                        this.swings[n - 3].index,

                    to:
                        this.swings[n - 2].index
                }
                : null;


        return {

            latestLeg,

            previousLeg
        };
    }
}


// =============================================================================
// 3) FVG TRACKER
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


        // =====================================================================
        // IMPORTANT:
        //
        // c0 = first candle
        // c1 = second candle
        // c2 = third candle
        //
        // If 05:30 is c0:
        //
        // 05:30 -> first
        // 05:45 -> second
        // 06:00 -> third
        //
        // Therefore the FVG is confirmed when 06:00 is processed.
        // =====================================================================

        const [
            c0,
            c1,
            c2
        ] =
            this.window;


        // =========================================================================
        // DEBUG
        //
        // Check the exact 05:30 candle as the FIRST candle.
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
                "\n\n=================================================="
            );

            console.log(
                "🧪 TARGET 05:30 FVG DEBUG"
            );

            console.log(
                "=================================================="
            );


            console.log(
                "\nThree-candle FVG window:"
            );


            console.table([

                debugCandle(
                    c0.candle,
                    "1st / POTENTIAL OB"
                ),

                debugCandle(
                    c1.candle,
                    "2nd candle"
                ),

                debugCandle(
                    c2.candle,
                    "3rd / FVG CONFIRMATION"
                )

            ]);


            console.log(
                "\nBullish FVG condition:"
            );

            console.log(
                `3rd LOW (${c2.candle.low}) > ` +
                `1st HIGH (${c0.candle.high})`
            );

            console.log(
                "RESULT:",
                bullishGap
                    ? "✅ TRUE"
                    : "❌ FALSE"
            );


            console.log(
                "\nBearish FVG condition:"
            );

            console.log(
                `3rd HIGH (${c2.candle.high}) < ` +
                `1st LOW (${c0.candle.low})`
            );

            console.log(
                "RESULT:",
                bearishGap
                    ? "✅ TRUE"
                    : "❌ FALSE"
            );


            console.log(
                "\nExpected bearish OB test:"
            );


            if (
                bearishGap
            ) {

                console.log(
                    "✅ 05:30 qualifies as a BEARISH FVG."
                );

            } else {

                console.log(
                    "❌ 05:30 does NOT qualify as a BEARISH FVG."
                );
            }


            console.log(
                "\nFVG confirmation candle:",
                toIST(
                    c2.candle.time
                )
            );


            console.log(
                "==================================================\n"
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
                    "bullish"
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
                    "bearish"
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
        obType
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
                        : "doji"
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
// 4) CANDLESTICK PATTERNS
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
// 5) ORDER BLOCK MANAGER - NEW SWING-BASED DEBUG VERSION
// =============================================================================
//
// NEW RULE:
//
// DOWN TREND:
//     LH ----------------------------> LL
//          ALL bearish OBs
//          are recorded here
//
// UP TREND:
//     LL ----------------------------> HH
//          ALL bullish OBs
//          are recorded here
//
// IMPORTANT:
//
// BOS / CHOCH DOES NOT END THE OB COLLECTION.
//
// OB collection continues after BOS/CHOCH until the relevant swing endpoint
// is confirmed.
//
// DOWN:
//     LH -> LL
//
// UP:
//     LL -> HH
//
// FVG can be confirmed AFTER BOS.
// When that happens, the FVG is still added to the active swing.
//
// =============================================================================


class OrderBlockManager {

    constructor() {

        // All OBs ever discovered.
        this.orderBlocks = [];

        // Currently active swing OB collection.
        this.activeSwing = null;

        // BOS / CHOCH events associated with the current swing.
        this.currentStructureEvents = [];

        // Candle history for entry patterns.
        this.recentCandles = [];

        // Prevent the BOS/CHOCH candle itself from touching an OB that
        // existed before that event.
        this.skipCandleIndex = null;

        // Used for unique OB ids.
        this.nextObId = 1;
    }


    // =========================================================================
    // START A NEW SWING
    // =========================================================================

    startSwing(
        swing,
        trend
    ) {

        if (!swing) {
            return;
        }


        // ---------------------------------------------------------------------
        // trend = bearish
        //
        // Swing starts at LH and finishes at LL.
        // ---------------------------------------------------------------------

        if (
            trend === "bearish" &&
            swing.type === "HIGH"
        ) {

            this.activeSwing = {

                direction: "bearish",

                startType: "LH",

                startIndex:
                    swing.index,

                startPrice:
                    swing.price,

                startTime:
                    swing.swingTime,

                endType: "LL",

                endIndex: null,

                endPrice: null,

                endTime: null,

                closed: false,

                bosOccurred: false,

                chochOccurred: false,

                obIds: []
            };


            console.log(
                "\n🟠 ===== NEW BEARISH OB SWING ====="
            );


            console.log(
                `LH @ ${toIST(
                    swing.swingTime
                )} | ` +
                `index=${swing.index} | ` +
                `price=${swing.price}`
            );


            console.log(
                "OB collection is now OPEN:"
            );


            console.log(
                "LH → LL"
            );


            console.log(
                "BOS/CHOCH will NOT stop collection."
            );


            console.log(
                "====================================\n"
            );


            return;
        }


        // ---------------------------------------------------------------------
        // trend = bullish
        //
        // Swing starts at LL and finishes at HH.
        // ---------------------------------------------------------------------

        if (
            trend === "bullish" &&
            swing.type === "LOW"
        ) {

            this.activeSwing = {

                direction: "bullish",

                startType: "LL",

                startIndex:
                    swing.index,

                startPrice:
                    swing.price,

                startTime:
                    swing.swingTime,

                endType: "HH",

                endIndex: null,

                endPrice: null,

                endTime: null,

                closed: false,

                bosOccurred: false,

                chochOccurred: false,

                obIds: []
            };


            console.log(
                "\n🟢 ===== NEW BULLISH OB SWING ====="
            );


            console.log(
                `LL @ ${toIST(
                    swing.swingTime
                )} | ` +
                `index=${swing.index} | ` +
                `price=${swing.price}`
            );


            console.log(
                "OB collection is now OPEN:"
            );


            console.log(
                "LL → HH"
            );


            console.log(
                "BOS/CHOCH will NOT stop collection."
            );


            console.log(
                "===================================\n"
            );


            return;
        }
    }


    // =========================================================================
    // CLOSE CURRENT SWING
    // =========================================================================

    closeSwing(
        swing
    ) {

        if (
            !this.activeSwing ||
            this.activeSwing.closed
        ) {

            return;
        }


        this.activeSwing.endIndex =
            swing.index;


        this.activeSwing.endPrice =
            swing.price;


        this.activeSwing.endTime =
            swing.swingTime;


        this.activeSwing.closed =
            true;


        console.log(
            "\n🔵 ===== OB SWING CLOSED ====="
        );


        console.log(
            `${this.activeSwing.startType} ` +
            `${toIST(
                this.activeSwing.startTime
            )}` +

            ` → ` +

            `${this.activeSwing.endType} ` +
            `${toIST(
                this.activeSwing.endTime
            )}`
        );


        console.log(
            `Total OBs collected: ` +
            `${this.activeSwing.obIds.length}`
        );


        console.log(
            "==============================\n"
        );
    }


    // =========================================================================
    // STRUCTURE EVENT
    // =========================================================================

    onStructureEvent(
        structureEvent
    ) {

        if (
            !this.activeSwing ||
            !structureEvent
        ) {

            return;
        }


        this.currentStructureEvents.push(
            structureEvent
        );


        if (
            structureEvent.kind ===
            "BOS"
        ) {

            this.activeSwing.bosOccurred =
                true;
        }


        if (
            structureEvent.kind ===
            "CHOCH"
        ) {

            this.activeSwing.chochOccurred =
                true;
        }


        // ---------------------------------------------------------------------
        // DEBUG
        // ---------------------------------------------------------------------

        console.log(
            "\n📌 ===== STRUCTURE EVENT INSIDE OB SWING ====="
        );


        console.log(
            `${structureEvent.kind} ` +
            `${structureEvent.direction} ` +
            `@ ${toIST(
                structureEvent.time
            )}`
        );


        console.log(
            `OB swing remains OPEN: ` +

            `${this.activeSwing.startType}` +

            ` → ` +

            `${this.activeSwing.endType}`
        );


        console.log(
            `Existing OB count: ` +
            `${this.activeSwing.obIds.length}`
        );


        console.log(
            "New FVGs will CONTINUE to be recorded after this event."
        );


        console.log(
            "===============================================\n"
        );
    }


    // =========================================================================
    // ADD NEWLY CONFIRMED FVG
    // =========================================================================
    //
    // This is the critical part.
    //
    // We DO NOT ask:
    //
    //     "Did this FVG exist when BOS happened?"
    //
    // Instead:
    //
    //     "Does this FVG candle belong to the currently open swing?"
    //
    // If YES -> record it.
    //
    // =========================================================================

    addConfirmedFVG(
        fvg,
        currentIndex
    ) {

        if (
            !fvg ||
            !this.activeSwing
        ) {

            return null;
        }


        const swing =
            this.activeSwing;


        // ---------------------------------------------------------------------
        // Only matching direction.
        // ---------------------------------------------------------------------

        if (
            fvg.obType !==
            swing.direction
        ) {

            return null;
        }


        // ---------------------------------------------------------------------
        // FVG first candle must be inside the swing.
        //
        // Start boundary:
        //     LH for bearish
        //     LL for bullish
        //
        // End boundary:
        //     if swing is already closed -> actual endpoint
        //     otherwise -> current candle
        //
        // This allows OBs confirmed AFTER BOS.
        // ---------------------------------------------------------------------

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


        // ---------------------------------------------------------------------
        // Don't add same FVG twice.
        // ---------------------------------------------------------------------

        const alreadyAdded =
            this.orderBlocks.some(
                ob =>
                    ob.index === fvg.index &&
                    ob.obType === fvg.obType &&
                    ob.swingStartIndex ===
                        swing.startIndex
            );


        if (
            alreadyAdded
        ) {

            return null;
        }


        // ---------------------------------------------------------------------
        // Was BOS already present when this OB became known?
        // ---------------------------------------------------------------------

        const discoveredAfterBOS =
            swing.bosOccurred;


        const discoveredAfterCHOCH =
            swing.chochOccurred;


        const ob = {

            id:
                this.nextObId++,

            ...fvg,

            label:
                swing.direction === "bullish"
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

            discoveredAtTime:
                new Date(),

            discoveredAfterBOS,

            discoveredAfterCHOCH,

            status:
                "waiting",

            touchedAt:
                null,

            signalAt:
                null,

            pattern:
                null
        };


        this.orderBlocks.push(
            ob
        );


        swing.obIds.push(
            ob.id
        );


        // ---------------------------------------------------------------------
        // DEBUG
        // ---------------------------------------------------------------------

        console.log(
            "\n📦 ===== NEW SWING OB ====="
        );


        console.log(
            `OB #${ob.id}`
        );


        console.log(
            `OB candle: ${toIST(
                ob.time
            )}`
        );


        console.log(
            `OB type: ${ob.obType}`
        );


        console.log(
            `Zone: ${ob.low} - ${ob.high}`
        );


        console.log(
            `Swing: ${ob.swingStartType} ` +
            `${toIST(
                ob.swingStartTime
            )} → ` +
            `${ob.swingEndType}`
        );


        console.log(
            `FVG confirmed at: ${toIST(
                fvg.confirmedAt ??
                fvg.time
            )}`
        );


        console.log(
            discoveredAfterBOS
                ? "🟣 This OB was confirmed AFTER BOS."
                : "🔵 This OB was confirmed BEFORE BOS."
        );


        console.log(
            "OB collection remains OPEN."
        );


        console.log(
            "========================\n"
        );


        return ob;
    }


    // =========================================================================
    // SET ACTIVE OB
    // =========================================================================

    refreshActiveStatuses() {

        const openOBs =
            this.orderBlocks.filter(
                ob =>
                    ob.status !==
                        "invalidated" &&
                    ob.status !==
                        "signal"
            );


        if (
            openOBs.length === 0
        ) {

            return;
        }


        // Newest valid OB is active.
        // Older ones remain waiting.

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
    // PROCESS CANDLE
    // =========================================================================

    onCandle(
        candle
    ) {

        this.recentCandles.push(
            candle
        );


        if (
            this.recentCandles.length >
            3
        ) {

            this.recentCandles.shift();
        }


        const alerts = [];


        // ---------------------------------------------------------------------
        // Find current active/touched OB.
        // ---------------------------------------------------------------------

        const activeOB =
            this.orderBlocks
                .filter(
                    ob =>
                        ob.status ===
                            "active" ||
                        ob.status ===
                            "touched"
                )
                .sort(
                    (a, b) =>
                        b.index -
                        a.index
                )[0];


        if (
            !activeOB
        ) {

            return alerts;
        }


        // ---------------------------------------------------------------------
        // Don't process the BOS/CHOCH candle itself.
        // ---------------------------------------------------------------------

        if (
            this.skipCandleIndex !== null &&
            candle.index ===
                this.skipCandleIndex
        ) {

            return alerts;
        }


        if (
            this.skipCandleIndex !== null &&
            candle.index >
                this.skipCandleIndex
        ) {

            this.skipCandleIndex =
                null;
        }


        // =========================================================================
        // BULLISH OB
        // =========================================================================

        if (
            activeOB.obType ===
            "bullish"
        ) {

            // Invalidation

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


                return alerts;
            }


            // Touch

            if (
                activeOB.status ===
                    "active" &&

                candle.low <=
                    activeOB.high
            ) {

                activeOB.status =
                    "touched";


                activeOB.touchedAt =
                    candle.time;


                alerts.push({

                    ob:
                        activeOB,

                    type:
                        "touched",

                    note:
                        "Price touched bullish OB."
                });
            }


            // Entry pattern

            if (
                activeOB.status ===
                "touched"
            ) {

                const pattern =
                    this._detectBullishPattern();


                if (
                    pattern
                ) {

                    activeOB.status =
                        "signal";


                    activeOB.signalAt =
                        candle.time;


                    activeOB.pattern =
                        pattern;


                    alerts.push({

                        ob:
                            activeOB,

                        type:
                            "BUY_SIGNAL",

                        note:
                            `${pattern} confirmed.`
                    });
                }
            }
        }


        // =========================================================================
        // BEARISH OB
        // =========================================================================

        else {

            // Invalidation

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


                return alerts;
            }


            // Touch

            if (
                activeOB.status ===
                    "active" &&

                candle.high >=
                    activeOB.low
            ) {

                activeOB.status =
                    "touched";


                activeOB.touchedAt =
                    candle.time;


                alerts.push({

                    ob:
                        activeOB,

                    type:
                        "touched",

                    note:
                        "Price touched bearish OB."
                });
            }


            // Entry pattern

            if (
                activeOB.status ===
                "touched"
            ) {

                const pattern =
                    this._detectBearishPattern();


                if (
                    pattern
                ) {

                    activeOB.status =
                        "signal";


                    activeOB.signalAt =
                        candle.time;


                    activeOB.pattern =
                        pattern;


                    alerts.push({

                        ob:
                            activeOB,

                        type:
                            "SELL_SIGNAL",

                        note:
                            `${pattern} confirmed.`
                    });
                }
            }
        }


        return alerts;
    }


    // =========================================================================
    // BULLISH PATTERNS
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


    // =========================================================================
    // BEARISH PATTERNS
    // =========================================================================

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
// 6) MARKET STRUCTURE ENGINE - NEW SWING OB DEBUG VERSION
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


    // =========================================================================
    // ON CANDLE
    // =========================================================================

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
        // 1. STRUCTURE
        // =========================================================================

        const structureEvents =
            this.structure.onCandle(
                normalizedCandle,
                index
            );


        const structureEvent =
            structureEvents.length >
            0

                ? structureEvents[0]

                : null;


        // =========================================================================
        // 2. FVG
        //
        // IMPORTANT:
        //
        // FVG must be processed BEFORE adding newly-confirmed swing endpoints
        // to the OB swing logic.
        //
        // This lets us see exactly when a post-BOS FVG becomes available.
        // =========================================================================

        const newFVGs =
            this.fvg.onCandle(
                normalizedCandle,
                index
            );


        // =========================================================================
        // 3. HANDLE STRUCTURE EVENT
        // =========================================================================

        if (
            structureEvent
        ) {

            this.obManager.onStructureEvent(
                structureEvent
            );


            this.obManager.skipCandleIndex =
                structureEvent.breakCandleIndex;
        }


        // =========================================================================
        // 4. ADD NEWLY CONFIRMED FVGs
        //
        // THIS IS THE CRITICAL CHANGE.
        //
        // We do this on EVERY candle.
        //
        // Therefore an FVG confirmed after BOS can still become an OB.
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
                    index
                );
            }


            this.obManager.refreshActiveStatuses();
        }


        // =========================================================================
        // 5. ZIGZAG
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
        // 6. SWING MANAGEMENT
        // =========================================================================
        //
        // We use the newly confirmed swing to OPEN/CLOSE the OB collection.
        //
        // Bearish:
        //     LH -> LL
        //
        // Bullish:
        //     LL -> HH
        // =========================================================================

        if (
            swing &&
            swingClassification
        ) {

            const classification =
                swingClassification.classification;


            // ---------------------------------------------------------------------
            // BEARISH SWING
            //
            // LH starts bearish OB collection.
            // LL closes it.
            // ---------------------------------------------------------------------

            if (
                classification ===
                    "LH"
            ) {

                // If another swing was open, close it first.

                if (
                    this.obManager.activeSwing &&
                    !this.obManager.activeSwing.closed
                ) {

                    // Do NOT forcibly close it as a valid endpoint unless
                    // the direction requires it.
                    //
                    // For debugging, report it.

                    console.log(
                        "\n⚠️ Previous OB swing still open when new LH arrived."
                    );
                }


                this.obManager.startSwing(
                    swing,
                    "bearish"
                );
            }


            if (
                classification ===
                    "LL"
            ) {

                if (
                    this.obManager.activeSwing &&
                    this.obManager.activeSwing.direction ===
                        "bearish"
                ) {

                    this.obManager.closeSwing(
                        swing
                    );
                }


                // A new LL can also be the beginning of a bullish swing.

                this.obManager.startSwing(
                    swing,
                    "bullish"
                );
            }


            // ---------------------------------------------------------------------
            // BULLISH SWING
            //
            // LL starts bullish OB collection.
            // HH closes it.
            // ---------------------------------------------------------------------

            if (
                classification ===
                    "HH"
            ) {

                if (
                    this.obManager.activeSwing &&
                    this.obManager.activeSwing.direction ===
                        "bullish"
                ) {

                    this.obManager.closeSwing(
                        swing
                    );
                }


                // New HH can become start of bearish swing.

                this.obManager.startSwing(
                    swing,
                    "bearish"
                );
            }


            if (
                classification ===
                    "HL"
            ) {

                // HL is an internal bullish-structure pivot.
                //
                // It does not close LL -> HH OB collection.

            }
        }


        // =========================================================================
        // 7. OB LIFECYCLE
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
// 7) REPLAY / DEBUG MAIN
// =============================================================================

async function main() {

    const engine =
        new MarketStructureEngine({

            // KEEP YOUR EXISTING VALUE
            zigzagLength: 5
        });


    const candles =
        await getHistoricalCandles();


    if (
        !candles ||
        candles.length === 0
    ) {

        console.log(
            "No candles received."
        );

        return;
    }


    const swings = [];

    const structureEvents = [];

    const signals = [];


    // =========================================================================
    // CHRONOLOGICAL ORDER
    // =========================================================================

    candles.sort(
        (a, b) =>
            new Date(a.time) -
            new Date(b.time)
    );


    console.log(
        `\n📊 Processing ${candles.length} candles chronologically...`
    );


    // =========================================================================
    // PROCESS
    // =========================================================================

    for (
        const candle of candles
    ) {

        const result =
            engine.onCandle(
                candle
            );


        const {

            swing,

            swingClassification,

            structureEvent,

            obAlerts

        } =
            result;


        // =====================================================================
        // SWING
        // =====================================================================

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


        // =====================================================================
        // STRUCTURE
        // =====================================================================

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


            console.log(

                `   Broken swing: ` +

                `${structureEvent.brokenSwingType} ` +

                `#${structureEvent.brokenSwingIndex} ` +

                `@ ${structureEvent.brokenPrice}`
            );


            console.log(

                `   Break candle: ` +

                `#${structureEvent.breakCandleIndex} ` +

                `close=${structureEvent.breakClose}`
            );
        }


        // =====================================================================
        // ALERTS
        // =====================================================================

        for (
            const alert of obAlerts
        ) {

            const marker =

                alert.type ===
                    "BUY_SIGNAL"

                    ? "🟢"

                    : alert.type ===
                        "SELL_SIGNAL"

                        ? "🔴"

                        : alert.type ===
                            "invalidated"

                            ? "⚫"

                            : "🔔";


            console.log(

                `   ${marker} ` +

                `${alert.ob.label} ` +

                `[${alert.type}] ` +

                `${alert.note} ` +

                `— ${toIST(
                    candle.time
                )}`
            );


            if (
                alert.type ===
                    "BUY_SIGNAL" ||

                alert.type ===
                    "SELL_SIGNAL"
            ) {

                signals.push({

                    ...alert.ob,

                    alertType:
                        alert.type,

                    signalTime:
                        toIST(
                            candle.time
                        )
                });
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
        "FINAL SWINGS"
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
        "FINAL BOS / CHOCH"
    );

    console.log(
        "=================================================="
    );


    console.table(
        structureEvents
    );


    // =========================================================================
    // ALL ORDER BLOCKS
    // =========================================================================

    console.log(
        "\n=================================================="
    );

    console.log(
        "ALL SWING ORDER BLOCKS"
    );

    console.log(
        "=================================================="
    );


    const finalOBTable =

        engine.obManager.orderBlocks
            .slice()
            .sort(
                (a, b) =>
                    a.index -
                    b.index
            )
            .map(
                ob => ({

                    id:
                        ob.id,

                    OB_CANDLE:
                        toIST(
                            ob.time
                        ),

                    type:
                        ob.obType,

                    zone:
                        `${ob.low} - ${ob.high}`,

                    SWING:
                        `${ob.swingStartType} → ` +
                        `${ob.swingEndType}`,

                    swingStart:
                        toIST(
                            ob.swingStartTime
                        ),

                    swingEnd:
                        ob.swingEndTime
                            ? toIST(
                                ob.swingEndTime
                            )
                            : "OPEN",

                    discoveredAfterBOS:
                        ob.discoveredAfterBOS
                            ? "YES"
                            : "NO",

                    discoveredAfterCHOCH:
                        ob.discoveredAfterCHOCH
                            ? "YES"
                            : "NO",

                    status:
                        ob.status,

                    touchedAt:
                        ob.touchedAt
                            ? toIST(
                                ob.touchedAt
                            )
                            : "-",

                    pattern:
                        ob.pattern ??
                        "-",

                    signalAt:
                        ob.signalAt
                            ? toIST(
                                ob.signalAt
                            )
                            : "-"
                })
            );


    console.table(
        finalOBTable
    );


    // =========================================================================
    // SPECIFIC 14 AUG DEBUG
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

                    swingStart:
                        toIST(
                            ob.swingStartTime
                        ),

                    swingEnd:
                        ob.swingEndTime
                            ? toIST(
                                ob.swingEndTime
                            )
                            : "OPEN",

                    afterBOS:
                        ob.discoveredAfterBOS,

                    status:
                        ob.status
                })
            )
        );
    }


    // =========================================================================
    // TRADE SIGNALS
    // =========================================================================

    console.log(
        "\n=================================================="
    );

    console.log(
        "TRADE SIGNALS"
    );

    console.log(
        "=================================================="
    );


    console.table(
        signals.map(
            s => ({

                label:
                    s.label,

                alertType:
                    s.alertType,

                zone:
                    `${s.low} - ${s.high}`,

                pattern:
                    s.pattern,

                signalTime:
                    s.signalTime
            })
        )
    );
}


// =============================================================================
// START
// =============================================================================

main();