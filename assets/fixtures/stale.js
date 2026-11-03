(function () {
  var kit = window.MinionFixture;
  window.__MINION_BOARD__ = kit.shell({
    built_at: kit.iso(-20 * 60 * 1000),
    refresh_mode: "watch",
    tasks: [
      kit.task({
        task_id: "tsk-stale-run",
        minion: "hermes",
        bot: "t05",
        title: "【假】宣布橡皮鸭放假",
        started_at: kit.iso(-12 * 60 * 1000),
        status: "running",
        start_event_id: "evt-stale",
        threshold_s: 30 * 60,
      }),
    ],
    seq: 6,
  });
})();
