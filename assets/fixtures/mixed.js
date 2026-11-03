(function () {
  var kit = window.MinionFixture;
  var hour = 60 * 60 * 1000;
  var titles = {
    codex: ["【假】给三只鸭涂编号", "【假】把云朵涂成紫色", "【假】给月亮写一封信", "【假】给星星补一顶帽子", "【假】给字母表涂颜色"],
    hermes: ["【假】向盆栽问一声好", "【假】宣布橡皮鸭放假", "【假】把笑话排成一张表", "【假】量一量云朵的距离", "【假】收集三句废话"],
    pi: ["【假】数五颗玻璃弹珠", "【假】改一块假招牌", "【假】把十二朵云涂紫", "【假】写三封给鸭子的信", "【假】想八个梦里的题目"],
  };
  var tasks = [];

  tasks.push(
    kit.task({
      task_id: "tsk-mix-codex-fail",
      minion: "codex",
      bot: "t05",
      title: "【假】把云朵涂成紫色",
      task_type: "consistency",
      model: "gpt-6.1-sol",
      started_at: kit.iso(-12 * 60 * 1000),
      ended_at: kit.iso(-2 * 60 * 1000),
      status: "failed",
      fail_kind: "error",
      fail_text: "【假】故意涂错的一笔",
      exit_code: 1,
      end_count: 1,
      start_event_id: "evt-mix-cf-s",
      end_event_id: "evt-mix-cf-e",
      threshold_s: 45 * 60,
    })
  );

  tasks.push(
    kit.task({
      task_id: "tsk-mix-fail",
      minion: "hermes",
      bot: "t05",
      title: "【假】向盆栽问一声好",
      task_type: "skill",
      host: "server",
      started_at: kit.iso(-8 * 60 * 1000),
      ended_at: kit.iso(-4 * 60 * 1000),
      status: "failed",
      fail_kind: "error",
      fail_text: "【假】门打不开，这是假错误",
      exit_code: 2,
      end_count: 1,
      start_event_id: "evt-mix-fail-s",
      end_event_id: "evt-mix-fail-e",
      threshold_s: 30 * 60,
    })
  );

  tasks.push(
    kit.task({
      task_id: "tsk-mix-stuck",
      minion: "pi",
      bot: "t06",
      title: "【假】数五颗玻璃弹珠",
      started_at: kit.iso(-25 * 60 * 1000),
      status: "running",
      start_event_id: "evt-mix-stuck",
      threshold_s: 20 * 60,
    })
  );

  tasks.push(
    kit.task({
      task_id: "tsk-chain-codex",
      minion: "codex",
      bot: "t06",
      title: "【假】把三张画叠在一起",
      task_type: "mg",
      model: "gpt-6.1-sol",
      started_at: kit.iso(-3.2 * hour),
      ended_at: kit.iso(-3 * hour),
      status: "degraded",
      degraded_to: "pi",
      fail_kind: "quota",
      fail_text: "Codex 额度用完",
      end_count: 1,
      start_event_id: "evt-chain-c-s",
      end_event_id: "evt-chain-c-e",
      route_ref: "rt-mix-chain",
      threshold_s: 45 * 60,
      route_match: {
        kind: "ref",
        count: 1,
        note: "",
        route: {
          ts: kit.iso(-3.3 * hour),
          bot: "t06",
          task_type: "mg",
          choice_id: "pi-deepseek-flash",
          choice_label: "pi",
          actual: "codex",
          actual_label: "Codex",
          confidence: 0.66,
          why: "【假】叠画时假装 Codex 更稳",
          why_missing: false,
          mismatch: true,
          route_id: "rt-mix-chain",
        },
      },
    })
  );

  tasks.push(
    kit.task({
      task_id: "tsk-chain-pi",
      minion: "pi",
      bot: "t06",
      title: "【假】把三张画叠好（转来的）",
      task_type: "mg",
      model: "deepseek-v4.1-flash",
      parent_task_id: "tsk-chain-codex",
      started_at: kit.iso(-3 * hour + 60 * 1000),
      ended_at: kit.iso(-2.5 * hour),
      status: "success",
      exit_code: 0,
      end_count: 1,
      start_event_id: "evt-chain-p-s",
      end_event_id: "evt-chain-p-e",
      route_ref: "rt-mix-chain",
      route_match: {
        kind: "ref",
        count: 1,
        note: "",
        route: {
          ts: kit.iso(-3.3 * hour),
          bot: "t06",
          task_type: "mg",
          choice_id: "pi-deepseek-flash",
          choice_label: "pi",
          actual: "pi",
          actual_label: "pi",
          confidence: 0.66,
          why: "",
          why_missing: false,
          mismatch: false,
          route_id: "rt-mix-chain",
        },
      },
    })
  );

  tasks.push(
    kit.task({
      task_id: "tsk-mix-noend",
      minion: "hermes",
      bot: "t05",
      title: "【假】量一量云朵的距离",
      started_at: kit.iso(-8 * hour),
      status: "running",
      start_event_id: "evt-mix-noend",
      threshold_s: 30 * 60,
    })
  );

  tasks.push(
    kit.task({
      task_id: "tsk-mix-smoke",
      minion: "pi",
      bot: "eggbot",
      title: "冒烟：写一句测试",
      task_type: "smoke",
      smoke: true,
      started_at: kit.iso(-1 * hour),
      ended_at: kit.iso(-50 * 60 * 1000),
      status: "success",
      end_count: 1,
      start_event_id: "evt-mix-smoke-s",
      end_event_id: "evt-mix-smoke-e",
    })
  );

  tasks.push(
    kit.task({
      task_id: "tsk-mix-guess",
      minion: "codex",
      bot: "t05",
      title: "【假】给字母表涂颜色",
      task_type: "consistency",
      started_at: kit.iso(-26 * hour),
      ended_at: kit.iso(-25 * hour),
      status: "success",
      end_count: 1,
      start_event_id: "evt-mix-guess-s",
      end_event_id: "evt-mix-guess-e",
      route_match: {
        kind: "guess",
        count: 1,
        note: "按时间推测对应这条路由，不一定准",
        route: {
          ts: kit.iso(-26 * hour - 2 * 60 * 1000),
          bot: "t05",
          task_type: "consistency",
          choice_id: "codex",
          choice_label: "Codex",
          actual: "codex",
          actual_label: "Codex",
          confidence: 0.81,
          why: "",
          why_missing: true,
          mismatch: false,
        },
      },
    })
  );

  var mins = ["codex", "hermes", "pi"];
  for (var i = 0; i < 55; i++) {
    var minion = mins[i % 3];
    var ended = i < 12 ? -(20 + i * 25) * 60 * 1000 : -((i - 11) * 3 * hour + 10 * hour);
    var dur = (6 + (i % 18)) * 60 * 1000;
    if (i === 2) dur = 50 * 60 * 1000;
    tasks.push(
      kit.task({
        task_id: "tsk-mix-" + i,
        minion: minion,
        bot: i % 2 ? "t06" : "t05",
        title: titles[minion][i % titles[minion].length],
        task_type: minion === "codex" ? "consistency" : "copy",
        model: minion === "codex" ? "gpt-6.1-sol" : minion === "pi" ? "deepseek-v4.1-flash" : "",
        started_at: kit.iso(ended - dur),
        ended_at: kit.iso(ended),
        status: "success",
        exit_code: 0,
        end_count: 1,
        start_event_id: "evt-mix-" + i + "-s",
        end_event_id: "evt-mix-" + i + "-e",
        threshold_s: minion === "codex" ? 45 * 60 : minion === "hermes" ? 30 * 60 : 20 * 60,
      })
    );
  }

  var reset = kit.iso(2 * hour);
  window.__MINION_BOARD__ = kit.shell({
    tasks: tasks,
    codex_quota: {
      current: {
        state: "quota_exhausted",
        reset_at: reset,
        source: "quota_event",
        updated_at: kit.iso(-40 * 60 * 1000),
        time_unknown: false,
        raw: "",
        bot: "t06",
      },
      history: [
        { event_id: "evt-mix-q1", ts: kit.iso(-5 * hour), state: "ok", reset_at: null, raw: "", bot: "t05" },
        { event_id: "evt-mix-q2", ts: kit.iso(-40 * 60 * 1000), state: "quota_exhausted", reset_at: reset, raw: "", bot: "t06" },
      ],
    },
    seq: 9,
  });
})();
