/* doubleplus.fund prototype — basic JS only: chrome injection, sample records,
   the launch-page templater, pixel charts, popover wiring.
   No framework, no build step. */
(function () {
  "use strict";

  /* ------------------------------------------------------------
     SAMPLE RECORDS (fake, shaped like the live testnet data)
     ------------------------------------------------------------ */
  var VENTURES = [
    { no: "0023", sym: "SCRB",  name: "SCRIBE",         pitch: "Voice-to-contract transcription AI, notarized on-chain.", cat: "AI · legal", by: "ana@scribe", phase: "raising", raised: 8.42, target: 9.0, founder: 22, buy: 2.0, sell: 3.0, deadline: "3d 07h", addr: "0x51c0a9b2ee4463f0d1b0a4663c9e2f7a8b3d4663", holders: 214, seed: 9,
      about: ["Every verbal agreement dies in a follow-up email nobody sends. Scribe listens to a call, drafts the contract in real time, and notarizes the signed hash on-chain — so the deal you shook on is the deal on record.", "We have a working prototype transcribing two-party calls with 96% clause accuracy and a waitlist of 40 freelancer collectives. This raise funds the mobile app and the notary contract audit."],
      funds: "60% engineering (two hires), 25% notary-contract audit, 15% pilot with three freelancer collectives.",
      milestones: [["Prototype: live call → draft contract", true], ["Waitlist of 40 collectives", true], ["Mobile app beta", false], ["Notary contract audit", false], ["First 1,000 notarized contracts", false]] },
    { no: "0021", sym: "HAULR", name: "HAULR",          pitch: "Autonomous last-mile cargo bikes as a service.", cat: "hardware · logistics", by: "jt@haulr", phase: "raising", raised: 3.11, target: 12.0, founder: 15, buy: 1.0, sell: 4.0, deadline: "6d 19h", addr: "0x77aa19c3d24d1f00b3aa27cbf171db8691920021", holders: 96, seed: 4,
      about: ["Vans are the wrong tool for the last mile. Haulr's electric cargo bikes drive themselves between micro-depots at night and get pedaled by couriers by day — one fleet, two shifts, half the cost per parcel.", "Two prototype bikes have run 1,400 autonomous depot-to-depot km. The raise buys a ten-bike pilot fleet for one city district."],
      funds: "70% pilot fleet (10 bikes), 20% depot leases, 10% safety certification.",
      milestones: [["2 prototypes, 1,400 autonomous km", true], ["City pilot permit", false], ["10-bike fleet live", false], ["Cost per parcel under €0.90", false]] },
    { no: "0016", sym: "BREW",  name: "COLDBREW LABS",  pitch: "Robotic nitro-brew kiosks for transit hubs.", cat: "consumer · robotics", by: "marek@coldbrew", phase: "raising", raised: 1.02, target: 6.0, founder: 30, buy: 4.0, sell: 4.0, deadline: "11d 02h", addr: "0x0bd7d3c8f8e1639fab988df18a8011f41eac0016", holders: 41, seed: 2,
      about: ["A barista-free kiosk that pours a perfect nitro cold brew in 40 seconds, sited where the queues are: metro stations and airports. One kiosk clears its own cost in about seven months at 180 cups a day.", "Kiosk #1 has been pouring at a Warsaw metro exit for two months. This raise builds three more and a small roastery contract."],
      funds: "65% three kiosks, 20% roastery contract, 15% maintenance tooling.",
      milestones: [["Kiosk #1 live, 11k cups poured", true], ["Three-kiosk expansion", false], ["Airport concession", false]] },
    { no: "0012", sym: "ORCL",  name: "ORACLEYARD",     pitch: "Prediction markets settled by sensor networks, not juries.", cat: "infra · data", by: "field@oracleyard", phase: "raising", raised: 5.96, target: 6.0, founder: 18, buy: 0.0, sell: 2.5, deadline: "22h 40m", addr: "0x8366a39cc670b4001a1121b8f6a443a643e40012", holders: 188, seed: 7,
      about: ["Markets about the physical world shouldn't be settled by a vote. Oracleyard settles them with signed readings from weather stations, traffic loops and grid meters — hardware attestations instead of committee outcomes.", "The sensor-attestation contract is deployed and reading 30 stations. This raise funds 200 more stations and the dispute layer."],
      funds: "55% sensor network expansion, 30% dispute-layer development, 15% operations.",
      milestones: [["Attestation contract live, 30 stations", true], ["200-station network", false], ["Dispute layer", false], ["First weather derivatives market", false]] },
    { no: "0011", sym: "PAGE",  name: "PAGEFORGE",      pitch: "AI serial-fiction studio; readers own the back catalog.", cat: "media", by: "iris@pageforge", phase: "graduated", raised: 10.0, target: 10.0, founder: 25, buy: 2.0, sell: 2.0, price: 0.00000481, change: +12.4, vol24: 3.92, addr: "0x93acce31b154d5225de7608a8b264da825060011", holders: 517, seed: 11,
      about: ["Serialized fiction with a twist: the readers who fund a series own its back catalog and share its licensing revenue. Three series running, 9,000 weekly readers."],
      funds: "Raise funded two new series and the licensing marketplace (shipped).",
      milestones: [["Three series live", true], ["9,000 weekly readers", true], ["Licensing marketplace", true], ["First TV option deal", false]] },
    { no: "0007", sym: "CACAO", name: "COCOAWORKS",     pitch: "Direct-to-grower chocolate futures with on-chain settlement.", cat: "commodities", by: "kofi@cocoaworks", phase: "graduated", raised: 14.5, target: 14.5, founder: 12, buy: 1.5, sell: 1.5, price: 0.00001260, change: -3.1, vol24: 6.51, addr: "0x5b288e589d0c82149295045edcbc466cd0220007", holders: 903, seed: 5,
      about: ["Growers sell next season's cocoa directly to buyers as on-chain futures, skipping four layers of intermediaries. 212 growers onboarded across two cooperatives; first harvest settled in full this August."],
      funds: "Raise funded co-op onboarding and the settlement escrow (shipped).",
      milestones: [["Two cooperatives, 212 growers", true], ["First harvest settled", true], ["Third cooperative", false]] },
    { no: "0004", sym: "VAULT", name: "ZEROVAULT",      pitch: "Self-expiring cloud storage for compliance teams.", cat: "SaaS · security", by: "kim@zerovault", phase: "graduated", raised: 7.77, target: 7.77, founder: 20, buy: 3.0, sell: 3.0, price: 0.00000094, change: +48.9, vol24: 11.08, addr: "0xdea6209c26fcb5a77b3941fa63464e1c59fc0004", holders: 1341, seed: 13,
      about: ["Storage where deletion is the feature: every object carries a cryptographic expiry, and expiry is provable to an auditor. 14 paying compliance teams, €8.2k MRR, growing 20% monthly."],
      funds: "Raise funded SOC 2 audit and enterprise SSO (shipped).",
      milestones: [["14 paying teams", true], ["SOC 2 Type I", true], ["SOC 2 Type II", false]] },
    { no: "0002", sym: "WIPE",  name: "CLEANSLATE",     pitch: "Automated personal-data deletion, subscription model.", cat: "consumer · privacy", by: "sam@cleanslate", phase: "failed", raised: 0.88, target: 8.0, founder: 28, buy: 4.0, sell: 4.0, addr: "0x24a95e1b6d62e06eb3928913b1601af07ff50002", holders: 27, seed: 3,
      about: ["A subscription agent that files deletion requests against data brokers on your behalf, every month, forever. The raise closed below target; all backers were refunded in full."],
      funds: "—", milestones: [["Raise closed below target — refunds open", true]] },
    { no: "0001", sym: "CLIPS", name: "CLIPFARM",       pitch: "Short-video licensing marketplace for creators.", cat: "media", by: "leo@clipfarm", phase: "failed", raised: 2.04, target: 20.0, founder: 30, buy: 4.0, sell: 4.0, addr: "0x5346fddce64e39c00090369e1486de20d6210001", holders: 66, seed: 6,
      about: ["A rights marketplace where creators license clips to media houses with automatic revenue splits. The raise closed below target; all backers were refunded in full."],
      funds: "—", milestones: [["Raise closed below target — refunds open", true]] }
  ];

  var EPOCHS = [
    { n: 3, week: "W37 · 8–14 SEP 2026", vol: "41.208", pot: "0.412",
      burns: [["VAULT", "0.0824 ETH → 61,204,118 burned"], ["CACAO", "0.0494 ETH → 3,921,566 burned"], ["PAGE", "0.0330 ETH → 6,861,412 burned"]],
      rebates: [["0x1B97…Acce", "0.0257"], ["0x9F02…77b1", "0.0198"], ["0x33e4…0B94", "0.0141"], ["0xCaf6…5cb2", "0.0117"], ["0x0812…d2aa", "0.0093"]],
      makers: [["0x6A55…19c0", "0.0714"], ["0xE901…44af", "0.0522"]] },
    { n: 2, week: "W36 · 1–7 SEP 2026", vol: "27.443", pot: "0.274",
      burns: [["CACAO", "0.0549 ETH → 4,406,020 burned"], ["VAULT", "0.0329 ETH → 27,010,944 burned"], ["SCRB", "0.0219 ETH → curve buy, escrowed"]],
      rebates: [["0x9F02…77b1", "0.0176"], ["0x1B97…Acce", "0.0148"], ["0x77aa…0021", "0.0090"]],
      makers: [] },
    { n: 1, week: "W35 · 25–31 AUG 2026", vol: "9.017", pot: "0.090",
      burns: [["VAULT", "0.0180 ETH → 15,220,371 burned"], ["PAGE", "0.0108 ETH → 2,204,187 burned"], ["CACAO", "0.0072 ETH → 571,914 burned"]],
      rebates: [["0x1B97…Acce", "0.0135"], ["0x6A55…19c0", "0.0067"]],
      makers: [] }
  ];

  var PAGES = [
    ["index.html",    "Launches"],
    ["launch.html",   "Launch a token"],
    ["desk.html",     "Portfolio"],
    ["flywheel.html", "Rewards"],
    ["stats.html",    "Stats"],
    ["handbook.html", "Docs"]
  ];

  var STAMPS = {
    raising:   { cls: "blue", top: "LIVE",    sub: "RAISE OPEN" },
    funded:    { cls: "",     top: "FUNDED",  sub: "TARGET REACHED" },
    graduated: { cls: "",     top: "TRADING", sub: "POOL LIVE" },
    failed:    { cls: "red",  top: "FAILED",  sub: "REFUNDS OPEN" }
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

  /* pixel candles */
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
     CHROME
     ------------------------------------------------------------ */
  function filterDefs() {
    return '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>' +
      '<filter id="roughen" x="-8%" y="-8%" width="116%" height="116%">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.11" numOctaves="2" seed="3" result="n"/>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="3.4"/></filter>' +
      "</defs></svg>";
  }

  function tickerHTML() {
    var items = [], i, v;
    for (i = 0; i < VENTURES.length; i++) {
      v = VENTURES[i];
      if (v.phase === "graduated") {
        items.push("<b>$" + v.sym + "</b> " + v.price.toFixed(8) + ' <span class="' + (v.change >= 0 ? "up" : "dn") + '">' + (v.change >= 0 ? "▲" : "▼") + Math.abs(v.change).toFixed(1) + "%</span>");
      } else if (v.phase === "raising") {
        items.push("<b>#" + v.no + " $" + v.sym + "</b> raise " + pct(v) + "% · " + v.deadline + " left");
      }
    }
    items.push("<b>WEEKLY REWARDS</b> epoch 3 settled: 0.412 ETH — 3 buybacks · 5 trader rebates · 2 LP rewards");
    var reel = items.join(" &nbsp;&nbsp;│&nbsp;&nbsp; ");
    return '<div class="ticker" role="marquee" aria-label="market ticker"><div class="ticker-reel">' + reel + " &nbsp;&nbsp;│&nbsp;&nbsp; " + reel + "</div></div>";
  }

  function chromeTop(current) {
    var tabs = "";
    for (var i = 0; i < PAGES.length; i++) {
      var cur = PAGES[i][0] === current ? ' aria-current="page"' : "";
      tabs += '<a href="' + PAGES[i][0] + '"' + cur + ">" + PAGES[i][1] + "</a>";
    }
    return filterDefs() + tickerHTML() +
      '<header class="masthead"><div class="shell">' +
      '<div><a class="brand" href="index.html">doubleplus<sub>.fund</sub></a>' +
      '<p class="ministry-line">Launch and fund startups as decentralized stocks</p></div>' +
      '<div class="mast-cell">Robinhood Chain testnet · 46630<br>protocol fee 1% · referrals 20% of it<br><br>' +
      '<button class="connect" id="connect">Connect wallet</button></div>' +
      "</div></header>" +
      '<nav class="tabs"><div class="shell">' + tabs + "</div></nav>";
  }

  function chromeFoot() {
    return '<footer class="footer"><div class="shell">' +
      "<span>doubleplus.fund — testnet build</span>" +
      '<span><a href="https://explorer.testnet.chain.robinhood.com" target="_blank" rel="noreferrer">explorer ↗</a></span>' +
      '<span><a href="handbook.html">docs</a></span>' +
      "<span>unregistered instruments · unaudited contracts · back only what you can afford to lose</span>" +
      "</div></footer>";
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
    }
  }

  /* speculation rules: prefetch sibling pages */
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
      }, 700);
    });
  }

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
      document.body.insertAdjacentHTML("beforeend", chromeFoot());
      speculate();
      connectWire();
      setTimeout(notes, 0);
    },
    notes: notes
  };
})();
