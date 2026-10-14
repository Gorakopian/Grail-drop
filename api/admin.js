// POST /api/admin?action=create|cancel|delivered|refundsPaid|hide|pot  (admin wallet only)
import { sessionAddress } from "../lib/auth.js";
import { adminAction } from "../lib/raffles.js";
import { setJSON } from "../lib/redis.js";
import { isAdmin } from "../lib/config.js";
import { latestBlockhash } from "../lib/solana.js";
import { readBody, send, query } from "../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const wallet = await sessionAddress(req);
  if (!isAdmin(wallet)) return send(res, 403, { error: "Admins only." });
  const { action } = query(req);
  const body = await readBody(req);
  try {
    if (action === "blockhash") return send(res, 200, { blockhash: await latestBlockhash() });
    if (action === "pot") {
      const pot = { potUsd: Math.max(0, Math.round(Number(body.potUsd) || 0)), goalUsd: Math.max(0, Math.round(Number(body.goalUsd) || 0)), goalLabel: String(body.goalLabel || "").slice(0, 60) };
      await setJSON("grail:pot", pot);
      return send(res, 200, { ok: true, pot });
    }
    const r = await adminAction(action, body);
    return send(res, r.error ? 400 : 200, r);
  } catch (e) { return send(res, 500, { error: String(e.message || e).slice(0, 160) }); }
}
