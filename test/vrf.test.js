// Run with: node test/vrf.test.js — VRF draw with a fake Solana (no real requests).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";

process.env.HELIUS_API_KEY = "H";
const payer = Keypair.generate();
process.env.VRF_PAYER_KEY = JSON.stringify([...payer.secretKey]);
const V = await import("../lib/vrf.js");
const R = await import("../lib/raffles.js");
const { winnerFrom, ticketsOf } = await import("../lib/draw.js");

// ---- pure: seed, addresses, account parsing, instruction ----
const seed = V.vrfSeed("r1", "aa", null);
assert.equal(seed.toString("hex"), createHash("sha256").update("slot-vrf:r1:aa:none").digest("hex"));
assert.equal(V.VRF_PROGRAM.toBase58(), "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y");
const [expectNs] = PublicKey.findProgramAddressSync([Buffer.from("orao-vrf-network-configuration")], V.VRF_PROGRAM);
assert.equal(V.networkStateAddress().toBase58(), expectNs.toBase58());

const TREASURY = Keypair.generate().publicKey, AUTH = Keypair.generate().publicKey, A1 = Keypair.generate().publicKey;
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const nsBuf = Buffer.concat([Buffer.from([212, 237, 148, 56, 97, 245, 51, 169]), AUTH.toBuffer(), TREASURY.toBuffer(), u64(1000000), u32(1), A1.toBuffer(), Buffer.from([0]), u64(42)]);
assert.deepEqual(V.parseNetworkState(nsBuf), { authority: AUTH.toBase58(), treasury: TREASURY.toBase58(), requestFee: 1000000, authorities: [A1.toBase58()] });
const rand = Buffer.alloc(64, 7);
const accBuf = (s, fulfilled) => Buffer.concat([Buffer.from([139, 239, 184, 215, 227, 86, 191, 226]), Buffer.from([fulfilled ? 1 : 0]), payer.publicKey.toBuffer(), Buffer.from(s), fulfilled ? rand : u32(0)]);
assert.equal(V.parseRandomness(accBuf(seed, false)).status, "pending");
const f = V.parseRandomness(accBuf(seed, true));
assert.deepEqual([f.status, f.seed, f.randomness], ["fulfilled", seed.toString("hex"), rand.toString("hex")]);
assert.throws(() => V.parseRandomness(Buffer.alloc(140)), /not_vrf/);
const ix = V.requestInstruction(payer.publicKey, TREASURY.toBase58(), seed);
assert.deepEqual([...ix.data.subarray(0, 8)], [38, 151, 209, 6, 195, 102, 28, 217]);
assert.ok(ix.data.subarray(8).equals(seed));
assert.deepEqual(ix.keys.map((k) => [k.isSigner, k.isWritable]), [[true, true], [false, true], [false, true], [false, true], [false, false]]);
assert.equal(ix.keys[3].pubkey.toBase58(), V.requestAddress(seed).toBase58());

// ---- full draw with VRF ----
const ADMIN = "7r7YLo6P4KbqR2v9vFsUfcS2X4VrSkmE93PqWgtLvawW";
const A = "WaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", B = "WaLLetBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const txs = {}, accounts = {}, sent = [];
let fulfillNow = false;
const pay = (sig, from, lamports) => { txs[sig] = { blockTime: Math.floor(Date.now() / 1000), meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [{ program: "system", parsed: { type: "transfer", info: { source: from, destination: ADMIN, lamports } } }] } } }; };
accounts[V.networkStateAddress().toBase58()] = nsBuf;
globalThis.fetch = async (url, init = {}) => {
  const ok = (x) => ({ ok: true, json: async () => x });
  if (String(url).includes("jup.ag")) return ok({});
  const { method, params } = JSON.parse(init.body);
  const res = (result) => ok({ result });
  switch (method) {
    case "getSlot": return res(100);
    case "getLatestBlockhash": return res({ value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi" } });
    case "getTransaction": return res(txs[params[0]] || null);
    case "getAccountInfo": { const b = accounts[params[0]]; return res(b ? { value: { data: [b.toString("base64"), "base64"] } } : { value: null }); }
    case "sendTransaction": {
      const tx = Transaction.from(Buffer.from(params[0], "base64"));
      sent.push(tx);
      const s = tx.instructions[0].data.subarray(8);
      accounts[V.requestAddress(s).toBase58()] = accBuf(s, false);   // ORAO creates the request account (pending)
      return res("ReqSig" + sent.length);
    }
    case "getBlocks": throw new Error("block path must not be used with VRF");
    default: throw new Error("unexpected rpc " + method);
  }
};
let r = (await R.createRaffle({ title: "VRF test", spots: 2, priceSol: 0.1 })).raffle;
for (const [w, s] of [[A, "P".repeat(70)], [B, "Q".repeat(70)]]) { const h = await R.reserve({ id: r.id, wallet: w, n: 1 }); pay(s, w, 1e8); await R.confirm({ nonce: h.nonce, sig: s, wallet: w }); }
assert.equal((await R.getRaffle(r.id)).status, "drawing");
// first poll: requests randomness, signed by the payer, seeded with the locked lists
r = await R.maybeDraw(r.id);
assert.equal(r.status, "drawing");
assert.equal(sent.length, 1);
const expectSeed = V.vrfSeed(r.id, r.draw.ticketsHash, null);
assert.equal(r.draw.vrf.seed, expectSeed.toString("hex"), "seed = fingerprint of the locked slots");
assert.ok(sent[0].verifySignatures(), "request is signed by the VRF payer");
assert.equal(sent[0].feePayer.toBase58(), payer.publicKey.toBase58());
// still pending → no new request, still drawing
r = await R.maybeDraw(r.id);
assert.deepEqual([r.status, sent.length], ["drawing", 1]);
// ORAO fulfills → winner comes from the randomness
accounts[r.draw.vrf.account] = accBuf(expectSeed, true);
r = await R.maybeDraw(r.id);
assert.equal(r.status, "drawn");
assert.equal(r.draw.source, "vrf");
assert.equal(r.draw.winner, winnerFrom(rand.toString("hex"), r.id, ticketsOf(r.draw.tickets.map((w) => ({ wallet: w, n: 1 })))).winner);
const proof = await R.proofOf(r);
assert.deepEqual([proof.source, proof.entropy, proof.vrf.account, proof.vrf.program], ["vrf", rand.toString("hex"), V.requestAddress(expectSeed).toBase58(), "VRFzZoJdhFWL8rkvu87LpKM3RbcVezpMEc6X5GVDr7y"]);
assert.equal(R.publicView(r).draw.source, "vrf");
console.log("vrf OK");
