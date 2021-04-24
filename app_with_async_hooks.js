import express from "express";
import async_hooks from "async_hooks";
import fs from "fs";

//////////////////////////////// Async hook ////////////////////////////////

// synchronous write to the console
function writeSync(event, msg) {
  const ts = getTimeMs();
  fs.writeSync(1, `>> ${ts ? `[${ts}] ` : ""}${event}: executionAsyncId: ${async_hooks.executionAsyncId()}${msg ? ` | ${msg}` : " |"}\n`);
};

const beforeTimeByAsyncId = new Map();

const asyncHook = async_hooks.createHook({
  init(asyncId, type, triggerAsyncId, resource) {
    writeSync(
      "init",
      `asyncId: ${asyncId}, type: "${type}", triggerAsyncId: ${triggerAsyncId}, resource: ${resource.constructor.name}`
    );
  },
  before(asyncId) {
    beforeTimeByAsyncId.set(asyncId, process.hrtime.bigint());
    writeSync("before", `asyncId: ${asyncId}`);
  },
  after(asyncId) {
    const durationMs = elapsedMsSince(beforeTimeByAsyncId.get(asyncId));
    writeSync("after", `asyncId: ${asyncId}, durationMs: ${durationMs}${durationMs > 10 ? ", event loop blocked!" : ""}`);
  },
  destroy(asyncId) {
    writeSync("destroy", `asyncId: ${asyncId}`);
  },
});
asyncHook.enable();

//////////////////////////////// Web app ////////////////////////////////

const app = express();
const bigObject = makeBigObject(2000, 2);
// const bigObject = makeBigObject(24, 2);  // < 8K
let requestCount = 0;
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

  console.log(
    `[${getTimeMs()}] Serializing response for request ${requestIndex}...`
  );
  const serializedBigObject = JSON.stringify(bigObject);

  const flushStartTime = process.hrtime.bigint();
  res.on("finish", () => {
    writeSync("res.finish");
    const flushDurationMs = elapsedMsSince(flushStartTime);
    console.log(
      `[${getTimeMs()}] -- Took ${flushDurationMs}ms to flush response for request ${requestIndex} --`
    );
  });

  console.log(
    `[${getTimeMs()}] Sending ${getReadableString(serializedBigObject.length)} response for request ${requestIndex}...`
  );
  res.send(serializedBigObject);

  console.log(`[${getTimeMs()}] - Handler done for request ${requestIndex} -`);
}

app.get("/", async (req, res) => {
  const requestIndex = ++requestCount;
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
function getReadableString(length) {
  if (length >= 1024 * 1024) {
    return `${Math.round(length / 1024 / 1024)}MB`;
  } else if (length >= 1024) {
    return `${Math.round(length / 1024)}KB`;
  } else {
    return `${length}B`;
  }
}