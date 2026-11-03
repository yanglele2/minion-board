/* 两个接口共用的小工具：读请求体、比对令牌、回 JSON。 */
const crypto = require("node:crypto");

const MAX_BYTES = 1024 * 1024;

function header(req, name) {
  const headers = req.headers || {};
  if (typeof headers.get === "function") {
    return headers.get(name) || "";
  }
  const value = headers[name.toLowerCase()] ?? headers[name] ?? "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value || "");
}

function send(res, status, payload, extra) {
  res.statusCode = status;
  const headers = Object.assign({ "Content-Type": "application/json; charset=utf-8" }, extra || {});
  if (typeof res.setHeader === "function") {
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value);
    }
  }
  // Vercel 的 response 带 status().json()。普通 Node 只有 end()。
  if (typeof res.status === "function" && typeof res.json === "function") {
    res.status(status).json(payload);
    return;
  }
  res.end(JSON.stringify(payload));
}

function limitText(text, limit) {
  if (Buffer.byteLength(text) > limit) {
    const err = new Error("too big");
    err.status = 413;
    throw err;
  }
  return text;
}

function readDeclaredBody(req) {
  try {
    return req.body;
  } catch (err) {
    const error = new Error("bad json");
    error.status = 400;
    error.code = "invalid_json";
    throw error;
  }
}

function readStream(source, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const ok = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    source.on("data", (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > limit) {
        const err = new Error("too big");
        err.status = 413;
        if (typeof source.destroy === "function") source.destroy();
        fail(err);
        return;
      }
      parts.push(buf);
    });
    source.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    source.on("error", (err) => fail(err));
  });
}

async function readBody(req, limit) {
  const declared = Number(header(req, "content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    const err = new Error("too big");
    err.status = 413;
    throw err;
  }
  const preset = readDeclaredBody(req);
  if (typeof preset === "string") return limitText(preset, limit);
  if (Buffer.isBuffer(preset)) return limitText(preset.toString("utf8"), limit);
  if (preset && typeof preset === "object") return limitText(JSON.stringify(preset), limit);
  if (req && typeof req.on === "function") return readStream(req, limit);
  return "";
}

function parseJsonObject(text) {
  if (!text || !String(text).trim()) {
    const err = new Error("empty");
    err.status = 400;
    err.code = "invalid_json";
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    const error = new Error("bad json");
    error.status = 400;
    error.code = "invalid_json";
    throw error;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const err = new Error("not object");
    err.status = 400;
    err.code = "invalid_json";
    throw err;
  }
  return data;
}

function bearerToken(req) {
  const raw = header(req, "authorization");
  const match = /^Bearer\s+(\S+)\s*$/i.exec(raw);
  return match ? match[1] : "";
}

function tokenOk(provided, expected) {
  if (!expected || !provided) return false;
  const left = crypto.createHash("sha256").update(String(provided), "utf8").digest();
  const right = crypto.createHash("sha256").update(String(expected), "utf8").digest();
  return crypto.timingSafeEqual(left, right);
}

module.exports = {
  MAX_BYTES,
  header,
  send,
  readBody,
  parseJsonObject,
  bearerToken,
  tokenOk,
};
