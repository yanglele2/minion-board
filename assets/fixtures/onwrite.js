(function () {
  var kit = window.MinionFixture;
  window.__MINION_BOARD__ = kit.shell({
    built_at: kit.iso(-2 * 60 * 60 * 1000),
    refresh_mode: "on_write",
    tasks: [
      kit.task({
        task_id: "tsk-onwrite",
        minion: "codex",
        bot: "t05",
        title: "【假】给月亮写一封信",
        started_at: kit.iso(-3 * 60 * 60 * 1000),
        status: "running",
        start_event_id: "evt-onwrite",
        threshold_s: 45 * 60,
      }),
    ],
    seq: 7,
  });
})();
