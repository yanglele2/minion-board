/* 夹具共用的小工具。时间都相对「打开页面的这一刻」，所以过期、卡住、倒计时不用改系统时钟。 */
(function () {
  function iso(deltaMs) {
    var shifted = new Date(Date.now() + deltaMs + 8 * 3600 * 1000);
    function pad(n) {
      return String(n).padStart(2, "0");
    }
    return (
      shifted.getUTCFullYear() +
      "-" +
      pad(shifted.getUTCMonth() + 1) +
      "-" +
      pad(shifted.getUTCDate()) +
      "T" +
      pad(shifted.getUTCHours()) +
      ":" +
      pad(shifted.getUTCMinutes()) +
      ":" +
      pad(shifted.getUTCSeconds()) +
      "+08:00"
    );
  }

  function task(fields) {
    var base = {
      task_id: "",
      minion: "pi",
      bot: "t06",
      title: "",
      task_type: "copy",
      route_ref: "",
      model: "",
      host: "box",
      attempt: 1,
      parent_task_id: "",
      expect_minutes: null,
      smoke: false,
      started_at: null,
      ended_at: null,
      status: "running",
      fail_kind: null,
      fail_text: null,
      exit_code: null,
      degraded_to: null,
      start_event_id: null,
      end_event_id: null,
      end_count: 0,
      conflict: false,
      missing_start: false,
      writer: "t06",
      route_match: { kind: "none", count: 0, note: "没找到对应路由", route: null },
      threshold_s: 20 * 60,
    };
    var merged = Object.assign(base, fields);
    if (!merged.threshold_s) {
      merged.threshold_s = merged.minion === "codex" ? 45 * 60 : merged.minion === "hermes" ? 30 * 60 : 20 * 60;
    }
    return merged;
  }

  function minions() {
    return [
      { id: "codex", name: "Codex", nickname: "扣扣", today: { success: 0, failed: 0, degraded: 0 }, median_7d_s: null, ever: false },
      { id: "hermes", name: "Hermes", nickname: "赫米", today: { success: 0, failed: 0, degraded: 0 }, median_7d_s: null, ever: false },
      { id: "pi", name: "pi", nickname: "派派", today: { success: 0, failed: 0, degraded: 0 }, median_7d_s: null, ever: false },
    ];
  }

  function health(extra) {
    return Object.assign(
      {
        bad_lines: 0,
        dup_events: 0,
        conflicts: 0,
        clock_skew: 0,
        legacy_rows: 0,
        unmatched_routes: 0,
        log_mark_inconsistent: 0,
        missing_why: 0,
        mismatch: 0,
      },
      extra || {}
    );
  }

  function shell(extra) {
    var data = {
      schema: 1,
      built_at: iso(0),
      refresh_mode: "watch",
      watch_interval_s: 30,
      sources: [
        {
          kind: "events",
          path: "fixture",
          exists: true,
          mtime: iso(0),
          lines: (extra && extra.tasks ? extra.tasks.length : 0),
        },
      ],
      minions: minions(),
      tasks: [],
      today_longest: null,
      codex_quota: {
        current: {
          state: null,
          reset_at: null,
          source: "unknown",
          updated_at: null,
          time_unknown: true,
          raw: "",
          bot: "",
        },
        history: [],
      },
      legacy_routes: [],
      health: health(),
      seq: 1,
    };
    return Object.assign(data, extra || {});
  }

  window.MinionFixture = { iso: iso, task: task, shell: shell, health: health };
})();
