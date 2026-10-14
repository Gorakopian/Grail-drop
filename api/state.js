// GET /api/state → raffles, the bonus pot, SOL price and (signed in) your holder status and spots.
// Also keeps things moving: expired reservations, deadlines, and draws whose block is final.
import { sessionAddress } from "../lib/auth.js";
import { listRaffles, settle, maybeDraw, publicView } from "../lib/raffles.js";
import { getJSON, setJSON, hasDatabase } from "../lib/redis.js";
import { solUsd, holderStatus } from "../lib/solana.js";
import { isAdmin, tokenMint, tokenSymbol, MIN_HOLD, HOLD_HOURS, treasury, blockedCountries, BRAND } from "../lib/config.js";
import { send } from "../lib/http.js";

export default async function handler(req, res) {
  if (!hasDatabase() && process.env.VERCEL) return send(res, 503, { error: "The database isn't connected yet." });
  try {
    const wallet = await sessionAddress(req);
    const admin = isAdmin(wallet);
    let raffles = await listRaffles();
    raffles = await Promise.all(raffles.map(async (r) => {
      if (r.status === "drawing") return (await maybeDraw(r.id).catch(() => r)) || r;
      if (r.status === "open") { const before = JSON.stringify(r.holds); settle(r); if (r.status !== "open" || JSON.stringify(r.holds) !== before) await setJSON(`grail:raffle:${r.id}`, r); }
      return r;
    }));
    const mint = tokenMint();
    let gate = null;
    if (wallet && mint) gate = await holderStatus(wallet, mint, MIN_HOLD, HOLD_HOURS).catch(() => ({ ok: false, reason: "check_failed" }));
    const country = String(req.headers?.["x-vercel-ip-country"] || "").toUpperCase();
    return send(res, 200, {
      brand: BRAND,
      coin: { live: !!mint, mint, symbol: tokenSymbol(), minHold: MIN_HOLD, holdHours: HOLD_HOURS },
      treasury: treasury(),
      solUsd: await solUsd(),
      pot: (await getJSON("grail:pot")) || { potUsd: 0, goalUsd: 0, goalLabel: "" },
      me: wallet ? { wallet, admin, gate: mint ? gate : { ok: true, reason: "coin_not_live" } } : null,
      blocked: country && blockedCountries().includes(country) ? country : null,
      raffles: raffles.map((r) => publicView(r, wallet, admin)),
    });
  } catch (e) {
    return send(res, 500, { error: "Something went wrong loading the raffles." });
  }
}
