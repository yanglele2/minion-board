(function () {
  var kit = window.MinionFixture;
  var tasks = [
    kit.task({
      task_id: "tsk-live-codex",
      minion: "codex",
      bot: "t05",
      title: "【假数据】数十二只橡皮鸭的帽子、颜色、间距和编号，一次改好别漏，纯属虚构演示专用",
      task_type: "consistency",
      model: "gpt-6.1-sol",
      started_at: kit.iso(-8 * 60 * 1000),
      status: "running",
      start_event_id: "evt-live-codex",
      threshold_s: 45 * 60,
    }),
    kit.task({
      task_id: "tsk-live-hermes",
      minion: "hermes",
      bot: "t05",
      title: "【假】向盆栽问一声好",
      task_type: "skill",
      host: "server",
      started_at: kit.iso(-5 * 60 * 1000),
      status: "running",
      start_event_id: "evt-live-hermes",
      threshold_s: 30 * 60,
    }),
    kit.task({
      task_id: "tsk-live-pi-1",
      minion: "pi",
      bot: "t06",
      title: "【假】数五颗玻璃弹珠",
      model: "deepseek-v4.1-flash",
      started_at: kit.iso(-6 * 60 * 1000),
      status: "running",
      start_event_id: "evt-live-pi-1",
    }),
    kit.task({
      task_id: "tsk-live-pi-2",
      minion: "pi",
      bot: "t06",
      title: "【假】改一块假招牌",
      started_at: kit.iso(-4 * 60 * 1000),
      status: "running",
      start_event_id: "evt-live-pi-2",
    }),
    kit.task({
      task_id: "tsk-live-pi-3",
      minion: "pi",
      bot: "t05",
      title: "【假】把十二朵云涂紫",
      started_at: kit.iso(-2 * 60 * 1000),
      status: "running",
      start_event_id: "evt-live-pi-3",
    }),
  ];
  window.__MINION_BOARD__ = kit.shell({
    tasks: tasks,
    codex_quota: {
      current: {
        state: "ok",
        reset_at: null,
        source: "quota_event",
        updated_at: kit.iso(-60 * 60 * 1000),
        time_unknown: false,
        raw: "",
        bot: "t05",
      },
      history: [
        { event_id: "evt-live-q", ts: kit.iso(-60 * 60 * 1000), state: "ok", reset_at: null, raw: "", bot: "t05" },
      ],
    },
    seq: 2,
  });
})();
