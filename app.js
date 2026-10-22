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
  const STAGE = { open: "on sale", drawing: "drawing", drawn: "drawn", refunding: "refunding", refunded: "refunded" };
  function stageOf(r) {
    if (r.status === "drawn") return r.delivered ? "prize sent" : r.bought ? "prize bought" : "drawn";
    return STAGE[r.status] || r.status;
  }
  const stageChip = (r) => el("span", "stage " + (r.status === "open" ? "open" : r.status === "drawing" ? "drawing" : r.status === "drawn" ? "drawn" : /refund/.test(r.status) ? "refund" : ""), stageOf(r));
  const ago = (ts) => { const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60)); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  const fillPct = (r) => Math.round((100 * r.sold) / Math.max(1, r.spots));
  const slotUsd = (r) => (r.priceUsd ? usd2(r.priceUsd) : state.solUsd ? usd2(sol(r.priceLamports) * state.solUsd) : null);

  function countdown(ts) {
    const s = Math.max(0, ts - Date.now() / 1000);
    if (s < 60) return "under a minute";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }

  // capsules: paid slots 1..N, then the free holder slots (gold, with a star)
  function strip(r) {
    const closed = !["open", "drawing"].includes(r.status);
    const box = el("div", "strip" + (closed ? " closed" : ""));
    const mine = new Set(r.mySpots || []), fresh = new Set(ui[r.id]?.fresh || []);
    const winIdx = r.status === "drawn" ? r.draw.index : -1;
    const show = Math.min(r.spots, 120);
    const cap = (cls, inner, title) => { const c = el("span", "cap " + cls); c.title = title; c.setAttribute("aria-hidden", "true"); c.append(el("span", null, inner)); return c; };
    for (let i = 0; i < show; i++) {
      let cls = "", inner = String(i + 1), title = `Slot ${i + 1}: open`;
      if (i < r.sold) { cls = mine.has(i) ? "mine" : "taken"; inner = "✓"; title = `Slot ${i + 1}: ${mine.has(i) ? "yours" : "taken"}`; }
      else if (i < r.sold + r.reserved) { cls = "held"; inner = "…"; title = `Slot ${i + 1}: being paid for`; }
      if (i === winIdx) { cls += " win"; inner = "♛"; title = `Slot ${i + 1}: winner`; }
      if (fresh.has(i)) cls += " new";
      box.append(cap(cls, inner, title));
    }
    if (r.spots > show) box.append(el("span", "msg", `+${r.spots - show} more`));
    const free = /refund/.test(r.status) ? 0 : r.status === "drawn" ? r.draw.freeWinners.length : r.freeSpots;
    for (let k = 0; k < free; k++) box.append(cap("star" + (winIdx === r.spots + k ? " win" : ""), "★", r.status === "drawn" ? `Free slot: ${short(r.draw.freeWinners[k])}` : "Free slot for a holder"));
    const sum = el("span", "sr", `${r.sold} of ${r.spots} slots taken${r.mine ? `, ${r.mine} yours` : ""}${r.reserved ? `, ${r.reserved} being paid for` : ""}${free ? `, plus ${free} free holder slot${free === 1 ? "" : "s"}` : ""}.`);
    box.prepend(sum);
    return box;
  }
  function legend(r) {
    const lg = el("div", "legend");
    const item = (cls, t) => { const s = el("span", cls); s.append(el("i"), t); lg.append(s); };
    if (r.status === "open") item("", "open");
    item("l-sold", "taken");
    if (r.mine) item("l-mine", "yours");
    if (r.freeSpots && !/refund/.test(r.status)) item("l-star", "free for a holder");
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
        <rect y="0" width="120" height="24" fill="#000" opacity=".22"/><rect y="128" width="120" height="32" fill="#000" opacity=".28"/>
        <path d="M0 24h120M0 128h120" stroke="#fff" stroke-opacity=".25"/>
      </g>
      <text x="60" y="38" text-anchor="middle" font-family="inherit" font-weight="800" font-size="${t.label.length > 9 ? 9 : 11}" letter-spacing="1.2" fill="#fff">${t.label}</text>
      <g transform="translate(0 -7)"><circle cx="60" cy="76" r="24" fill="#000" opacity=".2"/>
      ${GLYPH[t.glyph] || GLYPH.card}</g>
      <text x="60" y="118" text-anchor="middle" font-family="inherit" font-weight="900" font-size="20" fill="#fff" stroke="#000" stroke-opacity=".25" stroke-width=".6">${n}${price}</text>
      <text x="60" y="141.5" text-anchor="middle" font-family="inherit" font-weight="900" font-size="10" letter-spacing="2.5" fill="#fff">SLOT</text>
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

  // compact coin-style card for the grid
  function coinCard(r) {
    const c = el("a", "coin"); c.href = "#/r/" + r.id;
    const t = el("div", "t");
    t.append(el("div", "name", r.title));
    const r1 = el("div", "row1"); const l = el("span"); l.append(el("b", null, `${r.sold}/${r.spots}`), " slots"); r1.append(l, stageChip(r));
    const bar = el("div", "fill" + (fillPct(r) >= 70 ? " hot" : "")); const i = el("i"); i.style.width = fillPct(r) + "%"; bar.append(i);
    bar.setAttribute("role", "img"); bar.setAttribute("aria-label", `${fillPct(r)}% filled`);
    const r2 = el("div", "row1"); const pr = el("span"); pr.append(el("b", "g", slotUsd(r) || `${sol(r.priceLamports)} SOL`), "/slot");
    r2.append(pr, el("span", null, r.status === "open" ? countdown(r.deadline) : r.status === "drawn" ? `won by ${r.draw.winnerShort}` : stageOf(r)));
    t.append(r1, bar, r2);
    if (r.mine) t.append(el("div", "row1", `you: ${r.mine} slot${r.mine === 1 ? "" : "s"}`));
    c.append(pic(r, 128), t);
    return c;
  }

  // the "king of the hill" slot: the open raffle closest to filling
  function kothCard(r) {
    const k = el("section", "koth"); k.setAttribute("aria-label", "Closest to filling");
    k.append(el("span", "sticker", "closest to full"));
    const art = el("div", "art"); art.append(pic(r, 384));
    const info = el("div", "info");
    const h = el("h2"); h.append(link("#/r/" + r.id, r.title));
    const nums = el("div", "nums");
    const n = (label, val) => { const s = el("span"); s.append(label, " ", el("b", null, val)); nums.append(s); };
    n("worth", usd(r.prizeUsd)); n("filled", `${r.sold}/${r.spots}`); n("ends in", countdown(r.deadline)); n("odds", oddsText(r));
    const bar = el("div", "fill hot"); const i = el("i"); i.style.width = fillPct(r) + "%"; bar.append(i);
    info.append(h, nums, bar, strip(r), legend(r), buyRow(r));
    const m = ui[r.id]?.msg; if (m) info.append(el("p", "msg " + (m.kind || ""), m.text));
    k.append(art, info);
    return k;
  }

  function resultLine(r) {
    const p = el("p", "msg");
    if (r.status === "drawing") p.textContent = "sold out. drawing the winner…";
    else if (r.status === "drawn") { p.append(r.youWon ? el("b", null, "you won this. ") : "won by ", r.youWon ? "" : el("b", null, r.draw.winnerShort), " ", link("#/r/" + r.id, "see the draw")); }
    else p.textContent = r.status === "refunded" ? "didn't fill. everyone got refunded." : "didn't fill. refunds on the way.";
    return p;
  }

  function buyRow(r) {
    const row = el("div", "buy");
    const left = r.spots - r.sold;
    const can = Math.min(r.maxPerWallet - r.mine, left - r.reserved);
    const priceTxt = `${sol(r.priceLamports)} SOL`;
    if (left <= 0) { row.append(el("span", "msg", "sold out. draw's next.")); return row; }
    if (!state.me) { const b = el("button", "pull"); b.type = "button"; b.append("PULL", el("small", null, "connect wallet")); b.onclick = connect; row.append(b, el("span", "price", priceTxt)); return row; }
    if (can <= 0) { row.append(el("span", "msg", r.mine >= r.maxPerWallet ? `you have the max (${r.maxPerWallet}).` : "all slots are being paid for. back in a few min.")); return row; }
    for (let n = 1; n <= Math.min(can, 2); n++) {
      const b = el("button", "pull" + (n === 1 ? "" : " ghost")); b.type = "button";
      b.append(n === 1 ? "PULL" : "PULL ×2", el("small", null, n === 1 ? priceTxt : `${sol(r.priceLamports * 2)} SOL`));
      b.setAttribute("aria-label", n === 1 ? `Buy 1 slot for ${priceTxt}` : `Buy 2 slots for ${sol(r.priceLamports * 2)} SOL`);
      b.disabled = busy || !!state.blocked;
      b.onclick = () => { if (!matchMedia("(prefers-reduced-motion: reduce)").matches) { const d = el("span", "drop"); b.append(d); setTimeout(() => d.remove(), 600); } buy(r, n); };
      row.append(b);
    }
    const p = el("span", "price"); if (slotUsd(r)) p.append(el("small", null, `≈ ${slotUsd(r)} per slot`)); row.append(p);
    return row;
  }

  // ---------- pages ----------
  const GROUPS = [["all", null], ["pokémon", /^pokemon/], ["one piece", /^onepiece/], ["sports", /^(soccer|basketball|baseball|football|sports)/], ["watches", /watch/], ["other", null]];
  const groupOf = (r) => { const code = r.prize?.machine || r.category || ""; const g = GROUPS.find(([n, re]) => re && re.test(code)); return g ? g[0] : r.category === "watch" ? "watches" : "other"; };
  ui.filter = store.get("slot_filter") || "all";
  ui.view = store.get("slot_view") || "grid";

  function rafflesTable(list) {
    const wrap = el("div", "tablewrap");
    const tbl = el("table");
    const head = el("tr"); for (const h of ["raffle", "stage", "slots", "slot price", "ends / ended", "worth"]) head.append(el("th", null, h));
    tbl.append(head);
    for (const r of list) {
      const tr = el("tr");
      const c1 = el("td"); c1.append(link("#/r/" + r.id, r.title));
      const c2 = el("td"); c2.append(stageChip(r));
      tr.append(c1, c2, el("td", "num", `${r.sold}/${r.spots}`), el("td", "num", slotUsd(r) || `${sol(r.priceLamports)} SOL`), el("td", "num", r.status === "open" ? countdown(r.deadline) : when(r.deadline)), el("td", "num", usd(r.prizeUsd)));
      tbl.append(tr);
    }
    wrap.append(tbl);
    return wrap;
  }

  function pageHome() {
    const v = [];
    const intro = el("section", "intro");
    const h1 = el("h1"); const sc = el("span", "scribble", "the grail.");
    sc.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 200 12" preserveAspectRatio="none" aria-hidden="true"><path d="M2 8 C 40 2, 80 11, 120 5 S 180 3, 198 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>');
    h1.append("grab a slot. win ", sc);
    intro.append(h1, el("p", null, "real graded cards and watches. fills or refunds, drawn on-chain, prize straight to your wallet."));
    v.push(intro);

    const open = state.raffles.filter((r) => r.status === "open");
    const king = [...open].sort((a, b) => fillPct(b) - fillPct(a) || a.deadline - b.deadline)[0];
    if (king) v.push(kothCard(king));

    const flow = el("div", "flow"); flow.setAttribute("aria-label", "How it works");
    ["grab a slot", "raffle fills (or everyone's refunded)", "VRF picks the winner", "pack opened", "card in your wallet"].forEach((t, i) => { if (i) flow.append(el("span", "arr", "→")); flow.append(el("span", null, t)); });
    flow.append(link("#/verify", "check a draw"));
    v.push(flow);

    const how = el("details");
    how.append(el("summary", null, "how does it work?"));
    for (const t of [
      "Fill or refund: the draw only happens when every paid slot is sold. If a raffle isn't full by its deadline, everyone gets their SOL back.",
      "Anyone can play: connect a Solana wallet and grab a slot. A few slots per wallet per raffle, so everyone gets a shot.",
      state.coin.live ? `Free slots for holders: when a raffle fills, 2 extra slots go to random wallets holding ${needText()} or more. Every holder has the same chance, drawn with the same on-chain randomness.` : `Free slots for holders: once $${state.coin.symbol} launches, every full raffle gets 2 extra slots for random holders of ${needText()}, drawn with the same on-chain randomness.`,
      state.vrf?.enabled ? "Provably fair: the paid slots are locked first, then ORAO's verifiable randomness on Solana picks the winner. Anyone can check the draw." : "Provably fair: the paid slots are locked first, then the hash of a later Solana block picks the winner. Anyone can check the draw.",
      "Real prizes: packs come from Collector Crypt. Opened right after the draw, the graded card or watch goes straight to the winner's wallet. Keep it, sell it back, or have it shipped.",
    ]) how.append(el("p", null, t));
    v.push(how);

    // live raffles: filters, grid or table
    const live = state.raffles.filter((r) => ["open", "drawing"].includes(r.status) && r !== king);
    const head = el("div", "bar-row"); head.append(el("h2", null, `live · ${live.length + (king ? 1 : 0)}`));
    const tools = el("div", "filters");
    const present = new Set(state.raffles.filter((r) => ["open", "drawing"].includes(r.status)).map(groupOf));
    for (const [name] of GROUPS) {
      if (name !== "all" && !present.has(name)) continue;
      const b = el("button", null, name); b.type = "button"; b.setAttribute("aria-pressed", String(ui.filter === name));
      b.onclick = () => { ui.filter = name; store.set("slot_filter", name); paint(); };
      tools.append(b);
    }
    const vt = el("button", null, ui.view === "grid" ? "▤ table" : "▦ grid"); vt.type = "button"; vt.setAttribute("aria-label", ui.view === "grid" ? "Show as table" : "Show as grid");
    vt.onclick = () => { ui.view = ui.view === "grid" ? "table" : "grid"; store.set("slot_view", ui.view); paint(); };
    tools.append(vt);
    head.append(tools);
    v.push(head);
    const shown = live.filter((r) => ui.filter === "all" || groupOf(r) === ui.filter).sort((a, b) => fillPct(b) - fillPct(a) || a.deadline - b.deadline);
    if (!shown.length) v.push(el("p", "empty joke", king ? "nothing else here. the one above is all yours." : "no raffles live right now. touch grass, check back soon."));
    else if (ui.view === "table") v.push(rafflesTable(shown));
    else { const g = el("div", "grid"); g.append(...shown.map(coinCard)); v.push(g); }

    const past = state.raffles.filter((r) => !["open", "drawing"].includes(r.status)).slice(0, 4);
    if (past.length) {
      const ph = el("div", "bar-row"); ph.append(el("h2", null, "just finished"), link("#/all", "all raffles →"));
      const g = el("div", "grid"); g.append(...past.map(coinCard));
      v.push(ph, g);
    }
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
    if (!r) return [el("h1", null, "raffle not found"), el("p", "lede", "it may have been removed.")];
    const v = [];

    // top: pack art | the essentials, the slots and the PULL lever
    const top = el("section", "split");
    const art = el("div", "art"); art.append(pic(r, 640));
    const info = el("div", "info");
    const h = el("h1", null, r.title);
    const line = el("div", "nums"); line.append(stageChip(r));
    const n = (label, val, tip) => { const s2 = el("span"); s2.append(label, " "); const b2 = el("b", null, val); if (tip) b2.title = tip; s2.append(b2); line.append(s2); };
    n("worth", usd(r.prizeUsd), r.prize?.kind === "packs" ? `${r.prize.count}× ${r.prize.name}` : r.link ? "on Courtyard" : r.category);
    n("slots", `${r.sold}/${r.spots}`, `${r.spots - r.sold} left, max ${r.maxPerWallet} per wallet`);
    if (r.freeSpots) n("free", String(r.freeSpots), "for random holders");
    if (r.priceUsd) n("slot", usd2(r.priceUsd), r.priceLamports ? `${sol(r.priceLamports)} SOL right now` : "paid in SOL");
    else n("slot", `${sol(r.priceLamports)} SOL`, state.solUsd ? `about ${solUsd(r.priceLamports)}` : "");
    if (r.status === "open") n("ends in", countdown(r.deadline), when(r.deadline));
    const bar = el("div", "fill" + (fillPct(r) >= 70 ? " hot" : "")); const bi = el("i"); bi.style.width = fillPct(r) + "%"; bar.append(bi);
    info.append(h, line, bar, strip(r), legend(r));
    if (r.status === "open") info.append(buyRow(r), el("div", "odds", `odds: ${oddsText(r)} · max ${r.maxPerWallet} per wallet`));
    else if (r.status !== "drawn") info.append(resultLine(r));
    else info.append(el("p", "msg", r.youWon ? "you won this one. your pull is below ↓" : `won by ${r.draw.winnerShort}. the pull is below ↓`));
    const m = ui[r.id]?.msg; if (m) info.append(el("p", "msg " + (m.kind || ""), m.text));
    if (r.myRefunds) for (const f of r.myRefunds) info.append(el("p", "msg " + (f.paid ? "ok" : ""), f.paid ? `refunded ${sol(f.lamports)} SOL to your wallet.` : `you'll get ${sol(f.lamports)} SOL back.`));
    top.append(art, info);
    v.push(top);

    // the result: pulled cards, face down until you flip them
    if (r.status === "drawn") {
      const res = el("section", "plain");
      res.append(el("h2", null, r.youWon ? "you won 🎉" : `won by ${r.draw.winnerShort}`));
      if (!r.youWon) res.append(el("p", "msg", `with ${r.draw.index >= r.spots ? "a free holder slot" : "slot " + (r.draw.index + 1)}.`));
      if (r.prize?.kind === "packs") {
        if (r.youWon) res.append(el("p", "msg ok", r.auto?.status === "done" ? "your card is in your wallet. open it on Collector Crypt to keep, sell or ship it." : "your packs are being opened. the card goes straight to your wallet, nothing to fill in."));
        const cards = r.auto?.cards || [];
        if (cards.length) { const pulls = el("div", "pulls"); pulls.append(...cards.map(flipCard)); res.append(pulls); }
        else res.append(el("p", "empty", "no pulls yet. packs open right after the draw."));
      } else if (r.youWon && !r.claimed) res.append(claimForm(r)); else if (r.youWon) res.append(el("p", "msg ok", r.delivered ? "prize sent." : "got your details. your prize is on its way."));
      const a = el("p", "msg"); a.style.margin = "0"; a.append(link("#/verify/" + r.id, "check this draw yourself"));
      if (r.draw.vrf?.account) a.append(" · ", solscan("account", r.draw.vrf.account, "the random number on Solana"));
      res.append(a);
      v.push(res);
      if (r.youWon) winFlash(r);
    }

    // progress + prize details, uneven columns
    const cols = el("div", "cols");
    const prog = el("section", "panel"); prog.append(el("h2", null, "progress"), steps(r));
    const pz = el("section", "panel"); pz.append(el("h2", null, "the prize"));
    const kv = el("dl", "kv");
    const add = (k, val) => { kv.append(el("dt", null, k)); const dd = el("dd"); dd.append(val); kv.append(dd); };
    add("worth", usd(r.prizeUsd));
    if (r.link) add("listing", link(r.link, "open on Courtyard", true));
    if (r.prize?.kind === "packs") add("packs", `${r.prize.count}× ${r.prize.name} · $${r.prize.unitUsd} each · Collector Crypt`);
    add("opened", when(r.createdAt));
    add("paid to", solscan("account", r.payTo || state.entryWallet));
    pz.append(kv);
    if (r.prize?.kind === "packs") {
      const d = el("details"); d.append(el("summary", null, "what happens after the draw?"),
        el("p", null, "Opened automatically right after the draw. The card lands in the winner's wallet as an NFT backed by the real graded card: keep it, sell it, or have the physical card shipped from Collector Crypt."));
      pz.append(d);
    }
    cols.append(prog, pz); v.push(cols);

    // free slots: plain section, explanation folded
    const fs = el("section", "plain");
    fs.append(el("h2", null, "free slots"));
    if (r.status === "drawn" && r.draw.freeWinners.length) {
      const ul = el("ul");
      r.draw.freeWinners.forEach((wlt, k) => { const li = el("li"); li.append(`slot ★${k + 1}: `, solscan("account", wlt)); ul.append(li); });
      fs.append(ul);
    } else fs.append(el("p", "msg", r.freeSpots ? "no winners yet. drawn when the raffle fills." : "none in this raffle."));
    const fd = el("details"); fd.append(el("summary", null, "who gets free slots?"), el("p", null, `Free slots go to random wallets holding ${needText()} or more for ${state.coin.holdHours} hours. Every eligible wallet has the same chance and nobody gets two.`));
    fs.append(fd);
    v.push(fs);

    // paid slots ledger
    const ps = el("section", "plain");
    ps.append(el("h2", null, "paid slots"), el("p", "msg", "in buy order. this order is the slot numbering the draw uses."));
    const tw = el("div", "tablewrap"); const tbl = el("table");
    const hr = el("tr"); for (const x of ["slots", "wallet", "payment"]) hr.append(el("th", null, x)); tbl.append(hr);
    let k = 0;
    for (const e of r.entries || []) {
      const tr = el("tr");
      const nums = e.n === 1 ? `${k + 1}` : `${k + 1}–${k + e.n}`; k += e.n;
      const c2 = el("td", "addr"); c2.append(solscan("account", e.wallet, e.wallet));
      const c3 = el("td"); c3.append(solscan("tx", e.sig, "tx"));
      tr.append(el("td", "num", nums), c2, c3); tbl.append(tr);
    }
    if (!(r.entries || []).length) { const tr = el("tr"); const td = el("td", "empty", "nobody yet. be first."); td.colSpan = 3; tr.append(td); tbl.append(tr); }
    tw.append(tbl); ps.append(tw); v.push(ps);
    return v;
  }

  // a pulled card: face down, flips on click; the frame colour is the rarity Collector Crypt reported
  function flipCard(c) {
    const rar = String(c.rarity || "").toLowerCase();
    const b = el("button", "flip" + (["common", "uncommon", "rare", "epic"].includes(rar) ? " r-" + rar : ""));
    b.type = "button"; b.setAttribute("aria-pressed", "false"); b.setAttribute("aria-label", `Pulled card: ${c.name || "card"}${c.rarity ? `, ${c.rarity}` : ""}. Click to flip.`);
    const inner = el("div", "in");
    const back = el("div", "face back-side", "SLOT");
    const front = el("div", "face front");
    const top = el("div"); top.append(el("div", "rar", c.rarity || "pulled"), el("b", null, c.name || "Card"));
    const bottom = el("div"); if (c.grade) bottom.append(el("div", "msg", `grade ${c.grade}`));
    if (c.nft) { const l = solscan("token", c.nft, "NFT on Solscan"); l.onclick = (e) => e.stopPropagation(); bottom.append(l); }
    front.append(top, bottom);
    inner.append(back, front); b.append(inner);
    b.onclick = () => b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
    return b;
  }
  function cardRow(c) { return flipCard(c); }

  // a one-time "SSR!" flash the first time you see your win
  function winFlash(r) {
    const key = "slot_won_" + r.id;
    if (store.get(key) || matchMedia("(prefers-reduced-motion: reduce)").matches) { store.set(key, "1"); return; }
    store.set(key, "1");
    const f = el("div", "ssr"); f.setAttribute("aria-hidden", "true"); f.append(el("b", null, "SSR!"));
    document.body.append(f); setTimeout(() => f.remove(), 1500);
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
  function renderTicker() {
    const box = $("ticker"); if (!box) return;
    const ev = state.activity || [];
    if (!ev.length) { box.hidden = true; return; }
    box.hidden = false;
    const run = el("div", "run");
    for (const e of ev) {
      const a = el("a"); a.href = "#/r/" + e.id;
      if (e.kind === "buy") a.append(el("b", null, short(e.wallet)), " ", el("span", "g", `bought ${e.n === 1 ? `slot #${e.from}` : `slots #${e.from}–${e.from + e.n - 1}`}`), ` · ${e.title} · ${ago(e.at)}`);
      else if (e.kind === "win") a.append(el("b", null, short(e.wallet)), " ", el("span", "y", "won"), ` ${e.title} · ${ago(e.at)}`);
      else if (e.kind === "card") a.append(el("b", null, short(e.wallet)), " pulled ", el("span", "y", `${e.card || "a card"}${e.rarity ? ` (${e.rarity.toLowerCase()})` : ""}`), ` · ${ago(e.at)}`);
      else if (e.kind === "refunded") a.append(`${e.title} didn't fill · refunded · ${ago(e.at)}`);
      else a.append(el("span", "g", "new"), ` ${e.title} · ${e.spots} slots${e.priceUsd ? ` @ ${usd2(e.priceUsd)}` : ""} · ${ago(e.at)}`);
      run.append(a);
    }
    box.replaceChildren(run);
    run.style.animationDuration = Math.max(30, ev.length * 5) + "s";
  }

  function paint() {
    const { page, arg } = route();
    renderWallet();
    renderTicker();
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
