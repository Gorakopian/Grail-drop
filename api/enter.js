// POST /api/enter?step=reserve {id, n, agree} → hold the spots 5 min, returns what to pay and to whom
// POST /api/enter?step=confirm {nonce, sig}   → checks the SOL payment on-chain and gives you the spots
import { sessionAddress } from "../lib/auth.js";
import { reserve, confirm } from "../lib/raffles.js";
import { latestBlockhash, holderStatus } from "../lib/solana.js";
import { tokenMint, MIN_HOLD, HOLD_HOURS, blockedCountries, tokenSymbol } from "../lib/config.js";
import { readBody, send, query } from "../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const wallet = await sessionAddress(req);
  if (!wallet) return send(res, 401, { error: "Connect your wallet first." });
  const { step } = query(req);
  const body = await readBody(req);
  try {
    if (step === "reserve") {
      const country = String(req.headers?.["x-vercel-ip-country"] || "").toUpperCase();
      if (country && blockedCountries().includes(country)) return send(res, 403, { error: "Raffles aren't available in your country." });
      if (body.agree !== true) return send(res, 400, { error: "Please confirm you're 18+ and that raffles are allowed where you live." });
      const mint = tokenMint();
      if (mint) {
        const g = await holderStatus(wallet, mint, MIN_HOLD, HOLD_HOURS);
        if (!g.ok) {
          const need = `${(MIN_HOLD / 1e6).toLocaleString("en")}M $${tokenSymbol()}`;
          return send(res, 403, { error: g.reason === "not_long_enough" ? `You need to have held ${need} for ${HOLD_HOURS} hours.` : g.reason === "too_busy" ? "Your wallet has too many recent transactions to verify the hold. Try again later." : `You need to hold ${need} to buy slots.` });
        }
      }
      const r = await reserve({ id: String(body.id || ""), wallet, n: body.n });
      if (r.error) return send(res, 400, r);
      return send(res, 200, { ...r, blockhash: await latestBlockhash() });
    }
    if (step === "confirm") {
      const r = await confirm({ nonce: String(body.nonce || ""), sig: String(body.sig || ""), wallet });
      return send(res, r.error ? 400 : 200, r);
    }
    return send(res, 400, { error: "Unknown step." });
  } catch (e) {
    return send(res, 500, { error: String(e.message) === "busy" ? "Lots of people buying right now. Try again." : "Something went wrong. If you paid, keep the transaction link: nothing is lost." });
  }
}
