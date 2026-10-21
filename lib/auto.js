// The background loop (api/tick.js runs it every few minutes, nobody needs to have the site open):
//  1. Payment watcher: payments for reservations count even if the buyer closed the page. Late ones become refunds.
//  2. Draws: raffles that filled get their VRF randomness and winner.
//  3. Pack prizes: SOL → USDC (Jupiter), then buy + open the Collector Crypt packs, card straight to the winner.
//  4. Refunds of vault raffles are paid by the vault itself.
//  5. Sweep: whatever the vault holds beyond what running raffles need goes to the treasury.
//
// Every money step is written down BEFORE it's sent and checked on-chain before it's retried, so a crash
// or a double run can't pay twice. Transactions built by Jupiter / Collector Crypt are simulated and
// refused if they'd take more than that step should cost (lib/packs.js guardedSign).
import { redis, getJSON } from "./redis.js";
import * as chain from "./solana.js";
import { treasury, vaultSecret, ADMIN_WALLETS, VAULT_KEEP_LAMPORTS, SWEEP_MIN_LAMPORTS, LAMPORTS } from "./config.js";
import { parseSecretKey, sendSol, sendSigned, payoutState, usdcBalance, solBalance, txId, signatureState } from "./sol.js";
import { listRaffles, getRaffle, save, withLock, confirm, maybeDraw, payToOf } from "./raffles.js";
import * as packs from "./packs.js";

const now = () => Math.floor(Date.now() / 1000);
const FEE_ROOM = 20_000_000;    // 0.02 SOL of network fees / account rent a swap or pack purchase may cost
const PACK_TIMEOUT = 180;
export const MAX_ERRORS = 12;   // after this many failed tries in a row the prize waits for the admin to press "Try again"       // a pack payment not seen 3 min after sending can't land any more (its blockhash expired)

export function vault() {
  if (!vaultSecret()) return null;
  try { return parseSecretKey(vaultSecret()); } catch { return null; }
}

export async function vaultStatus() {
  const kp = vault();
  if (!kp) return { enabled: false, problem: vaultSecret() ? "not_a_private_key" : "not_set" };
  const a = kp.publicKey.toBase58();
  const [sol, usdc] = await Promise.all([solBalance(a).catch(() => null), usdcBalance(a).catch(() => null)]);
  return { enabled: true, address: a, solLamports: sol, usdc: usdc == null ? null : usdc / packs.USDC, unmatched: (await getJSON("grail:unmatched")) || [] };
}

/** Save only r.auto / refunds changes made outside the raffle lock, on top of the latest copy. */
async function patch(id, fn) {
  return withLock(id, async () => { const r = await getRaffle(id); fn(r); await save(r); return r; });
}

// ---- 1. payment watcher ----------------------------------------------------------------
export async function watchPayments() {
  const flat = (await redis("HGETALL", "grail:pending")) || [];
  const pending = [];
  for (let i = 0; i < flat.length; i += 2) { try { pending.push({ nonce: flat[i], ...JSON.parse(flat[i + 1]) }); } catch {} }
  const t = now();
  for (const p of pending) if (t - p.at > 86400) await redis("HDEL", "grail:pending", p.nonce); // gave up after a day
  const live = pending.filter((p) => t - p.at <= 86400);
  const v = vault()?.publicKey.toBase58();
  const addrs = new Set(live.map((p) => p.payTo));
  if (v) addrs.add(v); // the vault is always watched, so stray deposits show up for the admin
  let confirmed = 0;
  for (const addr of addrs) {
    const mine = live.filter((p) => p.payTo === addr).sort((a, b) => a.at - b.at);
    const oldest = mine.length ? mine[0].at - 120 : t - 3600;
    const sigs = (await chain.rpc("getSignaturesForAddress", [addr, { limit: 40, commitment: "confirmed" }]).catch(() => [])) || [];
    for (const s of sigs.reverse()) {
      if (s.err || (s.blockTime || 0) < oldest) continue;
      if ((await redis("SET", `grail:seen:${s.signature}`, "1", "NX", "EX", 172800)) !== "OK") continue;
      const tx = await chain.getParsedTx(s.signature).catch(() => null);
      if (!tx) { await redis("DEL", `grail:seen:${s.signature}`); continue; } // look again next time
      const p = mine.find((x) => !x.used && chain.lamportsTransferred(tx, x.wallet, addr) >= x.lamports && (tx.blockTime || 0) >= x.at - 120);
      if (p) {
        p.used = true;
        const res = await confirm({ nonce: p.nonce, sig: s.signature, wallet: p.wallet }).catch((e) => ({ error: e.message }));
        if (res.status === "ok" || res.status === "refund") confirmed++;
        continue;
      }
      if (addr === v) await recordStray(tx, s.signature, v);
    }
  }
  return { pending: live.length, confirmed };
}

/** SOL that reached the vault without a reservation: listed for the admin (never refunded automatically). */
async function recordStray(tx, sig, v) {
  const ixs = [...(tx.transaction?.message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((x) => x.instructions || [])];
  const known = new Set([v, treasury(), ...ADMIN_WALLETS]);
  for (const ix of ixs) {
    const i = ix.parsed?.info;
    if (ix.program !== "system" || ix.parsed?.type !== "transfer" || i?.destination !== v || known.has(i.source)) continue;
    if (await redis("GET", `grail:sig:${sig}`)) return; // it was a slot payment after all
    const list = (await getJSON("grail:unmatched")) || [];
    if (!list.some((x) => x.sig === sig)) {
      list.unshift({ sig, from: i.source, lamports: Number(i.lamports), at: tx.blockTime || now() });
      await redis("SET", "grail:unmatched", JSON.stringify(list.slice(0, 50)));
    }
  }
}

// ---- 3. pack prizes -----------------------------------------------------------------------
const collected = (r) => r.entries.reduce((s, e) => s + e.lamports, 0);

/** One step forward for a drawn pack raffle. Safe to call as often as you like. */
export async function runPrize(id, { budgetMs = 35000 } = {}) {
  const kp = vault();
  if (!kp) return { skipped: "no_vault" };
  if ((await redis("SET", `grail:prize:${id}`, "1", "NX", "EX", 90)) !== "OK") return { skipped: "busy" };
  const until = Date.now() + budgetMs;
  try {
    for (let step = 0; step < 12 && Date.now() < until; step++) {
      const r = await getRaffle(id);
      if (r?.status !== "drawn" || r.prize?.kind !== "packs" || r.auto?.status === "done") return { done: true };
      const res = await prizeStep(r, kp).catch((e) => ({ wait: true, error: String(e.message || e).slice(0, 200) }));
      await patch(id, (x) => {
        x.auto = { ...(x.auto || {}), ...res.auto };
        if (res.error) { x.auto.error = res.error; x.auto.errors = (x.auto.errors || 0) + 1; } else if (!res.wait) { x.auto.error = null; x.auto.errors = 0; }
        if (x.auto.status === "done") { x.bought ||= { note: "Collector Crypt, automatic", at: now() }; x.delivered ||= { note: "Card sent to the winner's wallet", at: now() }; }
      });
      if (res.wait) return { waiting: true, error: res.error || null };
    }
    return { more: true };
  } finally { await redis("DEL", `grail:prize:${id}`); }
}

/** Decide and do the next thing. → { auto: changes, wait?, error? } (pure-ish: all I/O goes through packs/sol) */
async function prizeStep(r, kp) {
  const me = kp.publicKey.toBase58();
  const a = r.auto || { status: "buying", packs: [], swap: null, startedAt: now() };
  const list = [...(a.packs || [])];
  const { count, unitUsd, machine } = r.prize;
  const done = list.filter((p) => p.card).length;
  if (done >= count) return { auto: { status: "done", packs: list, doneAt: now() } };

  // a pack is on its way: open it
  const open = list.find((p) => !p.card && !p.dropped);
  if (open) {
    let res;
    try { res = await packs.openPack(open.memo); } catch (e) { res = { error: e.message, status: e.status }; }
    if (res?.success && res.code !== "WAITING_FOR_WEBHOOK" && (res.nft_address || res.code === "TURBO_MODE_BUYBACK")) {
      open.card = { ...packs.cardFrom(res), at: now() };
      return { auto: { ...a, packs: list } };
    }
    // not paid (yet): did our payment land at all?
    const st = await signatureState(open.sig).catch(() => null);
    if (st === "failed" || (!st && now() - open.at > PACK_TIMEOUT)) {
      const status = await packs.packStatus(open.memo).catch(() => null);
      if (!status?.pack?.webhook_received && status?.pack?.status !== "confirmed") { open.dropped = st || "expired"; return { auto: { ...a, packs: list } }; }
    }
    return { auto: { ...a, packs: list }, wait: true, error: res?.error || null };
  }

  // a swap is on its way: wait for it
  if (a.swap) {
    const st = await payoutState(a.swap);
    if (st === "pending") return { auto: a, wait: true };
    const refund = st === "confirmed" ? 0 : Number(a.swap.lamports || 0); // it never happened: the SOL wasn't spent
    return { auto: { ...a, swap: null, spentLamports: Math.max(0, Number(a.spentLamports || 0) - refund), lastSwap: { ...a.swap, result: st } } };
  }

  // enough USDC for the remaining packs? If not, swap SOL for exactly what's missing.
  const needUsdc = (count - done) * unitUsd * packs.USDC;
  const have = await usdcBalance(me);
  if (have < unitUsd * packs.USDC) {
    const missing = Math.ceil((needUsdc - have) * 1.005);
    const quote = await packs.quoteSolForUsdc(missing);
    const solIn = Number(quote.inAmount || quote.otherAmountThreshold);
    const spentSoFar = Number(a.spentLamports || 0);
    if (!(solIn > 0)) throw new Error("no_quote");
    if (spentSoFar + solIn > collected(r)) return { auto: { ...a, status: "short" }, wait: true, error: `Slot money (${(collected(r) / LAMPORTS).toFixed(3)} SOL) doesn't cover the packs any more at today's SOL price. Top up the vault with USDC or SOL; it continues by itself.` };
    const sw = await packs.swapTransaction(quote, me);
    const signed = await packs.guardedSign(sw.swapTransaction, kp, { maxSolOut: solIn + FEE_ROOM, maxUsdcOut: 0 });
    const lvbh = Number(sw.lastValidBlockHeight) || (await chain.rpc("getBlockHeight", [{ commitment: "confirmed" }])) + 150;
    const swap = { sig: txId(signed), lastValidBlockHeight: lvbh, at: now(), usdc: missing, lamports: solIn };
    await patch(r.id, (x) => { x.auto = { ...(x.auto || a), status: "buying", swap, spentLamports: spentSoFar + solIn }; }); // written down before it's sent
    await sendSigned(signed);
    return { auto: { status: "buying", swap, spentLamports: spentSoFar + solIn }, wait: true };
  }

  // buy the next pack, card goes straight to the winner
  const gen = await packs.generatePack(me, machine, r.draw.winner);
  const signed = await packs.guardedSign(gen.transaction, kp, { maxSolOut: FEE_ROOM, maxUsdcOut: unitUsd * packs.USDC });
  const pack = { memo: gen.memo, sig: txId(signed), at: now() };
  const next = [...list, pack];
  await patch(r.id, (x) => { x.auto = { ...(x.auto || a), status: "buying", packs: next }; }); // written down before it's sent
  await packs.submitPack(signed);
  return { auto: { status: "buying", packs: next } };
}

// ---- 4. refunds paid by the vault -----------------------------------------------------------
export async function payVaultRefunds(r) {
  const kp = vault();
  const v = kp?.publicKey.toBase58();
  if (!kp || payToOf(r) !== v) return 0;
  let paid = 0;
  for (let i = 0; i < r.refunds.length; i++) {
    const f = r.refunds[i];
    if (f.paid) continue;
    if (f.payout) {
      const st = await payoutState(f.payout).catch(() => "pending");
      if (st === "pending") continue;
      await patch(r.id, (x) => {
        const g = x.refunds[i];
        if (st === "confirmed") { g.paid = { sig: g.payout.sig, at: now(), auto: true }; paid++; }
        g.payout = null;
        if (x.status === "refunding" && x.refunds.every((z) => z.paid)) x.status = "refunded";
      });
      continue;
    }
    const bal = await solBalance(v);
    if (bal < f.lamports + 10_000) continue; // not enough in the vault: try again later (admin sees it)
    const p = await sendSol(kp, f.wallet, f.lamports);
    await patch(r.id, (x) => { x.refunds[i].payout = { sig: p.sig, lastValidBlockHeight: p.lastValidBlockHeight, at: now() }; });
    await sendSigned(p.signed).catch(() => {}); // if sending failed it expires and is retried
  }
  return paid;
}

// ---- 5. sweep -----------------------------------------------------------------------------------
/** SOL the vault must keep: money of raffles that aren't finished + refunds owed + fees. Pure. */
export function vaultNeeds(raffles, v) {
  let need = VAULT_KEEP_LAMPORTS;
  for (const r of raffles) {
    if (payToOf(r) !== v) continue;
    if (["open", "drawing"].includes(r.status) || (r.status === "drawn" && r.auto?.status !== "done")) need += Math.max(0, collected(r) - Number(r.auto?.spentLamports || 0));
    for (const f of r.refunds) if (!f.paid) need += f.lamports;
    for (const h of r.holds || []) need += h.lamports; // reservations being paid right now
  }
  return need;
}

export async function sweep(raffles) {
  const kp = vault();
  if (!kp) return null;
  const v = kp.publicKey.toBase58();
  if (treasury() === v) return null;
  const last = await getJSON("grail:sweep");
  if (last?.pending) {
    const st = await payoutState(last.pending).catch(() => "pending");
    if (st === "pending") return { waiting: true };
    await redis("SET", "grail:sweep", JSON.stringify({ at: now(), lastResult: st, last: last.pending }));
    return { result: st };
  }
  if (last && now() - last.at < 3600) return null; // once an hour at most
  const spare = (await solBalance(v)) - vaultNeeds(raffles, v);
  if (spare < SWEEP_MIN_LAMPORTS) return null;
  const p = await sendSol(kp, treasury(), spare);
  await redis("SET", "grail:sweep", JSON.stringify({ at: now(), pending: { sig: p.sig, lastValidBlockHeight: p.lastValidBlockHeight, lamports: spare } }));
  await sendSigned(p.signed).catch(() => {});
  return { sent: spare };
}

// ---- the loop -----------------------------------------------------------------------------------
export async function tick({ budgetMs = 45000 } = {}) {
  if ((await redis("SET", "grail:tick", "1", "NX", "EX", 55)) !== "OK") return { skipped: "already_running" };
  const t0 = Date.now(), out = { payments: null, draws: 0, prizes: {}, refunds: 0, sweep: null, errors: [] };
  const left = () => budgetMs - (Date.now() - t0);
  try {
    out.payments = await watchPayments().catch((e) => (out.errors.push("payments: " + e.message), null));
    let raffles = await listRaffles();
    for (const r of raffles.filter((x) => x.status === "drawing")) { const d = await maybeDraw(r.id).catch(() => null); if (d?.status === "drawn") out.draws++; }
    raffles = await listRaffles();
    for (const r of raffles.filter((x) => x.status === "drawn" && x.prize?.kind === "packs" && x.auto?.status !== "done" && !((x.auto?.errors || 0) >= MAX_ERRORS))) {
      if (left() < 8000) break;
      out.prizes[r.id] = await runPrize(r.id, { budgetMs: Math.min(30000, left() - 5000) }).catch((e) => ({ error: e.message }));
    }
    for (const r of raffles.filter((x) => x.refunds?.some((f) => !f.paid))) {
      if (left() < 4000) break;
      out.refunds += await payVaultRefunds(r).catch((e) => (out.errors.push("refunds: " + e.message), 0));
    }
    if (left() > 6000) out.autopilot = await (await import("./autopilot.js")).runAutopilot().catch((e) => (out.errors.push("autopilot: " + e.message), null));
    if (left() > 3000) out.sweep = await sweep(await listRaffles()).catch((e) => (out.errors.push("sweep: " + e.message), null));
    await redis("SET", "grail:lastTick", JSON.stringify({ at: now(), ms: Date.now() - t0, ...out }), "EX", 86400);
    return out;
  } finally { await redis("DEL", "grail:tick"); }
}
