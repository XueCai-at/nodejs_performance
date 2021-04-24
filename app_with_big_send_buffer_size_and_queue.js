import express from "express";
import os from "os";
import ref from "ref-napi";
import ffi from "ffi-napi";
import async from "async";

//////////////////////////////// Send buffer size ////////////////////////////////
const cInt = ref.types.int;
const cVoid = ref.types.void;
const bindings = ffi.Library(null, {
  setsockopt: [cInt, [cInt, cInt, cInt, ref.refType(cVoid), cInt]],
});

let SOL_SOCKET;
let SO_SNDBUF;
switch (os.platform()) {
  case "linux":
    SOL_SOCKET = 1;
    SO_SNDBUF = 7;
    break;

  case "darwin":
    SOL_SOCKET = 0xffff;
    SO_SNDBUF = 0x1001;
    break;
}

function setsockoptInt(fd, level, name, value) {
  const valueRef = ref.alloc(cInt, value);
  bindings.setsockopt(fd, level, name, valueRef, cInt.size);
}
function setSendBufferSize(res, sendBufferSizeInBytes) {
  const fd = res.socket._handle.fd;
  setsockoptInt(fd, SOL_SOCKET, SO_SNDBUF, sendBufferSizeInBytes);
}

//////////////////////////////// Async queue ////////////////////////////////
const requestQueue = async.queue(async function (task, callback) {
  await requestHandler(task);
  callback();
}, 1);

//////////////////////////////// Web app ////////////////////////////////
const app = express();
const bigObject = makeBigObject(2000, 2);
// const bigObject = makeBigObject(24, 2);  // < 8K
let requestCount = 0;
let firstRequestStartTime;
function getTimeMs() {
  return elapsedMsSince(firstRequestStartTime);
}

async function requestHandler({ requestIndex, req, res }) {
  if (!firstRequestStartTime) {
    firstRequestStartTime = process.hrtime.bigint();
  }

  // add some async gaps
  for (let i = 0; i < 20; ++i) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  console.log(
    `[${getTimeMs()}] Serializing response for request ${requestIndex}...`
  );
  const serializedBigObject = JSON.stringify(bigObject);

  const flushStartTime = process.hrtime.bigint();
  res.on("finish", () => {
    const flushDurationMs = elapsedMsSince(flushStartTime);
    console.log(
      `[${getTimeMs()}] -- Took ${flushDurationMs}ms to flush response for request ${requestIndex} --`
    );
  });

  console.log(
    `[${getTimeMs()}] Sending ${getReadableString(serializedBigObject.length)} response for request ${requestIndex}...`
  );
  setSendBufferSize(res, 4 * 1024 * 1024);  // 4MB
  res.send(serializedBigObject);

  console.log(`[${getTimeMs()}] - Handler done for request ${requestIndex} -`);
}

app.get("/", async (req, res) => {
  const requestIndex = ++requestCount;
  requestQueue.push({ requestIndex, req, res });
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