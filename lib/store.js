/* 把整份看板 JSON 存进 Upstash Redis。
 *
 * Vercel Marketplace 的集成写入 KV_REST_API_URL / KV_REST_API_TOKEN。
 * 在 Upstash 控制台自己建库时，名字是 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN。
 * 有 KV_ 就用 KV_，没有再看 UPSTASH_。
 */
const KEY = "minion:board:v1";

function redisEnv() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  return { url: String(url).replace(/\/$/, ""), token: String(token).trim() };
}

function redisError(message) {
  const err = new Error(message);
  err.code = message === "redis not configured" ? "NO_REDIS" : "REDIS";
  return err;
}

async function command(args) {
  const { url, token } = redisEnv();
  if (!url || !token) throw redisError("redis not configured");
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
  } catch (cause) {
    const err = redisError("redis unreachable");
    err.cause = cause;
    throw err;
  }
  let data = null;
  try {
    data = await response.json();
  } catch (cause) {
    const err = redisError("redis bad response");
    err.cause = cause;
    throw err;
  }
  if (!response.ok || (data && data.error)) throw redisError("redis error");
  return data ? data.result : null;
}

function unwrap(result) {
  if (result == null) return null;
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch (err) {
      return null;
    }
  }
  if (typeof result === "object") return result;
  return null;
}

async function putBoard(board, pushedAt) {
  const payload = JSON.stringify({ pushed_at: pushedAt, board });
  await command(["SET", KEY, payload]);
}

async function getBoard() {
  return unwrap(await command(["GET", KEY]));
}

function createMemoryStore() {
  let saved = null;
  return {
    async putBoard(board, pushedAt) {
      saved = JSON.parse(JSON.stringify({ pushed_at: pushedAt, board }));
    },
    async getBoard() {
      return saved ? JSON.parse(JSON.stringify(saved)) : null;
    },
  };
}

const defaultStore = { putBoard, getBoard };

module.exports = {
  KEY,
  redisEnv,
  command,
  putBoard,
  getBoard,
  createMemoryStore,
  defaultStore,
};
