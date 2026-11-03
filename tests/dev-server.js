/* 本机预览：静态页面加上 /api/ingest 和 /api/board。
 * 没配 Redis 时用内存，进程一停数据就没了。只给自己看，不要拿去当正式服务。
 *
 *   INGEST_TOKEN=dev node tests/dev-server.js
 *   打开 http://127.0.0.1:4173/
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ingest = require("../api/ingest");
const board = require("../api/board");
const { createMemoryStore, defaultStore, redisEnv } = require("../lib/store");

const root = path.join(__dirname, "..");
const port = Number(process.env.PORT || 4173);
const token = process.env.INGEST_TOKEN || "dev-token";
const redis = redisEnv();
const store = redis.url && redis.token ? defaultStore : createMemoryStore();

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const file = path.normalize(path.join(root, pathname));
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.statusCode = 403;
    res.end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  if (pathname === "/api/ingest") {
    ingest(req, res, { store, token });
    return;
  }
  if (pathname === "/api/board") {
    board(req, res, { store });
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }
  res.statusCode = 405;
  res.end("method not allowed");
});

if (require.main === module) {
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write("http://127.0.0.1:" + port + "\n");
  });
}

module.exports = { server, store, token };
