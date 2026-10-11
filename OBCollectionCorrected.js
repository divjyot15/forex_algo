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
// 5) ORDER BLOCK MANAGER
// =============================================================================
//
// IMPORTANT NEW LOGIC:
//
// Bearish swing:
//
//      LH ======================= LL
//          OB   BOS   OB   OB
//
// Bullish swing:
//
//      LL ======================= HH
//          OB   BOS   OB   OB
//
// BOS / CHOCH NEVER CLOSES THE SWING.
//
// The swing closes ONLY when:
//
//      bearish -> LL
//      bullish -> HH
//
// =============================================================================

class OrderBlockManager {

    constructor() {

        // =========================================================================
        // ALL OBs
        // =========================================================================

        this.orderBlocks = [];


        // =========================================================================
        // CURRENT OB SWING
        // =========================================================================

        this.activeSwing = null;


        // =========================================================================
        // STRUCTURE EVENTS
        // =========================================================================

        this.currentStructureEvents = [];


        // =========================================================================
        // CANDLE HISTORY
        // =========================================================================

        this.recentCandles = [];


        // =========================================================================
        // BOS / CHOCH CANDLE
        // =========================================================================

        this.skipCandleIndex = null;


        // =========================================================================
        // OB ID
        // =========================================================================

        this.nextObId = 1;
    }


    // =========================================================================
    // START NEW BEARISH SWING
    // =========================================================================

    startBearishSwing(
        swing
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
            "\n🟠 =================================================="
        );

        console.log(
            "NEW BEARISH OB SWING"
        );

        console.log(
            "=================================================="
        );

        console.log(
            `LH: ${toIST(
                swing.swingTime
            )}`
        );

        console.log(
            `LH index: ${swing.index}`
        );

        console.log(
            `LH price: ${swing.price}`
        );

        console.log(
            "COLLECTION RANGE: LH → LL"
        );

        console.log(
            "BOS/CHOCH WILL NOT CLOSE THIS SWING"
        );

        console.log(
            "==================================================\n"
        );
    }


    // =========================================================================
    // START NEW BULLISH SWING
    // =========================================================================

    startBullishSwing(
        swing
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
            "\n🟢 =================================================="
        );

        console.log(
            "NEW BULLISH OB SWING"
        );

        console.log(
            "=================================================="
        );

        console.log(
            `LL: ${toIST(
                swing.swingTime
            )}`
        );

        console.log(
            `LL index: ${swing.index}`
        );

        console.log(
            `LL price: ${swing.price}`
        );

        console.log(
            "COLLECTION RANGE: LL → HH"
        );

        console.log(
            "BOS/CHOCH WILL NOT CLOSE THIS SWING"
        );

        console.log(
            "==================================================\n"
        );
    }


    // =========================================================================
    // HANDLE STRUCTURE EVENT
    // =========================================================================
    //
    // BOS/CHOCH IS ONLY AN EVENT.
    //
    // IT DOES NOT CLOSE activeSwing.
    //
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

            console.log(
                "\n⚠️ Structure event occurred but no active OB swing exists."
            );

            return;
        }


        // =========================================================================
        // RECORD BOS / CHOCH
        // =========================================================================

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


        // =========================================================================
        // DEBUG
        // =========================================================================

        console.log(
            "\n📌 =================================================="
        );

        console.log(
            "STRUCTURE EVENT INSIDE OB SWING"
        );

        console.log(
            "=================================================="
        );

        console.log(
            `${structureEvent.kind} ` +
            `${structureEvent.direction} ` +
            `@ ${toIST(
                structureEvent.time
            )}`
        );

        console.log(
            `Current OB swing: ` +

            `${this.activeSwing.startType}` +

            ` → ` +

            `${this.activeSwing.endType}`
        );

        console.log(
            `OB swing start index: ` +
            `${this.activeSwing.startIndex}`
        );

        console.log(
            `BOS/CHOCH index: ` +
            `${structureEvent.breakCandleIndex}`
        );

        console.log(
            "⚠️ BOS/CHOCH DOES NOT END OB COLLECTION"
        );

        console.log(
            "OB collection CONTINUES."
        );

        console.log(
            "==================================================\n"
        );
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


        // =========================================================================
        // FINAL SWING SWEEP
        // =========================================================================
        //
        // This is VERY important.
        //
        // Any FVG whose OB candle is between:
        //
        //     LH index → LL index
        //
        // is now eligible.
        //
        // This catches FVGs that were confirmed late.
        //
        // =========================================================================

        console.log(
            "\n🔎 FINAL BEARISH SWING OB SWEEP"
        );

        console.log(
            `Range: ${this.activeSwing.startIndex} → ` +
            `${this.activeSwing.endIndex}`
        );


        const candidates =
            fvgTracker.findInRange(

                this.activeSwing.startIndex,

                this.activeSwing.endIndex,

                "bearish"
            );


        console.log(
            `Confirmed bearish FVGs found in range: ` +
            `${candidates.length}`
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
            "\n🔴 =================================================="
        );

        console.log(
            "BEARISH OB SWING CLOSED"
        );

        console.log(
            "=================================================="
        );

        console.log(
            `LH: ${toIST(
                this.activeSwing.startTime
            )}`
        );

        console.log(
            `LL: ${toIST(
                this.activeSwing.endTime
            )}`
        );

        console.log(
            `Total OBs: ${
                this.activeSwing.obIds.length
            }`
        );

        console.log(
            "==================================================\n"
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


        // =========================================================================
        // FINAL SWING SWEEP
        // =========================================================================

        console.log(
            "\n🔎 FINAL BULLISH SWING OB SWEEP"
        );

        console.log(
            `Range: ${this.activeSwing.startIndex} → ` +
            `${this.activeSwing.endIndex}`
        );


        const candidates =
            fvgTracker.findInRange(

                this.activeSwing.startIndex,

                this.activeSwing.endIndex,

                "bullish"
            );


        console.log(
            `Confirmed bullish FVGs found in range: ` +
            `${candidates.length}`
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
            "\n🔵 =================================================="
        );

        console.log(
            "BULLISH OB SWING CLOSED"
        );

        console.log(
            "=================================================="
        );

        console.log(
            `LL: ${toIST(
                this.activeSwing.startTime
            )}`
        );

        console.log(
            `HH: ${toIST(
                this.activeSwing.endTime
            )}`
        );

        console.log(
            `Total OBs: ${
                this.activeSwing.obIds.length
            }`
        );

        console.log(
            "==================================================\n"
        );
    }


    // =========================================================================
    // ADD CONFIRMED FVG
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


        // =========================================================================
        // MATCH DIRECTION
        // =========================================================================

        if (
            fvg.obType !==
            swing.direction
        ) {

            return null;
        }


        // =========================================================================
        // RANGE
        // =========================================================================
        //
        // If the swing is still open:
        //
        //     start → current candle
        //
        // If closed:
        //
        //     start → actual swing endpoint
        //
        // =========================================================================

        const startIndex =
            swing.startIndex;


        const endIndex =
            swing.closed
                ? swing.endIndex
                : currentIndex;


        // =========================================================================
        // FVG FIRST CANDLE MUST BE INSIDE THE SWING
        // =========================================================================

        if (
            fvg.index <
            startIndex ||
            fvg.index >
            endIndex
        ) {

            return null;
        }


        // =========================================================================
        // DUPLICATE CHECK
        // =========================================================================

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


        // =========================================================================
        // WAS BOS ALREADY SEEN?
        // =========================================================================

        const discoveredAfterBOS =
            swing.bosOccurred;


        const discoveredAfterCHOCH =
            swing.chochOccurred;


        // =========================================================================
        // CREATE OB
        // =========================================================================

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

            discoveredAtTime:
                new Date(),

            discoveredAfterBOS,

            discoveredAfterCHOCH,

            discoverySource:
                source,

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


        // =========================================================================
        // DEBUG
        // =========================================================================

        console.log(
            "\n📦 =================================================="
        );

        console.log(
            "NEW SWING OB"
        );

        console.log(
            "=================================================="
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
            `OB index: ${ob.index}`
        );

        console.log(
            `OB type: ${ob.obType}`
        );

        console.log(
            `Zone: ${ob.low} - ${ob.high}`
        );

        console.log(
            `Swing: ${ob.swingStartType} → ` +
            `${ob.swingEndType}`
        );

        console.log(
            `Swing range: ` +
            `${ob.swingStartIndex} → ` +
            `${ob.swingEndIndex ?? "OPEN"}`
        );

        console.log(
            `FVG confirmed: ${
                fvg.confirmedAt
                    ? toIST(fvg.confirmedAt)
                    : "UNKNOWN"
            }`
        );

        console.log(
            `Discovery source: ${source}`
        );

        console.log(
            discoveredAfterBOS
                ? "🟣 OB confirmed AFTER BOS"
                : "🔵 OB confirmed BEFORE BOS"
        );

        console.log(
            "OB COLLECTION CONTINUES."
        );

        console.log(
            "==================================================\n"
        );


        return ob;
    }


    // =========================================================================
    // REFRESH ACTIVE STATUSES
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


        // Newest OB gets active status.

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
    // CANDLE PROCESSING
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


        // =========================================================================
        // SKIP BOS/CHOCH CANDLE
        // =========================================================================

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
// 6) MARKET STRUCTURE ENGINE
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
        // 2. FVG
        // =========================================================================
        //
        // FVG confirmation happens here.
        //
        // IMPORTANT:
        //
        // We don't immediately assume the FVG belongs to a swing.
        //
        // It will be checked against the active swing.
        //
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
        //
        // THIS IS THE IMPORTANT ORDER.
        //
        // First process the newly confirmed swing endpoint.
        //
        // If it is HH/LL:
        //
        //     close the existing OB swing
        //
        // using the ACTUAL SWING INDEX.
        //
        // =========================================================================

        if (
            swing &&
            swingClassification
        ) {

            const classification =
                swingClassification.classification;


            // =====================================================================
            // LL
            //
            // A bearish LH → LL swing ENDS here.
            //
            // Then this LL becomes the beginning of a new bullish LL → HH swing.
            // =====================================================================

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


                // Start new bullish swing.

                this.obManager.startBullishSwing(
                    swing
                );
            }


            // =====================================================================
            // HH
            //
            // A bullish LL → HH swing ENDS here.
            //
            // Then this HH becomes the beginning of the next bearish cycle only
            // when a future LH is actually classified.
            //
            // We DO NOT create bearish OB swing from HH itself.
            // =====================================================================

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


            // =====================================================================
            // LH
            //
            // LH starts a bearish LH → LL collection window.
            // =====================================================================

            if (
                classification ===
                "LH"
            ) {

                this.obManager.startBearishSwing(
                    swing
                );
            }


            // =====================================================================
            // HL
            //
            // HL DOES NOT close a bullish LL → HH OB swing.
            // =====================================================================

            if (
                classification ===
                "HL"
            ) {

                console.log(
                    `🔹 HL @ ${toIST(
                        swing.swingTime
                    )} — bullish OB swing remains unchanged.`
                );
            }
        }


        // =========================================================================
        // 6. PROCESS NEW FVGs
        // =========================================================================
        //
        // This happens AFTER swing management.
        //
        // So if the current candle confirms an LL/HH, the FVG is checked against
        // the correct completed swing boundaries.
        //
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

                    ID:
                        ob.id,

                    OB_CANDLE:
                        toIST(
                            ob.time
                        ),

                    OB_INDEX:
                        ob.index,

                    TYPE:
                        ob.obType,

                    ZONE:
                        `${ob.low} - ${ob.high}`,

                    SWING:
                        `${ob.swingStartType} → ` +
                        `${ob.swingEndType}`,

                    SWING_START:
                        toIST(
                            ob.swingStartTime
                        ),

                    SWING_END:
                        ob.swingEndTime
                            ? toIST(
                                ob.swingEndTime
                            )
                            : "OPEN",

                    BOS_OR_CHOCH:
                        ob.discoveredAfterBOS ||
                        ob.discoveredAfterCHOCH
                            ? "AFTER"
                            : "BEFORE",

                    DISCOVERY:
                        ob.discoverySource,

                    FVG_CONFIRMED:
                        ob.confirmedAt
                            ? toIST(
                                ob.confirmedAt
                            )
                            : "-",

                    STATUS:
                        ob.status,

                    TOUCHED:
                        ob.touchedAt
                            ? toIST(
                                ob.touchedAt
                            )
                            : "-",

                    PATTERN:
                        ob.pattern ??
                        "-",

                    SIGNAL:
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

        console.log(
            "\nChecking all FVGs at 05:30:"
        );


        const targetFVGs =
            engine.fvg.confirmed.filter(
                fvg => {

                    const p =
                        istParts(
                            fvg.time
                        );

                    return (
                        p.date ===
                            "14/08/2026" &&

                        p.time ===
                            "05:30"
                    );
                }
            );


        console.table(
            targetFVGs
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

                    index:
                        ob.index,

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

                    discovery:
                        ob.discoverySource,

                    fvgConfirmed:
                        ob.confirmedAt
                            ? toIST(
                                ob.confirmedAt
                            )
                            : "-",

                    status:
                        ob.status
                })
            )
        );
    }


    // =========================================================================
    // FINAL OB COUNT BY SWING
    // =========================================================================

    console.log(
        "\n=================================================="
    );

    console.log(
        "OB COUNT BY SWING"
    );

    console.log(
        "=================================================="
    );


    const swingGroups = {};


    for (
        const ob of
        engine.obManager.orderBlocks
    ) {

        const key =
            `${ob.swingStartType} ` +
            `${toIST(
                ob.swingStartTime
            )} → ` +
            `${ob.swingEndType} ` +
            `${
                ob.swingEndTime
                    ? toIST(
                        ob.swingEndTime
                    )
                    : "OPEN"
            }`;


        if (
            !swingGroups[key]
        ) {

            swingGroups[key] = {

                swing:
                    key,

                totalOBs:
                    0,

                beforeBOS:
                    0,

                afterBOS:
                    0
            };
        }


        swingGroups[key].totalOBs++;


        if (
            ob.discoveredAfterBOS
        ) {

            swingGroups[key].afterBOS++;

        } else {

            swingGroups[key].beforeBOS++;
        }
    }


    console.table(
        Object.values(
            swingGroups
        )
    );


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

                swing:
                    `${s.swingStartType} → ` +
                    `${s.swingEndType}`,

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