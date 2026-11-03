/* GET /api/board
 * 公开页面读这一份。响应带上 pushed_at，页面可以告诉你数据有多旧。
 * CDN 缓存 15 秒，这样轮询不会每次都打到 Redis。
 */
const { send } = require("../lib/http");
const { defaultStore } = require("../lib/store");

const CACHE = "public, max-age=0, s-maxage=15, stale-while-revalidate=30";

function ageSeconds(pushedAt) {
  const ms = Date.parse(pushedAt || "");
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

async function board(req, res, options) {
  const opts = options || {};
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    send(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" });
    return;
  }
  const store = opts.store || defaultStore;
  let saved;
  try {
    saved = await store.getBoard();
  } catch (err) {
    send(res, 503, { ok: false, error: "store_unavailable" }, { "Cache-Control": "no-store" });
    return;
  }
  if (!saved || !saved.board) {
    send(
      res,
      200,
      { ok: true, empty: true, pushed_at: null, age_s: null, board: null },
      { "Cache-Control": CACHE }
    );
    return;
  }
  send(
    res,
    200,
    {
      ok: true,
      empty: false,
      pushed_at: saved.pushed_at || null,
      age_s: ageSeconds(saved.pushed_at),
      board: saved.board,
    },
    { "Cache-Control": CACHE }
  );
}

module.exports = board;
module.exports.CACHE = CACHE;
