(function () {
  var kit = window.MinionFixture;
  window.__MINION_BOARD__ = kit.shell({
    tasks: [
      kit.task({
        task_id: "tsk-stuck-pi",
        minion: "pi",
        bot: "t06",
        title: "【假】数五颗玻璃弹珠",
        started_at: kit.iso(-25 * 60 * 1000),
        status: "running",
        start_event_id: "evt-stuck-pi",
        threshold_s: 20 * 60,
      }),
    ],
    seq: 3,
  });
})();
