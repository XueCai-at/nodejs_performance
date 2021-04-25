import express from "express";
import async_hooks from "async_hooks";
import fs from "fs";

//////////////////////////////// Async hooks ////////////////////////////////
// synchronous write to the console
function writeSync(event, msg) {
  const ts = getTimeMs();
  fs.writeSync(1, `>> ${ts ? `[${ts}] ` : ""}${event}: executionAsyncId: ${async_hooks.executionAsyncId()}${msg ? ` | ${msg}` : " |"}\n`);
};

const beforeTimeByAsyncId = new Map();
const events = [];

const asyncHook = async_hooks.createHook({
  init(asyncId, type, triggerAsyncId, resource) {
    writeSync(
      "init",
      `asyncId: ${asyncId}, type: "${type}", triggerAsyncId: ${triggerAsyncId}, resource: ${resource.constructor.name}`
    );
  },
  before(asyncId) {
    writeSync("before", `asyncId: ${asyncId}`);
    beforeTimeByAsyncId.set(asyncId, process.hrtime.bigint());
  },
  after(asyncId) {
    const start = beforeTimeByAsyncId.get(asyncId);
    const end = process.hrtime.bigint();
    const durationMs = elapsedMsBetween(start, end);
    writeSync("after", `asyncId: ${asyncId}, durationMs: ${durationMs}${durationMs > 10 ? ", event loop blocked!" : ""}`);
    events.push(
      {
        type: 'syncOp',
        asyncId,
        start,
        end, 
      }
    )
  },
  destroy(asyncId) {
    writeSync("destroy", `asyncId: ${asyncId}`);
  },
});
asyncHook.enable();

function computeSyncOpStats(syncOpSpansInBetween, start, end) {
  let cpuTime = 0;
  for (const syncOpSpan of syncOpSpansInBetween) {
    // the span can start before `start`
    const spanStart = syncOpSpan.start < start ? start : syncOpSpan.start;
    cpuTime += elapsedUsBetween(spanStart, syncOpSpan.end);
  }
  const totalTime = elapsedUsBetween(start, end);
  const idleTime = totalTime - cpuTime;
  return {cpuTime, idleTime, totalTime};
}

function getEventsSummary() {
  let content = "";
  let lastResSendEndEvent;
  let syncOpSpansInBetween = [];
  for (const event of events) {
    if (event.type === "resSendEnd") {
      lastResSendEndEvent = event;
      syncOpSpansInBetween = [];
    } else if (event.type === "resFinish" || event.type === "serializeStart") {
      if (lastResSendEndEvent) {
        // TODO: print spans to sanity check
        content += `Between request ${lastResSendEndEvent.requestIndex} ${lastResSendEndEvent.type} and request ${event.requestIndex} ${event.type}\n`;
        const stats = computeSyncOpStats(syncOpSpansInBetween, lastResSendEndEvent.ts, event.ts);
        content += `  - total time: ${stats.totalTime} us\n`;
        content += `  - total cpu time: ${stats.cpuTime} us\n`;
        content += `  - total idle time: ${stats.idleTime} us\n`;
        content += `  - number of sync operations: ${syncOpSpansInBetween.length}\n`;
      }
      lastResSendEndEvent = null;
      syncOpSpansInBetween = [];
    } else {
      syncOpSpansInBetween.push(event);
    }
  }
  return content;
}

//////////////////////////////// Web app ////////////////////////////////
const app = express();
const bigObject = makeBigObject(2000, 2);
// const bigObject = makeBigObject(24, 2);  // < 8K
let requestCount = 0;
let inflightRequestCount = 0;
let firstRequestStartTime;
function getTimeMs() {
  if (!firstRequestStartTime) {
    return undefined;
  }
  return elapsedMsSince(firstRequestStartTime);
}

async function requestHandler({ requestIndex, req, res }) {
  if (!firstRequestStartTime) {
    firstRequestStartTime = process.hrtime.bigint();
  }

  events.push({
    type: 'serializeStart',
    requestIndex,
    ts: process.hrtime.bigint(),
  });
  console.log(
    `[${getTimeMs()}] Serializing response for request ${requestIndex}...`
  );
  const serializedBigObject = JSON.stringify(bigObject);

  const flushStartTime = process.hrtime.bigint();
  res.on("finish", () => {
    events.push({
      type: 'resFinish',
      requestIndex,
      ts: process.hrtime.bigint(),
    });
    writeSync("res.finish");
    const flushDurationMs = elapsedMsSince(flushStartTime);
    console.log(
      `[${getTimeMs()}] -- Took ${flushDurationMs}ms to flush response for request ${requestIndex} --`
    );
  });
  res.on("close", () => {
    writeSync("res.close");
    inflightRequestCount -= 1;
    if (inflightRequestCount === 0) {
      console.log(`\n${getEventsSummary()}`);
    }
  });

  console.log(
    `[${getTimeMs()}] Sending ${getReadableString(serializedBigObject.length)} response for request ${requestIndex}...`
  );
  res.send(serializedBigObject);
  events.push({
    type: 'resSendEnd',
    requestIndex,
    ts: process.hrtime.bigint(),
  });

  console.log(`[${getTimeMs()}] - Handler done for request ${requestIndex} -`);
}

app.get("/", async (req, res) => {
  const requestIndex = ++requestCount;
  inflightRequestCount += 1;
  requestHandler({ requestIndex, req, res });
});

app.listen("/tmp/sock", () =>
  console.log(`Example app listening on Unix domain socket /tmp/sock!`)
);

//////////////////////////////// Utils below ////////////////////////////////
function makeBigObject(leaves, depth) {
  if (depth === 0) {
    return "howdy";
  } else {
    const ret = {};
    for (let i = 0; i < leaves; ++i) {
      ret[i] = makeBigObject(leaves, depth - 1);
    }
    return ret;
  }
}
function elapsedMsSince(start) {
  return elapsedMsBetween(start, process.hrtime.bigint());
}
function elapsedMsBetween(start, end) {
  return Math.round(Number(end - start) / 1e6);
}
function elapsedUsBetween(start, end) {
  return Math.round(Number(end - start) / 1e3);
}
function getReadableString(length) {
  if (length >= 1024 * 1024) {
    return `${Math.round(length / 1024 / 1024)}MB`;
  } else if (length >= 1024) {
    return `${Math.round(length / 1024)}KB`;
  } else {
    return `${length}B`;
  }
}