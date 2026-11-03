(function () {
  var kit = window.MinionFixture;
  window.__MINION_BOARD__ = kit.shell({
    codex_quota: {
      current: {
        state: "quota_exhausted",
        reset_at: null,
        source: "quota_event",
        updated_at: kit.iso(-20 * 60 * 1000),
        time_unknown: false,
        raw: "",
        bot: "t06",
      },
      history: [
        {
          event_id: "evt-qu",
          ts: kit.iso(-20 * 60 * 1000),
          state: "quota_exhausted",
          reset_at: null,
          raw: "",
          bot: "t06",
        },
      ],
    },
    seq: 5,
  });
})();
