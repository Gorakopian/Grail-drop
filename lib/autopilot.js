// Autopilot: keep one raffle running for every Collector Crypt pack.
// Each round of the background loop: for every pack (machine) that's public, in stock and within the
// prize cap, make sure exactly one autopilot raffle is open. When it fills, lib/auto.js draws, buys and
// opens the pack for the winner, and the next round here starts a fresh raffle for that pack.
// Settings live in the database (admin panel). On by default; the admin can switch it off there.
import { getJSON, setJSON } from "./redis.js";
import { MAX_AUTO_PRIZE_USD } from "./config.js";
import { listRaffles, createRaffle, vaultAddress } from "./raffles.js";
import { machines } from "./packs.js";

// Every raffle has a fixed number of slots (the slot price follows the pack price):
// packs up to lowUsd get lowSlots, packs under tierUsd get smallSlots, packs from tierUsd up get bigSlots.
export const DEFAULTS = { on: true, lowUsd: 100, lowSlots: 5, smallSlots: 20, tierUsd: 1000, bigSlots: 50, marginPct: 10, hours: 168, maxPerWallet: 2, exclude: [] };

export async function settings() {
  const { targetSlotUsd, minSlots, maxSlots, ...saved } = (await getJSON("grail:autopilot")) || {}; // drop old settings
  return { ...DEFAULTS, ...saved };
}

/** Validate and store new settings from the admin panel. */
export async function saveSettings(input) {
  const cur = await settings();
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const next = {
    on: input.on === true || input.on === "true" || input.on === "on",
    lowUsd: num(input.lowUsd, 0, 1_000_000, cur.lowUsd),
    lowSlots: Math.round(num(input.lowSlots, 2, 1000, cur.lowSlots)),
    smallSlots: Math.round(num(input.smallSlots, 2, 1000, cur.smallSlots)),
    bigSlots: Math.round(num(input.bigSlots, 2, 1000, cur.bigSlots)),
    tierUsd: num(input.tierUsd, 1, 1_000_000, cur.tierUsd),
    marginPct: num(input.marginPct, 0, 50, cur.marginPct),
    hours: Math.round(num(input.hours, 1, 24 * 30, cur.hours)),
    maxPerWallet: Math.round(num(input.maxPerWallet, 1, 100, cur.maxPerWallet)),
    exclude: Array.isArray(input.exclude) ? input.exclude.map(String).slice(0, 200) : String(input.exclude ?? cur.exclude.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
  };
  await setJSON("grail:autopilot", next);
  return next;
}

/** Slots and slot price for one pack: fixed number of slots per tier, price covers prize + margin. Pure. */
export function plan(packUsd, s) {
  const total = packUsd * (1 + s.marginPct / 100);
  const spots = packUsd <= s.lowUsd ? s.lowSlots : packUsd < s.tierUsd ? s.smallSlots : s.bigSlots;
  const priceUsd = Math.ceil((total / spots) * 100 - 1e-6) / 100;
  return { spots, priceUsd };
}

/** Why a pack gets no raffle (or null if it should have one). Pure. */
export function skipReason(m, s) {
  if (s.exclude.includes(m.code)) return "turned off";
  if (m.price > MAX_AUTO_PRIZE_USD) return `above the $${MAX_AUTO_PRIZE_USD} cap`;
  if (m.stockLeft === 0) return "out of stock";
  return null;
}

/** One round. → { created: [codes], running, skipped: [{code, reason}] } */
export async function runAutopilot({ raffles } = {}) {
  const s = await settings();
  if (!s.on || !vaultAddress()) return { off: true };
  const list = await machines();
  raffles = raffles || (await listRaffles());
  const live = new Set(raffles.filter((r) => r.autopilot && r.status === "open").map((r) => r.autopilot));
  const out = { created: [], running: live.size, skipped: [] };
  for (const m of list) {
    const why = skipReason(m, s);
    if (why) { out.skipped.push({ code: m.code, name: m.name, reason: why }); continue; }
    if (live.has(m.code)) continue;
    const { spots, priceUsd } = plan(m.price, s);
    const res = await createRaffle({ prizeKind: "packs", machine: m.code, packCount: 1, spots, priceUsd, hours: s.hours, maxPerWallet: Math.min(s.maxPerWallet, spots), title: m.name, autopilot: m.code });
    if (res.error) out.skipped.push({ code: m.code, name: m.name, reason: res.error });
    else { out.created.push(m.code); live.add(m.code); }
  }
  out.running = live.size;
  await setJSON("grail:autopilot:last", { at: Math.floor(Date.now() / 1000), ...out });
  return out;
}
