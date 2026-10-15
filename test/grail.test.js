// Run with: node test/grail.test.js — fake Solana RPC, no real money.
import assert from "node:assert/strict";
import { Readable } from "node:stream";

process.env.HELIUS_API_KEY = "H";
const ADMIN = "7r7YLo6P4KbqR2v9vFsUfcS2X4VrSkmE93PqWgtLvawW";
const A = "WaLLetAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "WaLLetBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const C = "WaLLetCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const MINT = "MintGRA1LxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxX";

const { minBalanceSince } = await import("../lib/solana.js");
const { winnerFrom, ticketsOf, sha256, hashList, pickIndex, holdersHash, holderCandidate, pickFreeSpots } = await import("../lib/draw.js");
const R = await import("../lib/raffles.js");
const { redis } = await import("../lib/redis.js");

// ---- pure: 24h hold reconstruction ----
const now = Math.floor(Date.now() / 1000);
const tx = (ago, amt, dir) => ({ timestamp: now - ago, tokenTransfers: [{ mint: MINT, tokenAmount: amt, [dir === "in" ? "toUserAccount" : "fromUserAccount"]: A }] });
// bought 3M two days ago, sold 500k 1h ago → held ≥ 2.5M the whole day
assert.equal(minBalanceSince(2.5e6, [tx(3600, 5e5, "out"), tx(172800, 3e6, "in")], A, MINT, now - 86400, false), 2.5e6);
// bought 2M only 2 hours ago → before that 0
assert.equal(minBalanceSince(2e6, [tx(7200, 2e6, "in")], A, MINT, now - 86400, true), 0);
// sold down to 1M and bought back → min 1M
assert.equal(minBalanceSince(3e6, [tx(1000, 2e6, "in"), tx(5000, 2e6, "out"), tx(200000, 3e6, "in")], A, MINT, now - 86400, false), 1e6);
// busy wallet: whole page inside the window and more history exists → can't be sure
assert.equal(minBalanceSince(3e6, [tx(10, 1, "in")], A, MINT, now - 86400, false), null);

// ---- pure: draw ----
const t = ticketsOf([{ wallet: A, n: 2 }, { wallet: B, n: 1 }]);
assert.deepEqual(t, [A, A, B]);
const w = winnerFrom("BlockHash1", "r1", t);
assert.equal(w.seed, sha256(`BlockHash1:r1:${hashList(t)}`));
assert.equal(w.winner, t[pickIndex(w.seed, 3)]);
assert.deepEqual(winnerFrom("BlockHash1", "r1", t), w, "same inputs, same winner");

// free spots: equal chance per eligible wallet, never the same wallet twice
const list = ["big", "small"];
let bigWins = 0;
for (let i = 0; i < 400; i++) if (holderCandidate("bh" + i, "r", holdersHash(list), list, 0).owner === "big") bigWins++;
assert.ok(bigWins > 160 && bigWins < 240, "equal chance: " + bigWins);
const two = await pickFreeSpots("bh", "r", list, 2, async () => true);
assert.deepEqual([...two.winners].sort(), ["big", "small"]);
const skip = await pickFreeSpots("bh", "r", list, 2, async (w) => w !== "big");
assert.deepEqual(skip.winners, ["small"]);
assert.equal(skip.rounds.find((x) => x.owner === "big").ok, false);

// ---- fake chain ----
let slot = 1000;
let feesBalance = 0;
const FEES = "FeesWa11etxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const txs = {};        // sig → parsed tx
const holdings = { [A]: 3e6, [B]: 2.5e6, [C]: 1e6 };
const pay = (sig, from, lamports, to = ADMIN) => { txs[sig] = { blockTime: Math.floor(Date.now() / 1000), meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [{ program: "system", parsed: { type: "transfer", info: { source: from, destination: to, lamports } } }] } } }; };
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const ok = (x) => ({ ok: true, json: async () => x });
  if (u.includes("jup.ag")) return ok({ So11111111111111111111111111111111111111112: { usdPrice: 200 } });
  if (u.includes("/v0/addresses/")) return ok([]); // no recent token moves: held for ages
  const { method, params } = JSON.parse(init.body);
  const res = (result) => ok({ result });
  switch (method) {
    case "getLatestBlockhash": return res({ value: { blockhash: "RecentHash" } });
    case "getSlot": return res(slot);
    case "getTransaction": return res(txs[params[0]] || null);
    case "getTokenAccountsByOwner": return res({ value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: holdings[params[0]] || 0 } } } } } }] });
    case "getTokenSupply": return res({ value: { decimals: 6, uiAmount: 1e9 } });
    case "getTokenAccounts": return res({ token_accounts: Object.entries(holdings).map(([owner, a]) => ({ owner, amount: a * 1e6 })).concat([{ owner: "CurvePoo1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", amount: 8e8 * 1e6 }]) });
    case "getBlocks": return res(slot >= params[0] ? [params[0] + 2] : []);
    case "getBlock": return res({ blockhash: "FutureBlockHash" + params[0] });
    case "getBalance": return res({ value: feesBalance });
    default: throw new Error("unexpected rpc " + method);
  }
};

// ---- create: 3 spots, 0.5 SOL, max 2 per wallet ----
let r = (await R.createRaffle({ title: "Rolex Box", category: "watch", prizeUsd: 300, spots: 3, priceSol: 0.5, maxPerWallet: 2, hours: 24 })).raffle;
assert.equal(r.priceLamports, 5e8);
assert.ok(R.validateNew({ title: "x", spots: 1, priceSol: 1 }).error);

// reserve + pay + confirm
let h = await R.reserve({ id: r.id, wallet: A, n: 2 });
assert.equal(h.lamports, 1e9);
assert.equal(h.treasury, ADMIN);
assert.match((await R.reserve({ id: r.id, wallet: A, n: 1 })).error, /Max 2/);
let c = await R.confirm({ nonce: h.nonce, sig: "S".repeat(70), wallet: A });
assert.equal(c.status, "pending", "tx not on chain yet");
pay("S".repeat(70), A, 4e8);
assert.match((await R.confirm({ nonce: h.nonce, sig: "S".repeat(70), wallet: A })).error, /doesn't pay/, "underpaid");
pay("P".repeat(70), A, 1e9);
assert.equal((await R.confirm({ nonce: h.nonce, sig: "P".repeat(70), wallet: A })).status, "ok");
assert.equal((await R.confirm({ nonce: h.nonce, sig: "P".repeat(70), wallet: A })).already, true, "same payment twice = no double spots");
const h2 = await R.reserve({ id: r.id, wallet: B, n: 1 });
assert.match((await R.confirm({ nonce: h2.nonce, sig: "P".repeat(70), wallet: B })).error, /doesn't pay|already used/, "someone else's payment can't be reused");
// B pays → raffle full → drawing
pay("Q".repeat(70), B, 5e8);
assert.equal((await R.confirm({ nonce: h2.nonce, sig: "Q".repeat(70), wallet: B })).status, "ok");
r = await R.getRaffle(r.id);
assert.equal(r.status, "drawing");
assert.equal(r.draw.afterSlot, 1040);
assert.match((await R.reserve({ id: r.id, wallet: C, n: 1 })).error, /closed/);
// block not there yet → still drawing
r = await R.maybeDraw(r.id);
assert.equal(r.status, "drawing");

// with the coin live + a fees wallet: 2 free holder spots, paid for by the treasury
process.env.TOKEN_MINT = MINT;
process.env.FEES_WALLET = FEES;
feesBalance = 1e8; // 0.1 SOL: covers only 1 free spot at 0.1
assert.match((await R.createRaffle({ title: "Pokémon pack", spots: 2, priceSol: 0.1, freeSpots: 2 })).error, /only pay for 1 free slot/);
feesBalance = 5e8;
await redis("DEL", `grail:bal:${FEES}`);
let r2 = (await R.createRaffle({ title: "Pokémon pack", category: "pokemon", prizeUsd: 40, spots: 2, priceSol: 0.1 })).raffle;
assert.equal(r2.freeSpots, 2, "2 free spots by default");
assert.equal(r2.reservedLamports, 2e8);
let ts = await R.treasuryStatus();
assert.deepEqual([ts.balanceLamports, ts.reservedLamports, ts.availableLamports], [5e8, 2e8, 3e8]);
const ha = await R.reserve({ id: r2.id, wallet: A, n: 1 }); pay("A".repeat(70), A, 1e8); await R.confirm({ nonce: ha.nonce, sig: "A".repeat(70), wallet: A });
const hc = await R.reserve({ id: r2.id, wallet: C, n: 1 }); pay("C".repeat(70), C, 1e8); await R.confirm({ nonce: hc.nonce, sig: "C".repeat(70), wallet: C });
r2 = await R.getRaffle(r2.id);
assert.equal(r2.draw.holders.count, 2, "A and B hold ≥2M; C has 1M; the curve (80% of supply) is excluded");
assert.equal((await R.getRaffle(r2.id)).draw.holders.hash, holdersHash([A, B].sort()));

// time passes: block final → draw
slot = 2000;
r = await R.maybeDraw(r.id);
assert.equal(r.status, "drawn");
assert.equal(r.draw.blockhash, "FutureBlockHash1042");
assert.deepEqual(r.draw.finalTickets, [A, A, B], "first raffle was frozen before the coin went live: no holder spot");
assert.equal(r.draw.winner, winnerFrom("FutureBlockHash1042", r.id, [A, A, B]).winner);
r2 = await R.maybeDraw(r2.id);
assert.equal(r2.status, "drawn");
assert.equal(r2.draw.finalTickets.length, 4, "2 paid + 2 free holder spots");
assert.deepEqual([...r2.draw.freeWinners].sort(), [A, B].sort(), "without replacement: both holders get one");
const proof2 = await R.proofOf(r2, true);
assert.equal(proof2.holders.length, 2);
assert.equal(proof2.holderRounds.length, 2);

// public view + proof
const pv = R.publicView(r, r.draw.winner);
assert.equal(pv.youWon, true);
assert.equal(pv.sold, 3);
assert.equal((await R.proofOf(r)).tickets.length, 3);
assert.equal(R.publicView(r, C).youWon, false);

// claim
const loser = r.draw.winner === A ? B : A;
assert.match((await R.claim({ id: r.id, wallet: loser, method: "polygon", value: "0x" + "a".repeat(40) })).error, /Only the winner/);
assert.match((await R.claim({ id: r.id, wallet: r.draw.winner, method: "polygon", value: "nope" })).error, /Polygon/);
assert.equal((await R.claim({ id: r.id, wallet: r.draw.winner, method: "polygon", value: "0x" + "a".repeat(40) })).ok, true);

// prize bought → the free-spot reserve counts as spent
assert.equal((await R.adminAction("bought", { id: r2.id, note: "Courtyard order 1" })).ok, true);
ts = await R.treasuryStatus();
assert.deepEqual([ts.reservedLamports, ts.spentLamports], [0, 2e8]);

// ---- fill or refund: deadline passes with 1 of 3 sold ----
delete process.env.TOKEN_MINT;
let r3 = (await R.createRaffle({ title: "Sneakers", spots: 3, priceSol: 0.2, hours: 1 })).raffle;
const h3 = await R.reserve({ id: r3.id, wallet: C, n: 1 }); pay("D".repeat(70), C, 2e8); await R.confirm({ nonce: h3.nonce, sig: "D".repeat(70), wallet: C });
r3 = R.settle(await R.getRaffle(r3.id), Math.floor(Date.now() / 1000) + 7200);
assert.equal(r3.status, "refunding");
assert.deepEqual(r3.refunds.map((f) => [f.wallet, f.lamports]), [[C, 2e8]]);
await redis("SET", `grail:raffle:${r3.id}`, JSON.stringify(r3));
// admin refunds from the treasury in one tx → marked paid → refunded
pay("F".repeat(70), ADMIN, 2e8, C);
assert.equal((await R.adminAction("refundsPaid", { id: r3.id, sig: "F".repeat(70) })).ok, true);
assert.equal((await R.getRaffle(r3.id)).status, "refunded");
assert.equal(R.publicView(await R.getRaffle(r3.id), C).myRefunds[0].paid, true);

// late payment: reservation expired and the spots got taken → owed a refund, not a spot
let r4 = (await R.createRaffle({ title: "Late", spots: 2, priceSol: 0.1, maxPerWallet: 1 })).raffle;
const late = await R.reserve({ id: r4.id, wallet: A, n: 1 });
let raw = await R.getRaffle(r4.id); raw.holds[0].exp = 1; await redis("SET", `grail:raffle:${r4.id}`, JSON.stringify(raw));
for (const [w, s] of [[B, "G"], [C, "H"]]) { const x = await R.reserve({ id: r4.id, wallet: w, n: 1 }); pay(s.repeat(70), w, 1e8); await R.confirm({ nonce: x.nonce, sig: s.repeat(70), wallet: w }); }
pay("L".repeat(70), A, 1e8);
assert.equal((await R.confirm({ nonce: late.nonce, sig: "L".repeat(70), wallet: A })).status, "refund");
assert.equal((await R.getRaffle(r4.id)).refunds[0].reason, "late_payment");

// ---- HTTP: state endpoint works signed out, admin gate on admin endpoint ----
const call = (mod, { method = "GET", url = "/", headers = {}, body } = {}) => new Promise((resolve) => {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, { method, url, headers });
  mod.default(req, { statusCode: 200, setHeader() {}, end(x) { resolve({ status: this.statusCode, body: JSON.parse(x) }); } });
});
const state = await call(await import("../api/state.js"));
assert.equal(state.status, 200);
assert.equal(state.body.coin.live, false);
assert.ok(state.body.raffles.length >= 4);
assert.equal(state.body.solUsd, 200);
await redis("SET", "grail:sess:" + "t".repeat(32), A);
const notAdmin = await call(await import("../api/admin.js"), { method: "POST", url: "/api/admin?action=pot", headers: { authorization: "Bearer " + "t".repeat(32) }, body: { potUsd: 5 } });
assert.equal(notAdmin.status, 403);
const noAgree = await call(await import("../api/enter.js"), { method: "POST", url: "/api/enter?step=reserve", headers: { authorization: "Bearer " + "t".repeat(32) }, body: { id: r4.id, n: 1 } });
assert.match(noAgree.body.error, /18\+/);
console.log("grail OK");
