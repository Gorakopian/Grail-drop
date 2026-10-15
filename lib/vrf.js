// Verifiable randomness from ORAO VRF (Solana program VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y).
//
// How SLOT uses it:
//  1. A raffle fills → the paid slots and the holder list are locked (their hashes are public).
//  2. seed = sha256("slot-vrf:<raffleId>:<ticketsHash>:<holdersHash|none>") — the seed IS a fingerprint of those lists.
//  3. SLOT asks the ORAO program for randomness with that seed (paid by the VRF payer wallet, VRF_PAYER_KEY).
//  4. ORAO's independent nodes each sign the seed; the program checks the signatures on-chain and stores
//     randomness = XOR of the signatures in the request account (an address derived from the seed).
//  5. The free slots and the winner are computed from that randomness. Anyone can read the account on Solana.
//
// No @solana/web3.js here on purpose: it's heavy and crashed the serverless functions. Addresses, the
// transaction and the signature are built with node:crypto. test/vrf.test.js checks them against web3.js.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { base58Decode } from "./auth.js";
import { rpc } from "./solana.js";

// ---- tiny Solana helpers ---------------------------------------------------------------
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

const shortVec = (n) => { const out = []; for (;;) { let b = n & 0x7f; n >>= 7; if (n) { out.push(b | 0x80); } else { out.push(b); return Buffer.from(out); } } };

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

/** A signing key from a 64-byte Solana secret key (seed + public key). */
export function keypairFromSecret(secret) {
  const s = Buffer.from(secret);
  if (s.length !== 64) throw new Error("bad_secret");
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), s.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const pub = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  if (!pub.equals(s.subarray(32))) throw new Error("secret_mismatch");
  return { publicKey: new Key(pub), privateKey };
}

export function signTransaction(message, kp) {
  return Buffer.concat([shortVec(1), sign(null, message, kp.privateKey), message]);
}

// ---- ORAO VRF ------------------------------------------------------------------------
export const VRF_PROGRAM = new Key("VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
export const SYSTEM_PROGRAM = new Key(Buffer.alloc(32));
const NETWORK_SEED = Buffer.from("orao-vrf-network-configuration");
const REQUEST_SEED = Buffer.from("orao-vrf-randomness-request");
const REQUEST_V2 = Buffer.from([38, 151, 209, 6, 195, 102, 28, 217]);   // anchor discriminator of request_v2
const RANDOMNESS_V2 = Buffer.from([139, 239, 184, 215, 227, 86, 191, 226]); // account discriminator
const NETWORK_STATE = Buffer.from([212, 237, 148, 56, 97, 245, 51, 169]);

/** The 32-byte seed for a raffle: a fingerprint of the locked lists. Pure. */
export function vrfSeed(raffleId, ticketsHash, holdersHash) {
  return createHash("sha256").update(`slot-vrf:${raffleId}:${ticketsHash}:${holdersHash || "none"}`).digest();
}

let nsCache;
export const networkStateAddress = () => (nsCache ||= findProgramAddress([NETWORK_SEED], VRF_PROGRAM)[0]);
export const requestAddress = (seed) => findProgramAddress([REQUEST_SEED, Buffer.from(seed)], VRF_PROGRAM)[0];

/** Network state account → { treasury, requestFee (lamports), authorities }. Pure. */
export function parseNetworkState(buf) {
  if (!buf.subarray(0, 8).equals(NETWORK_STATE)) throw new Error("not_vrf_network_state");
  let o = 8;
  const key = () => { const k = base58Encode(buf.subarray(o, o + 32)); o += 32; return k; };
  const authority = key(), treasury = key();
  const requestFee = Number(buf.readBigUInt64LE(o)); o += 8;
  const n = buf.readUInt32LE(o); o += 4;
  const authorities = [];
  for (let i = 0; i < n; i++) authorities.push(key());
  return { authority, treasury, requestFee, authorities };
}

/** Request account → { status: "pending"|"fulfilled", client, seed, randomness (hex or null) }. Pure. */
export function parseRandomness(buf) {
  if (!buf.subarray(0, 8).equals(RANDOMNESS_V2)) throw new Error("not_vrf_randomness_account");
  const tag = buf[8];
  const client = base58Encode(buf.subarray(9, 41));
  const seed = buf.subarray(41, 73).toString("hex");
  if (tag === 1) return { status: "fulfilled", client, seed, randomness: buf.subarray(73, 137).toString("hex") };
  return { status: "pending", client, seed, randomness: null };
}

/** The wallet that pays for randomness requests (VRF_PAYER_KEY: base58 secret key or [1,2,…] JSON). */
export function vrfPayer(env = process.env) {
  const raw = String(env.VRF_PAYER_KEY || "").trim();
  if (!raw) return null;
  try { return keypairFromSecret(raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : base58Decode(raw)); }
  catch { return null; }
}
export const vrfEnabled = (env = process.env) => !!vrfPayer(env);

async function accountData(address) {
  const r = await rpc("getAccountInfo", [address.toBase58(), { encoding: "base64", commitment: "finalized" }]);
  return r?.value ? Buffer.from(r.value.data[0], "base64") : null;
}

export async function networkState() {
  const data = await accountData(networkStateAddress());
  if (!data) throw new Error("vrf_network_state_missing");
  return parseNetworkState(data);
}

/** Current state of the randomness request for this seed, or null if it was never requested. */
export async function readRandomness(seed) {
  const data = await accountData(requestAddress(seed));
  return data ? parseRandomness(data) : null;
}

/** The request_v2 instruction. Pure (given the treasury). */
export function requestInstruction(payer, treasury, seed) {
  return {
    payer, programId: VRF_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: networkStateAddress(), isSigner: false, isWritable: true },
      { pubkey: new Key(treasury), isSigner: false, isWritable: true },
      { pubkey: requestAddress(seed), isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([REQUEST_V2, Buffer.from(seed)]),
  };
}

/** Send the randomness request. Returns the transaction signature. */
export async function requestRandomness(seed, env = process.env) {
  const payer = vrfPayer(env);
  if (!payer) throw new Error("vrf_payer_missing");
  const { treasury } = await networkState();
  const { value } = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const msg = compileMessage(requestInstruction(payer.publicKey, treasury, seed), value.blockhash);
  return rpc("sendTransaction", [signTransaction(msg, payer).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
}

/** Admin info: payer address, balance and the per-request fee. */
export async function vrfStatus(env = process.env) {
  const payer = vrfPayer(env);
  if (!payer) return { enabled: false };
  const [bal, ns] = await Promise.all([
    rpc("getBalance", [payer.publicKey.toBase58(), { commitment: "confirmed" }]).then((x) => x.value).catch(() => null),
    networkState().catch(() => null),
  ]);
  return { enabled: true, payer: payer.publicKey.toBase58(), balanceLamports: bal, feeLamports: ns?.requestFee ?? null };
}
