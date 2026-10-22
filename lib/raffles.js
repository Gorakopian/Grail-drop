// The raffles. Rules:
//  - Entries pay for the prize: spots × price covers the prize (+ margin). The coin's fees only pay extras.
//  - Fill or refund: the draw only happens when every spot is sold; not full by the deadline → everyone refunded.
//  - Max N spots per wallet; holders of the coin (MIN_HOLD for HOLD_HOURS) only, once the coin is live.
//  - When full, 1 free spot goes to a random holder, then a future Solana block picks the winner.
// Two kinds of prize:
//  - "manual" (watches, sneakers, boxes from Courtyard): slot money goes to the treasury, the admin buys and
//    sends the prize and pays refunds from their own wallet. Nothing moves automatically.
//  - "packs" (Collector Crypt): slot money goes to the vault, and lib/auto.js buys and opens the packs for the
//    winner, pays refunds and sweeps what's left over to the treasury, all by itself.
import { randomBytes } from "node:crypto";
import { redis, getJSON, setJSON } from "./redis.js";
import { treasury, feesWallet, tokenMint, MIN_HOLD, HOLD_HOURS, RESERVE_SECONDS, DRAW_DELAY_SLOTS, MAX_HOLDER_SHARE, MAX_FREE_SPOTS, excludedHolders, MAX_AUTO_PRIZE_USD, MAX_PACKS, vaultSecret, LAMPORTS } from "./config.js";
import { parseSecretKey } from "./sol.js";
import * as chain from "./solana.js";
import * as vrf from "./vrf.js";
import { ticketsOf, hashList, winnerFrom, holdersHash, pickFreeSpots } from "./draw.js";

const KEY = (id) => `grail:raffle:${id}`;
const INDEX = "grail:raffles";
const now = () => Math.floor(Date.now() / 1000);
export const CATEGORIES = ["watch", "sneakers", "pokemon", "cards", "other"];

export const getRaffle = (id) => getJSON(KEY(id));
export const save = (r) => setJSON(KEY(r.id), r);

/** The vault's address, or null when VAULT_KEY isn't set (or isn't a valid key). */
export function vaultAddress() {
  if (!vaultSecret()) return null;
  try { return parseSecretKey(vaultSecret()).publicKey.toBase58(); } catch { return null; }
}
/** Where slot payments of this raffle go. */
export const payToOf = (r) => r.payTo || treasury();
/** Lamports for one slot right now. Pack raffles are priced in dollars, converted at the current SOL price. */
export function slotLamports(r, solUsd) {
  if (!r.priceUsd) return r.priceLamports;
  if (!(solUsd > 0)) return null;
  return Math.ceil((r.priceUsd / solUsd) * LAMPORTS / 1000) * 1000;
}

export async function listRaffles() {
  const flat = (await redis("HGETALL", INDEX)) || [];
  const ids = [];
  for (let i = 0; i < flat.length; i += 2) ids.push(flat[i]);
  const all = await Promise.all(ids.map(getRaffle));
  return all.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

export async function withLock(id, fn) {
  const key = `grail:lock:${id}`;
  for (let i = 0; i < 25; i++) {
    if ((await redis("SET", key, "1", "NX", "EX", 15)) === "OK") {
      try { return await fn(); } finally { await redis("DEL", key); }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("busy");
}

export const sold = (r) => r.entries.reduce((s, e) => s + e.n, 0);
const held = (r, t = now()) => r.holds.filter((h) => h.exp > t).reduce((s, h) => s + h.n, 0);
const mine = (r, w, t = now()) => r.entries.filter((e) => e.wallet === w).reduce((s, e) => s + e.n, 0) + r.holds.filter((h) => h.wallet === w && h.exp > t).reduce((s, h) => s + h.n, 0);

/** Checks and fills in a Collector Crypt pack prize. */
async function packPrize(input) {
  const { machines } = await import("./packs.js");
  if (!vaultAddress()) return { error: "Pack raffles need the vault: set VAULT_KEY in Vercel first." };
  const count = Math.floor(Number(input.packCount) || 0);
  if (!(count >= 1 && count <= MAX_PACKS)) return { error: `Between 1 and ${MAX_PACKS} packs.` };
  const list = await machines().catch(() => null);
  if (!list) return { error: "Couldn't load the Collector Crypt packs. Try again." };
  const m = list.find((x) => x.code === input.machine);
  if (!m) return { error: "Pick a pack." };
  const prizeUsd = m.price * count;
  if (prizeUsd > MAX_AUTO_PRIZE_USD) return { error: `Pack prizes are capped at $${MAX_AUTO_PRIZE_USD} per raffle (MAX_AUTO_PRIZE_USD).` };
  const spots = Math.floor(Number(input.spots ?? input.slots) || 0);
  const priceUsd = Number(input.priceUsd) > 0 ? Number(input.priceUsd) : Math.ceil((prizeUsd * 1.1 / Math.max(spots, 1)) * 100 - 1e-6) / 100;
  return { fill: {
    prize: { kind: "packs", machine: m.code, name: m.name, count, unitUsd: m.price },
    prizeUsd, priceUsd, priceSol: 1, // priceSol is a placeholder; pack raffles are priced in dollars
    title: String(input.title || "").trim() || `${count}× ${m.name}`, image: input.image || m.image || "",
  } };
}

export function validateNew(input) {
  const r = {
    title: String(input.title || "").trim().slice(0, 80),
    category: CATEGORIES.includes(input.category) ? input.category : "other",
    image: /^https:\/\//.test(input.image || "") ? String(input.image).slice(0, 500) : null,
    link: /^https:\/\//.test(input.link || "") ? String(input.link).slice(0, 500) : null,
    prizeUsd: Math.round(Number(input.prizeUsd) || 0),
    spots: Math.floor(Number(input.spots ?? input.slots) || 0),
    priceLamports: chain.toLamports(input.priceSol),
    maxPerWallet: Math.max(1, Math.floor(Number(input.maxPerWallet) || 2)),
    deadline: now() + Math.round((Number(input.hours) || 72) * 3600),
    freeSpots: Math.max(0, Math.min(MAX_FREE_SPOTS, Math.floor(Number(input.freeSpots ?? 2)))),
  };
  if (!r.title) return { error: "Give the raffle a title." };
  if (r.spots < 2 || r.spots > 1000) return { error: "Slots must be between 2 and 1000." };
  if (!(r.priceLamports > 0)) return { error: "Set a slot price in SOL." };
  if (r.maxPerWallet > r.spots) r.maxPerWallet = r.spots;
  return { raffle: r };
}

export async function createRaffle(input) {
  if (input.prizeKind === "packs") {
    const p = await packPrize(input);
    if (p.error) return p;
    Object.assign(input, p.fill);
  }
  const v = validateNew(input);
  if (v.error) return v;
  const nr = v.raffle;
  if (input.prizeKind === "packs") {
    Object.assign(nr, { prize: input.prize, payTo: vaultAddress(), priceUsd: Number(input.priceUsd), priceLamports: 0, category: /watch/i.test(input.prize.machine + input.prize.name) ? "watch" : "cards" });
    if (input.autopilot) nr.autopilot = String(input.autopilot);
    if (!(nr.priceUsd * nr.spots >= nr.prizeUsd)) return { error: `The slots only bring in $${(nr.priceUsd * nr.spots).toFixed(2)}, the packs cost $${nr.prizeUsd}. Raise the slot price or the number of slots.` };
  }
  if (!tokenMint() || !feesWallet()) nr.freeSpots = 0; // no coin or no fees wallet yet → no free spots
  nr.reservedLamports = nr.freeSpots * nr.priceLamports;
  if (nr.reservedLamports > 0) {
    const t = await treasuryStatus();
    if (t.availableLamports < nr.reservedLamports) {
      const canCover = Math.floor(t.availableLamports / nr.priceLamports);
      return { error: `The treasury can only pay for ${canCover} free slot${canCover === 1 ? "" : "s"} at this price right now. Lower the free slots or the price.` };
    }
  }
  const id = randomBytes(5).toString("hex");
  const r = { id, ...nr, createdAt: now(), status: "open", entries: [], holds: [], refunds: [], draw: null, claim: null, bought: null, delivered: null };
  await save(r);
  await redis("HSET", INDEX, id, String(r.createdAt));
  return { raffle: r };
}

/**
 * The fees wallet: what's in it, what's set aside for free spots of raffles still running, what's free to use.
 * Free-spot money stays reserved until the prize is bought (then it's spent on the prize).
 */
export async function treasuryStatus(raffles) {
  const wallet = feesWallet();
  raffles = raffles || (await listRaffles());
  const reserving = raffles.filter((r) => r.reservedLamports > 0 && ["open", "drawing", "drawn"].includes(r.status) && !r.bought);
  const reservedLamports = reserving.reduce((s, r) => s + r.reservedLamports, 0);
  const spentLamports = raffles.filter((r) => r.bought).reduce((s, r) => s + (r.reservedLamports || 0), 0);
  let balanceLamports = null;
  if (wallet) {
    const c = await redis("GET", `grail:bal:${wallet}`);
    if (c != null) balanceLamports = Number(c);
    else {
      balanceLamports = await chain.rpc("getBalance", [wallet, { commitment: "finalized" }]).then((x) => x.value).catch(() => null);
      if (balanceLamports != null) await redis("SET", `grail:bal:${wallet}`, String(balanceLamports), "EX", 30);
    }
  }
  return {
    wallet, balanceLamports, reservedLamports, spentLamports,
    availableLamports: balanceLamports == null ? 0 : Math.max(0, balanceLamports - reservedLamports),
    reserving: reserving.map((r) => ({ id: r.id, title: r.title, lamports: r.reservedLamports, freeSpots: r.freeSpots })),
  };
}

/** Housekeeping: drop expired reservations; past the deadline and not full → refund everyone. */
export function settle(r, t = now()) {
  r.holds = r.holds.filter((h) => h.exp > t);
  if (r.status === "open" && t > r.deadline && sold(r) < r.spots) startRefunds(r, "not_full");
  return r;
}

function startRefunds(r, reason) {
  r.status = "refunding";
  r.reservedLamports = 0; // the free-spot money goes back to the treasury
  r.refundReason = reason;
  const per = {};
  for (const e of r.entries) per[e.wallet] = (per[e.wallet] || 0) + e.lamports;
  for (const [wallet, lamports] of Object.entries(per)) r.refunds.push({ wallet, lamports, reason, paid: null });
  r.holds = [];
}

// ---- buying a spot: reserve → pay in the wallet → confirm --------------------------
export async function reserve({ id, wallet, n }) {
  n = Math.floor(Number(n));
  return withLock(id, async () => {
    const r = await getRaffle(id);
    if (!r) return { error: "Raffle not found." };
    settle(r);
    if (r.status !== "open") { await save(r); return { error: "This raffle is closed." }; }
    if (!(n >= 1)) return { error: "How many slots?" };
    const have = mine(r, wallet);
    if (have + n > r.maxPerWallet) return { error: have ? `Max ${r.maxPerWallet} slots per wallet. You already have ${have}.` : `Max ${r.maxPerWallet} slots per wallet.` };
    const free = r.spots - sold(r) - held(r);
    if (free <= 0) return { error: held(r) ? "All slots are being paid for right now. Try again in a few minutes." : "Sold out." };
    if (n > free) return { error: `Only ${free} slot${free === 1 ? "" : "s"} left.` };
    const each = slotLamports(r, r.priceUsd ? await chain.solUsd() : null);
    if (!each) return { error: "Couldn't get the SOL price right now. Try again in a minute." };
    const hold = { nonce: randomBytes(9).toString("hex"), wallet, n, lamports: each * n, at: now(), exp: now() + RESERVE_SECONDS, payTo: payToOf(r) };
    r.holds.push(hold);
    await save(r);
    await redis("SET", `grail:hold:${hold.nonce}`, JSON.stringify({ id, ...hold }), "EX", 86400);
    await redis("HSET", "grail:pending", hold.nonce, JSON.stringify({ id, wallet, lamports: hold.lamports, at: hold.at, payTo: hold.payTo }));
    return { nonce: hold.nonce, lamports: hold.lamports, treasury: hold.payTo, expiresAt: hold.exp, n };
  });
}

/**
 * Check the payment on-chain and turn the reservation into spots.
 * → { status: "ok" } | { status: "pending" } | { status: "refund", reason } | { error }
 */
export async function confirm({ nonce, sig, wallet }) {
  const hold = await getJSON(`grail:hold:${nonce}`);
  if (!hold || hold.wallet !== wallet) return { error: "Reservation not found." };
  if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(String(sig || ""))) return { error: "That's not a transaction signature." };
  const tx = await chain.getParsedTx(sig);
  if (!tx) return { status: "pending" };
  if (tx.meta?.err) return { error: "That transaction failed on-chain. Nothing was paid." };
  if ((tx.blockTime || 0) < hold.at - 120) return { error: "That payment is older than this reservation." };
  const paid = chain.lamportsTransferred(tx, wallet, hold.payTo || treasury());
  if (paid < hold.lamports) return { error: "That transaction doesn't pay for these slots." };
  await redis("HDEL", "grail:pending", nonce); // paid (or about to be refunded): the watcher can stop looking
  if ((await redis("SET", `grail:sig:${sig}`, nonce, "NX")) !== "OK") {
    return (await redis("GET", `grail:sig:${sig}`)) === nonce ? { status: "ok", already: true } : { error: "That payment was already used." };
  }
  return withLock(hold.id, async () => {
    const r = await getRaffle(hold.id);
    settle(r);
    const i = r.holds.findIndex((h) => h.nonce === nonce);
    if (i >= 0) r.holds.splice(i, 1);
    const roomFor = r.status === "open" ? r.spots - sold(r) - held(r) : 0;
    const allowed = r.maxPerWallet - mine(r, wallet);
    let result;
    if (roomFor >= hold.n && allowed >= hold.n) {
      r.entries.push({ wallet, n: hold.n, lamports: paid, sig, at: now() });
      result = { status: "ok" };
    } else {
      // paid too late (reservation expired and the spots are gone): owed back
      r.refunds.push({ wallet, lamports: paid, reason: "late_payment", sig, paid: null });
      result = { status: "refund", reason: "Your reservation ran out and the slots were taken. Your SOL will be refunded." };
    }
    if (r.status === "open" && sold(r) >= r.spots) await startDraw(r);
    await save(r);
    return result;
  });
}

// ---- the draw ---------------------------------------------------------------------
async function startDraw(r) {
  r.status = "drawing";
  const tickets = ticketsOf(r.entries);
  const d = { tickets, ticketsHash: hashList(tickets), frozenAt: now(), afterSlot: (await chain.currentSlot()) + DRAW_DELAY_SLOTS, holders: null };
  const mint = tokenMint();
  if (r.freeSpots > 0 && mint) {
    try {
      const list = (await chain.holdersAtLeast(mint, MIN_HOLD, { maxShare: MAX_HOLDER_SHARE, exclude: [treasury(), feesWallet(), ...excludedHolders()] }))
        .map((h) => h.owner); // equal chance for everyone over the minimum
      await setJSON(`grail:holders:${r.id}`, list);
      d.holders = { count: list.length, hash: holdersHash(list) };
    } catch (e) { d.holders = { count: 0, error: String(e.message || e).slice(0, 120) }; }
  }
  r.draw = d;
}

/**
 * Where the randomness comes from. With VRF configured (or already started for this raffle): ORAO VRF,
 * seeded with a fingerprint of the locked lists. Otherwise: the hash of a Solana block after the lock.
 * Returns the entropy string, or null if it isn't available yet (records progress on r.draw).
 */
async function drawEntropy(r) {
  const d = r.draw;
  if (d.vrf || vrf.vrfEnabled()) {
    if (!d.vrf) {
      const seed = vrf.vrfSeed(r.id, d.ticketsHash, d.holders?.hash);
      d.vrf = { seed: seed.toString("hex"), account: vrf.requestAddress(seed).toBase58() };
    }
    const seed = Buffer.from(d.vrf.seed, "hex");
    let acc;
    try { acc = await vrf.readRandomness(seed); } catch (e) { d.vrf.error = String(e.message || e).slice(0, 160); return null; }
    if (!acc) {
      // not requested yet, or the request transaction got dropped: (re)send it
      if (!d.vrf.requestedAt || now() - d.vrf.requestedAt > 90) {
        try { d.vrf.requestSig = await vrf.requestRandomness(seed); d.vrf.requestedAt = now(); d.vrf.error = null; }
        catch (e) { d.vrf.error = String(e.message || e).slice(0, 160); }
      }
      return null;
    }
    if (!d.vrf.requestedAt) d.vrf.requestedAt = now();
    if (acc.status !== "fulfilled") return null;
    if (acc.seed !== d.vrf.seed) { d.vrf.error = "seed_mismatch"; return null; }
    Object.assign(d.vrf, { randomness: acc.randomness, client: acc.client, fulfilledAt: now(), error: null });
    d.source = "vrf";
    return acc.randomness;
  }
  let block;
  try { block = await chain.blockAtOrAfter(d.afterSlot); } catch { return null; } // not final yet
  d.slot = block.slot;
  d.blockhash = block.blockhash;
  d.source = "block";
  return block.blockhash;
}

/** Run the draw once the randomness is in. Safe to call often. */
export async function maybeDraw(id) {
  const peek = await getRaffle(id);
  if (peek?.status !== "drawing") return peek;
  return withLock(id, async () => {
    const r = await getRaffle(id);
    if (r.status !== "drawing") return r;
    const d = r.draw;
    const entropy = await drawEntropy(r);
    if (!entropy) { await save(r); return r; } // randomness not there yet
    let tickets = [...d.tickets];
    d.freeWinners = [];
    if (d.holders?.count) {
      const list = (await getJSON(`grail:holders:${r.id}`)) || [];
      if (holdersHash(list) === d.holders.hash && list.length) {
        const res = await pickFreeSpots(entropy, r.id, list, r.freeSpots,
          (w) => chain.holderStatus(w, tokenMint(), MIN_HOLD, HOLD_HOURS).then((st) => st.ok).catch(() => false));
        d.freeWinners = res.winners;
        d.holderRounds = res.rounds;
        tickets.push(...res.winners);
      }
    }
    // unused free spots (not enough eligible holders) give their money back to the treasury
    r.reservedLamports = d.freeWinners.length * r.priceLamports;
    const w = winnerFrom(entropy, r.id, tickets);
    Object.assign(d, { finalTickets: tickets, finalHash: w.ticketsHash, seed: w.seed, index: w.index, winner: w.winner, at: now() });
    r.status = "drawn";
    await save(r);
    return r;
  });
}

// ---- after the draw ---------------------------------------------------------------
export async function claim({ id, wallet, method, value }) {
  return withLock(id, async () => {
    const r = await getRaffle(id);
    if (!r || r.status !== "drawn" || r.draw?.winner !== wallet) return { error: "Only the winner can claim this prize." };
    const v = String(value || "").trim().slice(0, 120);
    if (method === "polygon" && !/^0x[0-9a-fA-F]{40}$/.test(v)) return { error: "That's not a Polygon (0x…) address." };
    if (method === "courtyard" && !v) return { error: "Enter your Courtyard username or email." };
    if (!["polygon", "courtyard"].includes(method)) return { error: "Choose how to receive it." };
    r.claim = { method, value: v, at: now() };
    await save(r);
    return { ok: true };
  });
}

export async function adminAction(action, body) {
  const id = body.id;
  if (action === "create") return createRaffle(body);
  return withLock(id, async () => {
    const r = await getRaffle(id);
    if (!r) return { error: "Raffle not found." };
    if (action === "cancel") {
      if (!["open", "drawing"].includes(r.status)) return { error: "Only open raffles can be cancelled." };
      startRefunds(r, "cancelled");
    } else if (action === "bought") {
      if (r.status !== "drawn") return { error: "Not drawn yet." };
      r.bought = { note: String(body.note || "").slice(0, 200), at: now() };
    } else if (action === "delivered") {
      if (r.status !== "drawn") return { error: "Not drawn yet." };
      if (!r.bought) r.bought = { note: "", at: now() };
      r.delivered = { note: String(body.note || "").slice(0, 200), at: now() };
    } else if (action === "refundsPaid") {
      // the admin paid refunds from the treasury in one transaction: mark every refund it covers
      const tx = await chain.getParsedTx(String(body.sig || ""));
      if (!tx || tx.meta?.err) return { error: "Transaction not found (yet) or failed." };
      let marked = 0;
      for (const f of r.refunds) {
        if (f.paid) continue;
        if (chain.lamportsTransferred(tx, treasury(), f.wallet) >= f.lamports) { f.paid = { sig: body.sig, at: now() }; marked++; }
      }
      if (!marked) return { error: "That transaction doesn't pay any open refund of this raffle." };
      if (r.status === "refunding" && r.refunds.every((f) => f.paid)) r.status = "refunded";
    } else if (action === "retryPrize") {
      if (r.prize?.kind !== "packs" || !r.auto) return { error: "Nothing to retry." };
      r.auto.errors = 0; r.auto.error = null;
    } else if (action === "hide") {
      await redis("HDEL", INDEX, id);
      return { ok: true };
    } else return { error: "Unknown action." };
    await save(r);
    return { ok: true };
  });
}

// ---- what the page sees -----------------------------------------------------------
/** The latest things that happened, newest first, for the ticker. Pure. */
export function activity(raffles, limit = 24) {
  const ev = [];
  for (const r of raffles) {
    const base = { id: r.id, title: r.title };
    ev.push({ ...base, kind: "new", at: r.createdAt, spots: r.spots, priceUsd: r.priceUsd || null, priceLamports: r.priceLamports });
    let slot = 0;
    for (const e of r.entries || []) { ev.push({ ...base, kind: "buy", at: e.at, wallet: e.wallet, n: e.n, from: slot + 1 }); slot += e.n; }
    if (r.status === "drawn" && r.draw?.winner) ev.push({ ...base, kind: "win", at: r.draw.at, wallet: r.draw.winner });
    for (const p of r.auto?.packs || []) if (p.card) ev.push({ ...base, kind: "card", at: p.card.at || r.draw?.at, wallet: r.draw?.winner, card: p.card.name, rarity: p.card.rarity });
    if (r.status === "refunded") ev.push({ ...base, kind: "refunded", at: r.refunds?.at(-1)?.paid?.at || r.deadline });
  }
  return ev.filter((e) => e.at).sort((a, b) => b.at - a.at).slice(0, limit);
}

const short = (w) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : null);

export function publicView(r, wallet, admin = false, detail = false, solUsd = null) {
  const t = now();
  const v = {
    id: r.id, title: r.title, category: r.category, image: r.image, link: r.link, prizeUsd: r.prizeUsd,
    spots: r.spots, sold: sold(r), reserved: held(r, t), priceLamports: r.priceUsd ? slotLamports(r, solUsd) || 0 : r.priceLamports, maxPerWallet: r.maxPerWallet,
    priceUsd: r.priceUsd || null, payTo: payToOf(r),
    prize: r.prize || { kind: "manual" },
    auto: r.auto ? { status: r.auto.status, cards: (r.auto.packs || []).filter((p) => p.card).map((p) => p.card), bought: (r.auto.packs || []).filter((p) => p.card).length, error: admin ? r.auto.error || null : undefined } : null,
    deadline: r.deadline, status: r.status, freeSpots: r.freeSpots ?? (r.holderSpot ? 1 : 0), createdAt: r.createdAt,
    reservedLamports: r.reservedLamports || 0, bought: !!r.bought, delivered: !!r.delivered, refundReason: r.refundReason || null,
    mine: wallet ? mine(r, wallet, t) : 0,
    mySpots: wallet ? ticketsOf(r.entries).flatMap((w, i) => (w === wallet ? [i] : [])) : [],
    buyers: new Set(r.entries.map((e) => e.wallet)).size,
  };
  if (detail) v.entries = r.entries.map((e) => ({ wallet: e.wallet, n: e.n, sig: e.sig, at: e.at }));
  if (r.draw) {
    const d = r.draw;
    v.draw = {
      afterSlot: d.afterSlot, ticketsHash: d.ticketsHash, frozenAt: d.frozenAt, holders: d.holders ? { count: d.holders.count, hash: d.holders.hash } : null,
      vrf: d.vrf ? { seed: d.vrf.seed, account: d.vrf.account, requested: !!d.vrf.requestedAt, requestSig: d.vrf.requestSig || null, randomness: d.vrf.randomness || null, error: admin ? d.vrf.error || null : undefined } : null,
    };
    if (r.status === "drawn") {
      Object.assign(v.draw, {
        source: d.source || "block", slot: d.slot, blockhash: d.blockhash, seed: d.seed, index: d.index, finalHash: d.finalHash, tickets: d.finalTickets.length,
        winner: d.winner, winnerShort: short(d.winner), freeWinners: d.freeWinners || (d.holderPick ? [d.holderPick.wallet] : []),
        holderRounds: d.holderRounds || [], at: d.at,
      });
      v.youWon = !!wallet && d.winner === wallet;
      v.claimed = !!r.claim;
    }
  }
  const myRefunds = wallet ? r.refunds.filter((f) => f.wallet === wallet) : [];
  if (myRefunds.length) v.myRefunds = myRefunds.map((f) => ({ lamports: f.lamports, paid: !!f.paid, reason: f.reason }));
  if (detail) v.refunds = { total: r.refunds.length, paid: r.refunds.filter((f) => f.paid).length };
  if (admin) v.admin = { refunds: r.refunds, claim: r.claim, bought: r.bought, delivered: r.delivered };
  return v;
}

/** Everything needed to recheck a draw yourself. */
export async function proofOf(r, withHolders = false) {
  if (r?.status !== "drawn") return null;
  const d = r.draw;
  const p = {
    id: r.id, source: d.source || "block", entropy: d.source === "vrf" ? d.vrf.randomness : d.blockhash,
    vrf: d.vrf ? { seed: d.vrf.seed, account: d.vrf.account, randomness: d.vrf.randomness, requestSig: d.vrf.requestSig || null, program: vrf.VRF_PROGRAM.toBase58() } : null,
    blockSlot: d.slot, blockhash: d.blockhash, afterSlot: d.afterSlot, paidTicketsHash: d.ticketsHash, paidTickets: d.tickets, tickets: d.finalTickets, ticketsHash: d.finalHash,
    seed: d.seed, index: d.index, winner: d.winner, freeSpots: r.freeSpots ?? 0, freeWinners: d.freeWinners || [], holderRounds: d.holderRounds || [], holdersHash: d.holders?.hash || null,
  };
  if (withHolders && d.holders?.hash) p.holders = (await getJSON(`grail:holders:${r.id}`)) || [];
  return p;
}
