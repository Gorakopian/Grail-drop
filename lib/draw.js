// Provably fair draw. Everything is frozen BEFORE the deciding Solana block exists:
//   tickets (who bought which spot, in order) and the holder list.
// Then the hash of a future block decides. Anyone can recompute it:
//   holderSeed = sha256("<blockhash>:<raffleId>:holders:<holdersHash>")  → index into the holder list
//   seed       = sha256("<blockhash>:<raffleId>:<ticketsHash>")          → winning ticket = seed mod tickets
import { createHash } from "node:crypto";

export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
export const hashList = (arr) => sha256(arr.join(","));
export const pickIndex = (seedHex, n) => Number(BigInt("0x" + seedHex) % BigInt(n));

/** One ticket per paid spot, in the order they were confirmed. Pure. */
export const ticketsOf = (entries) => entries.flatMap((e) => Array(e.n).fill(e.wallet));

export function holderSeed(blockhash, raffleId, holdersHash) {
  return sha256(`${blockhash}:${raffleId}:holders:${holdersHash}`);
}

export function winnerFrom(blockhash, raffleId, tickets) {
  const ticketsHash = hashList(tickets);
  const seed = sha256(`${blockhash}:${raffleId}:${ticketsHash}`);
  const index = pickIndex(seed, tickets.length);
  return { ticketsHash, seed, index, winner: tickets[index] };
}

// ---- free holder spots: every wallet holding the minimum has the same chance -------------
// The list of eligible holders (sorted addresses) is frozen before the deciding block exists.
// Round j: seed_j = sha256("<blockhash>:<raffleId>:holders:<holdersHash>:<j>"), pick = remaining[seed_j mod remaining.length].
// A picked wallet must still pass the 24h hold check; if not it's skipped (and recorded). Nobody can win twice.
export const holdersHash = (list) => hashList(list);

export function holderCandidate(blockhash, raffleId, listHash, remaining, round) {
  if (!remaining.length) return null;
  const seed = sha256(`${blockhash}:${raffleId}:holders:${listHash}:${round}`);
  return { owner: remaining[pickIndex(seed, remaining.length)], seed };
}

/** Run the rounds. `eligible(owner)` (async) is the hold check. → { winners, rounds:[{owner, ok}] } */
export async function pickFreeSpots(blockhash, raffleId, list, count, eligible, maxRounds = 30) {
  const listHash = holdersHash(list);
  let remaining = [...list];
  const winners = [], rounds = [];
  for (let j = 0; j < maxRounds && winners.length < count && remaining.length; j++) {
    const c = holderCandidate(blockhash, raffleId, listHash, remaining, j);
    const ok = !!(await eligible(c.owner));
    rounds.push({ owner: c.owner, ok });
    if (ok) winners.push(c.owner);
    remaining = remaining.filter((o) => o !== c.owner);
  }
  return { winners, rounds, listHash };
}
