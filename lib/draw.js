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
