/* doubleplus.fund prototype — basic JS only: chrome injection, fake records,
   the venture templater, pixel charts, boot gate, margin-note wiring.
   No framework, no build step. */
(function () {
  "use strict";

  /* ------------------------------------------------------------
     RECORDS (fake, shaped like the live testnet data)
     Filing numbers are sequential WITH GAPS — skipped numbers are
     never reused (withdrawn before docketing).
     ------------------------------------------------------------ */
  var VENTURES = [
    { no: "0023", sym: "SPKW",   name: "SPEAKWRITE",         pitch: "Voice-to-affidavit stenography AI. Dictate anywhere; notarize on-chain.", phase: "raising",  raised: 8.42,  target: 9.0,  founder: 22, buy: 2.0, sell: 3.0, deadline: "3d 07h", addr: "0x51c0a9b2ee4463f0d1b0a4663c9e2f7a8b3d4663", holders: 214, seed: 9 },
    { no: "0021", sym: "WATCH",  name: "TELESCREEN+",        pitch: "Two-way household streaming hardware. It watches back, as a service.", phase: "raising",  raised: 3.11,  target: 12.0, founder: 15, buy: 1.0, sell: 4.0, deadline: "6d 19h", addr: "0x77aa19c3d24d1f00b3aa27cbf171db8691920021", holders: 96,  seed: 4 },
    { no: "0016", sym: "VICGIN", name: "VICTORY GIN",        pitch: "Algorithmic distillery. Ration-grade spirits, dynamically priced by despair index.", phase: "raising",  raised: 1.02,  target: 6.0,  founder: 30, buy: 4.0, sell: 4.0, deadline: "11d 02h", addr: "0x0bd7d3c8f8e1639fab988df18a8011f41eac0016", holders: 41,  seed: 2 },
    { no: "0012", sym: "R101",   name: "ROOM 101 LABS",      pitch: "Fear-indexed prediction markets. Wagers settle on what you dread most.", phase: "raising",  raised: 5.96,  target: 6.0,  founder: 18, buy: 0.0, sell: 2.5, deadline: "22h 40m", addr: "0x8366a39cc670b4001a1121b8f6a443a643e40012", holders: 188, seed: 7 },
    { no: "0011", sym: "FICDEP", name: "FICTION DEPARTMENT", pitch: "Procedural novel machine. Six plots, infinite paperbacks, zero authors.", phase: "graduated", raised: 10.0, target: 10.0, founder: 25, buy: 2.0, sell: 2.0, price: 0.00000481, change: +12.4, vol24: 3.92, addr: "0x93acce31b154d5225de7608a8b264da825060011", holders: 517, seed: 11 },
    { no: "0007", sym: "PLENTY", name: "PLENTYWORKS",        pitch: "Chocolate-ration futures. The ration was raised to twenty grammes. It was.", phase: "graduated", raised: 14.5, target: 14.5, founder: 12, buy: 1.5, sell: 1.5, price: 0.00001260, change: -3.1,  vol24: 6.51, addr: "0x5b288e589d0c82149295045edcbc466cd0220007", holders: 903, seed: 5 },
    { no: "0004", sym: "HOLE",   name: "MEMORYHOLE",         pitch: "Self-deleting cloud storage. Retention policy: none. Compliance: total.", phase: "graduated", raised: 7.77, target: 7.77, founder: 20, buy: 3.0, sell: 3.0, price: 0.00000094, change: +48.9, vol24: 11.08, addr: "0xdea6209c26fcb5a77b3941fa63464e1c59fc0004", holders: 1341, seed: 13 },
    { no: "0002", sym: "GONE",   name: "UNPERSON",           pitch: "Full-service biographical scrubbing. You were never here.", phase: "failed",    raised: 0.88, target: 8.0, founder: 28, buy: 4.0, sell: 4.0, addr: "0x24a95e1b6d62e06eb3928913b1601af07ff50002", holders: 27, seed: 3 },
    { no: "0001", sym: "FEED",   name: "PROLEFEED",          pitch: "Infinite content firehose for the masses. Engagement is compulsory.", phase: "failed",    raised: 2.04, target: 20.0, founder: 30, buy: 4.0, sell: 4.0, addr: "0x5346fddce64e39c00090369e1486de20d6210001", holders: 66, seed: 6 }
  ];

  var EPOCHS = [
    { n: 3, week: "W37 · 8–14 SEP 2026", vol: "41.208", pot: "0.412",
      burns: [["HOLE", "0.0824 ETH → 61,204,118 burned"], ["PLENTY", "0.0494 ETH → 3,921,566 burned"], ["FICDEP", "0.0330 ETH → 6,861,412 burned"]],
      rebates: [["0x1B97…Acce", "0.0257"], ["0x9F02…77b1", "0.0198"], ["0x33e4…0B94", "0.0141"], ["0xCaf6…5cb2", "0.0117"], ["0x0812…d2aa", "0.0093"]],
      makers: [["0x6A55…19c0", "0.0714"], ["0xE901…44af", "0.0522"]] },
    { n: 2, week: "W36 · 1–7 SEP 2026", vol: "27.443", pot: "0.274",
      burns: [["PLENTY", "0.0549 ETH → 4,406,020 burned"], ["HOLE", "0.0329 ETH → 27,010,944 burned"], ["SPKW", "0.0219 ETH → curve buy, escrowed"]],
      rebates: [["0x9F02…77b1", "0.0176"], ["0x1B97…Acce", "0.0148"], ["0x77aa…0021", "0.0090"]],
      makers: [] },
    { n: 1, week: "W35 · 25–31 AUG 2026", vol: "9.017", pot: "0.090",
      burns: [["HOLE", "0.0180 ETH → 15,220,371 burned"], ["FICDEP", "0.0108 ETH → 2,204,187 burned"], ["PLENTY", "0.0072 ETH → 571,914 burned"]],
      rebates: [["0x1B97…Acce", "0.0135"], ["0x6A55…19c0", "0.0067"]],
      makers: [] }
  ];

  var PAGES = [
    ["index.html",    "The Docket"],
    ["launch.html",   "Form DP-1"],
    ["desk.html",     "Personal Effects"],
    ["flywheel.html", "The Gazette"],
    ["stats.html",    "Records Office"],
    ["handbook.html", "Handbook"]
  ];

  var STAMPS = {
    raising:   { cls: "blue",   top: "PROVISIONAL",     sub: "SUBJECT TO COMPLETION" },
    funded:    { cls: "",       top: "DOUBLEPLUSGOOD",  sub: "TARGET ATTAINED" },
    graduated: { cls: "",       top: "IN CIRCULATION",  sub: "LIQUIDITY PERPETUAL" },
    failed:    { cls: "red",    top: "MEMORY-HOLED",    sub: "REFUNDS OWED IN FULL" }
  };

  function pct(v) { return Math.min(100, Math.round(v.raised / v.target * 100)); }
  function phaseOf(v) { return v.phase === "raising" && pct(v) >= 100 ? "funded" : v.phase; }
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

  /* seeded pseudo-random walk for charts */
  function walk(seed, n, drift) {
    var x = seed * 2654435761 % 4294967296, out = [], v = 40;
    for (var i = 0; i < n; i++) {
      x = (1103515245 * x + 12345) % 2147483648;
      v = Math.max(4, Math.min(92, v + ((x / 2147483648) - 0.5 + (drift || 0)) * 14));
      out.push(v);
    }
    return out;
  }

  /* pixelated step sparkline */
  function spark(seed, w, h, up) {
    var pts = walk(seed, 24, up ? 0.06 : -0.05), bw = w / pts.length, s = "";
    for (var i = 0; i < pts.length; i++) {
      var y = h - (pts[i] / 100) * h;
      s += '<rect x="' + (i * bw).toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + Math.max(1, bw - 1).toFixed(1) + '" height="2.4" fill="currentColor"/>';
    }
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '" aria-hidden="true" style="color:' + (up ? "var(--phosphor)" : "#d98a8a") + '">' + s + "</svg>";
  }

  /* pixel candles for the dossier telescreen */
  function candles(seed, w, h) {
    var n = 42, pts = walk(seed, n + 1, 0.04), cw = w / n, s = "";
    for (var i = 0; i < n; i++) {
      var o = pts[i], c = pts[i + 1], up = c >= o;
      var top = h - Math.max(o, c) / 100 * h, bh = Math.max(2, Math.abs(c - o) / 100 * h);
      var wickT = top - 4 - (i % 5), wickB = top + bh + 3 + (i % 4);
      var col = up ? "var(--phosphor)" : "#d98a8a";
      s += '<rect x="' + (i * cw + cw / 2 - 0.7).toFixed(1) + '" y="' + Math.max(0, wickT).toFixed(1) + '" width="1.4" height="' + (wickB - wickT).toFixed(1) + '" fill="' + col + '" opacity=".55"/>';
      s += '<rect x="' + (i * cw + 1).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + (cw - 2.4).toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="' + (up ? col : "none") + '" stroke="' + col + '" stroke-width="1.2"/>';
    }
    return '<svg class="px" width="100%" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" style="height:' + h + 'px">' + s + "</svg>";
  }

  /* ------------------------------------------------------------
     CHROME: filters, ticker, masthead, tabs, footer, boot
     ------------------------------------------------------------ */
  function filterDefs() {
    return '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
      '<filter id="roughen" x="-8%" y="-8%" width="116%" height="116%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.11" numOctaves="2" seed="3" result="n"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="3.4"/></filter>' +
      '<filter id="roughen2" x="-10%" y="-10%" width="120%" height="120%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="3" seed="11" result="n"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="5.5"/></filter>' +
      "</defs></svg>";
  }

  function tickerHTML() {
    var items = [], i, v;
    for (i = 0; i < VENTURES.length; i++) {
      v = VENTURES[i];
      if (v.phase === "graduated") {
        items.push("<b>$" + v.sym + "</b> " + v.price.toFixed(8) + ' <span class="' + (v.change >= 0 ? "up" : "dn") + '">' + (v.change >= 0 ? "▲" : "▼") + Math.abs(v.change).toFixed(1) + "%</span>");
      } else if (v.phase === "raising") {
        items.push("<b>№" + v.no + " $" + v.sym + "</b> raise " + pct(v) + "% · " + v.deadline + " left");
      }
    }
    items.push("<b>WEEKLY FLYWHEEL</b> epoch 3 settled: 0.412 ETH · burned 3 · rebated 5 · makers paid 2");
    items.push('<b>MINISTRY NOTICE</b> the dividend ration has been raised to twenty grammes. <span class="up">doubleplusgood.</span>');
    var reel = items.join(" &nbsp;&nbsp;│&nbsp;&nbsp; ");
    return '<div class="ticker" role="marquee" aria-label="market ticker"><div class="ticker-reel">' + reel + " &nbsp;&nbsp;│&nbsp;&nbsp; " + reel + "</div></div>";
  }

  function chromeTop(current) {
    var today = "16 SEP 2026";
    var tabs = "";
    for (var i = 0; i < PAGES.length; i++) {
      var cur = PAGES[i][0] === current ? ' aria-current="page"' : "";
      tabs += '<a href="' + PAGES[i][0] + '"' + cur + ">" + PAGES[i][1] + "</a>";
    }
    return filterDefs() + tickerHTML() +
      '<header class="masthead"><div class="shell">' +
      '<div><a class="brand" href="index.html">doubleplus<sub>.fund</sub></a>' +
      '<p class="ministry-line">Ministry of Plenty — Directorate of New Ventures — Robinhood Chain 46630</p></div>' +
      '<div class="mast-cell">FILE UNDER: PLENTY / VENTURES<br>' + today + " · AIRSTRIP ONE<br><br>" +
      '<button class="connect" id="connect">Present Papers</button></div>' +
      "</div></header>" +
      '<nav class="tabs"><div class="shell">' + tabs + "</div></nav>";
  }

  function chromeFoot(formNo) {
    return '<footer class="footer"><div class="shell">' +
      "<span>FORM " + (formNo || "DP-0") + " REV. 9/26</span>" +
      "<span>RETAIN THIS COPY FOR YOUR RECORDS</span>" +
      '<span class="stamp" style="--stamp-angle:-2deg">archivist: w.s.</span>' +
      '<span><a href="https://explorer.testnet.chain.robinhood.com" target="_blank" rel="noreferrer">public ledger ↗</a></span>' +
      "<span>unregistered instruments · unaudited machinery · back only what you can lose</span>" +
      '<span class="gap-note">missing filing numbers were withdrawn before docketing and are never reused.</span>' +
      "</div></footer>";
  }

  function bootHTML() {
    return '<div id="boot"><div class="tube"><h1>MINISTRY OF PLENTY</h1>' +
      "<p>DIRECTORATE OF NEW VENTURES — TELESCREEN SERVICE</p>" +
      '<p data-t="bootline">warming tube … syncing ledger 46630 … ALL FIGURES DOUBLEPLUSGOOD</p>' +
      '<p class="cursor"></p><button id="boot-skip">PROCEED [⏎]</button></div></div>';
  }

  function boot() {
    var done = false;
    try { if (sessionStorage.getItem("dp_boot")) return; } catch (e) { return; }
    document.body.insertAdjacentHTML("afterbegin", bootHTML());
    var el = document.getElementById("boot");
    function off() {
      if (done) return; done = true;
      try { sessionStorage.setItem("dp_boot", "1"); } catch (e) {}
      el.classList.add("off");
    }
    document.getElementById("boot-skip").addEventListener("click", off);
    window.addEventListener("keydown", off, { once: true });
    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(off, reduced ? 400 : 2600);
  }

  /* margin-note popovers: wire anchors */
  function notes() {
    var fns = document.querySelectorAll(".fn[popovertarget]");
    for (var i = 0; i < fns.length; i++) {
      var b = fns[i], id = b.getAttribute("popovertarget"), note = document.getElementById(id);
      if (!note) continue;
      var an = "--fn-" + id;
      b.style.anchorName = an;
      note.style.setProperty("--anchor", an);
      if (!note.dataset.ref) note.dataset.ref = b.textContent.trim();
    }
  }

  /* speculation rules: prerender sibling pages (MPA-only tech) */
  function speculate() {
    try {
      var urls = [], i;
      for (i = 0; i < PAGES.length; i++) if (!location.pathname.endsWith(PAGES[i][0])) urls.push(PAGES[i][0]);
      var s = document.createElement("script");
      s.type = "speculationrules";
      s.textContent = JSON.stringify({ prefetch: [{ urls: urls, eagerness: "moderate" }] });
      document.head.appendChild(s);
    } catch (e) {}
  }

  function connectWire() {
    var b = document.getElementById("connect");
    if (!b) return;
    b.addEventListener("click", function () {
      document.body.classList.add("busy");
      setTimeout(function () {
        document.body.classList.remove("busy");
        b.textContent = "0x1B97…Acce";
        b.style.rotate = "0deg";
      }, 900);
    });
  }

  /* ------------------------------------------------------------
     PUBLIC
     ------------------------------------------------------------ */
  window.DP = {
    VENTURES: VENTURES,
    EPOCHS: EPOCHS,
    STAMPS: STAMPS,
    pct: pct,
    phaseOf: phaseOf,
    esc: esc,
    spark: spark,
    candles: candles,
    walk: walk,
    page: function (opts) {
      document.body.insertAdjacentHTML("afterbegin", chromeTop(opts.current));
      document.body.insertAdjacentHTML("beforeend", chromeFoot(opts.form));
      boot();
      speculate();
      connectWire();
      /* defer note wiring until page content scripts ran */
      setTimeout(notes, 0);
    },
    notes: notes
  };
})();
