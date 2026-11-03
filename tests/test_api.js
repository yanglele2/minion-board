/* 接口测试：令牌不对要拒绝，正文太大要拒绝，存进去再读出来要一致。 */
const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const ingest = require("../api/ingest");
const board = require("../api/board");
const { createMemoryStore, putBoard, getBoard, KEY } = require("../lib/store");

const TOKEN = "test-token-do-not-print";

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(payload) {
      this.body = payload;
    },
  };
}

function mockReq(method, headers, body) {
  return { method, headers: headers || {}, body };
}

async function callIngest(req, store, token) {
  const res = mockRes();
  await ingest(req, res, { store, token: token == null ? TOKEN : token });
  return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null, raw: res.body };
}

async function callBoard(store) {
  const res = mockRes();
  await board({ method: "GET", headers: {} }, res, { store });
  return { status: res.statusCode, headers: res.headers, json: JSON.parse(res.body) };
}

test("没有令牌、令牌错、不是 Bearer，都是 401，而且响应里没有令牌", async () => {
  const store = createMemoryStore();
  const cases = [
    mockReq("POST", { "content-type": "application/json" }, '{"schema":1}'),
    mockReq("POST", { authorization: "Bearer wrong-token", "content-type": "application/json" }, '{"schema":1}'),
    mockReq("POST", { authorization: "Basic " + TOKEN, "content-type": "application/json" }, '{"schema":1}'),
    mockReq("POST", { authorization: "Bearer", "content-type": "application/json" }, '{"schema":1}'),
  ];
  for (const req of cases) {
    const out = await callIngest(req, store);
    assert.equal(out.status, 401);
    assert.equal(out.json.error, "unauthorized");
    assert.equal(out.raw.includes(TOKEN), false);
    assert.equal(out.raw.includes("wrong-token"), false);
  }
  assert.equal(await store.getBoard(), null);
});

test("环境变量没设令牌时也不能推", async () => {
  const previous = process.env.INGEST_TOKEN;
  delete process.env.INGEST_TOKEN;
  const res = mockRes();
  await ingest(mockReq("POST", { authorization: "Bearer " + TOKEN }, '{"schema":1}'), res);
  assert.equal(res.statusCode, 401);
  if (previous === undefined) delete process.env.INGEST_TOKEN;
  else process.env.INGEST_TOKEN = previous;
});

test("不是 POST 的写入、不是 GET 的读取，都是 405", async () => {
  const store = createMemoryStore();
  const posted = mockRes();
  await ingest(mockReq("GET", { authorization: "Bearer " + TOKEN }), posted, { store, token: TOKEN });
  assert.equal(posted.statusCode, 405);
  const read = mockRes();
  await board({ method: "POST", headers: {} }, read, { store });
  assert.equal(read.statusCode, 405);
});

test("不是 JSON、不是对象、空正文，都是 400", async () => {
  const store = createMemoryStore();
  const bodies = ["{", "[]", "null", "\"hi\"", "   ", ""];
  for (const body of bodies) {
    const out = await callIngest(
      mockReq("POST", { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body),
      store
    );
    assert.equal(out.status, 400, body);
    assert.equal(out.json.error, "invalid_json");
  }
});

test("正文超过 1 MB，或者声明的长度超过 1 MB，都是 413", async () => {
  const store = createMemoryStore();
  const huge = '{"title":"' + "鸭".repeat(600000) + '"}';
  assert.ok(Buffer.byteLength(huge) > 1024 * 1024);
  const bySize = await callIngest(
    mockReq("POST", { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, huge),
    store
  );
  assert.equal(bySize.status, 413);
  assert.equal(bySize.json.error, "too_large");

  const byHeader = await callIngest(
    mockReq(
      "POST",
      { authorization: "Bearer " + TOKEN, "content-type": "application/json", "content-length": String(2 * 1024 * 1024) },
      '{"schema":1}'
    ),
    store
  );
  assert.equal(byHeader.status, 413);
  assert.equal(await store.getBoard(), null);
});

test("推上去再读出来，中文还在，并且带上推送时间", async () => {
  const store = createMemoryStore();
  const boardJson = {
    schema: 1,
    built_at: "2026-11-03T08:00:00+08:00",
    refresh_mode: "watch",
    tasks: [{ task_id: "tsk-1", title: "【假】数三只橡皮鸭", minion: "pi" }],
  };
  const out = await callIngest(
    mockReq("POST", { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, JSON.stringify(boardJson)),
    store
  );
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.match(out.json.pushed_at, /^\d{4}-\d{2}-\d{2}T/);

  const read = await callBoard(store);
  assert.equal(read.status, 200);
  assert.equal(read.json.empty, false);
  assert.equal(read.json.board.tasks[0].title, "【假】数三只橡皮鸭");
  assert.equal(read.json.pushed_at, out.json.pushed_at);
  assert.equal(typeof read.json.age_s, "number");
  assert.equal(read.headers["cache-control"], board.CACHE);
});

test("还没有推送时，公开接口返回空状态而不是报错", async () => {
  const read = await callBoard(createMemoryStore());
  assert.equal(read.status, 200);
  assert.equal(read.json.empty, true);
  assert.equal(read.json.board, null);
  assert.equal(read.json.pushed_at, null);
  assert.equal(read.headers["cache-control"], board.CACHE);
});

test("Vercel 已经把 JSON 解析成对象时，也能存", async () => {
  const store = createMemoryStore();
  const out = await callIngest(
    mockReq(
      "POST",
      { authorization: "Bearer " + TOKEN, "content-type": "application/json", "content-length": "32" },
      { schema: 1, title: "【假】已经是对象" }
    ),
    store
  );
  assert.equal(out.status, 200);
  const read = await callBoard(store);
  assert.equal(read.json.board.title, "【假】已经是对象");
});

test("访问 request.body 抛错时当成坏 JSON", async () => {
  const store = createMemoryStore();
  const req = {
    method: "POST",
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    get body() {
      throw new Error("malformed");
    },
  };
  const out = await callIngest(req, store);
  assert.equal(out.status, 400);
});

test("存储没配好时写入和读取都是 503", async () => {
  const broken = {
    async putBoard() {
      throw new Error("redis not configured");
    },
    async getBoard() {
      throw new Error("redis not configured");
    },
  };
  const posted = await callIngest(
    mockReq("POST", { authorization: "Bearer " + TOKEN }, '{"schema":1}'),
    broken
  );
  assert.equal(posted.status, 503);
  const res = mockRes();
  await board({ method: "GET", headers: {} }, res, { store: broken });
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error, "store_unavailable");
  assert.equal(res.headers["cache-control"], "no-store");
});

test("用真正的 HTTP 请求走一遍：拒绝、超限、往返", async () => {
  const store = createMemoryStore();
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (path === "/api/ingest") {
      ingest(req, res, { store, token: TOKEN });
      return;
    }
    board(req, res, { store });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = "http://127.0.0.1:" + port;
  try {
    const denied = await fetch(base + "/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
      body: '{"schema":1}',
    });
    assert.equal(denied.status, 401);
    const deniedText = await denied.text();
    assert.equal(deniedText.includes(TOKEN), false);

    const big = '{"title":"' + "x".repeat(1024 * 1024) + '"}';
    const tooBig = await fetch(base + "/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: big,
    });
    assert.equal(tooBig.status, 413);

    const payload = { schema: 1, note: "【假】从 HTTP 走进来" };
    const posted = await fetch(base + "/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify(payload),
    });
    assert.equal(posted.status, 200);
    const read = await fetch(base + "/api/board");
    const json = await read.json();
    assert.equal(json.board.note, "【假】从 HTTP 走进来");
    assert.ok(json.pushed_at);
    assert.match(read.headers.get("cache-control"), /s-maxage=15/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Redis 客户端认 KV_ 和 UPSTASH_ 两套变量，并且 SET/GET 的键是固定的", async () => {
  const previous = {
    KV_REST_API_URL: process.env.KV_REST_API_URL,
    KV_REST_API_TOKEN: process.env.KV_REST_API_TOKEN,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const command = JSON.parse(opts.body);
    if (command[0] === "SET") return { ok: true, json: async () => ({ result: "OK" }) };
    return { ok: true, json: async () => ({ result: command[2] || null }) };
  };
  try {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.KV_REST_API_URL = "https://kv.example.test/";
    process.env.KV_REST_API_TOKEN = "kv-token";
    await putBoard({ schema: 1, title: "【假】鸭子" }, "2026-11-03T00:00:00.000Z");
    assert.equal(calls[0].url, "https://kv.example.test");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer kv-token");
    const set = JSON.parse(calls[0].opts.body);
    assert.deepEqual(set.slice(0, 2), ["SET", KEY]);
    assert.match(set[2], /【假】鸭子/);

    calls.length = 0;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    process.env.UPSTASH_REDIS_REST_URL = "https://upstash.example.test";
    process.env.UPSTASH_REDIS_REST_TOKEN = "up-token";
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return {
        ok: true,
        json: async () => ({ result: JSON.stringify({ pushed_at: "2026-11-03T00:00:00.000Z", board: { schema: 1 } }) }),
      };
    };
    const saved = await getBoard();
    assert.equal(calls[0].url, "https://upstash.example.test");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer up-token");
    assert.deepEqual(JSON.parse(calls[0].opts.body), ["GET", KEY]);
    assert.equal(saved.board.schema, 1);
  } finally {
    global.fetch = original;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
