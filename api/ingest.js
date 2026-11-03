/* POST /api/ingest
 * 盒子用 Authorization: Bearer <INGEST_TOKEN> 推来最新的看板 JSON。
 * 别的请求一律 401。正文必须是 JSON 对象，并且不超过 1 MB。
 */
const { readBody, send, parseJsonObject, bearerToken, tokenOk, MAX_BYTES } = require("../lib/http");
const { defaultStore } = require("../lib/store");

async function ingest(req, res, options) {
  const opts = options || {};
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "POST") {
    send(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
    return;
  }
  const expected = String(opts.token != null ? opts.token : process.env.INGEST_TOKEN || "").trim();
  if (!tokenOk(bearerToken(req), expected)) {
    send(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  let board;
  try {
    const text = await readBody(req, MAX_BYTES);
    board = parseJsonObject(text);
  } catch (err) {
    const status = err.status === 413 ? 413 : 400;
    send(res, status, { ok: false, error: status === 413 ? "too_large" : "invalid_json" });
    return;
  }
  const pushedAt = new Date().toISOString();
  const store = opts.store || defaultStore;
  try {
    await store.putBoard(board, pushedAt);
  } catch (err) {
    send(res, 503, { ok: false, error: "store_unavailable" });
    return;
  }
  send(res, 200, { ok: true, bytes: Buffer.byteLength(JSON.stringify(board)), pushed_at: pushedAt });
}

module.exports = ingest;
