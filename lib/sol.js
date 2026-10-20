// Small Solana toolkit without @solana/web3.js (too heavy for the serverless functions):
// keys, addresses, building and signing transactions, sending them and checking they landed.
// test/vrf.test.js and test/auto.test.js check everything here against web3.js byte for byte.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { base58Decode } from "./auth.js";
import { rpc } from "./solana.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(bytes) {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0")), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

/** A 32-byte public key with the one method callers use. */
export class Key {
  constructor(v) { this.bytes = Buffer.from(typeof v === "string" ? base58Decode(v) : v); if (this.bytes.length !== 32) throw new Error("bad_key"); }
  toBase58() { return base58Encode(this.bytes); }
  equals(o) { return this.bytes.equals(o.bytes); }
}
export const SYSTEM_PROGRAM = new Key(Buffer.alloc(32));
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Is a 32-byte string a point on ed25519? (PDAs must NOT be.) Same rule as curve25519-dalek's decompress.
const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P + P;
function modPow(b, e) { let r = 1n; b %= P; while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
function modInv(a) { return modPow(((a % P) + P) % P, P - 2n); }
export function isOnCurve(bytes) {
  const b = Buffer.from(bytes); b[31] &= 0x7f;
  const y = BigInt("0x" + Buffer.from(b).reverse().toString("hex")) % P;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P, v = (D * y2 + 1n) % P;
  const x2 = (u * modInv(v)) % P;
  return x2 === 0n || modPow(x2, (P - 1n) / 2n) === 1n;
}

export function findProgramAddress(seeds, program) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(Buffer.from(s));
    const out = h.update(Buffer.from([bump])).update(program.bytes).update("ProgramDerivedAddress").digest();
    if (!isOnCurve(out)) return [new Key(out), bump];
  }
  throw new Error("no_pda");
}

export const shortVec = (n) => { const out = []; for (;;) { const b = n & 0x7f; n >>= 7; if (n) out.push(b | 0x80); else { out.push(b); return Buffer.from(out); } } };
function readShortVec(buf, o) { let n = 0, shift = 0, i = 0; for (;;) { const b = buf[o + i++]; n |= (b & 0x7f) << shift; if (!(b & 0x80)) return [n, i]; shift += 7; } }

/**
 * Legacy transaction with one fee-paying signer and one instruction. Pure.
 * keys: [{pubkey: Key, isSigner, isWritable}], the first must be the payer.
 */
export function compileMessage({ payer, programId, keys, data }, recentBlockhash) {
  const all = [{ pubkey: payer, isSigner: true, isWritable: true }, ...keys, { pubkey: programId, isSigner: false, isWritable: false }];
  const metas = [];
  for (const k of all) {
    const m = metas.find((x) => x.pubkey.equals(k.pubkey));
    if (m) { m.isSigner ||= k.isSigner; m.isWritable ||= k.isWritable; } else metas.push({ ...k });
  }
  const rank = (m) => (m.isSigner ? 0 : 2) + (m.isWritable ? 0 : 1);
  const first = metas.shift(); // payer stays first
  metas.sort((a, b) => rank(a) - rank(b)); metas.unshift(first);
  const signers = metas.filter((m) => m.isSigner);
  if (signers.length !== 1) throw new Error("one_signer_only");
  const header = Buffer.from([1, signers.filter((m) => !m.isWritable).length, metas.filter((m) => !m.isSigner && !m.isWritable).length]);
  const idx = (k) => metas.findIndex((m) => m.pubkey.equals(k));
  const ix = Buffer.concat([Buffer.from([idx(programId)]), shortVec(keys.length), Buffer.from(keys.map((k) => idx(k.pubkey))), shortVec(data.length), Buffer.from(data)]);
  return Buffer.concat([header, shortVec(metas.length), ...metas.map((m) => m.pubkey.bytes), Buffer.from(base58Decode(recentBlockhash)), shortVec(1), ix]);
}

/** A plain SOL transfer message. Pure. */
export function transferMessage(from, to, lamports, recentBlockhash) {
  const data = Buffer.alloc(12); data.writeUInt32LE(2, 0); data.writeBigUInt64LE(BigInt(lamports), 4);
  return compileMessage({ payer: from, programId: SYSTEM_PROGRAM, keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: new Key(to), isSigner: false, isWritable: true }], data }, recentBlockhash);
}

/** A signing key from a 64-byte Solana secret key (seed + public key). */
export function keypairFromSecret(secret) {
  const s = Buffer.from(secret);
  if (s.length !== 64) throw new Error("bad_secret");
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), s.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  if (!pub.equals(s.subarray(32))) throw new Error("secret_mismatch");
  return { publicKey: new Key(pub), privateKey };
}
/** A secret key as Phantom exports it (base58) or as a [1,2,…] JSON array, quotes tolerated. Throws if invalid. */
export function parseSecretKey(raw) {
  raw = String(raw || "").trim().replace(/^["']|["']$/g, "").trim();
  return keypairFromSecret(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : base58Decode(raw));
}

export function signTransaction(message, kp) {
  return Buffer.concat([shortVec(1), sign(null, message, kp.privateKey), message]);
}

/**
 * Add our signature to a transaction someone else built (legacy or v0), e.g. Jupiter's swap or
 * Collector Crypt's pack purchase. Other signatures already in it are kept. Pure.
 */
export function signSerialized(b64, kp) {
  const tx = Buffer.from(b64, "base64");
  const [nSigs, sl] = readShortVec(tx, 0);
  const msgStart = sl + nSigs * 64;
  const msg = tx.subarray(msgStart);
  const h = msg[0] & 0x80 ? 1 : 0;                     // versioned messages start with a version byte
  const required = msg[h];
  const [nKeys, kl] = readShortVec(msg, h + 3);
  const keysAt = h + 3 + kl;
  let idx = -1;
  for (let i = 0; i < Math.min(required, nKeys); i++) if (msg.subarray(keysAt + i * 32, keysAt + i * 32 + 32).equals(kp.publicKey.bytes)) idx = i;
  if (idx < 0 || idx >= nSigs) throw new Error("not_a_signer_of_this_transaction");
  const out = Buffer.from(tx);
  sign(null, msg, kp.privateKey).copy(out, sl + idx * 64);
  return out.toString("base64");
}

/** The fee payer and signer list of a serialized transaction. Pure (used to check before signing). */
export function transactionSigners(b64) {
  const tx = Buffer.from(b64, "base64");
  const [nSigs, sl] = readShortVec(tx, 0);
  const msg = tx.subarray(sl + nSigs * 64);
  const h = msg[0] & 0x80 ? 1 : 0;
  const [, kl] = readShortVec(msg, h + 3);
  const keysAt = h + 3 + kl;
  return Array.from({ length: msg[h] }, (_, i) => base58Encode(msg.subarray(keysAt + i * 32, keysAt + i * 32 + 32)));
}

/** The signature id of a signed transaction (its first signature). Pure. */
export const txId = (b64) => { const tx = Buffer.from(b64, "base64"); const [, sl] = readShortVec(tx, 0); return base58Encode(tx.subarray(sl, sl + 64)); };

// ---- talking to the chain ------------------------------------------------------------
export const recentBlockhash = async () => (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])).value; // { blockhash, lastValidBlockHeight }
export const blockHeight = () => rpc("getBlockHeight", [{ commitment: "confirmed" }]);
export const sendSigned = (b64) => rpc("sendTransaction", [b64, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3 }]);

/** "confirmed" | "failed" | null (not seen) for one signature. */
export async function signatureState(sig) {
  const r = await rpc("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]);
  const s = r?.value?.[0];
  if (!s) return null;
  if (s.err) return "failed";
  return ["confirmed", "finalized"].includes(s.confirmationStatus) ? "confirmed" : null;
}

export async function solBalance(addr) { return (await rpc("getBalance", [addr, { commitment: "confirmed" }])).value; }

/** USDC in a wallet, in base units (6 decimals). */
export async function usdcBalance(owner) {
  const r = await rpc("getTokenAccountsByOwner", [owner, { mint: USDC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  return (r?.value || []).reduce((s, a) => s + Number(a.account?.data?.parsed?.info?.tokenAmount?.amount || 0), 0);
}

/**
 * Send SOL so that it can be retried safely: returns { sig, lastValidBlockHeight } BEFORE we know it landed.
 * Store that, then use payoutState() to find out. A transfer whose blockhash expired without landing
 * can never land any more, so it's safe to send again.
 */
export async function sendSol(kp, to, lamports) {
  const { blockhash, lastValidBlockHeight } = await recentBlockhash();
  const signed = signTransaction(transferMessage(kp.publicKey, to, lamports, blockhash), kp).toString("base64");
  const sig = txId(signed);
  return { sig, lastValidBlockHeight, signed };
}
/** "confirmed" | "failed" | "expired" (safe to retry) | "pending". */
export async function payoutState(p) {
  const st = await signatureState(p.sig);
  if (st) return st;
  return (await blockHeight()) > p.lastValidBlockHeight ? "expired" : "pending";
}
