// SLOT front end: pages are #/ (live raffles), #/r/<id>, #/all, #/treasury, #/verify[/<id>].
(function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
  const short = (w) => (w ? w.slice(0, 4) + "…" + w.slice(-4) : "");
  const LAMPORTS = 1e9;
  const sol = (l) => +(Number(l) / LAMPORTS).toFixed(4);
  const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const usd2 = (n) => "$" + Number(n).toFixed(2);
  const solUsd = (l) => (state?.solUsd ? usd(sol(l) * state.solUsd) : "");
  const when = (ts) => new Date(ts * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const ICON = { watch: "⌚", sneakers: "👟", pokemon: "🃏", cards: "🃏", other: "🎁" };
  const link = (href, text, ext) => { const a = el("a", null, text); a.href = href; if (ext) { a.target = "_blank"; a.rel = "noopener"; } return a; };
  const solscan = (kind, id, text) => link(`https://solscan.io/${kind}/${id}`, text || short(id), true);

  let token = store.get("gd_token");
  let state = null;
  const ui = {};
  let busy = false;

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: "no-store",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && !data.status) throw new Error(data.error || "Something went wrong.");
    return data;
  }
  const showError = (m) => { $("err").textContent = m || ""; $("err").hidden = !m; };

  // ---------- routing ----------
  const route = () => {
    const h = location.hash.replace(/^#\/?/, "");
    const [page, arg] = h.split("/");
    return { page: page === "r" ? "raffle" : page || "home", arg: arg || null };
  };
  window.addEventListener("hashchange", () => { window.scrollTo(0, 0); load(); });

  // ---------- wallet ----------
  const provider = () => window.phantom?.solana || window.solflare || window.backpack || window.solana || null;
  async function connect() {
    showError("");
    const p = provider();
    if (!p) {
      const url = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
      $("openPhantom").href = `https://phantom.app/ul/browse/${url}?ref=${ref}`;
      $("openSolflare").href = `https://solflare.com/ul/v1/browse/${url}?ref=${ref}`;
      $("noWallet").hidden = false;
      return;
    }
    try {
      const r = await p.connect();
      const address = (r?.publicKey || p.publicKey).toString();
      const n = await api("/api/auth?step=nonce", { address });
      const signed = await p.signMessage(new TextEncoder().encode(n.message), "utf8");
      const sig = signed?.signature || signed;
      const v = await api("/api/auth?step=verify", { address, nonce: n.nonce, signature: btoa(String.fromCharCode(...new Uint8Array(sig))) });
      token = v.token; store.set("gd_token", token);
      await load();
    } catch (e) { showError(/reject/i.test(e?.message) ? "Sign-in cancelled." : e.message || "Couldn't connect your wallet."); }
  }
  $("closeNoWallet").onclick = () => { $("noWallet").hidden = true; };

  function renderWallet() {
    const box = $("wallet"); box.replaceChildren();
    if (!state?.me) { const b = el("button", "btn primary", "Connect wallet"); b.type = "button"; b.onclick = connect; box.append(b); return; }
    const g = state.me.gate, c = state.coin;
    if (c.live) {
      const need = needText();
      if (g?.ok) box.append(el("span", "chip ok", `Holder ✓ in the free slot draws`)); // holding is optional: it only gives free-slot chances
      void need;
    }
    box.append(el("span", "chip", short(state.me.wallet)));
    const out = el("button", "btn small", "Sign out"); out.type = "button";
    out.onclick = async () => { try { await api("/api/auth?step=logout", {}); } catch {} token = null; store.set("gd_token", null); await load(); };
    box.append(out);
  }
  const needText = () => `${(state.coin.minHold / 1e6).toLocaleString("en")}M $${state.coin.symbol}`;

  // ---------- shared pieces ----------
  const STAGE = { open: "On sale", drawing: "Drawing", drawn: "Winner drawn", refunding: "Refunding", refunded: "Refunded" };
  function stageOf(r) {
    if (r.status === "drawn") return r.delivered ? "Prize sent" : r.bought ? "Prize bought" : "Winner drawn";
    return STAGE[r.status] || r.status;
  }
  const stageChip = (r) => el("span", "stage " + (r.status === "open" ? "open" : r.status === "drawn" ? "drawn" : ""), stageOf(r));

  function countdown(ts) {
    const s = Math.max(0, ts - Date.now() / 1000);
    if (s < 60) return "under a minute";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }

  // the ticket strip: paid spots 1..N, then the free holder spots as gold stars
  function strip(r) {
    const closed = !["open", "drawing"].includes(r.status);
    const box = el("div", "strip" + (closed ? " closed" : ""));
    const mine = new Set(r.mySpots || []), fresh = new Set(ui[r.id]?.fresh || []);
    const winIdx = r.status === "drawn" ? r.draw.index : -1;
    const show = Math.min(r.spots, 120);
    for (let i = 0; i < show; i++) {
      let cls = "tk";
      if (i < r.sold) cls += mine.has(i) ? " mine" : " sold";
      else if (i < r.sold + r.reserved) cls += " held";
      if (i === winIdx) cls += " win";
      if (fresh.has(i)) cls += " new";
      const t = el("span", cls, String(i + 1));
      t.title = i === winIdx ? "Winning slot" : mine.has(i) ? "Your slot" : i < r.sold ? "Taken" : i < r.sold + r.reserved ? "Being paid for" : "Open";
      box.append(t);
    }
    if (r.spots > show) box.append(el("span", "msg", `+${r.spots - show} more`));
    const free = /refund/.test(r.status) ? 0 : r.status === "drawn" ? r.draw.freeWinners.length : r.freeSpots;
    for (let k = 0; k < free; k++) {
      const t = el("span", "tk star" + (winIdx === r.spots + k ? " win" : ""), "★");
      t.title = r.status === "drawn" ? `Free slot: ${short(r.draw.freeWinners[k])}` : "Free slot for a holder";
      box.append(t);
    }
    return box;
  }
  function legend(r) {
    const lg = el("div", "legend");
    if (r.status === "open") lg.append(el("span", null, "Open"));
    lg.append(el("span", "l-sold", "Taken"));
    if (r.mine) lg.append(el("span", "l-mine", "Yours"));
    if (r.freeSpots && !/refund/.test(r.status)) lg.append(el("span", "l-star", "Free slot for a holder"));
    return lg;
  }
  const oddsText = (r) => `1 in ${r.spots + (r.status === "drawn" ? r.draw.freeWinners.length : r.freeSpots)} per slot`;

  // ---- pack art: our own foil-pack design per pack, so every raffle looks the same family ----
  const PACK_THEMES = [
    [/^ewatch|watch/, "WATCH", "#e9c46a", "#15120c", "watch", "1 watch"],
    [/^e10|psa/, "PSA 10", "#f1f1f1", "#a4161a", "star", "1 PSA 10 card"],
    [/^sealed/, "SEALED", "#d9dee8", "#3d4a5c", "box", "1 sealed product"],
    [/^pokemon/, "POKÉMON", "#ffd84d", "#2d4ea2", "card", "1 graded card"],
    [/^onepiece/, "ONE PIECE", "#ff5a5f", "#6d0f16", "card", "1 graded card"],
    [/^dragonball/, "DRAGON BALL", "#ffa23a", "#8a2c00", "card", "1 graded card"],
    [/^riftbound/, "RIFTBOUND", "#a48bff", "#24145e", "card", "1 graded card"],
    [/^anime/, "ANIME", "#ff7ab8", "#5a1550", "card", "1 graded card"],
    [/^soccer/, "SOCCER", "#4fd18b", "#0b3d2a", "ball", "1 graded card"],
    [/^basketball/, "BASKETBALL", "#ff9f43", "#6b2c05", "ball", "1 graded card"],
    [/^baseball/, "BASEBALL", "#7fb2ff", "#0f2a57", "ball", "1 graded card"],
    [/^football/, "FOOTBALL", "#d9a066", "#3b2410", "ball", "1 graded card"],
    [/^sports/, "SPORTS", "#5ee0c0", "#0c3b4a", "ball", "1 graded card"],
    [/^lorcana/, "LORCANA", "#9fd3ff", "#1c2f66", "card", "1 graded card"],
    [/^comic/, "COMICS", "#ffe066", "#7a1f1f", "card", "1 graded comic"],
  ];
  function packTheme(code) {
    const t = PACK_THEMES.find(([re]) => re.test(code || "")) || [null, "PACK", "#f4c95d", "#1b2545", "card", "1 graded collectible"];
    return { label: t[1], light: t[2], dark: t[3], glyph: t[4], inside: t[5] };
  }
  const GLYPH = {
    card: '<rect x="47" y="58" width="26" height="36" rx="4" fill="none" stroke="#fff" stroke-width="3"/><rect x="53" y="64" width="14" height="14" rx="2" fill="#fff" opacity=".85"/>',
    watch: '<circle cx="60" cy="76" r="17" fill="none" stroke="#fff" stroke-width="3"/><rect x="54" y="52" width="12" height="7" rx="2" fill="#fff"/><rect x="54" y="93" width="12" height="7" rx="2" fill="#fff"/><path d="M60 76V66M60 76l7 4" stroke="#fff" stroke-width="3" stroke-linecap="round"/>',
    ball: '<circle cx="60" cy="76" r="17" fill="none" stroke="#fff" stroke-width="3"/><path d="M43 76h34M60 59c-7 6-7 28 0 34M60 59c7 6 7 28 0 34" fill="none" stroke="#fff" stroke-width="2.4"/>',
    star: '<path d="M60 57l5.6 11.6 12.7 1.8-9.2 8.9 2.2 12.6L60 85.9 48.7 91.9l2.2-12.6-9.2-8.9 12.7-1.8z" fill="#fff"/>',
    box: '<path d="M44 68l16-8 16 8v18l-16 8-16-8z" fill="none" stroke="#fff" stroke-width="3" stroke-linejoin="round"/><path d="M44 68l16 8 16-8M60 76v18" fill="none" stroke="#fff" stroke-width="2.4"/>',
  };
  let packArtId = 0;
  function packArt(r) {
    const t = packTheme(r.prize?.machine), id = "pa" + (packArtId++);
    const price = `$${Number(r.prize?.unitUsd || r.prizeUsd).toLocaleString("en-US")}`;
    const n = r.prize?.count > 1 ? `${r.prize.count}×` : "";
    const top = [], bottom = [];
    for (let i = 0, x = 8; x <= 112; i++, x += 8) { top.push(`${x} ${i % 2 ? 10 : 14}`); bottom.unshift(`${x} ${i % 2 ? 150 : 146}`); }
    const body = `M${top.join(" L")} L${bottom.join(" L")} Z`; // crimped top and bottom edges
    const svg = `<svg viewBox="0 0 120 160" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.light}"/><stop offset="1" stop-color="${t.dark}"/></linearGradient>
        <linearGradient id="${id}s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
        <clipPath id="${id}c"><path d="${body}"/></clipPath>
      </defs>
      <g clip-path="url(#${id}c)">
        <rect width="120" height="160" fill="url(#${id}g)"/>
        <rect x="-40" y="0" width="34" height="200" fill="url(#${id}s)" transform="rotate(22 60 80)"/>
        <rect y="0" width="120" height="24" fill="#000" opacity=".22"/><rect y="136" width="120" height="24" fill="#000" opacity=".22"/>
        <path d="M0 24h120M0 136h120" stroke="#fff" stroke-opacity=".25"/>
      </g>
      <text x="60" y="38" text-anchor="middle" font-family="inherit" font-weight="800" font-size="${t.label.length > 9 ? 9 : 11}" letter-spacing="1.2" fill="#fff">${t.label}</text>
      <circle cx="60" cy="76" r="26" fill="#000" opacity=".2"/>
      ${GLYPH[t.glyph] || GLYPH.card}
      <text x="60" y="122" text-anchor="middle" font-family="inherit" font-weight="900" font-size="20" fill="#fff" stroke="#000" stroke-opacity=".25" stroke-width=".6">${n}${price}</text>
      <text x="60" y="149" text-anchor="middle" font-family="inherit" font-weight="800" font-size="7" letter-spacing="2" fill="#fff" opacity=".85">SLOT</text>
    </svg>`;
    const d = el("div", "pic packart"); d.setAttribute("role", "img"); d.setAttribute("aria-label", `${r.title}: ${t.inside}`);
    d.innerHTML = svg;
    return d;
  }

  // Pack pictures are 1080px cut-outs: served resized as WebP through Vercel's image optimizer, shown whole.
  const optimized = (src, w) => !/^(localhost|127\.)/.test(location.hostname) && /\.public\.blob\.vercel-storage\.com\//.test(src)
    ? `/_vercel/image?url=${encodeURIComponent(src)}&w=${w}&q=80` : src;
  function pic(r, w = 384) {
    if (r.prize?.kind === "packs") return packArt(r);
    const p = el("div", "pic");
    p.setAttribute("role", "img"); p.setAttribute("aria-label", r.title);
    if (!r.image) { p.textContent = ICON[r.category] || "🎁"; p.classList.add("noimg"); return p; }
    const img = el("img"); img.alt = ""; img.loading = "lazy"; img.decoding = "async";
    img.src = optimized(r.image, w);
    img.onerror = () => { if (img.src !== r.image) img.src = r.image; else { p.replaceChildren(ICON[r.category] || "🎁"); p.classList.add("noimg"); } };
    if (r.prize?.kind === "packs") p.classList.add("pack");
    p.append(img);
    return p;
  }

  function raffleCard(r) {
    const card = el("article", "raffle");
    const body = el("div", "body");
    const head = el("div", "head");
    const h = el("h3"); h.append(link("#/r/" + r.id, r.title));
    const val = el("span", "value"); val.append("Worth ", el("b", null, usd(r.prizeUsd)));
    head.append(h, val);
    const facts = el("div", "facts");
    const f1 = el("span"); f1.append(el("b", null, `${r.sold} of ${r.spots}`), " paid slots sold"); facts.append(f1);
    if (r.freeSpots) facts.append(el("span", null, `+ ${r.freeSpots} free for holders`));
    if (r.status === "open") { const f2 = el("span"); f2.append("Fills or refunds in ", el("b", null, countdown(r.deadline))); facts.append(f2); }
    if (r.mine) { const f3 = el("span"); f3.append("You have ", el("b", null, String(r.mine))); facts.append(f3); }
    const meter = el("div", "meter"); meter.append(strip(r), legend(r));
    body.append(head, facts, meter);
    if (r.status === "open") body.append(buyRow(r));
    else body.append(resultLine(r));
    const m = ui[r.id]?.msg; if (m) body.append(el("p", "msg " + (m.kind || ""), m.text));
    card.append(pic(r), body);
    return card;
  }

  function resultLine(r) {
    const p = el("p", "msg");
    if (r.status === "drawing") p.textContent = "Sold out. The winner is being drawn from the next Solana slots…";
    else if (r.status === "drawn") { p.append(r.youWon ? el("b", null, "You won this. ") : "Won by ", r.youWon ? "" : el("b", null, r.draw.winnerShort), " ", link("#/r/" + r.id, "See the draw")); }
    else p.textContent = r.status === "refunded" ? "Didn't fill in time. Everyone was refunded." : "Didn't fill in time. Everyone gets their SOL back.";
    return p;
  }

  function buyRow(r) {
    const row = el("div", "buy");
    const left = r.spots - r.sold;
    const p = el("span", "price", `${sol(r.priceLamports)} SOL `);
    if (state.solUsd) p.append(el("small", null, `about ${solUsd(r.priceLamports)} per slot`));
    row.append(p);
    const can = Math.min(r.maxPerWallet - r.mine, left - r.reserved);
    if (left <= 0) { row.append(el("span", "msg", "Sold out, the draw is next.")); return row; }
    if (!state.me) { const b = el("button", "btn primary", "Connect to buy a slot"); b.type = "button"; b.onclick = connect; row.append(b); return row; }
    if (can <= 0) { row.append(el("span", "msg", r.mine >= r.maxPerWallet ? `You have the max ${r.maxPerWallet} slots.` : "All slots are being paid for. Check back in a few minutes.")); return row; }
    for (let n = 1; n <= Math.min(can, 2); n++) {
      const b = el("button", "btn" + (n === 1 ? " primary" : ""), n === 1 ? "Buy 1 slot" : `Buy ${n} slots`);
      b.type = "button"; b.disabled = busy || !!state.blocked;
      b.onclick = () => buy(r, n);
      row.append(b);
    }
    return row;
  }

  // ---------- pages ----------
  function pageHome() {
    const v = [];
    const hero = el("section", "hero");
    hero.append(el("h1", null, "Grab a slot. Win the grail."));
    hero.append(el("p", null, `Raffles for real graded cards and watches. Every raffle fills or refunds, the winner is picked on-chain, and the prize lands straight in their wallet.`));
    const t = state.treasury;
    if (t?.wallet) {
      const purse = el("div", "purse");
      purse.append(el("b", null, `${sol(t.availableLamports)} SOL`), el("span", null, `in the treasury for new free slots${state.solUsd ? ` (${solUsd(t.availableLamports)})` : ""}`), link("#/treasury", "See the treasury"));
      hero.append(purse);
    }
    v.push(hero);
    const live = state.raffles.filter((r) => ["open", "drawing"].includes(r.status)).sort((a, b) => a.deadline - b.deadline);
    v.push(el("h2", null, "Live raffles"));
    v.push(...(live.length ? live.map(raffleCard) : [el("p", "empty", "No raffle is open right now. The next drop gets announced on X first.")]));
    const past = state.raffles.filter((r) => !["open", "drawing"].includes(r.status)).slice(0, 3);
    if (past.length) { v.push(el("h2", null, "Just finished"), ...past.map(raffleCard)); const a = el("p"); a.append(link("#/all", "See all raffles")); v.push(a); }
    v.push(el("h2", null, "How it works"));
    const rules = el("div", "rules");
    const rule = (h, p) => { const d = el("div"); d.append(el("h3", null, h), el("p", null, p)); rules.append(d); };
    rule("Fill or refund", "The draw only happens when every paid slot is sold. If a raffle isn't full by its deadline, everyone gets their SOL back.");
    rule("Anyone can play", "Connect a Solana wallet and grab a slot. A few slots per wallet per raffle, so everyone gets a shot.");
    rule("Free slots for holders", state.coin.live ? `When a raffle fills, 2 extra slots go to random wallets holding ${needText()} or more. Every holder has the same chance, drawn with the same on-chain randomness.` : `Once $${state.coin.symbol} launches, every full raffle gets 2 extra slots for random holders of ${needText()}, drawn with the same on-chain randomness.`);
    rule("Provably fair", state.vrf?.enabled ? "The paid slots are locked first, then ORAO's verifiable randomness on Solana picks the winner. Anyone can check the draw." : "The paid slots are locked first, then the hash of a later Solana block picks the winner. Anyone can check the draw.");
    rule("Real prizes", "Packs come from Collector Crypt: opened right after the draw, the graded card or watch goes straight to the winner's wallet. Keep it, sell it back, or have it shipped.");
    v.push(rules);
    return v;
  }

  function pageAll() {
    const v = [el("h1", null, "All raffles"), el("p", "lede", `${state.raffles.length} raffle${state.raffles.length === 1 ? "" : "s"} so far. Open one to see where it stands and to check its draw.`)];
    const wrap = el("div", "panel tablewrap");
    const tbl = el("table");
    const head = el("tr"); for (const h of ["Raffle", "Stage", "Paid slots sold", "Free slots", "Slot price", "Opened"]) head.append(el("th", null, h));
    tbl.append(head);
    for (const r of state.raffles) {
      const tr = el("tr");
      const c1 = el("td"); c1.append(link("#/r/" + r.id, r.title));
      const c2 = el("td"); c2.append(stageChip(r));
      tr.append(c1, c2, el("td", null, `${r.sold} of ${r.spots}`), el("td", null, String(r.status === "drawn" ? r.draw.freeWinners.length : r.freeSpots)), el("td", null, `${sol(r.priceLamports)} SOL`), el("td", null, when(r.createdAt)));
      tbl.append(tr);
    }
    if (!state.raffles.length) { const tr = el("tr"); const td = el("td", "empty", "No raffles yet."); td.colSpan = 6; tr.append(td); tbl.append(tr); }
    wrap.append(tbl); v.push(wrap);
    return v;
  }

  // The step where randomness arrives: ORAO VRF when it's on, otherwise a future Solana block.
  function randomStep(r) {
    const d = r.draw, v = d?.vrf;
    if (v || (!d && state.vrf?.enabled)) {
      const sub = r.status === "drawn" ? "Received from ORAO's independent nodes and checked on-chain." : v?.requested ? "Requested on Solana, waiting for ORAO's nodes to answer." : d ? "Asking ORAO for a random number." : null;
      return ["Random number from ORAO VRF", sub];
    }
    return ["Deciding Solana slot", r.status === "drawn" ? `Slot ${d.slot}.` : d ? `Waiting for slot ${d.afterSlot} to be final.` : null];
  }

  function steps(r) {
    const list = [
      ["Slots on sale", r.status === "open" ? `Fills or refunds by ${when(r.deadline)} (${countdown(r.deadline)} left).` : null],
      ["Sold out, paid slots locked", r.draw ? `Locked ${when(r.draw.frozenAt)}.` : null],
      ["Holder list locked", r.freeSpots ? (r.draw?.holders ? `${r.draw.holders.count} wallets with ${needText()} or more.` : null) : "No free slots in this raffle."],
      randomStep(r),
      ["Free slots and winner drawn", r.status === "drawn" ? `Winner ${r.draw.winnerShort}.` : null],
      ...(r.prize?.kind === "packs" ? [
        [`${r.prize.count}× ${r.prize.name} bought and opened`, r.auto?.status === "done" ? "Automatically, at Collector Crypt." : r.status === "drawn" ? `Buying… ${r.auto?.bought || 0} of ${r.prize.count}` : "Happens by itself right after the draw."],
        ["Card sent to the winner's wallet", r.auto?.status === "done" ? "Straight from Collector Crypt to the winner." : null],
      ] : [
        ["Prize bought on Courtyard", null],
        ["Prize sent to the winner", null],
      ]),
    ];
    const done = r.status === "drawn" ? 5 + (r.bought ? 1 : 0) + (r.delivered ? 1 : 0) : r.status === "drawing" ? 2 + (r.draw?.holders || !r.freeSpots ? 1 : 0) : 0;
    const ol = el("ol", "steps");
    if (/refund/.test(r.status)) {
      const a = el("li", "done"); a.append(el("span", null, "Slots on sale"));
      const b = el("li", r.status === "refunded" ? "done" : "now"); b.append(el("span", null, r.status === "refunded" ? "Everyone refunded" : "Refunding everyone"));
      b.lastChild.append(el("small", null, r.refundReason === "cancelled" ? "The raffle was cancelled." : "It didn't fill before the deadline."));
      ol.append(a, b); return ol;
    }
    list.forEach(([t, sub], i) => {
      const li = el("li", i < done ? "done" : i === done ? "now" : "");
      const s = el("span", null, t); if (sub && i <= done) s.append(el("small", null, sub));
      li.append(s); ol.append(li);
    });
    return ol;
  }

  function pageRaffle(id) {
    const r = state.raffles.find((x) => x.id === id);
    if (!r) return [el("h1", null, "Raffle not found"), el("p", "lede", "It may have been removed.")];
    const v = [];
    const h = el("h1", null, r.title); v.push(h);
    const sub = el("p", "lede"); sub.append(stageChip(r), " ", `${r.sold} of ${r.spots} paid slots sold at ${sol(r.priceLamports)} SOL, plus ${r.freeSpots} free slot${r.freeSpots === 1 ? "" : "s"} for holders.`);
    v.push(sub);
    const stats = el("div", "stats");
    const stat = (k, val, s) => { const d = el("div", "stat"); d.append(el("div", "k", k), el("div", "v", val)); if (s) d.append(el("div", "s", s)); stats.append(d); };
    stat("Prize", usd(r.prizeUsd), r.prize?.kind === "packs" ? `${r.prize.count}× ${r.prize.name}` : r.link ? "on Courtyard" : r.category);
    stat("Paid slots", `${r.sold} / ${r.spots}`, `${r.spots - r.sold} left, max ${r.maxPerWallet} per wallet`);
    stat("Free slots", String(r.freeSpots), r.freeSpots ? "for random holders" : "none in this raffle");
    if (r.priceUsd) stat("Slot price", usd2(r.priceUsd), r.priceLamports ? `${sol(r.priceLamports)} SOL right now` : "paid in SOL");
    else stat("Slot price", `${sol(r.priceLamports)} SOL`, state.solUsd ? `about ${solUsd(r.priceLamports)}` : "");
    if (r.status === "open") stat("Closes in", countdown(r.deadline), when(r.deadline));
    v.push(stats);

    const spots = el("section", "panel");
    spots.append(el("h2", null, "The slots"), strip(r), legend(r));
    if (r.status === "open") spots.append(buyRow(r));
    const m = ui[r.id]?.msg; if (m) spots.append(el("p", "msg " + (m.kind || ""), m.text));
    if (r.myRefunds) for (const f of r.myRefunds) spots.append(el("p", "msg " + (f.paid ? "ok" : ""), f.paid ? `Refunded ${sol(f.lamports)} SOL to your wallet.` : `You'll get ${sol(f.lamports)} SOL back.`));
    v.push(spots);

    const cols = el("div", "cols");
    const prog = el("section", "panel"); prog.append(el("h2", null, "Progress"), steps(r));
    const info = el("section", "panel"); info.append(el("h2", null, "The prize"));
    if (r.image) { const p = pic(r, 640); p.style.width = "100%"; p.style.aspectRatio = r.prize?.kind === "packs" ? "4 / 3" : "16 / 9"; info.append(p); }
    const kv = el("dl", "kv");
    const add = (k, val) => { kv.append(el("dt", null, k)); const dd = el("dd"); dd.append(val); kv.append(dd); };
    add("Worth", usd(r.prizeUsd));
    if (r.link) add("Listing", link(r.link, "Open on Courtyard", true));
    if (r.prize?.kind === "packs") {
      add("Packs", `${r.prize.count}× ${r.prize.name} at $${r.prize.unitUsd} each, from Collector Crypt`);
      add("How you get it", "Opened automatically right after the draw. The card lands in the winner's wallet as an NFT backed by the real graded card: keep it, sell it, or have the physical card shipped from Collector Crypt.");
    }
    add("Opened", when(r.createdAt));
    add("Paid to", solscan("account", r.payTo || state.entryWallet));
    info.append(kv);
    cols.append(prog, info); v.push(cols);

    if (r.status === "drawn") {
      const res = el("section", "panel");
      res.append(el("h2", null, r.youWon ? "You won" : "Winner"));
      const w = el("p", "result"); w.style.margin = "0";
      w.append(r.youWon ? (r.prize?.kind === "packs" ? "This one is yours." : "This one is yours. Tell us where to send it.") : "Won by ", r.youWon ? "" : el("b", null, r.draw.winnerShort), r.youWon ? "" : ` with ${r.draw.index >= r.spots ? "a free holder slot" : "slot " + (r.draw.index + 1)}.`);
      res.append(w);
      if (r.prize?.kind === "packs") {
        if (r.youWon) res.append(el("p", "msg ok", r.auto?.status === "done" ? "Your card is in your wallet. Open it on Collector Crypt to keep, sell or ship it." : "Your packs are being opened. The card goes straight to your wallet, nothing to fill in."));
        for (const c of r.auto?.cards || []) res.append(cardRow(c));
      } else if (r.youWon && !r.claimed) res.append(claimForm(r)); else if (r.youWon) res.append(el("p", "msg ok", r.delivered ? "Prize sent." : "Got your details. Your prize is on its way."));
      const a = el("p"); a.style.margin = "0"; a.append(link("#/verify/" + r.id, "Check this draw yourself"));
      if (r.draw.vrf?.account) a.append(" · ", solscan("account", r.draw.vrf.account, "The random number on Solana"));
      res.append(a);
      v.push(res);
    }

    const fs = el("section", "panel");
    fs.append(el("h2", null, "Free slots"));
    fs.append(el("p", "msg", `Free slots go to random wallets holding ${needText()} or more for ${state.coin.holdHours} hours. Every eligible wallet has the same chance and nobody gets two.`));
    if (r.status === "drawn" && r.draw.freeWinners.length) {
      const ul = el("ul");
      r.draw.freeWinners.forEach((wlt, k) => { const li = el("li"); li.append(`Slot ★${k + 1}: `, solscan("account", wlt)); ul.append(li); });
      fs.append(ul);
    } else fs.append(el("p", "msg", r.freeSpots ? "No winners yet. They're drawn when the raffle fills." : "This raffle has no free slots."));
    v.push(fs);

    const ps = el("section", "panel");
    ps.append(el("h2", null, "Paid slots"), el("p", "msg", "In the order they were bought. This order is the slot numbering the draw uses."));
    const tw = el("div", "tablewrap"); const tbl = el("table");
    const hr = el("tr"); for (const x of ["Slots", "Wallet", "Payment"]) hr.append(el("th", null, x)); tbl.append(hr);
    let n = 0;
    for (const e of r.entries || []) {
      const tr = el("tr");
      const nums = e.n === 1 ? `${n + 1}` : `${n + 1}–${n + e.n}`; n += e.n;
      const c2 = el("td", "addr"); c2.append(solscan("account", e.wallet, e.wallet));
      const c3 = el("td"); c3.append(solscan("tx", e.sig, "transaction"));
      tr.append(el("td", null, nums), c2, c3); tbl.append(tr);
    }
    if (!(r.entries || []).length) { const tr = el("tr"); const td = el("td", "empty", "Nobody yet. Be the first."); td.colSpan = 3; tr.append(td); tbl.append(tr); }
    tw.append(tbl); ps.append(tw); v.push(ps);
    return v;
  }

  function cardRow(c) {
    const d = el("div", "card-pull");
    d.append(el("b", null, c.name || "Card"), el("span", "chip", [c.rarity, c.grade ? `grade ${c.grade}` : null].filter(Boolean).join(", ") || "pulled"));
    if (c.nft) { d.append(" ", solscan("token", c.nft, "NFT on Solscan")); }
    return d;
  }

  function claimForm(r) {
    const f = el("form", "claim");
    f.append(el("p", "msg", "Prizes come from Courtyard. Give your Courtyard username or email, or a Polygon wallet (0x…) to receive it."));
    const row = el("div", "row");
    const sel = el("select"); sel.append(new Option("Courtyard username or email", "courtyard"), new Option("Polygon wallet", "polygon"));
    const inp = el("input"); inp.type = "text"; inp.required = true; inp.placeholder = "you@example.com or 0x…"; inp.setAttribute("aria-label", "Where to send the prize");
    const b = el("button", "btn primary", "Send me my prize"); b.type = "submit";
    row.append(sel, inp, b); f.append(row);
    const msg = el("p", "msg"); f.append(msg);
    f.onsubmit = async (e) => {
      e.preventDefault(); b.disabled = true;
      try { await api("/api/claim", { id: r.id, method: sel.value, value: inp.value }); await load(); }
      catch (err) { msg.textContent = err.message; msg.className = "msg bad"; b.disabled = false; }
    };
    return f;
  }

  let treasuryCache = null;
  function pageTreasury() {
    const v = [el("h1", null, "Treasury"), el("p", "lede", "The coin's trading fees land in the fees wallet. They pay for the free holder slots, and nothing else. Entry money pays for the prize itself.")];
    const t = treasuryCache;
    if (!t) { v.push(el("p", "empty", "Reading the fees wallet from Solana…")); loadTreasury(); return v; }
    if (!t.wallet) { v.push(el("p", "notice", "No fees wallet is set yet, so raffles run without free slots for now.")); return v; }
    const stats = el("div", "stats");
    const stat = (k, l, s) => { const d = el("div", "stat"); d.append(el("div", "k", k), el("div", "v", `${sol(l)} SOL`), el("div", "s", (t.solUsd ? `about ${usd(sol(l) * t.solUsd)}. ` : "") + s)); stats.append(d); };
    stat("Available for new free slots", t.availableLamports, "Can pay for free slots of raffles that don't exist yet.");
    stat("Reserved for free slots", t.reservedLamports, "Set aside for raffles that are running.");
    stat("In the fees wallet", t.balanceLamports ?? 0, "The whole balance, read from Solana.");
    stat("Spent on prizes so far", t.spentLamports, "Free-slot money used once a prize was bought.");
    v.push(stats);
    const res = el("section", "panel"); res.append(el("h2", null, "What's reserved"));
    if (t.reserving.length) {
      const tw = el("div", "tablewrap"); const tbl = el("table");
      const hr = el("tr"); for (const x of ["Raffle", "Free slots", "Reserved"]) hr.append(el("th", null, x)); tbl.append(hr);
      for (const x of t.reserving) { const tr = el("tr"); const c = el("td"); c.append(link("#/r/" + x.id, x.title)); tr.append(c, el("td", null, String(x.freeSpots)), el("td", null, `${sol(x.lamports)} SOL`)); tbl.append(tr); }
      tw.append(tbl); res.append(tw);
    } else res.append(el("p", "msg", "Nothing reserved right now."));
    v.push(res);
    const how = el("section", "panel"); how.append(el("h2", null, "How the money is used"));
    const ul = el("ul");
    for (const x of [
      "A raffle only gets free slots when the fees wallet can pay for all of them: free slots × slot price is reserved when the raffle opens.",
      "If there aren't enough fees, the raffle still runs, just with fewer or no free slots. Fees never decide whether a raffle happens.",
      "When a raffle fills, the reserved money joins the entry money to buy the prize. If it doesn't fill, the reserve is released and the buyers are refunded.",
    ]) ul.append(el("li", null, x));
    how.append(ul); v.push(how);
    const who = el("section", "panel"); who.append(el("h2", null, "Check it yourself"));
    const kv = el("dl", "kv");
    const add = (k, val, s) => { kv.append(el("dt", null, k)); const dd = el("dd"); dd.append(val); if (s) dd.append(el("small", "msg", " " + s)); kv.append(dd); };
    add("Fees wallet", solscan("account", t.wallet, t.wallet), "receives the coin's trading fees");
    add("Entry wallet", solscan("account", t.entryWallet, t.entryWallet), "receives slot payments, pays refunds and prizes");
    who.append(kv, el("p", "msg", "Balances are read from Solana (finalized) every 30 seconds."));
    v.push(who);
    return v;
  }
  async function loadTreasury() {
    try { treasuryCache = await api("/api/treasury"); if (route().page === "treasury") paint(); } catch (e) { showError(e.message); }
  }

  // verify: recompute free spots and the winner in the browser from the published lists
  function pageVerify(id) {
    const drawn = state.raffles.filter((r) => r.status === "drawn");
    const v = [el("h1", null, "Verify a draw"), el("p", "lede", "Pick a finished raffle. Your browser downloads its locked lists, reads the random number from Solana itself, and redoes the whole draw.")];
    const p = el("section", "panel");
    const row = el("div", "row");
    const sel = el("select"); sel.setAttribute("aria-label", "Raffle");
    for (const r of drawn) sel.append(new Option(r.title, r.id));
    if (id) sel.value = id;
    const b = el("button", "btn primary", "Check this draw"); b.type = "button";
    row.append(sel, b); p.append(row);
    const out = el("ul", "checks"); p.append(out);
    if (!drawn.length) { p.replaceChildren(el("p", "empty", "No finished draws yet.")); v.push(p); return v; }
    b.onclick = () => runVerify(sel.value, out);
    v.push(p);
    if (id) setTimeout(() => runVerify(id, out), 0);
    return v;
  }
  async function runVerify(id, out) {
    out.replaceChildren();
    const line = (text, ok) => { const li = el("li", ok == null ? "" : ok ? "ok" : "bad", text); out.append(li); return li; };
    try {
      const pr = await api(`/api/proof?id=${id}&holders=1`);
      const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");
      const mod = (hex, n) => Number(BigInt("0x" + hex) % BigInt(n));
      const entropy = pr.entropy || pr.blockhash;
      const paidHash = await sha(pr.paidTickets.join(","));
      line(`Paid slots: ${pr.paidTickets.length}, hash matches what was locked.`, paidHash === pr.paidTicketsHash);
      if (pr.source === "vrf") {
        const seed = await sha(`slot-vrf:${pr.id}:${pr.paidTicketsHash}:${pr.holdersHash || "none"}`);
        line(`VRF seed is the fingerprint of the locked lists: ${seed.slice(0, 16)}…`, seed === pr.vrf.seed);
        const W = window.solanaWeb3;
        const seedBytes = Uint8Array.from(seed.match(/../g).map((h) => parseInt(h, 16)));
        const [acct] = W.PublicKey.findProgramAddressSync([new TextEncoder().encode("orao-vrf-randomness-request"), seedBytes], new W.PublicKey(pr.vrf.program));
        line(`ORAO request account for that seed: ${short(acct.toBase58())}.`, acct.toBase58() === pr.vrf.account);
        const onChain = await readVrfAccount(acct.toBase58()).catch(() => null);
        if (!onChain) line("Couldn't reach Solana from your browser to read the account. Open it on Solscan below instead.", null);
        else line(`Read from Solana: fulfilled by ORAO, random number ${onChain.randomness.slice(0, 16)}… matches the one used.`, onChain.fulfilled && onChain.seed === seed && onChain.randomness === entropy);
      } else {
        line(`Deciding block: slot ${pr.blockSlot}, hash ${pr.blockhash}. It was produced after the lists below were locked (target slot ${pr.afterSlot}).`, null);
      }
      let tickets = [...pr.paidTickets];
      if (pr.holdersHash) {
        const hh = await sha(pr.holders.join(","));
        line(`Holder list: ${pr.holders.length} wallets, hash matches what was locked.`, hh === pr.holdersHash);
        let remaining = [...pr.holders], winners = [], good = true;
        for (let j = 0; j < pr.holderRounds.length; j++) {
          const seed = await sha(`${entropy}:${pr.id}:holders:${hh}:${j}`);
          const cand = remaining[mod(seed, remaining.length)];
          const rec = pr.holderRounds[j];
          if (cand !== rec.owner) good = false;
          if (rec.ok) winners.push(cand);
          remaining = remaining.filter((o) => o !== cand);
        }
        const skipped = pr.holderRounds.filter((x) => !x.ok).length;
        line(`Free slots: ${winners.map(short).join(" and ") || "none"}${skipped ? ` (${skipped} picked wallet${skipped === 1 ? "" : "s"} skipped for not holding long enough)` : ""}.`, good && winners.join() === pr.freeWinners.join());
        tickets.push(...winners);
      }
      const th = await sha(tickets.join(","));
      line(`All slots: ${tickets.length}, list hash matches.`, th === pr.ticketsHash);
      const seed = await sha(`${entropy}:${pr.id}:${th}`);
      const idx = mod(seed, tickets.length);
      line(`Winner: seed mod ${tickets.length} = ${idx}, slot ${idx + 1}, wallet ${short(tickets[idx])}.`, seed === pr.seed && tickets[idx] === pr.winner);
      const sb = el("li"), sp = el("span"); sb.append(sp);
      if (pr.source === "vrf") { sp.append(solscan("account", pr.vrf.account, "See the random number on Solscan")); if (pr.vrf.requestSig) sp.append(" · ", solscan("tx", pr.vrf.requestSig, "the request")); }
      else sp.append(solscan("block", pr.blockSlot, "See the block on Solscan"));
      out.append(sb);
    } catch (e) { line(e.message, false); }
  }

  // Read an ORAO randomness account straight from a public Solana RPC (not through SLOT's server).
  async function readVrfAccount(address) {
    const res = await fetch("https://api.mainnet-beta.solana.com", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64", commitment: "finalized" }] }) });
    const v = (await res.json()).result?.value;
    if (!v) return null;
    const b = Uint8Array.from(atob(v.data[0]), (c) => c.charCodeAt(0));
    const hex = (a) => [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
    return { fulfilled: b[8] === 1, seed: hex(b.subarray(41, 73)), randomness: hex(b.subarray(73, 137)) };
  }

  // ---------- buying ----------
  // A plain SOL transfer, built by hand (the web3.js helper needs Node's Buffer, which browsers don't have).
  function transferIx(from, to, lamports) {
    const { SystemProgram, TransactionInstruction } = window.solanaWeb3;
    const data = new Uint8Array(12), dv = new DataView(data.buffer);
    dv.setUint32(0, 2, true);                       // System Program instruction 2 = transfer
    dv.setBigUint64(4, BigInt(lamports), true);
    return new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }], data });
  }

  async function buy(r, n) {
    if (busy) return;
    const say = (text, kind) => { ui[r.id] = { ...(ui[r.id] || {}), msg: { text, kind } }; paint(); };
    if (store.get("gd_agree") !== "1") {
      if (!window.confirm("Before you buy: you're 18 or older, and raffles like this are allowed where you live. Continue?")) return;
      store.set("gd_agree", "1");
    }
    const p = provider();
    if (!p || !window.solanaWeb3) return say("Open this page in your Solana wallet to pay.", "bad");
    busy = true;
    try {
      say("Holding your slot for 5 minutes…");
      const hold = await api("/api/enter?step=reserve", { id: r.id, n, agree: true });
      say(`Approve ${sol(hold.lamports)} SOL in your wallet…`);
      const { Transaction, PublicKey } = window.solanaWeb3;
      const me = new PublicKey(state.me.wallet);
      const tx = new Transaction({ feePayer: me, recentBlockhash: hold.blockhash }).add(transferIx(me, new PublicKey(hold.treasury), hold.lamports));
      const sent = await p.signAndSendTransaction(tx);
      const sig = sent?.signature || sent;
      say("Paid. Checking the payment on-chain…");
      let res;
      for (let i = 0; i < 40; i++) {
        res = await api("/api/enter?step=confirm", { nonce: hold.nonce, sig });
        if (res.status !== "pending") break;
        await new Promise((ok) => setTimeout(ok, 2500));
      }
      busy = false;
      if (res.status === "ok") {
        const before = new Set(r.mySpots || []);
        await load();
        const now = state.raffles.find((x) => x.id === r.id);
        ui[r.id] = { fresh: (now?.mySpots || []).filter((i) => !before.has(i)), msg: { text: n === 1 ? "You're in. Good luck." : `You're in with ${n} slots. Good luck.`, kind: "ok" } };
        paint();
        setTimeout(() => { if (ui[r.id]) ui[r.id].fresh = null; }, 900);
      } else if (res.status === "refund") say(res.reason, "bad");
      else say(`Your payment is still confirming. It will show up here; keep this link: https://solscan.io/tx/${sig}`, "bad");
    } catch (e) {
      busy = false;
      say(/reject|cancel/i.test(e?.message) ? "Payment cancelled. Your slot is released in 5 minutes." : e.message, "bad");
      load();
    }
  }

  // ---------- admin ----------
  function renderAdmin() {
    const admin = !!state.me?.admin && route().page === "home";
    $("admin").hidden = !admin;
    if (!admin) return;
    renderVrfStatus();
    renderVault();
    renderAutopilot();
    loadMachines();
    const list = $("adminList"); list.replaceChildren();
    for (const r of state.raffles) {
      const a = r.admin; if (!a) continue;
      const it = el("div", "item");
      it.append(el("b", null, `${r.title}: ${stageOf(r)}, ${r.sold} of ${r.spots} sold`));
      if (r.reservedLamports && ["open", "drawing", "drawn"].includes(r.status) && !a.bought) it.append(el("span", "msg", `${sol(r.reservedLamports)} SOL of fees reserved for its free slots.`));
      if (r.draw?.vrf?.error && r.status === "drawing") it.append(el("span", "msg bad", `VRF: ${r.draw.vrf.error}. It retries on its own every 90 seconds.`));
      const auto = r.prize?.kind === "packs";
      if (auto) {
        const au = r.auto;
        it.append(el("span", "msg", `Prize: ${r.prize.count}× ${r.prize.name}, bought and opened automatically.`));
        if (r.status === "drawn") it.append(el("span", au?.status === "done" ? "msg ok" : au?.error ? "msg bad" : "msg",
          au?.status === "done" ? `Done: ${au.bought} card${au.bought === 1 ? "" : "s"} sent to ${short(r.draw.winner)}.` : au?.error ? `Stuck: ${au.error}` : `Buying packs for ${short(r.draw.winner)}… (${au?.bought || 0} of ${r.prize.count})`));
      } else if (a.claim) it.append(el("span", null, `Winner ${short(r.draw?.winner)} wants it on ${a.claim.method}: ${a.claim.value}`));
      else if (r.status === "drawn") it.append(el("span", "msg", `Winner ${short(r.draw.winner)} hasn't said where to send it yet.`));
      const open = a.refunds.filter((f) => !f.paid);
      if (open.length) it.append(el("span", "msg bad", auto ? `${open.length} refund(s) being paid by the vault.` : `${open.length} refund(s) to pay: ${open.map((f) => `${short(f.wallet)} ${sol(f.lamports)} SOL`).join(", ")}`));
      const row = el("div", "row");
      const act = (label, fn) => { const b = el("button", "btn small", label); b.type = "button"; b.onclick = fn; row.append(b); };
      const run = async (action, extra = {}) => { try { await api("/api/admin?action=" + action, { id: r.id, ...extra }); await load(); } catch (e) { showError(e.message); } };
      if (open.length && !auto) act(`Pay ${open.length} refund(s) from my wallet`, () => payRefunds(r, open));
      if (auto && r.status === "drawn" && r.auto?.error) act("Try again", () => run("retryPrize"));
      if (!auto && r.status === "drawn" && !a.bought) act("Mark prize bought", () => { const note = prompt("Note (e.g. Courtyard order)") ?? ""; run("bought", { note }); });
      if (!auto && r.status === "drawn" && !a.delivered) act("Mark prize sent", () => { const note = prompt("Note (e.g. Courtyard transfer link)") ?? ""; run("delivered", { note }); });
      if (["open", "drawing"].includes(r.status)) act("Cancel and refund", () => confirm("Cancel this raffle and refund everyone?") && run("cancel"));
      if (!["open", "drawing"].includes(r.status) && !open.length) act("Hide", () => run("hide"));
      it.append(row);
      list.append(it);
    }
  }

  function renderVrfStatus() {
    const box = $("vrfStatus"); if (!box) return;
    const v = state.vrf || {};
    box.replaceChildren();
    if (!v.enabled) {
      box.className = "msg";
      box.append("Draws use a future Solana block hash. To switch to ORAO VRF, add VRF_PAYER_KEY in Vercel (a separate small wallet) and redeploy.");
      return;
    }
    const fee = v.feeLamports, bal = v.balanceLamports;
    const per = fee != null ? fee + 5000 : null; // request fee + network fee
    const left = per && bal != null ? Math.floor(bal / per) : null;
    const low = left != null && left < 3;
    box.className = low ? "msg bad" : "msg";
    box.append("Randomness: ORAO VRF. Payer ", solscan("account", v.payer, short(v.payer)),
      bal != null ? `, ${sol(bal)} SOL` : "", fee != null ? `, ${sol(fee)} SOL per draw` : "",
      left != null ? (low ? `. Only enough for ${left} draw(s), top it up.` : `. Enough for about ${left} draws.`) : ".");
  }

  function renderVault() {
    const box = $("vaultStatus"); if (!box) return;
    const v = state.vault;
    box.replaceChildren();
    if (!v?.enabled) {
      box.className = "msg";
      box.append(v?.problem === "not_a_private_key" ? "VAULT_KEY is set but isn't a valid private key." : "Automatic pack raffles are off. To turn them on, add VAULT_KEY in Vercel (a new wallet only used for this) and redeploy.");
      return;
    }
    box.className = "vault";
    const p = el("p", "msg");
    p.append("Vault ", solscan("account", v.address, short(v.address)), `: ${v.solLamports != null ? sol(v.solLamports) : "?"} SOL, ${v.usdc != null ? v.usdc.toFixed(2) : "?"} USDC. `);
    const t = state.lastTick;
    p.append(t ? `Background check ran ${agoText(t.at)}${t.errors?.length ? ` with problems: ${t.errors.join("; ")}` : ""}. ` : "The background check hasn't run yet. ");
    const b = el("button", "btn small", "Run it now"); b.type = "button";
    b.onclick = async () => { b.disabled = true; try { await api("/api/admin?action=tick", {}); await load(); } catch (e) { showError(e.message); b.disabled = false; } };
    p.append(b); box.append(p);
    if (state.rpcFallback && Date.now() / 1000 - state.rpcFallback.at < 3600) box.append(el("p", "msg bad", `Helius isn't answering (${state.rpcFallback.why}). SLOT uses the public Solana RPC for now, which is slower. Add credits in Helius or set SOLANA_RPC in Vercel.`));
    for (const x of v.unmatched || []) {
      const q = el("p", "msg bad");
      q.append(`${sol(x.lamports)} SOL arrived from `, solscan("account", x.from, short(x.from)), " without a reservation (", solscan("tx", x.sig, "transaction"), "). It's swept to your wallet with the rest; refund it yourself if it was a mistake. ");
      const d = el("button", "btn small", "Dismiss"); d.type = "button";
      d.onclick = async () => { try { await api("/api/admin?action=dismissStray", { sig: x.sig }); await load(); } catch (e) { showError(e.message); } };
      q.append(d); box.append(q);
    }
  }
  const agoText = (at) => { const m = Math.round((Date.now() / 1000 - at) / 60); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

  let autopilotFilled = false;
  function renderAutopilot() {
    const f = $("autopilotForm"); if (!f) return;
    f.hidden = !state.vault?.enabled || !state.autopilot?.settings;
    if (f.hidden) return;
    const st = state.autopilot.settings;
    if (!autopilotFilled) { // don't overwrite what the admin is typing
      f.on.checked = !!st.on; f.lowUsd.value = st.lowUsd; f.lowSlots.value = st.lowSlots; f.smallSlots.value = st.smallSlots; f.tierUsd.value = st.tierUsd; f.bigSlots.value = st.bigSlots; f.marginPct.value = st.marginPct;
      f.hours.value = st.hours; f.maxPerWallet.value = st.maxPerWallet; f.exclude.value = (st.exclude || []).join(", ");
      autopilotFilled = true;
    }
    const l = state.autopilot.last, box = $("autopilotLast"); box.replaceChildren();
    if (!st.on) box.append("Autopilot is off.");
    else if (!l) box.append("Autopilot is on. The first raffles open within 5 minutes.");
    else {
      box.append(`${l.running} pack raffle${l.running === 1 ? "" : "s"} running (checked ${agoText(l.at)}).`);
      if (l.skipped?.length) { const ul = el("ul"); for (const x of l.skipped) ul.append(el("li", null, `${x.name || x.code}: ${x.reason}`)); box.append(" Skipped:", ul); }
    }
  }
  $("autopilotForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { on: f.on.checked, lowUsd: f.lowUsd.value, lowSlots: f.lowSlots.value, smallSlots: f.smallSlots.value, tierUsd: f.tierUsd.value, bigSlots: f.bigSlots.value, marginPct: f.marginPct.value, hours: f.hours.value, maxPerWallet: f.maxPerWallet.value, exclude: f.exclude.value };
    try {
      await api("/api/admin?action=autopilot", body);
      if (body.on) await api("/api/admin?action=tick", {}).catch(() => {});
      $("autopilotMsg").textContent = body.on ? "Saved. Raffles are being opened." : "Saved. No new raffles will open; running ones finish."; $("autopilotMsg").className = "msg ok";
      autopilotFilled = false; await load();
    } catch (err) { $("autopilotMsg").textContent = err.message; $("autopilotMsg").className = "msg bad"; }
  };

  let machinesList = null, machinesLoading = false;
  async function loadMachines() {
    if (machinesList || machinesLoading || !state.vault?.enabled) return;
    machinesLoading = true;
    try { machinesList = (await api("/api/admin?action=machines", {})).machines; }
    catch { machinesList = null; }
    machinesLoading = false;
    const sel = $("createForm").machine; sel.replaceChildren();
    if (!machinesList?.length) { sel.append(new Option("Couldn't load packs", "")); return; }
    for (const m of machinesList) sel.append(new Option(`${m.name}, $${m.price}${m.ev ? ` (EV $${Math.round(m.ev)})` : ""}`, m.code));
    $("createForm").oninput();
  }
  function syncKind() {
    const f = $("createForm"), kind = f.prizeKind.value;
    for (const l of f.querySelectorAll("[data-kind]")) l.hidden = l.dataset.kind !== kind;
    f.prizeUsd.required = f.priceSol.required = kind === "manual";
    f.title.required = kind === "manual";
    if (kind === "packs" && !state.vault?.enabled) $("createMsg").textContent = "Pack raffles need VAULT_KEY in Vercel first.";
  }

  async function payRefunds(r, open) {
    const p = provider();
    if (!p || !window.solanaWeb3) return showError("Open this page in your wallet to pay refunds.");
    if (state.me.wallet !== state.entryWallet) return showError("Connect the entry wallet to pay refunds.");
    try {
      const { Transaction, PublicKey } = window.solanaWeb3;
      const me = new PublicKey(state.me.wallet);
      const { blockhash } = await api("/api/admin?action=blockhash", {});
      const tx = new Transaction({ feePayer: me, recentBlockhash: blockhash });
      for (const f of open.slice(0, 18)) tx.add(transferIx(me, new PublicKey(f.wallet), f.lamports));
      const sent = await p.signAndSendTransaction(tx);
      const sig = sent?.signature || sent;
      for (let i = 0; i < 30; i++) {
        try { await api("/api/admin?action=refundsPaid", { id: r.id, sig }); break; }
        catch (e) { if (i === 29) throw e; await new Promise((ok) => setTimeout(ok, 3000)); }
      }
      await load();
    } catch (e) { showError(/reject/i.test(e?.message) ? "Refund cancelled." : e.message); }
  }

  $("createForm").onchange = syncKind;
  $("createForm").oninput = () => {
    const f = $("createForm");
    syncKind();
    if (f.prizeKind.value === "packs") {
      const m = machinesList?.find((x) => x.code === f.machine.value);
      const n = Number(f.packCount.value) || 0, spots = Number(f.spots.value);
      if (m && n > 0 && spots > 1) {
        const prize = m.price * n, each = Number(f.priceUsd.value) || Math.ceil(prize * 1.1 / spots * 100 - 1e-6) / 100;
        $("suggest").textContent = `Prize: ${n}× ${m.name} = ${usd(prize)}. ${spots} slots at ${usd2(each)}${state.solUsd ? ` (about ${(each / state.solUsd).toFixed(3)} SOL today)` : ""} bring in ${usd(each * spots)}. The winner gets the card${n === 1 ? "" : "s"} straight in their wallet.`;
      } else $("suggest").textContent = "";
      return;
    }
    const prize = Number(f.prizeUsd.value), spots = Number(f.spots.value), free = Number(f.freeSpots.value) || 0;
    if (prize > 0 && spots > 1 && state?.solUsd) {
      const s = (prize * 1.1) / spots / state.solUsd;
      $("suggest").textContent = `Entries cover the prize plus 10% at ${s.toFixed(3)} SOL per slot (about ${usd(s * state.solUsd)}). ${free ? `${free} free slot${free === 1 ? "" : "s"} will reserve ${(s * free).toFixed(3)} SOL of fees.` : ""}`;
    } else $("suggest").textContent = "";
  };
  $("createForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api("/api/admin?action=create", Object.fromEntries(new FormData(f).entries())); $("createMsg").textContent = "Raffle is live."; $("createMsg").className = "msg ok"; f.reset(); syncKind(); await load(); }
    catch (err) { $("createMsg").textContent = err.message; $("createMsg").className = "msg bad"; }
  };

  // ---------- data ----------
  function paint() {
    const { page, arg } = route();
    renderWallet();
    const cur = page === "raffle" ? "home" : page;
    for (const a of document.querySelectorAll("[data-nav]")) { if (a.dataset.nav === cur) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
    $("blocked").hidden = !state.blocked;
    $("blocked").textContent = state.blocked ? "Raffles aren't available in your country." : "";
    const view = page === "all" ? pageAll() : page === "treasury" ? pageTreasury() : page === "verify" ? pageVerify(arg) : page === "raffle" ? pageRaffle(arg) : pageHome();
    const main = $("view");
    main.className = page === "home" ? "" : "page";
    main.replaceChildren(...view);
    renderAdmin();
  }
  async function load() {
    const { page, arg } = route();
    try { state = await api("/api/state" + (page === "raffle" && arg ? `?detail=${encodeURIComponent(arg)}` : "")); showError(""); }
    catch (e) { showError(e.message); return; }
    if (page === "treasury" && treasuryCache) loadTreasury(); // refresh in the background
    if (page === "verify" && document.querySelector(".checks li")) return renderWallet(); // don't wipe a finished check
    paint();
  }
  async function loop() {
    if (!busy && !document.hidden) await load();
    const drawing = state?.raffles?.some((r) => r.status === "drawing");
    setTimeout(loop, drawing ? 4000 : 15000);
  }
  loop();
})();
