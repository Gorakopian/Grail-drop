// Run with: node test/auto.test.js — the automatic pack raffle end to end against a fake Solana,
// a fake Jupiter and a fake Collector Crypt. Real signatures, checked with web3.js. No real money.
import assert from "node:assert/strict";
import { Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction, TransactionMessage, SystemInstruction, SystemProgram } from "@solana/web3.js";

process.env.HELIUS_API_KEY = "H";
const vaultKp = Keypair.generate(), gacha = Keypair.generate();
process.env.VAULT_KEY = JSON.stringify([...vaultKp.secretKey]);
const VAULT = vaultKp.publicKey.toBase58();
const ADMIN = "7r7YLo6P4KbqR2v9vFsUfcS2X4VrSkmE93PqWgtLvawW";
const A = Keypair.generate().publicKey.toBase58(), B = Keypair.generate().publicKey.toBase58(), C = Keypair.generate().publicKey.toBase58();
const STRANGER = Keypair.generate().publicKey.toBase58();
const FAKE_PROGRAM = new PublicKey("Fake111111111111111111111111111111111111111");
const SOLUSD = 100;

const S = await import("../lib/sol.js");
const P = await import("../lib/packs.js");
const R = await import("../lib/raffles.js");
const AU = await import("../lib/auto.js");
const { redis } = await import("../lib/redis.js");

// ---- sol.js against web3.js --------------------------------------------------------------
{
  const kp = S.parseSecretKey(process.env.VAULT_KEY);
  assert.equal(kp.publicKey.toBase58(), VAULT);
  assert.equal(S.parseSecretKey(`"${S.base58Encode(vaultKp.secretKey)}"`).publicKey.toBase58(), VAULT, "base58 + quotes");
  // our SOL transfer = web3's
  const bh = "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi";
  const ours = Transaction.from(S.signTransaction(S.transferMessage(kp.publicKey, A, 12345, bh), kp));
  assert.ok(ours.verifySignatures());
  const d = SystemInstruction.decodeTransfer(ours.instructions[0]);
  assert.deepEqual([d.fromPubkey.toBase58(), d.toPubkey.toBase58(), Number(d.lamports)], [VAULT, A, 12345]);
  // co-signing a v0 transaction where we are the 2nd signer and someone already signed
  const msg = new TransactionMessage({ payerKey: gacha.publicKey, recentBlockhash: bh, instructions: [new TransactionInstruction({ programId: FAKE_PROGRAM, keys: [{ pubkey: vaultKp.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([9]) })] }).compileToV0Message();
  const v0 = new VersionedTransaction(msg); v0.sign([gacha]);
  const signed = VersionedTransaction.deserialize(Buffer.from(S.signSerialized(Buffer.from(v0.serialize()).toString("base64"), kp), "base64"));
  const nacl = (await import("node:crypto"));
  const ok = (pk, i) => nacl.verify(null, Buffer.from(signed.message.serialize()), { key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk.toBuffer()]), format: "der", type: "spki" }, Buffer.from(signed.signatures[i]));
  assert.ok(ok(gacha.publicKey, 0) && ok(vaultKp.publicKey, 1), "both signatures valid, the first one kept");
  assert.deepEqual(S.transactionSigners(Buffer.from(v0.serialize()).toString("base64")), [gacha.publicKey.toBase58(), VAULT]);
  const stranger = S.keypairFromSecret(Keypair.generate().secretKey);
  assert.throws(() => S.signSerialized(Buffer.from(v0.serialize()).toString("base64"), stranger), /not_a_signer/);
  // the vault's USDC account = the associated token account web3/spl would use
  const [ata] = PublicKey.findProgramAddressSync([vaultKp.publicKey.toBuffer(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBuffer(), new PublicKey(S.USDC_MINT).toBuffer()], new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"));
  assert.equal(P.usdcAccount(VAULT), ata.toBase58());
}

// ---- the fake world ----------------------------------------------------------------------------
const sol = { [VAULT]: 0 }, usdc = { [VAULT]: 0 };
const txs = {}, statuses = {}, bySigner = {};
let height = 1000, slot = 5000, packMultiplier = 1, failNextSubmit = false;
const packs = {}; // memo → { paid, sig, opened, tries, to }
const sent = [];
const parsedTransfer = (from, to, lamports) => ({ blockTime: Math.floor(Date.now() / 1000), meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [{ program: "system", parsed: { type: "transfer", info: { source: from, destination: to, lamports } } }] } } });
const addSig = (addr, sig) => { (bySigner[addr] ||= []).unshift({ signature: sig, err: null, blockTime: Math.floor(Date.now() / 1000) }); };
const pay = (sig, from, to, lamports) => { txs[sig] = parsedTransfer(from, to, lamports); statuses[sig] = "confirmed"; sol[to] = (sol[to] || 0) + lamports; addSig(to, sig); addSig(from, sig); };

// what a transaction does: system transfer, fake swap (1, lamports, usdc), fake pack (2, usdc)
function effects(b64) {
  const raw = Buffer.from(b64, "base64");
  let ixs, keys;
  const t = VersionedTransaction.deserialize(raw);
  keys = t.message.staticAccountKeys;
  ixs = t.message.compiledInstructions.map((i) => ({ programId: keys[i.programIdIndex], data: Buffer.from(i.data),
    ix: new TransactionInstruction({ programId: keys[i.programIdIndex], data: Buffer.from(i.data), keys: i.accountKeyIndexes.map((k) => ({ pubkey: keys[k], isSigner: false, isWritable: true })) }) }));
  const out = [];
  for (const ix of ixs) {
    if (ix.programId.equals(SystemProgram.programId)) { const d = SystemInstruction.decodeTransfer(ix.ix); out.push({ kind: "transfer", from: d.fromPubkey.toBase58(), to: d.toPubkey.toBase58(), lamports: Number(d.lamports) }); }
    else if (ix.data[0] === 1) out.push({ kind: "swap", lamports: Number(ix.data.readBigUInt64LE(1)), usdc: Number(ix.data.readBigUInt64LE(9)) });
    else if (ix.data[0] === 2) out.push({ kind: "pack", usdc: Number(ix.data.readBigUInt64LE(1)), memo: ix.data.subarray(9).toString() });
  }
  return out;
}
function verifyAll(b64) {
  const raw = Buffer.from(b64, "base64");
  try { const t = VersionedTransaction.deserialize(raw); return t; } catch { const t = Transaction.from(raw); assert.ok(t.verifySignatures(), "legacy tx fully signed"); return t; }
}
function apply(eff, dry = false) {
  const s = { ...sol }, u = { ...usdc };
  for (const e of eff) {
    if (e.kind === "transfer") { if (s[e.from] < e.lamports) throw new Error("insufficient"); s[e.from] -= e.lamports; s[e.to] = (s[e.to] || 0) + e.lamports; }
    if (e.kind === "swap") { s[VAULT] -= e.lamports + 5000; u[VAULT] += e.usdc; }
    if (e.kind === "pack") { if (u[VAULT] < e.usdc) throw new Error("insufficient usdc"); u[VAULT] -= e.usdc; s[VAULT] -= 5000; }
  }
  if (!dry) { Object.assign(sol, s); Object.assign(usdc, u); }
  return { s, u };
}
function sendTx(b64) {
  const t = verifyAll(b64);
  const sig = S.txId(b64);
  const eff = effects(b64);
  apply(eff);
  statuses[sig] = "confirmed";
  sent.push({ sig, eff });
  for (const e of eff) {
    if (e.kind === "transfer") { txs[sig] = parsedTransfer(e.from, e.to, e.lamports); addSig(e.to, sig); }
    if (e.kind === "pack") packs[e.memo].paid = true;
  }
  return sig;
}
const ataOf = P.usdcAccount(VAULT);
const tokenAcc = (amount) => { const b = Buffer.alloc(165); b.writeBigUInt64LE(BigInt(amount), 64); return { data: [b.toString("base64"), "base64"], lamports: 2039280 }; };
const bh = () => S.base58Encode(Buffer.alloc(32, height % 250 + 1));
const fakeTx = (signers, data, payer) => {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bh(), instructions: [new TransactionInstruction({ programId: FAKE_PROGRAM, keys: signers.map((k) => ({ pubkey: k, isSigner: true, isWritable: true })), data })] }).compileToV0Message();
  return new VersionedTransaction(msg);
};

const json = (x, status = 200) => ({ ok: status < 400, status, json: async () => x, text: async () => JSON.stringify(x) });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes("price/v3")) return json({ So11111111111111111111111111111111111111112: { usdPrice: SOLUSD } });
  if (u.includes("/swap/v1/quote")) { const amt = Number(new URL(u).searchParams.get("amount")); return json({ inAmount: String(Math.ceil(amt / 1e6 / SOLUSD * 1e9)), outAmount: String(amt) }); }
  if (u.includes("/swap/v1/swap")) {
    const b = JSON.parse(init.body); const q = b.quoteResponse;
    const data = Buffer.alloc(17); data[0] = 1; data.writeBigUInt64LE(BigInt(q.inAmount), 1); data.writeBigUInt64LE(BigInt(q.outAmount), 9);
    const t = fakeTx([new PublicKey(b.userPublicKey)], data, new PublicKey(b.userPublicKey));
    return json({ swapTransaction: Buffer.from(t.serialize()).toString("base64"), lastValidBlockHeight: height + 150 });
  }
  if (u.includes("collectorcrypt")) {
    const path = new URL(u).pathname;
    if (path === "/api/machines") return json({ machines: [{ code: "pokemon_50", name: "Elite Pack", price: 50, public: true, thumbnailUrl: "https://img/pk50.png", odds: { epic: 0.01 }, ev: 51, stock: { epic: 1, rare: 5 } }] });
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === "/api/generatePack") {
      const memo = "slot-" + Object.keys(packs).length;
      const data = Buffer.concat([Buffer.from([2]), Buffer.alloc(8), Buffer.from(memo)]); data.writeBigUInt64LE(BigInt(50 * 1e6 * packMultiplier), 1);
      const t = fakeTx([gacha.publicKey, new PublicKey(body.playerAddress)], data, gacha.publicKey); t.sign([gacha]);
      packs[memo] = { to: body.altPlayerAddress, player: body.playerAddress, tries: 0 };
      return json({ memo, transaction: Buffer.from(t.serialize()).toString("base64") });
    }
    if (path === "/api/submitTransaction") {
      if (failNextSubmit) { failNextSubmit = false; return json({ error: "Blockhash not found" }, 500); } // never lands
      return json({ success: true, signature: sendTx(body.signedTransaction), confirmationStatus: "confirmed" });
    }
    if (path === "/api/openPack") {
      const p = packs[body.memo];
      if (!p.paid || p.tries++ < 1) return json({ success: true, code: "WAITING_FOR_WEBHOOK", memo: body.memo });
      p.opened = (p.opened || 0) + 1;
      return json({ success: true, transactionSignature: "nftTx" + body.memo, nft_address: "Nft" + body.memo, nftWon: { content: { metadata: { name: "Charizard PSA 9", attributes: [{ trait_type: "Grade", value: "9" }] } } }, rarity: "Epic" });
    }
    if (path === "/api/pack/status") return json({ pack: { status: packs[new URL(u).searchParams.get("memo")]?.paid ? "confirmed" : null } });
  }
  const { method, params } = JSON.parse(init.body);
  const res = (result) => json({ result });
  switch (method) {
    case "getBalance": return res({ value: sol[params[0]] || 0 });
    case "getTokenAccountsByOwner": return res({ value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(usdc[params[0]] || 0) } } } } } }] });
    case "getAccountInfo": return res({ value: params[0] === ataOf ? tokenAcc(usdc[VAULT]) : null });
    case "simulateTransaction": {
      try { const { s, u } = apply(effects(params[0]), true); return res({ value: { err: null, accounts: [{ lamports: s[VAULT] }, tokenAcc(u[VAULT])] } }); }
      catch (e) { return res({ value: { err: e.message, accounts: null } }); }
    }
    case "sendTransaction": return res(sendTx(params[0]));
    case "getSignatureStatuses": return res({ value: params[0].map((s) => (statuses[s] ? { confirmationStatus: statuses[s], err: null } : null)) });
    case "getBlockHeight": return res(height);
    case "getLatestBlockhash": return res({ value: { blockhash: bh(), lastValidBlockHeight: height + 150 } });
    case "getSignaturesForAddress": return res((bySigner[params[0]] || []).slice(0, params[1]?.limit || 40));
    case "getTransaction": return res(txs[params[0]] || null);
    case "getSlot": return res(slot);
    case "getBlocks": return res([params[0] + 1]);
    case "getBlock": return res({ blockhash: "BLoCKhash" + params[0] });
    default: throw new Error("unexpected rpc " + method);
  }
};

// ---- create a pack raffle --------------------------------------------------------------------
assert.equal((await R.createRaffle({ prizeKind: "packs", machine: "pokemon_50", packCount: 1, spots: 2, priceUsd: 20 })).error, "The slots only bring in $40.00, the packs cost $50. Raise the slot price or the number of slots.");
assert.match((await R.createRaffle({ prizeKind: "packs", machine: "pokemon_50", packCount: 25, spots: 2 })).error, /Between 1 and 20/);
let r = (await R.createRaffle({ prizeKind: "packs", machine: "pokemon_50", packCount: 1, spots: 2, maxPerWallet: 1 })).raffle;
assert.deepEqual([r.payTo, r.prizeUsd, r.priceUsd, r.title, r.prize.count], [VAULT, 50, 27.5, "1× Elite Pack", 1]);
assert.equal(R.publicView(r, null, false, false, SOLUSD).priceLamports, 275_000_000, "$27.50 at $100/SOL");

// A buys and closes the page right after paying: the watcher gives them the slot
const hA = await R.reserve({ id: r.id, wallet: A, n: 1 });
assert.deepEqual([hA.treasury, hA.lamports], [VAULT, 275_000_000]);
pay("PayA".padEnd(88, "a"), A, VAULT, hA.lamports);
let t = await AU.tick();
assert.equal(t.payments.confirmed, 1);
assert.equal(R.sold(await R.getRaffle(r.id)), 1, "A's slot counted without the page");
assert.equal((await AU.tick()).payments.confirmed, 0, "seen once, never twice");

// someone sends SOL to the vault without a reservation → listed for the admin, not swept as raffle money silently
pay("Stray".padEnd(88, "s"), STRANGER, VAULT, 1_000_000_000);

// B buys normally
const hB = await R.reserve({ id: r.id, wallet: B, n: 1 });
pay("PayB".padEnd(88, "b"), B, VAULT, hB.lamports);
assert.equal((await R.confirm({ nonce: hB.nonce, sig: "PayB".padEnd(88, "b"), wallet: B })).status, "ok");
assert.equal((await R.getRaffle(r.id)).status, "drawing");

// ---- the loop draws, swaps, buys, opens ------------------------------------------------------
for (let i = 0; i < 6; i++) { height += 1; await AU.tick(); }
r = await R.getRaffle(r.id);
assert.equal(r.status, "drawn");
assert.equal(r.auto.status, "done", JSON.stringify(r.auto));
assert.equal(r.auto.packs.filter((p) => p.card).length, 1);
assert.equal(Object.values(packs).filter((p) => p.paid).length, 1, "exactly one pack paid");
assert.equal(packs[r.auto.packs[0].memo].to, r.draw.winner, "card goes straight to the winner");
assert.ok(r.bought && r.delivered);
assert.equal(r.auto.packs[0].card.name, "Charizard PSA 9");
assert.equal(r.auto.packs[0].card.grade, "9");
const swaps = sent.filter((s) => s.eff[0].kind === "swap");
assert.equal(swaps.length, 1);
assert.ok(usdc[VAULT] >= 0 && usdc[VAULT] < 1e6, "only what was needed was swapped: left " + usdc[VAULT]);
const view = R.publicView(r, r.draw.winner, false, false, SOLUSD);
assert.equal(view.auto.cards[0].nft, "Nft" + r.auto.packs[0].memo);

// more ticks change nothing
const paidBefore = Object.values(packs).filter((p) => p.paid).length;
for (let i = 0; i < 3; i++) await AU.tick();
assert.equal(Object.values(packs).filter((p) => p.paid).length, paidBefore);

// ---- stray deposit listed, and the sweep sends what's spare to the treasury ---------------------
const vs = await AU.vaultStatus();
assert.equal(vs.unmatched.length, 1);
assert.equal(vs.unmatched[0].from, STRANGER);
const sweeps = sent.filter((s) => s.eff[0].kind === "transfer" && s.eff[0].to === ADMIN);
assert.equal(sweeps.length, 1, "one sweep");
assert.ok(sol[VAULT] >= 50_000_000 && sol[VAULT] < 150_000_000, "vault keeps 0.05 SOL for fees (+ less than the sweep minimum): " + sol[VAULT]);
assert.ok(sol[ADMIN] >= 900_000_000, "the spare SOL went to the treasury: " + sol[ADMIN]);

// ---- a cancelled raffle: the vault refunds by itself, exactly once ---------------------------
let r2 = (await R.createRaffle({ prizeKind: "packs", machine: "pokemon_50", packCount: 1, spots: 3, maxPerWallet: 2 })).raffle;
const h2 = await R.reserve({ id: r2.id, wallet: C, n: 2 });
pay("PayC".padEnd(88, "c"), C, VAULT, h2.lamports);
await AU.tick();
assert.equal(R.sold(await R.getRaffle(r2.id)), 2);
await R.adminAction("cancel", { id: r2.id });
await AU.tick(); await AU.tick(); await AU.tick();
r2 = await R.getRaffle(r2.id);
assert.equal(r2.status, "refunded");
assert.equal(sent.filter((s) => s.eff[0].kind === "transfer" && s.eff[0].to === C).length, 1, "C refunded once");
assert.equal(sol[C], h2.lamports);

// ---- the guard: Collector Crypt asks for more than the pack costs → refused, nothing spent ----------
packMultiplier = 2;
let r3 = (await R.createRaffle({ prizeKind: "packs", machine: "pokemon_50", packCount: 1, spots: 2, maxPerWallet: 1 })).raffle;
for (const [w, s] of [[A, "PayA3"], [B, "PayB3"]]) { const h = await R.reserve({ id: r3.id, wallet: w, n: 1 }); pay(s.padEnd(88, "3"), w, VAULT, h.lamports); }
usdc[VAULT] += 200 * 1e6; // plenty of USDC, so only the guard can stop it
const usdcBefore = usdc[VAULT];
for (let i = 0; i < 3; i++) { height++; await AU.tick(); }
r3 = await R.getRaffle(r3.id);
assert.equal(r3.status, "drawn");
assert.notEqual(r3.auto.status, "done");
assert.match(r3.auto.error, /guard: would spend 100000000 USDC/);
assert.equal(usdc[VAULT], usdcBefore, "no USDC left the vault");
assert.match(R.publicView(r3, ADMIN, true).auto.error, /guard/);
assert.equal(R.publicView(r3, A, false).auto.error, undefined, "errors only for the admin");

// ---- a pack payment that never lands: given up after 3 minutes and bought again, still exactly one card ----
await R.adminAction("hide", { id: r3.id });
packMultiplier = 1;
let r4 = (await R.createRaffle({ prizeKind: "packs", machine: "pokemon_50", packCount: 1, spots: 2, maxPerWallet: 1 })).raffle;
for (const [w, s2] of [[A, "PayA4"], [B, "PayB4"]]) { const h = await R.reserve({ id: r4.id, wallet: w, n: 1 }); pay(s2.padEnd(88, "4"), w, VAULT, h.lamports); }
await R.adminAction("hide", { id: r3.id }); // take the guarded one out of the loop
failNextSubmit = true;
await AU.tick(); await AU.tick();
r4 = await R.getRaffle(r4.id);
assert.equal(r4.auto.packs.length, 1);
assert.ok(!r4.auto.packs[0].card, "first payment never landed");
const realNow = Date.now;
Date.now = () => realNow() + 200_000; // 3+ minutes later
for (let i = 0; i < 4; i++) { height++; await AU.tick(); }
Date.now = realNow;
r4 = await R.getRaffle(r4.id);
assert.equal(r4.auto.status, "done", JSON.stringify(r4.auto));
assert.equal(r4.auto.packs.filter((p) => p.card).length, 1);
assert.equal(r4.auto.packs[0].dropped, "expired");
assert.equal(Object.values(packs).filter((p) => p.paid && p.to === r4.draw.winner && p.opened).length >= 1, true);
assert.equal(r4.auto.packs.filter((p) => !p.dropped).length, 1, "one pack bought for this raffle");

// ---- SOL fell hard: slot money doesn't cover the packs → waits for a top-up, spends nothing ----
let r5 = (await R.createRaffle({ prizeKind: "packs", machine: "pokemon_50", packCount: 1, spots: 2, maxPerWallet: 1 })).raffle;
for (const [w, s2] of [[A, "PayA5"], [B, "PayB5"]]) { const h = await R.reserve({ id: r5.id, wallet: w, n: 1 }); pay(s2.padEnd(88, "5"), w, VAULT, h.lamports); }
usdc[VAULT] = 0;
const solBefore5 = sol[VAULT];
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { const u = String(url); if (u.includes("/swap/v1/quote")) { const amt = Number(new URL(u).searchParams.get("amount")); return json({ inAmount: String(Math.ceil(amt / 1e6 / 50 * 1e9)), outAmount: String(amt) }); } return origFetch(url, init); };
for (let i = 0; i < 3; i++) { height++; await AU.tick(); }
globalThis.fetch = origFetch;
r5 = await R.getRaffle(r5.id);
assert.equal(r5.auto.status, "short");
assert.match(r5.auto.error, /doesn't cover the packs/);
assert.ok(sol[VAULT] >= solBefore5 - 100_000, "nothing swapped");

// ---- two loops at once: the second one does nothing --------------------------------------------
await redis("SET", "grail:tick", "1", "EX", 55);
assert.equal((await AU.tick()).skipped, "already_running");
await redis("DEL", "grail:tick");

// ---- a manual (Courtyard) raffle is untouched by the loop -----------------------------------------
const m = (await R.createRaffle({ title: "Rolex box", prizeUsd: 5000, spots: 2, priceSol: 0.1 })).raffle;
assert.equal(R.payToOf(m), ADMIN);
assert.equal(m.prize, undefined);
// ---- autopilot: one open raffle per pack, a new one as soon as one fills --------------------------
{
  const AP = await import("../lib/autopilot.js");
  const { setJSON } = await import("../lib/redis.js");
  // pure: slot plan — fixed slots per tier (≤$100: 5, under $1000: 20, $1000+: 50), price follows the pack
  assert.deepEqual(AP.plan(25, AP.DEFAULTS), { spots: 5, priceUsd: 5.5 });
  assert.deepEqual(AP.plan(100, AP.DEFAULTS), { spots: 5, priceUsd: 22 });
  assert.deepEqual(AP.plan(250, AP.DEFAULTS), { spots: 20, priceUsd: 13.75 });
  assert.deepEqual(AP.plan(500, AP.DEFAULTS), { spots: 20, priceUsd: 27.5 });
  assert.deepEqual(AP.plan(1000, AP.DEFAULTS), { spots: 50, priceUsd: 22 });
  assert.deepEqual(AP.plan(5000, AP.DEFAULTS), { spots: 50, priceUsd: 110 });
  for (const usdv of [25, 50, 77, 100, 250, 999, 2500]) { const p = AP.plan(usdv, AP.DEFAULTS); assert.ok(p.spots * p.priceUsd >= usdv * 1.1 - 1e-9, "covers prize + margin " + usdv); }

  await setJSON("grail:cc:machines:v2", [
    { code: "pkmn_25", name: "PKMN 25", price: 25, stockLeft: 40 },
    { code: "watch_500", name: "WATCH 500", price: 500, stockLeft: 3 },
    { code: "pkmn_5000", name: "PKMN 5000", price: 5000, stockLeft: 9 },
    { code: "soccer_50", name: "SOCCER 50", price: 50, stockLeft: 0 },
  ]);
  await AP.saveSettings({ on: false });
  assert.deepEqual(await AP.runAutopilot(), { off: true }, "the admin can switch it off");
  await AP.saveSettings({ on: true });
  let res = await AP.runAutopilot();
  assert.deepEqual(res.created.sort(), ["pkmn_25", "watch_500"]);
  assert.deepEqual(res.skipped.map((x) => x.code + ":" + x.reason).sort(), ["pkmn_5000:above the $1000 cap", "soccer_50:out of stock"]);
  assert.deepEqual((await AP.runAutopilot()).created, [], "no duplicates");
  const all = await R.listRaffles();
  const w = all.find((x) => x.autopilot === "watch_500");
  assert.deepEqual([w.title, w.category, w.spots, w.priceUsd, w.prizeUsd, w.payTo], ["WATCH 500", "watch", 20, 27.5, 500, VAULT]);
  const pk = all.find((x) => x.autopilot === "pkmn_25");
  assert.equal(pk.spots, 5);

  // fill the PKMN 25 raffle → it draws, buys, and a new PKMN 25 raffle opens
  await setJSON("grail:cc:machines:v2", [{ code: "pkmn_25", name: "PKMN 25", price: 25, stockLeft: 40 }, { code: "watch_500", name: "WATCH 500", price: 500, stockLeft: 3 }]);
  const buyers = Array.from({ length: 5 }, () => Keypair.generate().publicKey.toBase58());
  for (const [i, wlt] of buyers.entries()) { const h = await R.reserve({ id: pk.id, wallet: wlt, n: 1 }); pay(("AP" + "abcdefghijkmnopqrstuvwxyz"[i]).padEnd(88, "p"), wlt, VAULT, h.lamports); }
  height++; await AU.tick();
  const after = await R.listRaffles();
  assert.notEqual((await R.getRaffle(pk.id)).status, "open");
  assert.equal(after.filter((x) => x.autopilot === "pkmn_25" && x.status === "open").length, 1, "a fresh PKMN 25 raffle is open");
  assert.equal(after.filter((x) => x.autopilot === "watch_500" && x.status === "open").length, 1);

  // turning a pack off stops new raffles for it (running one stays)
  await AP.saveSettings({ on: true, exclude: "watch_500" });
  assert.equal((await AP.runAutopilot()).skipped.find((x) => x.code === "watch_500").reason, "turned off");
}

console.log("auto OK");
