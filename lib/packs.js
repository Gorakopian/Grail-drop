// Prizes that buy themselves: Collector Crypt packs (Solana, paid in USDC), opened for the winner,
// the card goes straight to the winner's wallet (altPlayerAddress). SOL from slot sales is swapped
// to exactly the USDC needed with Jupiter first.
//
// Safety: every transaction built by someone else (Jupiter, Collector Crypt) is SIMULATED first and
// only signed when the vault loses no more SOL and USDC than that step should cost.
import { redis, getJSON, setJSON } from "./redis.js";
import { rpc } from "./solana.js";
import { ccApiKey } from "./config.js";
import { Key, USDC_MINT, findProgramAddress, signSerialized, transactionSigners, solBalance } from "./sol.js";

export const CC_BASE = () => process.env.COLLECTORCRYPT_BASE || "https://gacha.collectorcrypt.com";
const JUP = () => process.env.JUPITER_BASE || "https://lite-api.jup.ag";
const WSOL = "So11111111111111111111111111111111111111112";
export const USDC = 1_000_000; // base units per dollar

async function http(url, init = {}, ms = 15000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 200) }; }
    if (!res.ok) { const e = new Error(`${new URL(url).pathname} ${res.status}: ${String(data?.error || data?.message || data?.raw || "").slice(0, 160)}`); e.status = res.status; e.data = data; throw e; }
    return data;
  } finally { clearTimeout(t); }
}
const ccHeaders = () => ({ "content-type": "application/json", ...(ccApiKey() ? { "x-api-key": ccApiKey() } : {}) });
const ccPost = (path, body) => http(CC_BASE() + path, { method: "POST", headers: ccHeaders(), body: JSON.stringify(body) });

// ---- Collector Crypt ------------------------------------------------------------------
/** The sharpest picture of a pack: the 1080px cut-out first, then the full image, then the thumbnail. Pure. */
export function bestImage(m) {
  for (const u of [m.imageNobg, m.image, m.thumbnailUrl]) {
    if (typeof u === "string" && /^https:\/\//.test(u)) return u; // relative paths point at their own site, skip them
  }
  return null;
}
/** Public pack machines: [{ code, name, price, image, odds, ev, instantBuyback, stockLeft }]. Cached 10 min. */
export async function machines() {
  const cached = await getJSON("grail:cc:machines");
  if (cached) return cached;
  const r = await http(CC_BASE() + "/api/machines", { headers: ccHeaders() });
  const list = (r.machines || []).filter((m) => m.public !== false && Number(m.price) > 0).map((m) => ({
    code: m.code, name: m.name || m.shortName || m.code, price: Number(m.price), image: bestImage(m),
    odds: m.odds || null, ev: m.ev ?? null, instantBuyback: m.instantBuyback ?? null,
    stockLeft: m.stock ? Object.values(m.stock).reduce((s, x) => s + (Number(x) || 0), 0) : null,
  }));
  await setJSON("grail:cc:machines", list);
  await redis("EXPIRE", "grail:cc:machines", 600);
  return list;
}
export const generatePack = (playerAddress, packType, altPlayerAddress) => ccPost("/api/generatePack", { playerAddress, packType, altPlayerAddress });
export const submitPack = (signedTransaction) => ccPost("/api/submitTransaction", { signedTransaction });
export const openPack = (memo) => ccPost("/api/openPack", { memo });
export const packStatus = (memo) => http(`${CC_BASE()}/api/pack/status?memo=${encodeURIComponent(memo)}`, { headers: ccHeaders() });

/** What the page shows about a pulled card. Pure. */
export function cardFrom(open) {
  const md = open?.nftWon?.content?.metadata || {};
  const attr = (k) => (md.attributes || []).find((a) => String(a.trait_type || a.name || "").toLowerCase() === k)?.value ?? null;
  return { nft: open?.nft_address || null, name: md.name || null, rarity: open?.rarity || null, grade: attr("grade"), insuredValue: attr("insured value") ?? attr("insured_value"), sig: open?.transactionSignature || null };
}

// ---- Jupiter: SOL → exactly N USDC ----------------------------------------------------
export async function quoteSolForUsdc(usdcBaseUnits, slippageBps = 100) {
  return http(`${JUP()}/swap/v1/quote?inputMint=${WSOL}&outputMint=${USDC_MINT}&amount=${usdcBaseUnits}&swapMode=ExactOut&slippageBps=${slippageBps}`);
}
export async function swapTransaction(quoteResponse, userPublicKey) {
  const r = await http(`${JUP()}/swap/v1/swap`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse, userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }) });
  if (!r?.swapTransaction) throw new Error("jupiter_no_transaction");
  return r; // { swapTransaction, lastValidBlockHeight }
}

// ---- the guard --------------------------------------------------------------------------
const TOKEN_PROGRAM = new Key("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new Key("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const usdcAccount = (owner) => findProgramAddress([new Key(owner).bytes, TOKEN_PROGRAM.bytes, new Key(USDC_MINT).bytes], ATA_PROGRAM)[0].toBase58();
const tokenAmount = (acc) => (acc?.data?.[0] ? Number(Buffer.from(acc.data[0], "base64").readBigUInt64LE(64)) : 0);

/**
 * Simulate someone else's transaction and sign it only if the vault loses at most
 * `maxSolOut` lamports and `maxUsdcOut` USDC base units. → signed base64. Throws otherwise.
 */
export async function guardedSign(b64, kp, { maxSolOut, maxUsdcOut }) {
  const me = kp.publicKey.toBase58();
  if (!transactionSigners(b64).includes(me)) throw new Error("vault_not_a_signer");
  const ata = usdcAccount(me);
  const [solBefore, ataBefore] = await Promise.all([solBalance(me), rpc("getAccountInfo", [ata, { encoding: "base64", commitment: "confirmed" }]).then((r) => tokenAmount(r?.value))]);
  const sim = await rpc("simulateTransaction", [b64, { encoding: "base64", sigVerify: false, commitment: "confirmed", accounts: { encoding: "base64", addresses: [me, ata] } }]);
  const v = sim?.value;
  if (!v) throw new Error("simulation_failed");
  if (v.err) throw new Error("simulation_error: " + JSON.stringify(v.err).slice(0, 120));
  const solOut = solBefore - Number(v.accounts?.[0]?.lamports ?? 0);
  const usdcOut = ataBefore - tokenAmount(v.accounts?.[1]);
  if (solOut > maxSolOut) throw new Error(`guard: would spend ${solOut} lamports, allowed ${maxSolOut}`);
  if (usdcOut > maxUsdcOut) throw new Error(`guard: would spend ${usdcOut} USDC units, allowed ${maxUsdcOut}`);
  return signSerialized(b64, kp);
}
