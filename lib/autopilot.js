// Autopilot: keep one raffle running for every Collector Crypt pack.
// Each round of the background loop: for every pack (machine) that's public, in stock and within the
// prize cap, make sure exactly one autopilot raffle is open. When it fills, lib/auto.js draws, buys and
// opens the pack for the winner, and the next round here starts a fresh raffle for that pack.
// Settings live in the database (admin panel); it's off until the admin turns it on.
import { getJSON, setJSON } from "./redis.js";
import { MAX_AUTO_PRIZE_USD } from "./config.js";
import { listRaffles, createRaffle, vaultAddress } from "./raffles.js";
import { machines } from "./packs.js";

export const DEFAULTS = { on: false, targetSlotUsd: 5, marginPct: 10, hours: 168, minSlots: 5, maxSlots: 500, maxPerWallet: 2, exclude: [] };

export async function settings() { return { ...DEFAULTS, ...((await getJSON("grail:autopilot")) || {}) }; }

/** Validate and store new settings from the admin panel. */
export async function saveSettings(input) {
  const cur = await settings();
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const next = {
    on: input.on === true || input.on === "true" || input.on === "on",
    targetSlotUsd: num(input.targetSlotUsd, 0.5, 1000, cur.targetSlotUsd),
    marginPct: num(input.marginPct, 0, 50, cur.marginPct),
    hours: Math.round(num(input.hours, 1, 24 * 30, cur.hours)),
    minSlots: Math.round(num(input.minSlots, 2, 1000, cur.minSlots)),
    maxSlots: Math.round(num(input.maxSlots, 2, 1000, cur.maxSlots)),
    maxPerWallet: Math.round(num(input.maxPerWallet, 1, 100, cur.maxPerWallet)),
    exclude: Array.isArray(input.exclude) ? input.exclude.map(String).slice(0, 200) : String(input.exclude ?? cur.exclude.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
  };
  if (next.maxSlots < next.minSlots) next.maxSlots = next.minSlots;
  await setJSON("grail:autopilot", next);
  return next;
}

/** Slots and slot price for one pack: slot price close to the target, prize + margin covered. Pure. */
export function plan(packUsd, s) {
  const total = packUsd * (1 + s.marginPct / 100);
  const spots = Math.min(s.maxSlots, Math.max(s.minSlots, Math.round(total / s.targetSlotUsd)));
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
