// The raffles. Rules:
//  - Entries pay for the prize: spots × price covers the prize (+ margin). The coin's fees only pay extras.
//  - Fill or refund: the draw only happens when every spot is sold; not full by the deadline → everyone refunded.
//  - Max N spots per wallet; holders of the coin (MIN_HOLD for HOLD_HOURS) only, once the coin is live.
//  - When full, 1 free spot goes to a random holder, then a future Solana block picks the winner.
// Money never moves automatically: refunds and prizes are paid by the admin from their own wallet.
import { randomBytes } from "node:crypto";
import { redis, getJSON, setJSON } from "./redis.js";
import { treasury, tokenMint, MIN_HOLD, HOLD_HOURS, RESERVE_SECONDS, DRAW_DELAY_SLOTS, MAX_HOLDER_SHARE, excludedHolders } from "./config.js";
import * as chain from "./solana.js";
import { ticketsOf, hashList, holderSeed, pickIndex, winnerFrom } from "./draw.js";

const KEY = (id) => `grail:raffle:${id}`;
const INDEX = "grail:raffles";
const now = () => Math.floor(Date.now() / 1000);
export const CATEGORIES = ["watch", "sneakers", "pokemon", "cards", "other"];

export const getRaffle = (id) => getJSON(KEY(id));
const save = (r) => setJSON(KEY(r.id), r);

export async function listRaffles() {
  const flat = (await redis("HGETALL", INDEX)) || [];
  const ids = [];
  for (let i = 0; i < flat.length; i += 2) ids.push(flat[i]);
  const all = await Promise.all(ids.map(getRaffle));
  return all.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
}

async function withLock(id, fn) {
  const key = `grail:lock:${id}`;
  for (let i = 0; i < 25; i++) {
    if ((await redis("SET", key, "1", "NX", "EX", 15)) === "OK") {
      try { return await fn(); } finally { await redis("DEL", key); }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("busy");
}

const sold = (r) => r.entries.reduce((s, e) => s + e.n, 0);
const held = (r, t = now()) => r.holds.filter((h) => h.exp > t).reduce((s, h) => s + h.n, 0);
const mine = (r, w, t = now()) => r.entries.filter((e) => e.wallet === w).reduce((s, e) => s + e.n, 0) + r.holds.filter((h) => h.wallet === w && h.exp > t).reduce((s, h) => s + h.n, 0);

export function validateNew(input) {
  const r = {
    title: String(input.title || "").trim().slice(0, 80),
    category: CATEGORIES.includes(input.category) ? input.category : "other",
    image: /^https:\/\//.test(input.image || "") ? String(input.image).slice(0, 500) : null,
    link: /^https:\/\//.test(input.link || "") ? String(input.link).slice(0, 500) : null,
    prizeUsd: Math.round(Number(input.prizeUsd) || 0),
    spots: Math.floor(Number(input.spots) || 0),
    priceLamports: chain.toLamports(input.priceSol),
    maxPerWallet: Math.max(1, Math.floor(Number(input.maxPerWallet) || 2)),
    deadline: now() + Math.round((Number(input.hours) || 72) * 3600),
    holderSpot: input.holderSpot !== false,
  };
  if (!r.title) return { error: "Give the raffle a title." };
  if (r.spots < 2 || r.spots > 1000) return { error: "Spots must be between 2 and 1000." };
  if (!(r.priceLamports > 0)) return { error: "Set a spot price in SOL." };
  if (r.maxPerWallet > r.spots) r.maxPerWallet = r.spots;
  return { raffle: r };
}

export async function createRaffle(input) {
  const v = validateNew(input);
  if (v.error) return v;
  const id = randomBytes(5).toString("hex");
  const r = { id, ...v.raffle, createdAt: now(), status: "open", entries: [], holds: [], refunds: [], draw: null, claim: null, delivered: null };
  await save(r);
  await redis("HSET", INDEX, id, String(r.createdAt));
  return { raffle: r };
}

/** Housekeeping: drop expired reservations; past the deadline and not full → refund everyone. */
export function settle(r, t = now()) {
  r.holds = r.holds.filter((h) => h.exp > t);
  if (r.status === "open" && t > r.deadline && sold(r) < r.spots) startRefunds(r, "not_full");
  return r;
}

function startRefunds(r, reason) {
  r.status = "refunding";
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
    if (!(n >= 1)) return { error: "How many spots?" };
    const have = mine(r, wallet);
    if (have + n > r.maxPerWallet) return { error: have ? `Max ${r.maxPerWallet} spots per wallet. You already have ${have}.` : `Max ${r.maxPerWallet} spots per wallet.` };
    const free = r.spots - sold(r) - held(r);
    if (free <= 0) return { error: held(r) ? "All spots are being paid for right now. Try again in a few minutes." : "Sold out." };
    if (n > free) return { error: `Only ${free} spot${free === 1 ? "" : "s"} left.` };
    const hold = { nonce: randomBytes(9).toString("hex"), wallet, n, lamports: r.priceLamports * n, at: now(), exp: now() + RESERVE_SECONDS };
    r.holds.push(hold);
    await save(r);
    await redis("SET", `grail:hold:${hold.nonce}`, JSON.stringify({ id, ...hold }), "EX", 86400);
    return { nonce: hold.nonce, lamports: hold.lamports, treasury: treasury(), expiresAt: hold.exp, n };
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
  const paid = chain.lamportsTransferred(tx, wallet, treasury());
  if (paid < hold.lamports) return { error: "That transaction doesn't pay for these spots." };
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
      result = { status: "refund", reason: "Your reservation ran out and the spots were taken. Your SOL will be refunded." };
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
  if (r.holderSpot && mint) {
    try {
      const list = (await chain.holdersAtLeast(mint, MIN_HOLD, { maxShare: MAX_HOLDER_SHARE, exclude: [treasury(), ...excludedHolders()] })).map((h) => h.owner);
      await setJSON(`grail:holders:${r.id}`, list);
      d.holders = { count: list.length, hash: hashList(list) };
    } catch (e) { d.holders = { count: 0, error: String(e.message || e).slice(0, 120) }; }
  }
  r.draw = d;
}

/** Run the draw once the deciding block is final. Safe to call often. */
export async function maybeDraw(id) {
  const peek = await getRaffle(id);
  if (peek?.status !== "drawing") return peek;
  return withLock(id, async () => {
    const r = await getRaffle(id);
    if (r.status !== "drawing") return r;
    let block;
    try { block = await chain.blockAtOrAfter(r.draw.afterSlot); } catch { return r; } // not final yet
    const d = r.draw;
    d.slot = block.slot;
    d.blockhash = block.blockhash;
    let tickets = [...d.tickets];
    // free holder spot: walk the frozen holder list from a random start until someone passes the hold check
    if (d.holders?.count) {
      const list = (await getJSON(`grail:holders:${r.id}`)) || [];
      if (hashList(list) === d.holders.hash && list.length) {
        const hs = holderSeed(block.blockhash, r.id, d.holders.hash);
        const start = pickIndex(hs, list.length);
        for (let k = 0; k < Math.min(10, list.length); k++) {
          const cand = list[(start + k) % list.length];
          const st = await chain.holderStatus(cand, tokenMint(), MIN_HOLD, HOLD_HOURS).catch(() => ({ ok: false }));
          if (st.ok) { d.holderPick = { wallet: cand, index: (start + k) % list.length, seed: hs, skipped: k }; break; }
        }
        if (d.holderPick) tickets.push(d.holderPick.wallet);
      }
    }
    const w = winnerFrom(block.blockhash, r.id, tickets);
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
    } else if (action === "delivered") {
      if (r.status !== "drawn") return { error: "Not drawn yet." };
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
    } else if (action === "hide") {
      await redis("HDEL", INDEX, id);
      return { ok: true };
    } else return { error: "Unknown action." };
    await save(r);
    return { ok: true };
  });
}

// ---- what the page sees -----------------------------------------------------------
const short = (w) => (w ? `${w.slice(0, 4)}…${w.slice(-4)}` : null);

export function publicView(r, wallet, admin = false) {
  const t = now();
  const v = {
    id: r.id, title: r.title, category: r.category, image: r.image, link: r.link, prizeUsd: r.prizeUsd,
    spots: r.spots, sold: sold(r), reserved: held(r, t), priceLamports: r.priceLamports, maxPerWallet: r.maxPerWallet,
    deadline: r.deadline, status: r.status, holderSpot: r.holderSpot, createdAt: r.createdAt,
    mine: wallet ? mine(r, wallet, t) : 0,
    mySpots: wallet ? ticketsOf(r.entries).flatMap((w, i) => (w === wallet ? [i] : [])) : [],
    buyers: new Set(r.entries.map((e) => e.wallet)).size,
  };
  if (r.draw) {
    const d = r.draw;
    v.draw = { afterSlot: d.afterSlot, ticketsHash: d.ticketsHash, holders: d.holders ? { count: d.holders.count, hash: d.holders.hash } : null };
    if (r.status === "drawn") {
      Object.assign(v.draw, {
        slot: d.slot, blockhash: d.blockhash, seed: d.seed, index: d.index, finalHash: d.finalHash, tickets: d.finalTickets.length,
        winner: d.winner, winnerShort: short(d.winner), holderPick: d.holderPick ? { wallet: d.holderPick.wallet, short: short(d.holderPick.wallet), index: d.holderPick.index, skipped: d.holderPick.skipped } : null,
      });
      v.youWon = !!wallet && d.winner === wallet;
      v.claimed = !!r.claim;
      v.delivered = !!r.delivered;
    }
  }
  const myRefunds = wallet ? r.refunds.filter((f) => f.wallet === wallet) : [];
  if (myRefunds.length) v.myRefunds = myRefunds.map((f) => ({ lamports: f.lamports, paid: !!f.paid, reason: f.reason }));
  if (admin) {
    v.admin = { refunds: r.refunds, claim: r.claim, delivered: r.delivered, entries: r.entries.map((e) => ({ wallet: e.wallet, n: e.n, sig: e.sig })) };
  }
  return v;
}

/** Full ticket list for anyone who wants to check a draw. */
export function proofOf(r) {
  if (r?.status !== "drawn") return null;
  const d = r.draw;
  return { id: r.id, blockSlot: d.slot, blockhash: d.blockhash, afterSlot: d.afterSlot, tickets: d.finalTickets, ticketsHash: d.finalHash, seed: d.seed, index: d.index, winner: d.winner, holderPick: d.holderPick || null, holdersHash: d.holders?.hash || null };
}
