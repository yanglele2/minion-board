/* 手下看板。
 * 盒子上用 file:// 或夹具时，读 window.__MINION_BOARD__。
 * 公开页面改向 /api/board 要同一份数据，大约每 20 秒看一次。
 */
(function () {
  var HOUR = 60 * 60 * 1000;
  var NAMES = { codex: "Codex", hermes: "Hermes", pi: "pi" };
  var ORDER = ["codex", "hermes", "pi"];
  var FAIL = {
    quota: "额度用完",
    capacity: "太忙（容量满）",
    timeout: "超时",
    error: "出错",
    cancelled: "被取消",
    unknown: "原因未知",
  };
  var STATE = {
    filters: { minion: "all", statuses: [], range: "7d", smoke: false },
    expanded: new Set(),
    extra: {},
    quotaOpen: false,
    legacyOpen: false,
    notesOpen: false,
    visible: 50,
    dismissed: new Set(),
    data: null,
    seeded: false,
    known: null,
    seenEnds: [],
    seenFails: [],
    seenDegs: [],
    memoryOnly: false,
    pollFails: 0,
    pollTimer: 0,
    mode: "file",
    loading: false,
    remoteEmpty: false,
    storeDown: false,
    didScroll: false,
    sig: "",
    celebQ: [],
    celebPlaying: false,
    justDone: new Set(),
    freshDeg: new Set(),
    shake: new Set(),
    ann: [],
    annTimer: 0,
    annStart: 0,
    seenStale: null,
    quotaState: undefined,
    booted: false,
  };

  function q() {
    return new URLSearchParams(location.search);
  }

  function nowMs() {
    var frozen = q().get("now");
    if (frozen) return Date.parse(frozen);
    var off = Number(q().get("offsetMs") || "0");
    return Date.now() + (Number.isFinite(off) ? off : 0);
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function bj(ms) {
    var d = new Date(ms + 8 * HOUR);
    return {
      y: d.getUTCFullYear(),
      m: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      min: d.getUTCMinutes(),
      s: d.getUTCSeconds(),
    };
  }

  function hm(ms) {
    var p = bj(ms);
    return pad(p.h) + ":" + pad(p.min);
  }

  function hms(ms) {
    var p = bj(ms);
    return pad(p.h) + ":" + pad(p.min) + ":" + pad(p.s);
  }

  function md(ms) {
    var p = bj(ms);
    return p.m + "月" + p.d + "日";
  }

  function fullStamp(ms) {
    var p = bj(ms);
    return p.y + "-" + pad(p.m) + "-" + pad(p.d) + " " + pad(p.h) + ":" + pad(p.min) + ":" + pad(p.s) + "（北京时间）";
  }

  function dayStart(ms) {
    var p = bj(ms);
    return Date.parse(p.y + "-" + pad(p.m) + "-" + pad(p.d) + "T00:00:00+08:00");
  }

  function formatDuration(ms) {
    if (ms == null || !isFinite(ms) || ms < 0) return "—";
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + " 秒";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " 分 " + pad(s % 60) + " 秒";
    var h = Math.floor(m / 60);
    return h + " 小时 " + pad(m % 60) + " 分";
  }

  function formatRemain(ms) {
    if (ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var h = Math.floor(m / 60);
    if (h >= 1) return h + " 小时 " + (m % 60) + " 分";
    if (m >= 10) return m + " 分";
    return m + " 分 " + pad(total % 60) + " 秒";
  }

  function spokenRun(ms) {
    if (ms == null || ms < 0) return "";
    var m = Math.floor(ms / 60000);
    if (m < 1) return "已运行不到 1 分钟";
    if (m < 60) return "已运行 " + m + " 分钟";
    return "已运行 " + Math.floor(m / 60) + " 小时 " + (m % 60) + " 分钟";
  }

  function narrow() {
    return window.matchMedia("(max-width: 767px)").matches;
  }

  function slots() {
    return narrow() ? 1 : 2;
  }

  function reduceMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function freezeMs() {
    if (!STATE.data || staleInfo(STATE.data, nowMs()).level !== "red") return 0;
    return Date.parse(STATE.data.built_at) || 0;
  }

  function clockNow() {
    var now = nowMs();
    var freeze = freezeMs();
    if (freeze && freeze < now) return freeze;
    return now;
  }

  function staleFromBuilt(data, now) {
    if (!data || data.refresh_mode !== "watch") return { level: "off", mins: 0 };
    var built = Date.parse(data.built_at);
    if (!isFinite(built)) return { level: "off", mins: 0 };
    if (built - now >= 2 * 60 * 1000) {
      return { level: "skew", mins: Math.round((built - now) / 60000) };
    }
    var age = now - built;
    var mins = Math.max(1, Math.round(age / 60000));
    if (age <= 90 * 1000) return { level: "fresh", mins: 0 };
    if (age <= 10 * 60 * 1000) return { level: "yellow", mins: mins };
    return { level: "red", mins: mins };
  }

  function staleInfo(data, now) {
    var base = staleFromBuilt(data, now);
    if (!data || !data.pushed_at) return base;
    var pushed = Date.parse(data.pushed_at);
    if (!isFinite(pushed)) return base;
    var age = now - pushed;
    if (age > 10 * 60 * 1000 && base.level !== "red" && base.level !== "skew") {
      return { level: "red", mins: Math.max(1, Math.round(age / 60000)) };
    }
    return base;
  }

  function phaseOf(task, now) {
    var end = task.ended_at ? Date.parse(task.ended_at) : NaN;
    var start = task.started_at ? Date.parse(task.started_at) : NaN;
    if (isFinite(end)) {
      var bad = isFinite(start) && end < start;
      return {
        phase: task.status,
        stuck: false,
        noEnd: false,
        elapsed: bad || !isFinite(start) ? null : end - start,
        recent: now - end <= 10 * 60 * 1000 && now >= end,
      };
    }
    if (!isFinite(start)) {
      return { phase: "running", stuck: false, noEnd: false, elapsed: null, recent: false };
    }
    var elapsed = now - start;
    if (elapsed >= 6 * HOUR) {
      return { phase: "no_end", stuck: false, noEnd: true, elapsed: elapsed, recent: false };
    }
    var threshold = (task.threshold_s || 20 * 60) * 1000;
    return {
      phase: "running",
      stuck: elapsed >= threshold,
      noEnd: false,
      elapsed: elapsed,
      recent: false,
    };
  }

  function shown(task) {
    return STATE.filters.smoke || !task.smoke;
  }

  function tasks() {
    return (STATE.data && STATE.data.tasks) || [];
  }

  function findTask(id) {
    return tasks().filter(function (t) { return t.task_id === id; })[0] || null;
  }

  function visibleTasks() {
    return tasks().filter(shown);
  }

  function byEndDesc(a, b) {
    return Date.parse(b.task.ended_at || 0) - Date.parse(a.task.ended_at || 0);
  }

  function countToday(list, now) {
    var start = dayStart(now);
    var counts = { success: 0, failed: 0, degraded: 0 };
    list.forEach(function (task) {
      if (!shown(task) || !task.ended_at) return;
      var end = Date.parse(task.ended_at);
      if (end < start || end > now + 5 * 60 * 1000) return;
      if (counts[task.status] != null) counts[task.status] += 1;
    });
    return counts;
  }

  function median7(list, now) {
    var cutoff = now - 7 * 24 * HOUR;
    var values = [];
    list.forEach(function (task) {
      if (!shown(task) || task.status !== "success") return;
      var start = Date.parse(task.started_at || "");
      var end = Date.parse(task.ended_at || "");
      if (!isFinite(start) || !isFinite(end) || end < start || end < cutoff) return;
      values.push(end - start);
    });
    if (values.length < 5) return null;
    values.sort(function (a, b) { return a - b; });
    var mid = Math.floor(values.length / 2);
    if (values.length % 2) return values[mid];
    return Math.floor((values[mid - 1] + values[mid]) / 2);
  }

  function longestToday(now) {
    var start = dayStart(now);
    var best = null;
    visibleTasks().forEach(function (task) {
      var begin = Date.parse(task.started_at || "");
      var end = Date.parse(task.ended_at || "");
      if (!isFinite(begin) || !isFinite(end) || end < begin || end < start) return;
      var dur = end - begin;
      if (!best || dur > best.dur) best = { title: task.title, dur: dur, minion: task.minion };
    });
    return best;
  }

  function quotaOf(now) {
    var cur = STATE.data && STATE.data.codex_quota && STATE.data.codex_quota.current;
    if (!cur || !cur.state) {
      return { known: false, resting: false, label: "额度状态未知", state: null };
    }
    if (cur.state === "ok") {
      var unknown = cur.time_unknown && cur.source === "codex_status";
      return {
        known: true,
        resting: false,
        state: "ok",
        label: unknown ? "额度正常（未记录检查时间）" : "额度正常",
      };
    }
    if (cur.state === "capacity") {
      return {
        known: true,
        resting: false,
        capacity: true,
        state: "capacity",
        label: "Codex 正忙（容量满），稍后再试",
      };
    }
    var reset = cur.reset_at ? Date.parse(cur.reset_at) : NaN;
    if (!isFinite(reset)) {
      return {
        known: true,
        resting: true,
        unknownReset: true,
        state: "quota_exhausted",
        sentence: "额度用完，恢复时间未知",
        label: "额度用完，恢复时间未知",
      };
    }
    if (now >= reset) {
      return {
        known: true,
        resting: true,
        past: true,
        state: "quota_exhausted",
        reset: reset,
        sentence: "按时间应该恢复了，等下一次调用确认",
        label: "按时间应该恢复了，等下一次调用确认",
      };
    }
    var remain = reset - now;
    return {
      known: true,
      resting: true,
      state: "quota_exhausted",
      reset: reset,
      remain: remain,
      started: cur.updated_at ? Date.parse(cur.updated_at) : NaN,
      sentence: "额度用完，在休息",
      label: hm(reset) + " 恢复（北京时间）· 还剩 " + formatRemain(remain),
    };
  }

  function viewOf(id, now) {
    var own = tasks().filter(function (t) { return t.minion === id && shown(t); });
    var derived = own.map(function (task) {
      return { task: task, info: phaseOf(task, now) };
    });
    var running = derived.filter(function (d) { return d.info.phase === "running"; });
    running.sort(function (a, b) {
      if (a.info.stuck !== b.info.stuck) return a.info.stuck ? -1 : 1;
      return Date.parse(a.task.started_at || 0) - Date.parse(b.task.started_at || 0);
    });
    var fails = derived.filter(function (d) { return d.info.phase === "failed" && d.info.recent; }).sort(byEndDesc);
    var oks = derived.filter(function (d) { return d.info.phase === "success" && d.info.recent; }).sort(byEndDesc);
    var ever = tasks().some(function (t) { return t.minion === id && !t.smoke; });
    var quota = id === "codex" ? quotaOf(now) : null;
    var expr = "idle";
    var sentence = ever ? "空闲中，等活来" : "还没接过活";
    var stuck = running.filter(function (d) { return d.info.stuck; });
    var live = null;
    if (quota && quota.resting) {
      expr = "rest";
      sentence = quota.sentence;
    } else if (stuck.length) {
      expr = "working";
      var longest = stuck.slice().sort(function (a, b) { return b.info.elapsed - a.info.elapsed; })[0];
      sentence = "已经跑了 " + formatDuration(longest.info.elapsed) + "，比平时久";
      live = { start: Date.parse(longest.task.started_at), prefix: "已经跑了 ", suffix: "，比平时久" };
    } else if (running.length === 1) {
      expr = "working";
      sentence = "正在干活 · " + formatDuration(running[0].info.elapsed);
      live = { start: Date.parse(running[0].task.started_at), prefix: "正在干活 · ", suffix: "" };
    } else if (running.length > 1) {
      expr = "working";
      sentence = "同时在干 " + running.length + " 件事";
    } else if (fails.length) {
      expr = "fail";
      sentence = "刚才失败了：" + fails[0].task.title;
    } else if (oks.length) {
      expr = "success";
      sentence = "刚做完：" + oks[0].task.title;
    }
    if (staleInfo(STATE.data, now).level === "red") sentence += "（可能过期）";
    return {
      id: id,
      name: NAMES[id],
      expr: expr,
      sentence: sentence,
      running: running,
      fails: fails,
      oks: oks,
      today: countToday(tasks().filter(function (t) { return t.minion === id; }), now),
      median: median7(tasks().filter(function (t) { return t.minion === id; }), now),
      quota: quota,
      ever: ever,
      live: live,
    };
  }

  function views(now) {
    return ORDER.map(function (id) { return viewOf(id, now); });
  }

  function problemCount() {
    var h = (STATE.data && STATE.data.health) || {};
    return ["bad_lines", "dup_events", "conflicts", "clock_skew", "legacy_rows", "unmatched_routes"].reduce(function (sum, key) {
      return sum + (Number(h[key]) || 0);
    }, 0);
  }

  function healthView(now) {
    var stale = staleInfo(STATE.data, now);
    var n = problemCount();
    if (stale.level === "red") return { text: "过期", tone: "bad" };
    if (stale.level === "yellow") return { text: "可能过期 · " + stale.mins + " 分钟没更新", tone: "warn" };
    if (n > 0) return { text: "有 " + n + " 条坏数据", tone: "warn" };
    if (STATE.data.refresh_mode === "on_write") return { text: "只在有新事件时更新", tone: "rest" };
    return { text: "正常", tone: "ok" };
  }

  function pushedBit(now) {
    if (!STATE.data || !STATE.data.pushed_at) return "";
    var pushed = Date.parse(STATE.data.pushed_at);
    if (!isFinite(pushed)) return "";
    var age = Math.max(0, now - pushed);
    if (age < 60000) return " · 推送于 " + hms(pushed);
    return " · 推送是 " + Math.max(1, Math.round(age / 60000)) + " 分钟前";
  }

  function topText(now) {
    var built = Date.parse(STATE.data.built_at);
    var extra = pushedBit(now);
    if (STATE.data.refresh_mode === "on_write") {
      return "只在有新事件时更新 · 上次 " + hm(built) + extra;
    }
    if (narrow()) {
      var age = Math.max(0, now - built);
      var head = age < 60000 ? Math.max(1, Math.round(age / 1000)) + " 秒前更新" : Math.max(1, Math.round(age / 60000)) + " 分钟前更新";
      return head + extra;
    }
    var every = STATE.mode === "api" ? "约每 20 秒更新" : "约每 15 秒更新";
    return every + " · 上次 " + hms(built) + "（北京时间）" + extra;
  }

  function dismissKey(item) {
    return item.id + "|" + item.level;
  }

  function bannerList(now, cardViews) {
    var list = [];
    if (STATE.pollFails > 0) {
      var red = STATE.pollFails >= 4;
      list.push({
        pri: 1,
        id: "poll",
        level: red ? "bad" : "warn",
        dismiss: false,
        text: "这次没读到新数据，继续显示上一次的（" + hms(Date.parse(STATE.data.built_at)) + "，北京时间）",
      });
    }
    var stale = staleInfo(STATE.data, now);
    if (stale.level === "red") {
      var builtStale = staleFromBuilt(STATE.data, now).level === "red";
      list.push({
        pri: 2,
        id: "stale-red",
        level: "bad",
        dismiss: false,
        text: builtStale
          ? "看板已经 " + stale.mins + " 分钟没更新，下面的「正在干活」可能早就结束了。请检查 build_board.py 是否还在跑。"
          : "盒子已经 " + stale.mins + " 分钟没把新数据推上来，下面的「正在干活」可能早就结束了。请检查推送是否还在跑。",
      });
    }
    cardViews.forEach(function (view) {
      view.fails.forEach(function (item) {
        list.push({
          pri: 3,
          id: "fail-" + item.task.task_id,
          level: "bad",
          dismiss: true,
          task: item.task.task_id,
          text: view.name + " 有 1 个任务失败了",
        });
      });
      view.running.forEach(function (item) {
        if (!item.info.stuck) return;
        list.push({
          pri: 4,
          id: "stuck-" + item.task.task_id,
          level: "warn",
          dismiss: true,
          task: item.task.task_id,
          text: view.name + " 的「" + item.task.title + "」已经跑了 " + formatDuration(item.info.elapsed) + "，可能卡住了。",
        stuckStart: Date.parse(item.task.started_at),
        stuckName: view.name,
        stuckTitle: item.task.title,
        });
      });
    });
    var quota = quotaOf(now);
    if (quota.resting && !quota.past) {
      var when = quota.reset ? md(quota.reset) + " " + hm(quota.reset) : "";
      list.push({
        pri: 5,
        id: "quota",
        level: "rest",
        dismiss: true,
        text: quota.unknownReset
          ? "Codex 额度用完，恢复时间未知。这段时间的活会转给 pi / Hermes / Grok Bot。"
          : "Codex 额度用完，预计 " + when + "（北京时间）恢复。这段时间的活会转给 pi / Hermes / Grok Bot。",
      });
    }
    if (stale.level === "yellow") {
      list.push({
        pri: 6,
        id: "stale-yellow",
        level: "warn",
        dismiss: true,
        text: "看板 " + stale.mins + " 分钟没更新了。可能是后台构建停了，数据仅供参考。",
      });
    }
    list.sort(function (a, b) { return a.pri - b.pri || String(a.id).localeCompare(String(b.id)); });
    return list.filter(function (item) {
      return !item.dismiss || !STATE.dismissed.has(dismissKey(item));
    });
  }

  function gear() {
    return '<svg class="gear-icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 1 V4 M8 12 V15 M1 8 H4 M12 8 H15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="dots">…</span>';
  }

  function pill(kind, text, extra) {
    var mark = kind === "run" ? gear() : '<span aria-hidden="true">' + ({ ok: "✓", bad: "✕", warn: "?", down: "↪", rest: "zZ", idle: "·" }[kind] || "") + "</span>";
    return '<span class="pill ' + kind + (extra || "") + '">' + mark + esc(text) + "</span>";
  }

  function statusPill(task, info) {
    if (info.noEnd) return pill("rest", "没收到结束记录");
    if (info.stuck) return pill("warn", "可能卡住");
    if (info.phase === "running") return pill("run", "运行中");
    if (info.phase === "success") return pill("ok", "完成");
    if (info.phase === "failed") return pill("bad", "失败");
    if (info.phase === "degraded") return pill("down", degradedLabel(task.degraded_to), STATE.freshDeg.has(task.task_id) ? " slide-in" : "");
    return pill("rest", "未知");
  }

  function degradedLabel(to) {
    if (to === "grok_only") return "转给 Grok Bot 自己做";
    if (to === "higgsfield") return "转给 Higgsfield";
    if (to === "ask_human") return "转给老板";
    if (NAMES[to]) return "转给 " + NAMES[to];
    return "转给别人";
  }

  function whoName(to) {
    if (to === "grok_only") return "Grok Bot";
    if (to === "higgsfield") return "Higgsfield";
    if (to === "ask_human") return "老板";
    return NAMES[to] || to || "别人";
  }

  function failReason(task) {
    if (task.fail_text) return task.fail_text;
    return FAIL[task.fail_kind] || "原因未知";
  }

  function parentName(task) {
    if (!task.parent_task_id) return "";
    var parent = findTask(task.parent_task_id);
    return parent ? NAMES[parent.minion] || parent.minion : "上一手";
  }

  function mismatchHTML(route) {
    if (!route || !route.mismatch) return "";
    var tip = "Jev 建议 " + (route.choice_label || route.choice_id) + "，实际 " + (route.actual_label || route.actual);
    return '<span class="pill warn" title="' + esc(tip) + '"><span aria-hidden="true">↔</span>建议≠实际</span>';
  }

  function avatar(minion, expr, size, stuck) {
    if (!window.MinionAvatar) return "";
    return window.MinionAvatar.html(minion, expr, size, stuck);
  }

  function avatarSize() {
    if (window.matchMedia("(min-width: 1440px)").matches) return 112;
    if (window.matchMedia("(max-width: 767px)").matches) return 56;
    if (window.matchMedia("(max-width: 1279px)").matches) return 72;
    return 96;
  }

  function inRange(task, range, now) {
    var stamp = Date.parse(task.started_at || task.ended_at || "");
    if (!isFinite(stamp)) return false;
    if (range === "today") return stamp >= dayStart(now);
    if (range === "24h") return now - stamp <= 24 * HOUR;
    if (range === "30d") return now - stamp <= 30 * 24 * HOUR;
    return now - stamp <= 7 * 24 * HOUR;
  }

  function statusOn(info, selected) {
    if (!selected.length) return true;
    return selected.some(function (name) {
      if (name === "running") return info.phase === "running";
      if (name === "stuck") return info.stuck;
      if (name === "success") return info.phase === "success";
      if (name === "failed") return info.phase === "failed";
      if (name === "degraded") return info.phase === "degraded";
      return false;
    });
  }

  function historyRows(now) {
    var rows = visibleTasks().filter(function (task) {
      if (STATE.filters.minion !== "all" && task.minion !== STATE.filters.minion) return false;
      var info = phaseOf(task, now);
      if (!statusOn(info, STATE.filters.statuses)) return false;
      return inRange(task, STATE.filters.range, now);
    }).map(function (task) {
      return { task: task, info: phaseOf(task, now) };
    });
    var running = rows.filter(function (row) { return row.info.phase === "running"; });
    var rest = rows.filter(function (row) { return row.info.phase !== "running"; });
    running.sort(function (a, b) {
      if (a.info.stuck !== b.info.stuck) return a.info.stuck ? -1 : 1;
      return Date.parse(a.task.started_at || 0) - Date.parse(b.task.started_at || 0);
    });
    rest.sort(function (a, b) {
      var as = Date.parse(a.task.started_at || a.task.ended_at || 0);
      var bs = Date.parse(b.task.started_at || b.task.ended_at || 0);
      return bs - as;
    });
    return running.concat(rest);
  }

  function groupTitle(ms, now) {
    var start = dayStart(now);
    if (ms >= start) return "今天 · " + md(ms) + "（北京时间）";
    if (ms >= start - 24 * HOUR) return "昨天 · " + md(ms);
    return md(ms);
  }

  function timeRangeText(task, info, now) {
    var start = task.started_at ? Date.parse(task.started_at) : NaN;
    var end = task.ended_at ? Date.parse(task.ended_at) : NaN;
    if (!isFinite(start)) return "时间不详";
    var today = dayStart(now);
    var sameDay = isFinite(start) && start >= today;
    if (info.phase === "running" || info.noEnd) {
      return (sameDay ? hm(start) : md(start) + " " + hm(start)) + " 起";
    }
    if (!isFinite(end)) return hm(start);
    if (start >= today && end >= today) return hm(start) + "–" + hm(end);
    return md(start) + " " + hm(start) + "–" + hm(end);
  }

  function newClass(id) {
    if (!STATE.known) return "";
    if (STATE.known.has(id)) return "";
    STATE.known.add(id);
    return " is-new";
  }

  function routeOf(task) {
    return task.route_match && task.route_match.route;
  }

  function chain(task) {
    var guard = 0;
    var root = task;
    while (root.parent_task_id && findTask(root.parent_task_id) && guard < 8) {
      root = findTask(root.parent_task_id);
      guard += 1;
    }
    var seq = [root];
    var cur = root;
    guard = 0;
    while (guard < 8) {
      var kids = tasks().filter(function (item) { return item.parent_task_id === cur.task_id; });
      if (!kids.length) break;
      var pick = kids[0];
      if (cur.degraded_to) {
        var hit = kids.filter(function (item) { return item.minion === cur.degraded_to; })[0];
        if (hit) pick = hit;
      }
      seq.push(pick);
      cur = pick;
      guard += 1;
    }
    return seq.length > 1 ? seq : [];
  }

  function chainBit(task) {
    var info = phaseOf(task, nowMs());
    var name = NAMES[task.minion] || task.minion;
    var inner = "运行中";
    if (task.status === "degraded") inner = FAIL[task.fail_kind] || "转出";
    else if (task.status === "success") inner = "完成";
    else if (task.status === "failed") inner = "失败";
    else if (info.noEnd) inner = "没收到结束记录";
    else if (info.stuck) inner = "可能卡住";
    return name + "（" + inner + "）";
  }

  function detailHTML(task, info) {
    var route = routeOf(task);
    var match = task.route_match || { kind: "none", note: "没找到对应路由" };
    var bits = [];
    bits.push("<p><strong>" + esc(task.title) + "</strong></p>");
    bits.push("<p>" + esc(NAMES[task.minion] || "") + (task.model ? " · " + esc(task.model) : "") + (task.host ? " · " + esc(task.host === "box" ? "盒子" : task.host === "server" ? "服务器" : task.host) : "") + "</p>");
    if (task.started_at) bits.push("<p>开始 " + esc(fullStamp(Date.parse(task.started_at))) + "</p>");
    if (task.ended_at) bits.push("<p>结束 " + esc(fullStamp(Date.parse(task.ended_at))) + "</p>");
    if (info.phase === "failed" || info.phase === "degraded") {
      bits.push("<p>原因：" + esc(FAIL[task.fail_kind] || "原因未知") + (task.fail_text ? "。" + esc(task.fail_text) : "") + "</p>");
    }
    if (info.noEnd) {
      bits.push("<p>开始超过 6 小时还没有结束记录，可能是发起 bot 忘了记，或者手下中途挂了。</p>");
    }
    if (task.end_count > 1) bits.push("<p>有 " + task.end_count + " 条结束记录</p>");
    var links = chain(task);
    if (links.length) {
      bits.push('<div class="chain">' + links.map(function (item, index) {
        var html = '<button type="button" data-act="jump" data-task="' + esc(item.task_id) + '">' + esc(chainBit(item)) + "</button>";
        return index ? "<span aria-hidden=\"true\">→</span>" + html : html;
      }).join("") + "</div>");
    }
    if (route) {
      var conf = route.confidence == null ? "" : "（置信 " + esc(String(route.confidence)) + "）";
      bits.push("<p>Jev 建议 " + esc(route.choice_label || route.choice_id) + conf + " → 实际 " + esc(route.actual_label || route.actual || "还没记下") + "</p>");
      if (route.why_missing) bits.push('<p class="pill warn">没写理由</p>');
      else if (route.why) bits.push("<p>" + esc(route.why) + "</p>");
    }
    if (match.kind === "guess") {
      bits.push('<div class="guess-box">按时间推测对应这条路由，不一定准</div>');
    } else if (match.kind === "ambiguous") {
      bits.push("<p>" + esc(match.note) + "</p>");
    } else if (match.kind === "none") {
      bits.push("<p>没找到对应路由</p>");
    }
    bits.push('<p class="mono">task_id ' + esc(task.task_id) + "</p>");
    if (task.start_event_id) bits.push('<p class="mono">start ' + esc(task.start_event_id) + "</p>");
    if (task.end_event_id) bits.push('<p class="mono">end ' + esc(task.end_event_id) + "</p>");
    return bits.join("");
  }

  function rowHTML(row, now) {
    var task = row.task;
    var info = row.info;
    var open = STATE.expanded.has(task.task_id);
    var route = routeOf(task);
    var from = parentName(task);
    var reason = info.phase === "failed" ? "失败 · " + failReason(task) : "";
    var elapsedAttr = info.phase === "running" && isFinite(Date.parse(task.started_at || ""))
      ? ' data-live-elapsed="' + Date.parse(task.started_at) + '" data-freeze="' + (freezeMs() ? "1" : "0") + '"'
      : "";
    return (
      '<article class="hist' + newClass(task.task_id) + '" data-key="' + esc(task.task_id) + '">' +
      '<button type="button" class="hist-btn" id="hist-' + esc(task.task_id) + '" data-act="toggle" data-task="' + esc(task.task_id) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
      '<span class="hist-grid">' +
      avatar(task.minion, info.stuck ? "working" : info.noEnd ? "idle" : info.phase === "running" ? "working" : info.phase === "success" ? "success" : info.phase === "failed" ? "fail" : "idle", 32, info.stuck) +
      '<span class="hist-title task-title" title="' + esc(task.title) + '">' + esc(task.title) + "</span>" +
      '<span class="hist-sub task-meta"><span class="bot-tag">' + esc(task.bot || "—") + "</span>" +
      "<span>" + esc(timeRangeText(task, info, now)) + "</span>" +
      '<span class="hist-dur"' + elapsedAttr + ">" + esc(info.elapsed == null ? "—" : formatDuration(info.elapsed)) + "</span>" +
      '<span class="sr-only">' + esc(spokenRun(info.elapsed)) + "</span></span>" +
      '<span class="hist-status">' + statusPill(task, info) + "</span>" +
      "<span>" + mismatchHTML(route) +
      (route && task.route_match && task.route_match.kind === "guess" ? '<span class="pill warn">按时间推测</span>' : "") +
      (from ? '<span class="pill down">从 ' + esc(from) + " 转来</span>" : "") +
      (STATE.justDone.has(task.task_id) ? '<span class="pill ok">刚完成</span>' : "") +
      (reason ? '<span class="muted">' + esc(reason) + "</span>" : "") +
      "</span></span></button>" +
      '<div class="hist-detail"' + (open ? "" : " hidden") + ">" + (open ? detailHTML(task, info) : "") + "</div></article>"
    );
  }

  function historyHTML(now) {
    var all = historyRows(now);
    var total = all.length;
    var rows = all.slice(0, STATE.visible);
    if (!visibleTasks().length) {
      return (
        '<div class="empty-hero"><div class="empty-faces">' +
        ORDER.map(function (id) { return avatar(id, "idle", 72, false); }).join("") +
        "</div><h2>还没有起止记录</h2><p>手下接活时，发起 bot 会写一条开始记录，这里就会出现。</p></div>"
      );
    }
    if (!total) {
      return '<div class="empty-hero"><h2>这个条件下没有任务</h2><p><button type="button" class="btn" data-act="clear">清除筛选</button></p></div>';
    }
    var html = "";
    var lastGroup = "";
    var seenRunningHead = false;
    rows.forEach(function (row) {
      if (row.info.phase === "running") {
        if (!seenRunningHead) {
          html += '<h3 class="day-label">正在跑（北京时间）</h3>';
          seenRunningHead = true;
        }
      } else {
        var stamp = Date.parse(row.task.started_at || row.task.ended_at || "");
        var title = groupTitle(stamp, now);
        if (title !== lastGroup) {
          html += '<h3 class="day-label">' + esc(title) + "</h3>";
          lastGroup = title;
        }
      }
      html += rowHTML(row, now);
    });
    if (total > rows.length) {
      html += '<p><button type="button" class="btn" id="more-btn" data-act="more">再显示 50 条</button></p>';
    }
    return html;
  }

  function taskRow(item) {
    var task = item.task;
    var info = item.info;
    var from = parentName(task);
    return (
      '<button type="button" class="task-row' + newClass(task.task_id) + '" id="task-' + esc(task.task_id) + '" data-act="jump" data-task="' + esc(task.task_id) + '">' +
      '<span class="task-title" title="' + esc(task.title) + '">' + esc(task.title) + "</span>" +
      '<span class="task-meta"><span class="bot-tag">' + esc(task.bot || "—") + "</span>" +
      '<span data-live-elapsed="' + Date.parse(task.started_at || "") + '" data-freeze="' + (freezeMs() ? "1" : "0") + '">' + esc(formatDuration(info.elapsed)) + "</span>" +
      '<span class="sr-only">' + esc(spokenRun(info.elapsed)) + "</span>" +
      (from ? "<span>从 " + esc(from) + " 转来</span>" : "") +
      (info.stuck ? pill("warn", "可能卡住") : "") +
      "</span></button>"
    );
  }

  function cardHTML(view, now) {
    var size = avatarSize();
    var show = STATE.extra[view.id] ? view.running.length : Math.min(slots(), view.running.length);
    var hidden = view.running.length - show;
    var tasksHTML = view.running.slice(0, show).map(taskRow).join("");
    if (!STATE.extra[view.id] && hidden > 0) {
      tasksHTML += '<button type="button" class="more-running" data-act="extra" data-minion="' + view.id + '" data-open="1">还有 ' + hidden + " 个在跑</button>";
    } else if (STATE.extra[view.id] && view.running.length > slots()) {
      tasksHTML += '<button type="button" class="more-running" data-act="extra" data-minion="' + view.id + '" data-open="0">收起</button>';
    }
    if (!view.running.length) {
      tasksHTML = '<p class="muted">现在没有正在跑的任务</p>';
    }
    var pressed = STATE.filters.minion === view.id;
    var foot = "";
    if (view.id === "codex") foot = quotaFoot(view.quota);
    else {
      var t = view.today;
      foot = "今天 完成 " + t.success + " · 失败 " + t.failed + " · 转出 " + t.degraded;
    }
    var donePill = "";
    if (reduceMotion()) {
      var marked = view.oks.some(function (item) { return STATE.justDone.has(item.task.task_id); });
      if (marked) donePill = pill("ok", "刚完成");
    }
    return (
      '<div class="card-top"></div>' +
      '<button type="button" class="card-head" id="card-head-' + view.id + '" data-act="minion" data-value="' + view.id + '" aria-pressed="' + (pressed ? "true" : "false") + '">' +
      avatar(view.id, view.expr, size, view.expr === "working" && view.running.some(function (item) { return item.info.stuck; })) +
      "<span><span class=\"minion-name\">" + esc(view.name) + "</span>" +
      '<span class="status-line">' + statusLineHTML(view) + "</span>" +
      '<span class="card-tags">' + cardTags(view) + donePill + "</span></span></button>" +
      '<div class="card-tasks">' + tasksHTML + "</div>" +
      '<div class="card-foot">' + foot + "</div>"
    );
  }

  function statusLineHTML(view) {
    var stale = staleInfo(STATE.data, nowMs()).level === "red" ? "（可能过期）" : "";
    if (!view.live || !isFinite(view.live.start)) return esc(view.sentence);
    return (
      esc(view.live.prefix) +
      '<span data-live-elapsed="' + view.live.start + '" data-freeze="' + (freezeMs() ? "1" : "0") + '">' +
      esc(formatDuration(clockElapsed(view.live.start))) +
      "</span>" +
      esc(view.live.suffix) +
      esc(stale)
    );
  }

  function clockElapsed(start) {
    return nowMs() - start;
  }

  function cardTags(view) {
    if (view.expr === "rest") return pill("rest", "额度用完·休息");
    if (view.running.some(function (item) { return item.info.stuck; })) return pill("warn", "可能卡住");
    if (view.running.length) return pill("run", "运行中");
    if (view.expr === "fail") return pill("bad", "失败");
    if (view.expr === "success") return pill("ok", "完成");
    return pill("idle", view.ever ? "空闲" : "还没接过活");
  }

  function quotaFoot(quota) {
    if (!quota || !quota.known) return "额度状态未知";
    if (quota.state === "ok") return '<span class="quota-label quota-ok"><span class="dot ok" aria-hidden="true"></span> ' + esc(quota.label) + "</span>";
    if (quota.capacity) return '<span class="quota-label">' + esc(quota.label) + "</span>";
    var bar = "";
    if (quota.reset && quota.started && isFinite(quota.started) && quota.started < quota.reset && !quota.past && !quota.unknownReset) {
      var span = quota.reset - quota.started;
      var gone = Math.min(1, Math.max(0, (clockNow() - quota.started) / span));
      bar = '<div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(gone * 100) + '" aria-label="距离恢复已经过去的比例"><span id="quota-bar" data-start="' + quota.started + '" data-reset="' + quota.reset + '" style="width:' + Math.round(gone * 100) + '%"></span></div>';
    }
    var live = quota.remain != null ? ' data-reset="' + quota.reset + '"' : "";
    return '<div class="quota-label"' + live + ">" + esc(quota.label) + "</div>" + bar + quotaHistory();
  }

  function quotaHistory() {
    var rows = ((STATE.data.codex_quota && STATE.data.codex_quota.history) || []).slice(-10).reverse();
    var btn = '<button type="button" class="btn" data-act="quota">' + (STATE.quotaOpen ? "收起额度记录" : "额度记录") + "</button>";
    if (!STATE.quotaOpen) return "<div>" + btn + "</div>";
    if (!rows.length) return "<div>" + btn + "<p>还没有额度变化记录</p></div>";
    var lines = rows.map(function (row) {
      var label = row.state === "ok" ? "额度正常" : row.state === "capacity" ? "太忙" : "额度用完";
      return "<p>" + esc(fullStamp(Date.parse(row.ts))) + " · " + esc(label) + " · " + esc(row.bot || "—") + "</p>";
    }).join("");
    return "<div>" + btn + lines + "</div>";
  }

  function todayHTML(cardViews, now) {
    var best = longestToday(now);
    var cells = cardViews.map(function (view) {
      var t = view.today;
      var done = t.success + t.failed;
      var rate = done >= 5 ? '<span class="rate">成功率 ' + Math.round((100 * t.success) / done) + "%</span>" : "";
      var med = view.median != null ? '<div class="dim">近 7 天中位 ' + esc(formatDuration(view.median)) + "</div>" : "";
      function num(status, label, value) {
        return '<button type="button" class="num-btn" data-act="today" data-minion="' + view.id + '" data-status="' + status + '"><span class="num">' + value + '</span><span class="num-label">' + label + "</span></button>";
      }
      return (
        '<div class="today-cell" data-minion="' + view.id + '"><div class="today-name">' + esc(view.name) + "</div>" +
        '<div class="today-nums">' + num("success", "完成", t.success) + num("failed", "失败", t.failed) + num("degraded", "转出", t.degraded) + rate + "</div>" + med + "</div>"
      );
    }).join("");
    var long = best ? '<p class="longest">今日最长：' + esc(best.title) + " · " + esc(formatDuration(best.dur)) + "（北京时间）</p>" : '<p class="longest">今天还没有跑完的任务（北京时间）</p>';
    return cells + long;
  }

  function chip(action, value, text, pressed) {
    return '<button type="button" class="chip" data-act="' + action + '" data-value="' + esc(value) + '" aria-pressed="' + (pressed ? "true" : "false") + '" id="filter-' + action + "-" + esc(value) + '">' + esc(text) + "</button>";
  }

  function filtersHTML(total) {
    var f = STATE.filters;
    var minions = [["all", "全部"], ["codex", "Codex"], ["hermes", "Hermes"], ["pi", "pi"]];
    var statuses = [["running", "运行中"], ["success", "完成"], ["failed", "失败"], ["degraded", "转给别人"], ["stuck", "可能卡住"]];
    var ranges = [["today", "今天"], ["24h", "近 24 小时"], ["7d", "近 7 天"], ["30d", "近 30 天"]];
    return (
      '<div class="filter-scroll">' +
      minions.map(function (item) { return chip("minion", item[0], item[1], f.minion === item[0]); }).join("") +
      chip("status", "all", "全部状态", f.statuses.length === 0) +
      statuses.map(function (item) { return chip("status", item[0], item[1], f.statuses.indexOf(item[0]) >= 0); }).join("") +
      ranges.map(function (item) { return chip("range", item[0], item[1], f.range === item[0]); }).join("") +
      '<button type="button" class="chip" id="filter-smoke" data-act="smoke" aria-pressed="' + (f.smoke ? "true" : "false") + '">显示冒烟测试</button>' +
      '<span class="count-label">共 ' + total + " 条</span></div>"
    );
  }

  function legacyRows() {
    return ((STATE.data && STATE.data.legacy_routes) || []).filter(function (row) {
      return (STATE.filters.smoke || !row.smoke) && row.actual_minion;
    });
  }

  function routePool() {
    return ((STATE.data && STATE.data.legacy_routes) || []).filter(function (row) {
      return STATE.filters.smoke || !row.smoke;
    });
  }

  function legacyHTML() {
    var rows = legacyRows().slice().sort(function (a, b) { return Date.parse(b.ts) - Date.parse(a.ts); });
    var pool = routePool();
    var grok = pool.filter(function (row) { return row.actual === "grok_only"; }).length;
    var higgs = pool.filter(function (row) { return row.actual === "higgsfield"; }).length;
    var human = pool.filter(function (row) { return row.actual === "ask_human"; }).length;
    var parts = [];
    if (grok) parts.push("Grok Bot 自己处理 " + grok + " 次");
    if (higgs) parts.push("Higgsfield " + higgs + " 次");
    if (human) parts.push("交给老板 " + human + " 次");
    var foot = parts.length ? "另外 " + parts.join("，") + "。不是手下，不在这里展开。" : "没有落在 Grok Bot 或 Higgsfield 上的记录。";
    var body = rows.map(function (row) {
      var conf = row.confidence == null ? "" : "（置信 " + row.confidence + "）";
      var why = row.why_missing ? '<span class="pill warn">没写理由</span>' : row.why ? "<span>" + esc(row.why) + "</span>" : "";
      return (
        '<div class="legacy-row"><p>' + esc(md(Date.parse(row.ts))) + " " + esc(hm(Date.parse(row.ts))) +
        " · " + esc(row.bot) + " · " + esc(row.task_type) + "</p><p>Jev 建议 " + esc(row.choice_label) + conf +
        " → 实际 " + esc(row.actual_label) + "</p><p>" + mismatchHTML(row) + " " + why +
        ' <span class="pill rest">没有起止记录</span></p></div>'
      );
    }).join("");
    var title = "旧路由记录（事件流上线前，只有路由没有起止）· " + rows.length + " 条";
    return (
      '<h2 id="legacy-title" class="sr-only">' + esc(title) + "</h2>" +
      '<details class="fold" id="legacy-fold"' + (STATE.legacyOpen ? " open" : "") + ">" +
      '<summary class="fold-sum">' + esc(title) + "</summary>" +
      '<div class="fold-body">' + (body || "<p>这里还没有手下的旧路由。</p>") +
      '<p class="legacy-foot">' + esc(foot) + "</p>" +
      "<p>事件流上线前只记了「分给谁」，没有开始和结束时间，所以这里不显示成败和时长。</p></div></details>"
    );
  }

  function notesHTML(now) {
    var data = STATE.data;
    var h = data.health || {};
    var pool = routePool();
    var mismatch = pool.filter(function (row) { return row.mismatch; }).length;
    var missingWhy = pool.filter(function (row) { return row.why_missing; }).length;
    var inconsistent = pool.filter(function (row) { return row.inconsistent_mark; }).length;
    var actuals = { codex: 0, hermes: 0, pi: 0, grok_only: 0, higgsfield: 0, ask_human: 0, none: 0 };
    pool.forEach(function (row) {
      if (!row.actual) actuals.none += 1;
      else if (actuals[row.actual] != null) actuals[row.actual] += 1;
      else if (row.actual_minion && actuals[row.actual_minion] != null) actuals[row.actual_minion] += 1;
    });
    var stale = staleInfo(data, now);
    var clock = "";
    if (stale.level === "skew") clock = "<p>这台电脑的时钟比盒子慢约 " + stale.mins + " 分钟</p>";
    var sources = (data.sources || []).map(function (src) {
      return "<li>" + esc(src.kind) + " · " + esc(src.path) + " · " + (src.exists ? "读到 " + (src.lines == null ? "—" : src.lines) + " 行" : "文件不在") +
        (src.mtime ? " · " + esc(src.mtime) + "（北京时间）" : "") + "</li>";
    }).join("");
    var mode = data.refresh_mode === "watch"
      ? "心跳大约每 " + (data.watch_interval_s || 30) + " 秒构建一次。"
      : "没有心跳。只在有新事件时更新，所以不按时间判断过期。可能卡住仍按这台电脑的时钟计算。";
    return (
      '<h2 id="notes-title" class="sr-only">数据说明</h2>' +
      '<details class="fold" id="notes-fold"' + (STATE.notesOpen ? " open" : "") + ">" +
      '<summary class="fold-sum">数据说明</summary><div class="fold-body notes-body">' +
      "<p>" + esc(mode) + "</p>" + clock +
      "<ul>" + sources + "</ul>" +
      "<p>坏行 " + (h.bad_lines || 0) + "：缺时区、手下名字不对，或者行没写完，这些被跳过了。</p>" +
      "<p>重复事件 " + (h.dup_events || 0) + "：同一个事件编号只认第一条。</p>" +
      "<p>冲突 " + (h.conflicts || 0) + "：同一任务有多条结束，或者结束早于开始。</p>" +
      "<p>时钟偏差 " + (h.clock_skew || 0) + "：有事件比构建时间晚了 5 分钟以上，仍照常显示。</p>" +
      "<p>读不懂的旧日志 " + (h.legacy_rows || 0) + " 行。</p>" +
      "<p>没对上路由 " + (h.unmatched_routes || 0) + " 条。</p>" +
      "<p>路由共 " + pool.length + " 条。Codex " + actuals.codex + "，Hermes " + actuals.hermes + "，pi " + actuals.pi +
      "，Grok Bot " + actuals.grok_only + "，Higgsfield " + actuals.higgsfield + "，没记下实际执行者 " + actuals.none + "。</p>" +
      "<p>建议≠实际 " + mismatch + " 条。没写理由 " + missingWhy + " 条。日志标记不一致 " + inconsistent + " 条。</p>" +
      "<p>看板只显示 Codex / Hermes / pi。Grok Bot 自己做的、Higgsfield 做的不在这里。</p>" +
      "<p>这里只看 Codex、Hermes、pi。Grok Bot 自己做的和 Higgsfield 做的，不在这块看板里。</p>" +
      "</div></details>"
    );
  }

  function bannersHTML(items) {
    var shown = items.slice(0, 3);
    var extra = items.length - shown.length;
    var html = shown.map(function (item) {
      var action = item.task ? '<button type="button" class="btn" data-act="jump" data-task="' + esc(item.task) + '">看这条</button>' : "";
      var dismiss = item.dismiss ? '<button type="button" class="btn" data-act="dismiss" data-key="' + esc(dismissKey(item)) + '">知道了</button>' : "";
      var stuckAttr = item.stuckStart ? ' data-banner-stuck="' + item.stuckStart + '" data-banner-name="' + esc(item.stuckName) + '" data-banner-title="' + esc(item.stuckTitle) + '"' : "";
      return '<div class="banner" data-level="' + item.level + '"><p' + stuckAttr + ">" + esc(item.text) + '</p><div class="actions">' + action + dismiss + "</div></div>";
    }).join("");
    if (extra > 0) html += '<p class="more-alerts">还有 ' + extra + " 条</p>";
    return html;
  }

  function shell() {
    var app = document.getElementById("app");
    if (document.getElementById("topbar")) return;
    app.innerHTML =
      '<div class="page">' +
      '<header class="topbar" id="topbar"></header>' +
      '<div class="banners" id="banners"></div>' +
      '<section class="section" aria-labelledby="cards-title"><h2 id="cards-title" class="sr-only">三个手下（北京时间）</h2><div class="cards" id="cards"></div></section>' +
      '<section class="section" aria-labelledby="today-title"><h2 id="today-title" class="sr-only">今日小结（北京时间）</h2><div class="today" id="today"></div></section>' +
      '<section class="section" id="history" aria-labelledby="history-title"><h2 id="history-title">历史 <span class="dim">北京时间</span></h2><div class="filters" id="filters"></div><div id="history-list"></div></section>' +
      '<section class="section" id="legacy" aria-labelledby="legacy-title"></section>' +
      '<section class="section" id="notes" aria-labelledby="notes-title"></section>' +
      "</div>";
  }

  function fatal(text) {
    var faces = ORDER.map(function (id) { return avatar(id, "fail", 72, false); }).join("");
    document.getElementById("app").innerHTML =
      '<div class="page"><div class="error-card"><div class="empty-faces">' + faces + "</div><h1>手下看板</h1><p>" + esc(text) + "</p></div></div>";
    STATE.sig = "fatal:" + text;
    publishProbe();
  }

  function waiting(text) {
    document.getElementById("app").innerHTML =
      '<div class="page"><div class="error-card"><h1>手下看板</h1><p>' + esc(text) + "</p></div></div>";
    STATE.sig = "wait:" + text;
    publishProbe();
  }

  function sectionTry(fn) {
    try {
      return fn();
    } catch (err) {
      return '<p class="section-error">页面出了点问题，数据没丢。刷新试试。</p>';
    }
  }

  function paint() {
    var now = nowMs();
    shell();
    var focusId = document.activeElement && document.activeElement.id;
    var y = window.scrollY;
    var cardViews = views(now);
    var health = healthView(now);
    document.getElementById("topbar").innerHTML =
      "<h1>手下看板</h1><div class=\"top-side\">" +
      '<p class="top-status' + (STATE.data.refresh_mode === "on_write" ? " onwrite" : "") + '" id="top-status">' + esc(topText(now)) + "</p>" +
      '<button type="button" class="health" id="health-dot" data-act="notes"><span class="dot ' + health.tone + '"></span><span class="health-label">' + esc(health.text) + "</span></button></div>";
    document.getElementById("banners").innerHTML = sectionTry(function () { return bannersHTML(bannerList(now, cardViews)); });
    var cards = document.getElementById("cards");
    cards.innerHTML = sectionTry(function () {
      return cardViews.map(function (view) {
        return '<article class="card" id="card-' + view.id + '" data-minion="' + view.id + '" data-expr="' + view.expr + '">' + cardHTML(view, now) + "</article>";
      }).join("");
    });
    document.getElementById("today").innerHTML = sectionTry(function () { return todayHTML(cardViews, now); });
    var rows = historyRows(now);
    document.getElementById("filters").innerHTML = filtersHTML(rows.length);
    document.getElementById("history-list").innerHTML = sectionTry(function () { return historyHTML(now); });
    document.getElementById("legacy").innerHTML = sectionTry(legacyHTML);
    document.getElementById("notes").innerHTML = sectionTry(function () { return notesHTML(now); });
    if (focusId) {
      var back = document.getElementById(focusId);
      if (back) back.focus({ preventScroll: true });
    }
    window.scrollTo(0, y);
    STATE.freshDeg.clear();
    afterMotion();
    publishProbe();
  }

  function afterMotion() {
    if (reduceMotion()) return;
    STATE.shake.forEach(function (id) {
      var task = findTask(id);
      if (!task) return;
      var node = document.querySelector("#card-" + task.minion + " .avatar");
      if (node) node.classList.add("shake");
    });
    STATE.shake.clear();
  }

  function render() {
    if (!STATE.data) {
      if (STATE.loading) {
        waiting("正在读取看板…");
        return;
      }
      if (STATE.remoteEmpty) {
        waiting("还没有数据。盒子还没把看板推上来。推送开始后，这个页面大约每 20 秒自己看一眼。");
        return;
      }
      if (STATE.storeDown) {
        waiting("看板的存储还没配好，所以这里是空的。");
        return;
      }
      if (STATE.mode === "api") {
        waiting("暂时连不上看板接口。请稍后再看。");
        return;
      }
      fatal("读不到看板数据。请在盒子上运行一次构建：`python3 scripts/build_board.py`");
      return;
    }
    if (STATE.data.schema !== 1) {
      fatal("数据格式版本对不上（看到 " + String(STATE.data.schema) + "，需要 1）。请更新看板。");
      return;
    }
    var sig = computeSig();
    if (sig === STATE.sig && document.getElementById("cards")) {
      updateTimers();
      updateChrome();
      publishProbe();
      return;
    }
    STATE.sig = sig;
    paint();
    updateTimers();
  }

  function computeSig() {
    var now = nowMs();
    var body = tasks().map(function (task) {
      var info = phaseOf(task, now);
      return [task.task_id, task.status, task.title, info.phase, info.stuck ? 1 : 0, task.end_count, shown(task) ? 1 : 0].join("~");
    }).join("|");
    var quota = STATE.data.codex_quota && STATE.data.codex_quota.current;
    return JSON.stringify({
      body: body,
      q: quota && quota.state,
      reset: quota && quota.reset_at,
      stale: staleInfo(STATE.data, now).level,
      filters: STATE.filters,
      open: Array.from(STATE.expanded),
      extra: STATE.extra,
      quotaOpen: STATE.quotaOpen,
      legacy: STATE.legacyOpen,
      notes: STATE.notesOpen,
      visible: STATE.visible,
      dismissed: Array.from(STATE.dismissed),
      poll: STATE.pollFails,
      just: Array.from(STATE.justDone),
      narrow: narrow(),
      wide: window.innerWidth >= 1440,
    });
  }

  function updateChrome() {
    if (!STATE.data || !document.getElementById("top-status")) return;
    var now = nowMs();
    document.getElementById("top-status").textContent = topText(now);
    var health = healthView(now);
    var label = document.querySelector(".health-label");
    var dot = document.querySelector("#health-dot .dot");
    if (label) label.textContent = health.text;
    if (dot) dot.className = "dot " + health.tone;
  }

  function updateTimers() {
    if (!STATE.data) return;
    var now = nowMs();
    var frozen = freezeMs();
    document.querySelectorAll("[data-live-elapsed]").forEach(function (node) {
      if (node.getAttribute("data-freeze") === "1" || frozen) return;
      var start = Number(node.getAttribute("data-live-elapsed"));
      if (!isFinite(start)) return;
      node.textContent = formatDuration(now - start);
      var sr = node.parentElement && node.parentElement.querySelector(".sr-only");
      if (sr) {
        var minute = Math.floor((now - start) / 60000);
        if (sr.getAttribute("data-minute") !== String(minute)) {
          sr.textContent = spokenRun(now - start);
          sr.setAttribute("data-minute", String(minute));
        }
      }
    });
    var label = document.querySelector(".quota-label[data-reset]");
    if (label && !frozen) {
      var reset = Number(label.getAttribute("data-reset"));
      if (now >= reset) label.textContent = "按时间应该恢复了，等下一次调用确认";
      else label.textContent = hm(reset) + " 恢复（北京时间）· 还剩 " + formatRemain(reset - now);
    }
    document.querySelectorAll("[data-banner-stuck]").forEach(function (node) {
      if (frozen) return;
      var start = Number(node.getAttribute("data-banner-stuck"));
      var name = node.getAttribute("data-banner-name") || "";
      var title = node.getAttribute("data-banner-title") || "";
      node.textContent = name + " 的「" + title + "」已经跑了 " + formatDuration(now - start) + "，可能卡住了。";
    });
    var bar = document.getElementById("quota-bar");
    if (bar && !frozen) {
      var start = Number(bar.getAttribute("data-start"));
      var end = Number(bar.getAttribute("data-reset"));
      if (end > start) {
        var gone = Math.min(1, Math.max(0, (now - start) / (end - start)));
        bar.style.width = Math.round(gone * 100) + "%";
      }
    }
  }

  function readHash() {
    var raw = location.hash.replace(/^#/, "");
    var params = new URLSearchParams(raw);
    var minion = params.get("m") || "all";
    if (ORDER.indexOf(minion) < 0) minion = "all";
    var statuses = (params.get("s") || "").split(",").filter(function (item) {
      return ["running", "success", "failed", "degraded", "stuck"].indexOf(item) >= 0;
    });
    var range = params.get("t") || "7d";
    if (["today", "24h", "7d", "30d"].indexOf(range) < 0) range = "7d";
    return { minion: minion, statuses: statuses, range: range, smoke: params.get("smoke") === "1" };
  }

  function writeHash() {
    var f = STATE.filters;
    var params = new URLSearchParams();
    if (f.minion !== "all") params.set("m", f.minion);
    if (f.statuses.length) params.set("s", f.statuses.join(","));
    params.set("t", f.range || "7d");
    params.set("smoke", f.smoke ? "1" : "0");
    var next = "#" + params.toString();
    if (location.hash === next) return;
    history.replaceState(null, "", next);
  }

  function persist() {
    try {
      sessionStorage.setItem("minionBoard.ui", JSON.stringify({
        expanded: Array.from(STATE.expanded),
        extra: STATE.extra,
        quotaOpen: STATE.quotaOpen,
        legacyOpen: STATE.legacyOpen,
        notesOpen: STATE.notesOpen,
        visible: STATE.visible,
        dismissed: Array.from(STATE.dismissed),
        scroll: window.scrollY,
      }));
    } catch (err) {
      STATE.memoryOnly = true;
    }
  }

  function restore() {
    try {
      var raw = sessionStorage.getItem("minionBoard.ui");
      if (!raw) return;
      var ui = JSON.parse(raw);
      STATE.expanded = new Set(ui.expanded || []);
      STATE.extra = ui.extra || {};
      STATE.quotaOpen = !!ui.quotaOpen;
      STATE.legacyOpen = !!ui.legacyOpen;
      STATE.notesOpen = !!ui.notesOpen;
      STATE.visible = ui.visible || 50;
      STATE.dismissed = new Set(ui.dismissed || []);
      if (ui.scroll) STATE.savedScroll = ui.scroll;
    } catch (err) {
      STATE.memoryOnly = true;
    }
  }

  function loadList(key) {
    try {
      var raw = localStorage.getItem(key);
      if (raw == null) return { ok: true, missing: true, value: [] };
      var parsed = JSON.parse(raw);
      return { ok: true, missing: false, value: Array.isArray(parsed) ? parsed : [] };
    } catch (err) {
      return { ok: false, missing: true, value: [] };
    }
  }

  function saveList(key, list) {
    if (STATE.memoryOnly) return;
    try {
      localStorage.setItem(key, JSON.stringify(list.slice(-500)));
    } catch (err) {
      STATE.memoryOnly = true;
    }
  }

  function seedSeen() {
    var ends = loadList("minionBoard.seenEnds");
    var fails = loadList("minionBoard.seenFails");
    var degs = loadList("minionBoard.seenDegs");
    if (!ends.ok || !fails.ok || !degs.ok) STATE.memoryOnly = true;
    var finished = tasks().filter(function (task) { return task.ended_at; });
    if (ends.missing) {
      STATE.seenEnds = finished.filter(function (task) { return task.status === "success"; }).map(function (task) { return task.task_id; });
      saveList("minionBoard.seenEnds", STATE.seenEnds);
    } else STATE.seenEnds = ends.value;
    if (fails.missing) {
      STATE.seenFails = finished.filter(function (task) { return task.status === "failed"; }).map(function (task) { return task.task_id; });
      saveList("minionBoard.seenFails", STATE.seenFails);
    } else STATE.seenFails = fails.value;
    if (degs.missing) {
      STATE.seenDegs = finished.filter(function (task) { return task.status === "degraded"; }).map(function (task) { return task.task_id; });
      saveList("minionBoard.seenDegs", STATE.seenDegs);
    } else STATE.seenDegs = degs.value;
  }

  function noteNew() {
    var now = nowMs();
    var fresh = [];
    tasks().forEach(function (task) {
      if (task.smoke || !task.ended_at) return;
      var end = Date.parse(task.ended_at);
      var recent = isFinite(end) && now - end <= 10 * 60 * 1000 && now >= end;
      if (task.status === "success" && recent && STATE.seenEnds.indexOf(task.task_id) < 0) {
        STATE.seenEnds.push(task.task_id);
        fresh.push(task);
        queueAnnounce({ kind: "success", text: NAMES[task.minion] + "完成了「" + task.title + "」，用时 " + formatDuration(phaseOf(task, now).elapsed) });
      }
      if (task.status === "failed" && recent && STATE.seenFails.indexOf(task.task_id) < 0) {
        STATE.seenFails.push(task.task_id);
        STATE.shake.add(task.task_id);
        queueAnnounce({ kind: "fail", text: NAMES[task.minion] + "的「" + task.title + "」失败了：" + failReason(task) });
      }
      if (task.status === "degraded" && STATE.seenDegs.indexOf(task.task_id) < 0) {
        STATE.seenDegs.push(task.task_id);
        STATE.freshDeg.add(task.task_id);
        queueAnnounce({ kind: "degraded", text: NAMES[task.minion] + "的「" + task.title + "」转给了" + whoName(task.degraded_to) });
      }
    });
    saveList("minionBoard.seenEnds", STATE.seenEnds);
    saveList("minionBoard.seenFails", STATE.seenFails);
    saveList("minionBoard.seenDegs", STATE.seenDegs);
    if (fresh.length >= 3) queueCeleb({ type: "multi", n: fresh.length, tasks: fresh });
    else fresh.forEach(function (task) { queueCeleb({ type: "one", task: task }); });
    var quota = STATE.data.codex_quota && STATE.data.codex_quota.current;
    var next = quota && quota.state;
    if (STATE.quotaState && next && STATE.quotaState !== next) {
      queueAnnounce({ kind: "quota", text: next === "ok" ? "Codex 额度恢复了" : "Codex 额度状态有变化" });
      if (STATE.quotaState === "quota_exhausted" && next === "ok") STATE.wake = true;
    }
    STATE.quotaState = next || STATE.quotaState;
    var stale = staleInfo(STATE.data, now);
    if (STATE.seenStale && STATE.seenStale !== "red" && stale.level === "red") {
      queueAnnounce({ kind: "stale", text: "看板数据过期了" });
    }
    STATE.seenStale = stale.level;
    Array.from(STATE.justDone).forEach(function (id) {
      var task = findTask(id);
      if (!task || !task.ended_at || now - Date.parse(task.ended_at) > 10 * 60 * 1000) STATE.justDone.delete(id);
    });
  }

  function queueAnnounce(entry) {
    if (!STATE.booted) return;
    STATE.ann.push(entry);
    if (!STATE.annStart) STATE.annStart = Date.now();
    clearTimeout(STATE.annTimer);
    var wait = STATE.ann.length >= 2 ? Math.max(0, 10000 - (Date.now() - STATE.annStart)) : 300;
    STATE.annTimer = setTimeout(flushAnnounce, wait);
  }

  function flushAnnounce() {
    var items = STATE.ann.splice(0, STATE.ann.length);
    STATE.annStart = 0;
    var live = document.getElementById("live");
    if (!live || !items.length) return;
    var notable = items.filter(function (item) { return item.kind !== "stale" && item.kind !== "quota"; });
    if (items.length === 1 || notable.length < 2) {
      live.textContent = items[items.length - 1].text;
      return;
    }
    var ok = notable.filter(function (item) { return item.kind === "success"; }).length;
    var bad = notable.filter(function (item) { return item.kind === "fail"; }).length;
    var deg = notable.filter(function (item) { return item.kind === "degraded"; }).length;
    var bits = [];
    if (ok) bits.push(ok + " 个完成");
    if (bad) bits.push(bad + " 个失败");
    if (deg) bits.push(deg + " 个转给别人");
    live.textContent = notable.length + " 个任务有了结果：" + bits.join("，");
  }

  function queueCeleb(item) {
    if (reduceMotion()) {
      (item.tasks || [item.task]).forEach(function (task) {
        if (task) STATE.justDone.add(task.task_id);
      });
      return;
    }
    STATE.celebQ.push(item);
    pumpCeleb();
  }

  function pumpCeleb() {
    if (STATE.celebPlaying || !STATE.celebQ.length) return;
    var ones = STATE.celebQ.filter(function (item) { return item.type === "one"; });
    if (ones.length >= 3) {
      STATE.celebQ = STATE.celebQ.filter(function (item) { return item.type !== "one"; });
      showToast("一口气完成 " + ones.length + " 个！", ones.map(function (item) { return item.task; }));
      return;
    }
    var item = STATE.celebQ.shift();
    if (item.type === "multi") showToast("一口气完成 " + item.n + " 个！", item.tasks || []);
    else showToast(NAMES[item.task.minion] + " 做完了：" + item.task.title + "！", [item.task]);
  }

  function showToast(text, list) {
    STATE.celebPlaying = true;
    var toast = document.getElementById("toast");
    var colors = ["#4C6FFF", "#FF8A3D", "#C04BE0", "#2EB872"];
    var bits = "";
    for (var i = 0; i < 12; i += 1) {
      bits += '<i class="confetti" style="background:' + colors[i % 4] + ";--dx:" + (i - 6) * 16 + "px;--dy:" + (36 + (i % 5) * 14) + 'px"></i>';
    }
    toast.innerHTML = "<p>" + esc(text) + "</p>" + bits;
    list.forEach(function (task) {
      var node = document.querySelector("#card-" + task.minion + " .avatar");
      if (node) {
        node.classList.remove("celebrate");
        void node.offsetWidth;
        node.classList.add("celebrate");
      }
    });
    setTimeout(function () {
      toast.innerHTML = "";
      STATE.celebPlaying = false;
      pumpCeleb();
    }, 3000);
  }

  var API_POLL_MS = 20000;
  var FILE_POLL_MS = 15000;

  function dataSrc() {
    var name = q().get("fixture");
    if (name) return "assets/fixtures/" + encodeURIComponent(name) + ".js";
    return "data/board-data.js";
  }

  function schedule() {
    clearTimeout(STATE.pollTimer);
    if (document.hidden) return;
    STATE.pollTimer = setTimeout(pollOnce, STATE.mode === "api" ? API_POLL_MS : FILE_POLL_MS);
  }

  function applyRemote(body) {
    STATE.loading = false;
    STATE.storeDown = false;
    STATE.pollFails = 0;
    if (!body || body.empty || !body.board) {
      STATE.remoteEmpty = true;
      STATE.data = null;
      STATE.sig = "";
      delete window.__MINION_BOARD__;
      render();
      return;
    }
    STATE.remoteEmpty = false;
    if (body.pushed_at) body.board.pushed_at = body.pushed_at;
    window.__MINION_BOARD__ = body.board;
    ingest(false);
    if (STATE.savedScroll && !STATE.didScroll) {
      STATE.didScroll = true;
      window.scrollTo(0, STATE.savedScroll);
    }
  }

  function useFileFallback() {
    if (window.__MINION_BOARD__) {
      STATE.mode = "file";
      STATE.loading = false;
      STATE.remoteEmpty = false;
      STATE.storeDown = false;
      ingest(true);
      if (STATE.savedScroll) window.scrollTo(0, STATE.savedScroll);
      schedule();
      return;
    }
    var script = document.createElement("script");
    script.src = "data/board-data.js?v=" + Date.now();
    script.dataset.boardData = "1";
    script.onload = function () {
      STATE.mode = "file";
      STATE.loading = false;
      ingest(true);
      if (STATE.savedScroll) window.scrollTo(0, STATE.savedScroll);
      schedule();
    };
    script.onerror = function () {
      script.remove();
      STATE.mode = "file";
      STATE.loading = false;
      STATE.data = null;
      render();
    };
    document.head.appendChild(script);
  }

  function loadApi(first) {
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, 8000);
    var opts = { headers: { Accept: "application/json" }, cache: "no-store" };
    if (ctrl) opts.signal = ctrl.signal;
    fetch("/api/board", opts)
      .then(function (res) {
        if (res.status === 404) {
          var missing = new Error("missing");
          missing.missing = true;
          throw missing;
        }
        if (res.status === 503) {
          var down = new Error("down");
          down.storeDown = true;
          throw down;
        }
        if (!res.ok) throw new Error("status");
        return res.json();
      })
      .then(function (body) {
        STATE.mode = "api";
        applyRemote(body);
        schedule();
      })
      .catch(function (err) {
        // 只有「根本没有这个接口」才退回本地文件。超时或暂时连不上，继续问接口。
        if (first && err && err.missing) {
          useFileFallback();
          return;
        }
        if (err && err.storeDown && !STATE.data) {
          STATE.loading = false;
          STATE.storeDown = true;
          STATE.remoteEmpty = false;
          STATE.mode = "api";
          render();
          schedule();
          return;
        }
        STATE.loading = false;
        STATE.pollFails += 1;
        STATE.mode = "api";
        STATE.sig = "";
        render();
        schedule();
      })
      .then(
        function () {
          clearTimeout(timer);
        },
        function () {
          clearTimeout(timer);
        }
      );
  }

  function pollOnce() {
    if (document.hidden) return;
    if (STATE.mode === "api") {
      loadApi(false);
      return;
    }
    var script = document.createElement("script");
    script.src = dataSrc() + "?v=" + Date.now();
    script.dataset.boardData = "1";
    script.onload = function () {
      STATE.pollFails = 0;
      document.querySelectorAll("script[data-board-data]").forEach(function (el) {
        if (el !== script) el.remove();
      });
      ingest(false);
      schedule();
    };
    script.onerror = function () {
      STATE.pollFails += 1;
      script.remove();
      STATE.sig = "";
      render();
      schedule();
    };
    document.head.appendChild(script);
  }

  function ingest(first) {
    var data = window.__MINION_BOARD__;
    if (!data) {
      STATE.data = null;
      STATE.sig = "";
      render();
      return;
    }
    STATE.data = data;
    if (!STATE.seeded) {
      seedSeen();
      STATE.seeded = true;
      STATE.known = new Set(tasks().map(function (task) { return task.task_id; }));
      var quota = data.codex_quota && data.codex_quota.current;
      STATE.quotaState = quota && quota.state;
      STATE.seenStale = staleInfo(data, nowMs()).level;
      STATE.booted = true;
      STATE.sig = "";
      render();
      return;
    }
    noteNew();
    if (STATE.wake) {
      STATE.wake = false;
      setTimeout(function () {
        var node = document.querySelector("#card-codex .avatar");
        if (node) node.classList.add("wake");
      }, 30);
    }
    render();
  }

  function jump(id) {
    var task = findTask(id);
    if (!task) return;
    var now = nowMs();
    var info = phaseOf(task, now);
    if (STATE.filters.minion !== "all" && STATE.filters.minion !== task.minion) STATE.filters.minion = "all";
    if (!statusOn(info, STATE.filters.statuses)) STATE.filters.statuses = [];
    if (!inRange(task, STATE.filters.range, now)) STATE.filters.range = "30d";
    if (task.smoke) STATE.filters.smoke = true;
    STATE.expanded.add(id);
    var index = historyRows(now).findIndex(function (row) { return row.task.task_id === id; });
    if (index >= STATE.visible) STATE.visible = index + 1;
    writeHash();
    persist();
    STATE.sig = "";
    render();
    var el = document.getElementById("hist-" + id);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "center" });
    }
  }

  function onClick(event) {
    var btn = event.target.closest("button");
    if (!btn || !btn.dataset) return;
    var act = btn.dataset.act;
    if (!act) return;
    if (act === "jump") {
      jump(btn.dataset.task);
      return;
    }
    if (act === "toggle") {
      var id = btn.dataset.task;
      if (STATE.expanded.has(id)) STATE.expanded.delete(id);
      else STATE.expanded.add(id);
      persist();
      STATE.sig = "";
      render();
      var again = document.getElementById("hist-" + id);
      if (again) again.focus();
      return;
    }
    if (act === "minion") {
      var value = btn.dataset.value;
      STATE.filters.minion = STATE.filters.minion === value ? "all" : value;
      writeHash();
      persist();
      STATE.sig = "";
      render();
      return;
    }
    if (act === "status") {
      var name = btn.dataset.value;
      if (name === "all") STATE.filters.statuses = [];
      else if (STATE.filters.statuses.indexOf(name) >= 0) {
        STATE.filters.statuses = STATE.filters.statuses.filter(function (item) { return item !== name; });
      } else STATE.filters.statuses = STATE.filters.statuses.concat([name]);
      writeHash();
      persist();
      STATE.sig = "";
      render();
      return;
    }
    if (act === "range") {
      STATE.filters.range = btn.dataset.value;
      writeHash();
      persist();
      STATE.sig = "";
      render();
      return;
    }
    if (act === "smoke") {
      STATE.filters.smoke = !STATE.filters.smoke;
      writeHash();
      persist();
      STATE.sig = "";
      render();
      return;
    }
    if (act === "clear") {
      STATE.filters = { minion: "all", statuses: [], range: "7d", smoke: false };
      writeHash();
      persist();
      STATE.sig = "";
      render();
      return;
    }
    if (act === "today") {
      STATE.filters.minion = btn.dataset.minion;
      STATE.filters.statuses = [btn.dataset.status];
      STATE.filters.range = "today";
      writeHash();
      persist();
      STATE.sig = "";
      render();
      document.getElementById("history").scrollIntoView();
      return;
    }
    if (act === "extra") {
      STATE.extra[btn.dataset.minion] = btn.dataset.open === "1";
      persist();
      STATE.sig = "";
      render();
      return;
    }
    if (act === "quota") {
      STATE.quotaOpen = !STATE.quotaOpen;
      persist();
      STATE.sig = "";
      render();
      return;
    }
    if (act === "dismiss") {
      STATE.dismissed.add(btn.dataset.key);
      persist();
      STATE.sig = "";
      render();
      return;
    }
    if (act === "notes") {
      STATE.notesOpen = true;
      persist();
      STATE.sig = "";
      render();
      var notes = document.getElementById("notes");
      if (notes) notes.scrollIntoView();
      return;
    }
    if (act === "more") {
      STATE.visible += 50;
      persist();
      STATE.sig = "";
      render();
    }
  }

  function publishProbe() {
    var root = document.documentElement;
    var minFont = 99;
    document.body.querySelectorAll("*").forEach(function (el) {
      if (!el.textContent || !el.textContent.trim()) return;
      var size = parseFloat(getComputedStyle(el).fontSize);
      if (size && size < minFont) minFont = size;
    });
    root.dataset.scrollWidth = String(root.scrollWidth);
    root.dataset.clientWidth = String(root.clientWidth);
    var probe = {
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
      innerWidth: window.innerWidth,
      top: document.getElementById("top-status") ? document.getElementById("top-status").textContent : "",
      health: document.querySelector(".health-label") ? document.querySelector(".health-label").textContent : "",
      banners: Array.from(document.querySelectorAll(".banner")).map(function (el) { return el.innerText; }),
      status: Array.from(document.querySelectorAll(".status-line")).map(function (el) { return el.textContent; }),
      error: document.querySelector(".error-card") ? document.querySelector(".error-card").innerText : "",
      legacyTitle: document.querySelector("#legacy-fold summary") ? document.querySelector("#legacy-fold summary").textContent : "",
      notes: document.querySelector(".notes-body") ? document.querySelector(".notes-body").innerText : "",
      foot: document.querySelector(".legacy-foot") ? document.querySelector(".legacy-foot").textContent : "",
      live: document.getElementById("live") ? document.getElementById("live").textContent : "",
      hash: location.hash,
      minFont: minFont,
      scripts: document.querySelectorAll("script[data-board-data]").length,
    };
    var node = document.getElementById("probe-json");
    if (!node) {
      node = document.createElement("script");
      node.type = "application/json";
      node.id = "probe-json";
      document.body.appendChild(node);
    }
    node.textContent = JSON.stringify(probe);
  }

  function gallery() {
    var states = ["idle", "working", "success", "fail", "rest"];
    var labels = { idle: "空闲", working: "工作中", success: "成功", fail: "失败", rest: "休息" };
    var cells = "";
    ORDER.forEach(function (id) {
      states.forEach(function (state) {
        cells += "<figure>" + avatar(id, state, 96, false) + "<figcaption>" + esc(NAMES[id] + " · " + labels[state]) + "</figcaption></figure>";
      });
    });
    document.getElementById("app").innerHTML = '<div class="gallery"><h1>表情检查</h1><div class="gallery-grid">' + cells + "</div></div>";
  }

  function boot() {
    if (q().get("gray") === "1") document.documentElement.classList.add("gray");
    if (q().get("avatars") === "1") {
      gallery();
      return;
    }
    restore();
    STATE.filters = readHash();
    document.body.addEventListener("click", onClick);
    document.body.addEventListener("toggle", function (event) {
      if (event.target.id === "legacy-fold") STATE.legacyOpen = event.target.open;
      if (event.target.id === "notes-fold") STATE.notesOpen = event.target.open;
      persist();
    }, true);
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      var id = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.task;
      if (id && STATE.expanded.has(id)) {
        STATE.expanded.delete(id);
        persist();
        STATE.sig = "";
        render();
        var again = document.getElementById("hist-" + id);
        if (again) again.focus();
      }
    });
    window.addEventListener("hashchange", function () {
      STATE.filters = readHash();
      STATE.sig = "";
      render();
    });
    window.addEventListener("resize", function () {
      STATE.sig = "";
      render();
    });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) clearTimeout(STATE.pollTimer);
      else pollOnce();
    });
    setInterval(function () {
      updateTimers();
      updateChrome();
      if (STATE.data && computeSig() !== STATE.sig) render();
    }, 1000);
    if (q().get("fixture") || location.protocol === "file:") {
      STATE.mode = "file";
      ingest(true);
      if (STATE.savedScroll) window.scrollTo(0, STATE.savedScroll);
      schedule();
    } else {
      STATE.mode = "api";
      STATE.loading = true;
      render();
      loadApi(true);
    }
    if (q().get("probe") === "1") {
      window.__MINION_TEST__ = {
        poll: pollOnce,
        state: STATE,
        jump: jump,
      };
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
