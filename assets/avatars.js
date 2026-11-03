/* 三个手下的几何头像。只靠形状区分：扣扣是方的，赫米有尖耳朵，派派是圆水滴。 */
(function () {
  var INK = "#1E2235";

  function cheek(cx) {
    return (
      '<ellipse class="cheek" cx="' +
      cx +
      '" cy="58" rx="4" ry="2.5" fill="#FF9AA8" fill-opacity="0.6"/>'
    );
  }

  function eyes(kind) {
    if (kind === "idle") {
      return (
        '<path d="M34 52 H44 M54 52 H64" fill="none" stroke="' +
        INK +
        '" stroke-width="3" stroke-linecap="round"/>'
      );
    }
    if (kind === "working") {
      return (
        '<rect x="34" y="44" width="10" height="10" rx="1.5" fill="' +
        INK +
        '"/><rect x="54" y="44" width="10" height="10" rx="1.5" fill="' +
        INK +
        '"/>'
      );
    }
    if (kind === "success") {
      return (
        '<path d="M33 54 L38 47 L43 54 M55 54 L60 47 L65 54" fill="none" stroke="' +
        INK +
        '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
      );
    }
    if (kind === "fail") {
      return (
        '<path d="M34 46 L44 56 M44 46 L34 56 M54 46 L64 56 M64 46 L54 56" fill="none" stroke="' +
        INK +
        '" stroke-width="3" stroke-linecap="round"/>'
      );
    }
    return (
      '<path d="M34 52 H44 M54 52 H64" fill="none" stroke="' +
      INK +
      '" stroke-width="3" stroke-linecap="round"/>'
    );
  }

  function hermesEyes(kind) {
    if (kind === "idle") {
      return (
        '<path d="M32 52 Q38 58 44 52 M54 52 Q60 58 66 52" fill="none" stroke="' +
        INK +
        '" stroke-width="3" stroke-linecap="round"/>'
      );
    }
    if (kind === "working") {
      return (
        '<circle cx="38" cy="50" r="4.5" fill="' +
        INK +
        '"/><circle cx="60" cy="50" r="4.5" fill="' +
        INK +
        '"/><circle cx="39.5" cy="48.5" r="1.4" fill="#fff"/><circle cx="61.5" cy="48.5" r="1.4" fill="#fff"/>'
      );
    }
    if (kind === "success") {
      return (
        '<path d="M32 54 L38 46 L44 54 M54 54 L60 46 L66 54" fill="none" stroke="' +
        INK +
        '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
      );
    }
    if (kind === "fail") {
      return (
        '<path d="M34 48 Q38 54 42 48 M56 48 Q60 54 64 48 M40 50 V56 M62 50 V56" fill="none" stroke="' +
        INK +
        '" stroke-width="3" stroke-linecap="round"/>'
      );
    }
    return (
      '<path d="M34 52 H44 M56 52 H66" fill="none" stroke="' +
      INK +
      '" stroke-width="3" stroke-linecap="round"/>'
    );
  }

  function piEyes(kind) {
    if (kind === "idle") {
      return (
        '<path d="M32 50 H42 M54 50 H64" fill="none" stroke="' +
        INK +
        '" stroke-width="3" stroke-linecap="round"/>'
      );
    }
    if (kind === "working") {
      return (
        '<path d="M30 44 L40 50 L30 56 M66 44 L56 50 L66 56" fill="none" stroke="' +
        INK +
        '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
      );
    }
    if (kind === "success") {
      return (
        '<path d="M30 54 L36 46 L42 54 M54 54 L60 46 L66 54" fill="none" stroke="' +
        INK +
        '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
      );
    }
    if (kind === "fail") {
      return (
        '<text x="34" y="56" font-size="14" font-weight="700" fill="' +
        INK +
        '">@</text><text x="54" y="56" font-size="14" font-weight="700" fill="' +
        INK +
        '">@</text>'
      );
    }
    return (
      '<path d="M32 52 H44 M54 52 H66" fill="none" stroke="' +
      INK +
      '" stroke-width="3" stroke-linecap="round"/>'
    );
  }

  function faceGroup(name, painter) {
    var states = ["idle", "working", "success", "fail", "rest"];
    return states
      .map(function (state) {
        return '<g class="face face-' + state + '">' + painter(state) + "</g>";
      })
      .join("");
  }

  function codex() {
    return (
      '<g class="avatar-body">' +
      '<rect x="28" y="78" width="40" height="14" rx="6" class="fill-shape"/>' +
      '<path class="prop" d="M70 80 H78 L76 88 H72 Z" fill="#fff" stroke="' +
      INK +
      '" stroke-width="2" stroke-linejoin="round"/>' +
      '<rect x="16" y="26" width="64" height="54" rx="14" class="fill-shape"/>' +
      '<line x1="48" y1="26" x2="48" y2="16" stroke="' +
      INK +
      '" stroke-width="2" stroke-linecap="round"/>' +
      '<circle class="bulb" cx="48" cy="12" r="4" stroke="' +
      INK +
      '" stroke-width="2"/>' +
      '<rect x="26" y="36" width="44" height="28" rx="8" fill="#fff" stroke="' +
      INK +
      '" stroke-width="2"/>' +
      cheek(36) +
      cheek(60) +
      faceGroup("codex", eyes) +
      "</g>" +
      '<g class="only-working" transform="translate(80 34)"><g class="gear">' +
      '<circle r="6" fill="#FFC83D" stroke="' +
      INK +
      '" stroke-width="2"/>' +
      '<path d="M0 -9 V-6 M0 6 V9 M-9 0 H-6 M6 0 H9 M-6 -6 L-4 -4 M6 6 L4 4 M-6 6 L-4 4 M6 -6 L4 -4" stroke="' +
      INK +
      '" stroke-width="2" stroke-linecap="round"/>' +
      "</g></g>" +
      '<g class="only-success">' +
      '<path d="M74 70 C78 64 86 66 84 74 C80 78 74 76 74 70 Z" fill="#2EB872" stroke="' +
      INK +
      '" stroke-width="2"/>' +
      "</g>" +
      '<g class="only-fail">' +
      '<circle cx="70" cy="22" r="4" fill="#8A94A8" stroke="' +
      INK +
      '" stroke-width="2"/><circle cx="78" cy="14" r="3" fill="#C5CAD6"/>' +
      "</g>" +
      '<g class="only-rest zzz">' +
      '<rect x="36" y="84" width="24" height="8" rx="2" fill="#fff" stroke="' +
      INK +
      '" stroke-width="2"/>' +
      '<rect x="38" y="86" width="5" height="4" fill="#2EB872"/>' +
      '<text x="66" y="24" font-size="12" font-weight="800" fill="' +
      INK +
      '">zZ</text>' +
      "</g>" +
      '<g class="qmark"><circle cx="78" cy="22" r="8" fill="#FFF1D6" stroke="#8F5300" stroke-width="2"/>' +
      '<text x="78" y="26" text-anchor="middle" font-size="12" font-weight="800" fill="#8F5300">?</text></g>'
    );
  }

  function hermes() {
    return (
      '<g class="avatar-body">' +
      '<path class="tail" d="M18 70 Q8 84 20 88" fill="none" stroke-width="6" stroke-linecap="round" class="fill-stroke"/>' +
      '<g class="ears"><polygon points="30,40 38,16 46,40" class="fill-shape"/><polygon points="52,40 60,16 68,40" class="fill-shape"/></g>' +
      '<ellipse class="wing wing-l" cx="20" cy="58" rx="8" ry="5" fill="#fff" stroke="' +
      INK +
      '" stroke-width="3"/>' +
      '<ellipse class="wing wing-r" cx="76" cy="58" rx="8" ry="5" fill="#fff" stroke="' +
      INK +
      '" stroke-width="3"/>' +
      '<ellipse cx="48" cy="54" rx="30" ry="26" class="fill-shape"/>' +
      '<ellipse cx="48" cy="66" rx="12" ry="7" fill="#FFF3E8" stroke="' +
      INK +
      '" stroke-width="2"/>' +
      cheek(34) +
      cheek(62) +
      faceGroup("hermes", hermesEyes) +
      "</g>" +
      '<g class="only-working only-success mail">' +
      '<rect x="62" y="28" width="16" height="12" rx="2" fill="#fff" stroke="' +
      INK +
      '" stroke-width="2"/>' +
      '<path d="M62 30 L70 36 L78 30" fill="none" stroke="' +
      INK +
      '" stroke-width="2"/>' +
      "</g>" +
      '<g class="only-fail mail-drop">' +
      '<rect x="66" y="74" width="16" height="12" rx="2" fill="#fff" stroke="' +
      INK +
      '" stroke-width="2" transform="rotate(18 74 80)"/>' +
      "</g>" +
      '<g class="only-rest zzz"><text x="64" y="28" font-size="12" font-weight="800" fill="' +
      INK +
      '">zZ</text></g>' +
      '<g class="qmark"><circle cx="78" cy="24" r="8" fill="#FFF1D6" stroke="#8F5300" stroke-width="2"/>' +
      '<text x="78" y="28" text-anchor="middle" font-size="12" font-weight="800" fill="#8F5300">?</text></g>'
    );
  }

  function pi() {
    return (
      '<g class="avatar-body">' +
      '<path class="drop fill-shape" d="M48 20 C48 20 80 46 80 66 A32 28 0 1 1 16 66 C16 46 48 20 48 20 Z"/>' +
      '<path class="ahoge ahoge-up" d="M48 20 C54 10 60 12 58 6" fill="none" stroke="' +
      INK +
      '" stroke-width="3" stroke-linecap="round"/>' +
      '<path class="ahoge ahoge-down" d="M46 22 C40 12 32 16 34 24" fill="none" stroke="' +
      INK +
      '" stroke-width="3" stroke-linecap="round"/>' +
      cheek(34) +
      cheek(62) +
      faceGroup("pi", piEyes) +
      '<text class="pi-mark" x="48" y="80" text-anchor="middle" font-size="18" font-weight="800">π</text>' +
      '<path class="prop" d="M70 70 L76 78 H72 L74 86 H68 L70 78 H66 Z" fill="#FFC83D" stroke="' +
      INK +
      '" stroke-width="2" stroke-linejoin="round"/>' +
      "</g>" +
      '<g class="only-success">' +
      '<path d="M18 30 L22 38 L30 38 L24 44 L26 52 L18 46 L10 52 L12 44 L6 38 L14 38 Z" fill="#FFC83D" stroke="' +
      INK +
      '" stroke-width="2"/>' +
      '<path d="M78 26 L80 32 L86 32 L81 36 L83 42 L78 38 L73 42 L75 36 L70 32 L76 32 Z" fill="#2EB872" stroke="' +
      INK +
      '" stroke-width="2"/>' +
      "</g>" +
      '<g class="only-rest zzz"><text x="66" y="24" font-size="12" font-weight="800" fill="' +
      INK +
      '">zZ</text></g>' +
      '<g class="qmark"><circle cx="78" cy="28" r="8" fill="#FFF1D6" stroke="#8F5300" stroke-width="2"/>' +
      '<text x="78" y="32" text-anchor="middle" font-size="12" font-weight="800" fill="#8F5300">?</text></g>'
    );
  }

  var DRAW = { codex: codex, hermes: hermes, pi: pi };
  var NAME = { codex: "Codex", hermes: "Hermes", pi: "pi" };
  var EXPR = {
    idle: "空闲",
    working: "工作中",
    success: "刚做完",
    fail: "失败",
    rest: "在休息",
  };

  function svg(minion) {
    return (
      '<svg class="avatar-svg" viewBox="0 0 96 96" focusable="false" aria-hidden="true">' +
      DRAW[minion]() +
      "</svg>"
    );
  }

  function html(minion, state, size, stuck) {
    var label = NAME[minion] + "，" + (stuck ? "可能卡住" : EXPR[state] || "空闲");
    return (
      '<span class="avatar" data-minion="' +
      minion +
      '" data-state="' +
      state +
      '" data-stuck="' +
      (stuck ? "1" : "0") +
      '" style="width:' +
      size +
      "px;height:" +
      size +
      'px" role="img" aria-label="' +
      label +
      '">' +
      svg(minion) +
      "</span>"
    );
  }

  window.MinionAvatar = {
    html: html,
    svg: svg,
    names: NAME,
  };
})();
