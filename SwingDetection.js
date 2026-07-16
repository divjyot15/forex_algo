import dotenv from "dotenv";
dotenv.config();

import { getConnection, getAccount, initConnection } from "./src/connection/metaapi.js";
let connection  = await initConnection();

const getHistoricalCandles = async () =>{
try {
    console.log("⏳ Connecting to MT5 via MetaApi...");

    const account =  getAccount();

    console.log("Connected");

    const candles = await account.getHistoricalCandles(
        "XAUUSD",
        "15m",
        new Date(),
    );

    console.log("candles", candles);

    return candles;
    
} catch (err) {
    console.error(err.stack);
}
}

function toIST(date) {
    return new Date(date).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    });
}

class ZigZagDetector {

    constructor(length = 9){

        this.length = length;

        this.trend = 1;

        this.currentHigh = null;
        this.currentLow = null;
    }


    process(candles){

        if(candles.length < this.length)
            return null;


        const current = candles.at(-1);


        // keep updating highest point
        // of entire current move

        if(
            !this.currentHigh ||
            current.high > this.currentHigh.high
        ){
            this.currentHigh = current;
        }


        if(
            !this.currentLow ||
            current.low < this.currentLow.low
        ){
            this.currentLow = current;
        }



        const recent =
            candles.slice(-this.length);


        const highest =
            Math.max(
                ...recent.map(c=>c.high)
            );


        const lowest =
            Math.min(
                ...recent.map(c=>c.low)
            );


        const toUp =
            current.high >= highest;


        const toDown =
            current.low <= lowest;



        // UP trend ended

        if(
            this.trend === 1 &&
            toDown
        ){

            const swing = {

                type:"HIGH",

                price:this.currentHigh.high,

                swingTime:this.currentHigh.time,

                detectedAt:current.time

            };


            this.trend = -1;


            this.currentLow = current;
            this.currentHigh = null;


            return swing;
        }



        // DOWN trend ended

        if(
            this.trend === -1 &&
            toUp
        ){

            const swing = {

                type:"LOW",

                price:this.currentLow.low,

                swingTime:this.currentLow.time,

                detectedAt:current.time

            };


            this.trend = 1;


            this.currentHigh = current;
            this.currentLow = null;


            return swing;

        }



        return null;
    }
}


async function main() {
    const detector = new ZigZagDetector(9);

    let candles = await getHistoricalCandles();
    let swings = [];


    for (
        let i = 0;
        i < candles.length;
        i++
    ) {

        const history =
            candles.slice(0, i + 1);


        const swing =
            detector.process(history);


        if (swing) {
            console.log(
                swing.type,
                swing.price,
                toIST(swing.swingTime),
                toIST(swing.detectedAt)
            );

            swings.push(swing);
            
        }

    }


    console.table(swings);
}

main()