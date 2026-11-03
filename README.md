# 手下看板

这是给老板看的看板。三张卡片告诉你 Codex（扣扣）、Hermes（赫米）、pi（派派）现在在干什么、刚才做成没有。页面是简体中文，时间一律是北京时间（UTC+8）。

盒子上仍然可以双击打开本地页面。另外可以把它放到 Vercel 的免费 Hobby 计划上，变成一个**公开网页**。盒子大约每一分钟把最新快照推上去，网页自己隔一小会儿读一次，不用为了新数据重新部署。

任务标题会出现在公开网页上。标题里不要写密钥、路径或提示词原文。

## 数据怎么走

可以把它想成一条接力：

1. **盒子**上的 `scripts/heartbeat.sh` 每 30 秒跑一次 `scripts/build_snapshot.py`，写出 `data/board-data.json`。
2. 如果设了 `MINION_INGEST_URL`，心跳最多每 60 秒调用一次 `scripts/push_vercel.sh`。内容和上次成功推送一样时，脚本不会发请求。
3. 脚本 `POST /api/ingest`，请求头是 `Authorization: Bearer <INGEST_TOKEN>`。
4. 接口把这份 JSON 存进 **Upstash Redis**（经 Vercel Marketplace 安装）。同时记下 `pushed_at`，也就是收到推送的时间。
5. 公开页面大约每 20 秒 `GET /api/board`。这个接口允许 CDN 缓存 15 秒（`s-maxage=15`），所以很多人同时打开，也不会每人每次都去打 Redis。
6. 页面用 `pushed_at` 和快照里的 `built_at` 告诉你数据有多旧。还没人推过，就显示空状态。太久没更新，就显示过期。

本地用 `file://` 打开时，页面不访问接口，仍然读 `data/board-data.js` 里的 `window.__MINION_BOARD__`。地址上的 `?fixture=名称` 也还是只读仓库里的假数据。

## 为什么用 Redis，不用 Vercel Blob

核对过当前的免费额度（2026 年 11 月）：

| 存储 | 免费额度里和这次有关的部分 | 一分钟写一次时 |
|---|---|---|
| Vercel Blob（Hobby） | 每月大约 **2000** 次高级操作。写入算高级操作。超出后要等约 30 天才能再用。 | 一个月大约 **4.3 万**次写入，大概是免费额度的 20 倍，放不下。 |
| Upstash Redis 免费档 | 每月 **50 万**次命令，数据 **250 MB**，流量 **10 GB**。一个 `SET` 或 `GET` 算一次命令。 | 写入最多约 4.3 万次。页面如果一直开着，CDN 大约每 15 秒才回源读一次，一个月大约 17 万次读取。加起来仍低于 50 万。内容没变时推送脚本会跳过，实际写入更少。 |

Hobby 的函数调用额度是每月 100 万次。按上面的节奏，也在额度里面。

请在 Upstash 里建**单区域**数据库，不要开 Global。Global 会把每次写入复制到每个读区域，复制也算命令，免费额度会薄一截。也不要给 Upstash 账号加支付方式：官方说明里，加上第一张卡之后，免费数据库会变成付费计划。

## 在 Vercel 上要你亲手做的事

这个仓库不会替你部署。你在网页上把项目连上之后，按下面做：

1. 用 Hobby（免费）团队，把 GitHub 仓库 `yanglele2/minion-board` 导入 Vercel。框架选 **Other**（这是静态页加两个小函数，不是 Next.js）。生产分支用 `main`。
2. 在 Vercel 的 **Integrations / Marketplace** 里安装 **Upstash Redis**（页面也叫 Upstash for Redis）。给这个项目建一个 **Free**、**单区域**的数据库。装好之后，Vercel 会写入：
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
3. 再手工加一个环境变量，Production 和 Preview 都要有：
   - `INGEST_TOKEN`：一长串随机字符。在你自己的电脑上可以这样生成：`openssl rand -hex 32`
4. **不要**打开 Deployment Protection，也**不要**打开 Vercel Authentication。开了之后，盒子的 `curl` 和别人打开的网页都会被挡在登录页外面。这个看板是靠 `INGEST_TOKEN` 保护「谁可以写入」，读取是公开的。
5. 部署完成后，记下生产域名。推送地址是 `https://你的域名/api/ingest`，看板地址是 `https://你的域名/`。

如果数据库是在 Upstash 自己的网站上建的，而不是 Marketplace，把控制台里的 REST 地址和令牌填成：

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

两套名字都认。同时存在时，用 `KV_` 那一对。

`.env.example` 里有同样的名字，里面没有真值。

## 盒子上怎么推

先照下面的「装到盒子上」把目录放好，并让心跳能写出 `data/board-data.json`。然后：

```bash
install -d -m 700 ~/.secrets
umask 077
printf '%s' '这里换成和 Vercel 里一样的 INGEST_TOKEN' > ~/.secrets/minion_ingest_token
chmod 600 ~/.secrets/minion_ingest_token

export MINION_INGEST_URL='https://你的域名/api/ingest'
# 令牌默认读 ~/.secrets/minion_ingest_token
# 也可以改用 MINION_INGEST_TOKEN，或 MINION_INGEST_TOKEN_FILE=/别的/路径

nohup /home/box/shared/helpers/minion-board/scripts/heartbeat.sh \
  >>/home/box/shared/helpers/minion-board/data/heartbeat.log 2>&1 &
```

`MINION_INGEST_URL` 要出现在心跳进程的环境里。没设这个变量时，心跳只构建、不推送，和以前一样。

想立刻推一次，而不是等心跳：

```bash
MINION_INGEST_URL='https://你的域名/api/ingest' \
  bash scripts/push_vercel.sh
```

脚本失败时退出码不是 0，并在标准错误打一行，例如 `推送失败：HTTP 401`。它不会把令牌打出来。成功过的内容哈希记在 `data/push-vercel.sha256`，60 秒间隔记在 `data/push-vercel.stamp`。这两个文件在 `data/` 里，不会进 git。

## 装到盒子上

假设三个旧文件还在原来的位置：

- `/home/box/shared/helpers/route-log.tsv`
- `/home/box/shared/helpers/codex-status.json`
- `/home/box/shared/helpers/model-catalog.json`

把这个目录放到：

```text
/home/box/shared/helpers/minion-board/
```

事件流放在旁边，按月份一个文件：

```text
/home/box/shared/helpers/minion-events/2026-11.jsonl
```

这三个路径都能改。构建时用参数，写事件时用环境变量：

```bash
python3 scripts/build_snapshot.py \
  --events-dir /home/box/shared/helpers/minion-events \
  --route-log /home/box/shared/helpers/route-log.tsv \
  --codex-status /home/box/shared/helpers/codex-status.json \
  --catalog /home/box/shared/helpers/model-catalog.json \
  --out-dir /home/box/shared/helpers/minion-board/data
```

对应的环境变量是 `MINION_EVENTS_DIR`、`MINION_ROUTE_LOG`、`MINION_CODEX_STATUS`、`MINION_CATALOG`、`MINION_OUT_DIR`。

`data/`、`reference/`、`*.jsonl` 都在 `.gitignore` 里。真路由、真事件、真状态不要提交。

在盒子上用浏览器打开：

```text
file:///home/box/shared/helpers/minion-board/index.html
```

## 启动心跳

盒子上没有 cron。心跳自己每 30 秒构建一次，这样「可能过期」和「可能卡住」才有依据。同一时间只能有一份在跑，再开一份会直接退出。

```bash
nohup /home/box/shared/helpers/minion-board/scripts/heartbeat.sh \
  >>/home/box/shared/helpers/minion-board/data/heartbeat.log 2>&1 &
```

停掉它：读 `data/heartbeat.pid`，然后 `kill` 那个进程。

没有心跳时，看板只在有人写事件时更新。顶栏会写成「只在有新事件时更新」，这时不按时间判断过期。

`scripts/build_board.py` 是 `build_snapshot.py` 的别名。页面上的报错文案用的是这个名字。

## 发起 bot 怎么记一笔活

不要手写 JSON。用 `minion_run` 把原来的命令包起来。它会先追加一条 start，再执行你的命令，退出后一定再追加一条 end。标准输出、标准错误和退出码都原样交还给调用方。Ctrl-C 或 SIGTERM 也会写 end。

```bash
/home/box/shared/helpers/minion-board/scripts/minion_run \
  --helper codex \
  --bot t06 \
  --task "【假】数三只橡皮鸭" \
  --route-id rt-20261103084205-t06-7c \
  -- \
  codex --model gpt-6.1-sol /tmp/job.txt
```

`--helper` 只能是 `codex`、`hermes`、`pi`。`--task` 写一句人话，不要写路径、密钥或提示词原文，最长 40 个字。

结束状态只有三种：`success`、`failed`、`degraded`。不写 `ok`。Codex 的输出里如果出现 usage limit、try again 这类额度提示，或者 at capacity，会额外写一条 `quota` 事件。

只想补一条事件、不跑命令时，用 `scripts/minion_event.py`：

```bash
python3 scripts/minion_event.py start --minion pi --bot t06 --title "【假】数五颗玻璃弹珠"
python3 scripts/minion_event.py end --task-id tsk-... --minion pi --status success --exit-code 0
python3 scripts/minion_event.py quota --state quota_exhausted --bot t06 --raw "usage limit"
```

写事件时用文件锁，只追加，不改旧行。

## 路由脚本的补丁

`patches/jev_choice_route.py` 是补丁后的完整文件，用来替换盒子上的 `jev_choice_route.py`。原来的参数和原来的 JSON 字段都还在，另外做了三件事：

1. 每次路由生成 `route_id`，打印在 JSON 里，也写进 route-log 的 notes，形如 `route_id=rt-...`。发起 bot 把它原样填进 `minion_run --route-id`。
2. `--amend-why` 只改这个 bot 最近一条 `why=MISSING` 的行。找不到就报错退出，不会悄悄改别的行。
3. `--record-codex-error` 在覆盖 `codex-status.json` 的同时，往事件流追加一条 quota 事件。

替换前先把原文件留一份副本。补丁通过旁边的 `minion-board/scripts/minion_lib.py` 写事件，所以看板要先装好。事件目录可以用 `MINION_EVENTS_DIR` 改。

## 看测试数据

在地址后面加 `?fixture=名称`。这些数据是页面自带的假任务，不读盒子上的事件文件。

| 名称 | 用来看什么 |
|---|---|
| `empty` | 一条事件都没有 |
| `live` | 三个手下都在跑，pi 同时跑 3 个 |
| `mixed` | 近 7 天很多条，含完成、失败、降级、没收到结束 |
| `quota` | Codex 额度用完，大约 2 小时后恢复 |
| `quota-unknown` | 额度用完，但不知道什么时候恢复 |
| `stuck` | pi 已经跑了 25 分钟 |
| `stale` | 快照比现在早 20 分钟 |
| `onwrite` | 没有心跳，只在写事件时更新 |
| `broken` | 数据版本不对 |
| `missing` | 根本没有数据 |
| `dirty` | 坏行、重复、冲突 |
| `avatars=1` | 3 个角色 × 5 种表情 |

例如：`index.html?fixture=live`。筛选条件写在 `#` 后面，刷新还在。

本机想连着接口看公开页面的行为（数据在内存里，关掉就没了）：

```bash
INGEST_TOKEN=dev node tests/dev-server.js
```

然后打开 `http://127.0.0.1:4173/`。

## 自己再跑一遍检查

不需要真数据，也不需要 Chrome：

```bash
npm test
```

它会跑这三件：

```bash
python3 tests/test_acceptance.py
node --test tests/test_api.js
python3 tests/test_push.py
```

`test_acceptance.py` 里对照真实 `reference/` 路由条数的检查，在仓库没有这份目录时会跳过。其余检查用临时造出来的假日志。

要看页面长什么样，本机需要 Google Chrome：

```bash
python3 tests/shot_board.py
python3 tests/test_hosted_page.py
```

截图会写到 `/tmp/minion-shots/`。`shot_board.py` 里依赖 `reference/` 的几条，没有那份真数据时也会跳过。
