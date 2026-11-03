(function () {
  var kit = window.MinionFixture;
  var reset = kit.iso(2 * 60 * 60 * 1000);
  var used = kit.iso(-30 * 60 * 1000);
  window.__MINION_BOARD__ = kit.shell({
    tasks: [
      kit.task({
        task_id: "tsk-quota-old",
        minion: "codex",
        bot: "t06",
        title: "【假】把三张画叠在一起",
        task_type: "mg",
        started_at: kit.iso(-40 * 60 * 1000),
        ended_at: kit.iso(-28 * 60 * 1000),
        status: "degraded",
        degraded_to: "pi",
        fail_kind: "quota",
        fail_text: "Codex 额度用完",
        end_count: 1,
        start_event_id: "evt-quota-s",
        end_event_id: "evt-quota-e",
      }),
    ],
    codex_quota: {
      current: {
        state: "quota_exhausted",
        reset_at: reset,
        source: "quota_event",
        updated_at: used,
        time_unknown: false,
        raw: "You've hit your usage limit.",
        bot: "t06",
      },
      history: [
        { event_id: "evt-quota-h", ts: used, state: "quota_exhausted", reset_at: reset, raw: "", bot: "t06" },
      ],
    },
    seq: 4,
  });
})();
