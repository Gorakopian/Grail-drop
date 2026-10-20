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
import { createHash } from "node:crypto";
import { base58Decode } from "./auth.js";
import { rpc } from "./solana.js";

import { Key, base58Encode, isOnCurve, findProgramAddress, compileMessage, keypairFromSecret, signTransaction, parseSecretKey } from "./sol.js";
export { Key, base58Encode, isOnCurve, findProgramAddress, compileMessage, keypairFromSecret, signTransaction };

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
const rawKey = (env) => String(env.VRF_PAYER_KEY || "").trim().replace(/^["']|["']$/g, "").trim();
function parsePayer(env) {
  const raw = rawKey(env);
  if (!raw) return { problem: "not_set" };
  try { return { kp: parseSecretKey(raw) }; }
  catch (e) { return { problem: /mismatch/.test(e.message) ? "key_damaged" : raw.length < 80 ? "too_short_not_a_private_key" : "not_a_private_key" }; }
}
export const vrfPayer = (env = process.env) => parsePayer(env).kp || null;
export const vrfEnabled = (env = process.env) => !!vrfPayer(env);
/** Why VRF is off (never reveals the key): "not_set", "not_a_private_key", … or null when it's on. */
export const vrfProblem = (env = process.env) => parsePayer(env).problem || null;

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
