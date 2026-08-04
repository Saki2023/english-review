"use strict";

function writeEnvelope(value) {
  const json = JSON.stringify(value);
  process.stdout.write(Buffer.from(json, "utf8").toString("base64"));
}

async function readInput() {
  let encoded = "";
  process.stdin.setEncoding("ascii");
  for await (const chunk of process.stdin) encoded += chunk;
  const json = Buffer.from(encoded.trim(), "base64").toString("utf8");
  return JSON.parse(json);
}

function safeErrorCode(error) {
  const values = [error && error.code, error && error.name, error && error.cause && error.cause.code];
  return String(values.find(Boolean) || "NETWORK_ERROR").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "NETWORK_ERROR";
}

async function main() {
  const request = await readInput();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Math.min(120000, Number(request.timeoutMs) || 30000)));
  try {
    const response = await fetch(String(request.uri || ""), {
      method: String(request.method || "GET").toUpperCase(),
      headers: request.headers && typeof request.headers === "object" ? request.headers : {},
      body: request.bodyBase64 ? Buffer.from(String(request.bodyBase64), "base64") : undefined,
      signal: controller.signal
    });
    const body = Buffer.from(await response.arrayBuffer());
    writeEnvelope({ transportOk: true, status: response.status, bodyBase64: body.toString("base64") });
  } catch (error) {
    writeEnvelope({ transportOk: false, errorCode: safeErrorCode(error) });
  } finally {
    clearTimeout(timeout);
  }
}

main().catch(error => {
  writeEnvelope({ transportOk: false, errorCode: safeErrorCode(error) });
  process.exitCode = 1;
});
