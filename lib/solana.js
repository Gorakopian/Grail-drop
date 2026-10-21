// Everything that talks to Solana: payments, token balances, the holder list and block hashes for the draw.
// Uses Helius (HELIUS_API_KEY) or any RPC in SOLANA_RPC.
import { redis } from "./redis.js";
import { LAMPORTS } from "./config.js";

const env = process.env;
const rpcUrl = () => env.SOLANA_RPC || (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : "https://api.mainnet-beta.solana.com");
export const WSOL = "So11111111111111111111111111111111111111112";

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
async function rpcAt(url, method, params) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(url, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = typeof res.text === "function" ? await res.text() : JSON.stringify(await res.json());
    let data;
    try { data = JSON.parse(text); } catch { const e = new Error(`rpc_unavailable: ${String(text).slice(0, 80)}`); e.unavailable = true; throw e; }
    if (data.error) {
      const e = new Error(`rpc_${method}: ${data.error.message || JSON.stringify(data.error)}`);
      if (res.status === 429 || /limit|usage|credits|rate/i.test(e.message)) e.unavailable = true;
      throw e;
    }
    return data.result;
  } finally { clearTimeout(timer); }
}
/** JSON-RPC call. If the main RPC (Helius) is out of credits or rate limited, the public Solana RPC is used instead. */
export async function rpc(method, params = []) {
  const main = rpcUrl();
  try { return await rpcAt(main, method, params); }
  catch (e) {
    const das = method === "getTokenAccounts"; // Helius-only method: no fallback for it
    if (!e.unavailable || main === PUBLIC_RPC || das) throw e;
    await redis("SET", "grail:rpcFallback", JSON.stringify({ at: Math.floor(Date.now() / 1000), why: e.message.slice(0, 120) }), "EX", 86400).catch(() => {});
    return rpcAt(PUBLIC_RPC, method, params);
  }
}

export async function solUsd() {
  const cached = await redis("GET", "grail:solusd");
  if (cached) return Number(cached);
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`).then((x) => x.json());
    const p = Number(r?.[WSOL]?.usdPrice || r?.data?.[WSOL]?.price);
    if (p > 0) { await redis("SET", "grail:solusd", String(p), "EX", 60); return p; }
  } catch { /* fall through */ }
  return null;
}

export const latestBlockhash = async () => (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value.blockhash;
export const currentSlot = () => rpc("getSlot", [{ commitment: "confirmed" }]);

/** SOL moved from → to in a parsed transaction (all System transfers, inner ones too). Pure. */
export function lamportsTransferred(tx, from, to) {
  if (!tx || tx.meta?.err) return 0;
  const ixs = [...(tx.transaction?.message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap((x) => x.instructions || [])];
  let sum = 0;
  for (const ix of ixs) {
    const p = ix.parsed;
    if (ix.program === "system" && p?.type === "transfer" && p.info?.source === from && p.info?.destination === to) sum += Number(p.info.lamports || 0);
  }
  return sum;
}

export async function getParsedTx(sig) {
  return rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
}

// ---- token balances and the 24h hold check -------------------------------------
export async function tokenBalance(wallet, mint) {
  const r = await rpc("getTokenAccountsByOwner", [wallet, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  return (r?.value || []).reduce((s, a) => s + Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
}

/**
 * Lowest balance the wallet had since `since` (unix s), rebuilt backwards from the current balance
 * and its recent transactions (Helius enhanced format, newest first). Pure.
 * Returns null when the history doesn't reach back far enough to be sure.
 */
export function minBalanceSince(current, txs, wallet, mint, since, complete) {
  let bal = current, min = current;
  for (const tx of txs) {
    if ((tx.timestamp || 0) < since) return min;
    let delta = 0;
    for (const t of tx.tokenTransfers || []) {
      if (t.mint !== mint) continue;
      if (t.toUserAccount === wallet) delta += Number(t.tokenAmount || 0);
      if (t.fromUserAccount === wallet) delta -= Number(t.tokenAmount || 0);
    }
    bal -= delta;          // balance just before this transaction
    if (bal < min) min = bal;
  }
  return complete ? min : null;
}

async function recentTxs(wallet, pages = 3) {
  const out = [];
  let before = "";
  for (let i = 0; i < pages; i++) {
    const url = `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${env.HELIUS_API_KEY}&limit=100${before ? `&before=${before}` : ""}`;
    const page = await fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error("helius_" + r.status))));
    out.push(...page);
    if (page.length < 100) return { txs: out, complete: true };
    before = page.at(-1).signature;
  }
  return { txs: out, complete: false };
}

/** { ok, balance, minHeld, reason } — does this wallet hold `min` tokens now and did it for the last `hours`? Cached 10 min. */
export async function holderStatus(wallet, mint, min, hours) {
  const key = `grail:gate:${mint}:${wallet}`;
  const cached = await redis("GET", key);
  if (cached) return JSON.parse(cached);
  const balance = await tokenBalance(wallet, mint);
  let st;
  if (balance < min) st = { ok: false, balance, minHeld: balance, reason: "not_enough" };
  else {
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const { txs, complete } = await recentTxs(wallet);
    const minHeld = minBalanceSince(balance, txs, wallet, mint, since, complete);
    st = minHeld == null ? { ok: false, balance, minHeld: null, reason: "too_busy" }
      : minHeld >= min ? { ok: true, balance, minHeld }
      : { ok: false, balance, minHeld, reason: "not_long_enough" };
  }
  await redis("SET", key, JSON.stringify(st), "EX", 600);
  return st;
}

// ---- holders (for the free spot) --------------------------------------------------
export async function tokenDecimals(mint) {
  const r = await rpc("getTokenSupply", [mint]);
  return { decimals: Number(r.value.decimals), supply: Number(r.value.uiAmount) };
}

/** Every owner holding at least `min` tokens: [{ owner, amount }] sorted by address (stable for the draw). */
export async function holdersAtLeast(mint, min, { maxShare = 1, exclude = [] } = {}) {
  const { decimals, supply } = await tokenDecimals(mint);
  const byOwner = new Map();
  for (let page = 1; page <= 20; page++) {
    const r = await rpc("getTokenAccounts", { mint, page, limit: 1000 });
    const accts = r?.token_accounts || [];
    for (const a of accts) byOwner.set(a.owner, (byOwner.get(a.owner) || 0) + Number(a.amount) / 10 ** decimals);
    if (accts.length < 1000) break;
  }
  const skip = new Set(exclude);
  return [...byOwner.entries()]
    .filter(([o, amt]) => amt >= min && !skip.has(o) && amt <= supply * maxShare)
    .map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) => (a.owner < b.owner ? -1 : 1));
}

// ---- randomness for the draw ------------------------------------------------------
/** The first produced block at or after `slot`: { slot, blockhash }. Throws if it isn't there yet. */
export async function blockAtOrAfter(slot) {
  const slots = await rpc("getBlocks", [slot, slot + 200, { commitment: "finalized" }]);
  if (!slots?.length) throw new Error("block_not_final_yet");
  const s = slots[0];
  const b = await rpc("getBlock", [s, { commitment: "finalized", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }]);
  return { slot: s, blockhash: b.blockhash };
}

export const toLamports = (sol) => Math.round(Number(sol) * LAMPORTS);
export const toSol = (lamports) => Number(lamports) / LAMPORTS;
