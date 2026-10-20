// POST /api/admin?action=create|cancel|bought|delivered|refundsPaid|retryPrize|hide|pot|machines|dismissStray|tick  (admin wallet only)
import { sessionAddress } from "../lib/auth.js";
import { adminAction } from "../lib/raffles.js";
import { setJSON, getJSON } from "../lib/redis.js";
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
    if (action === "machines") return send(res, 200, { machines: await (await import("../lib/packs.js")).machines() });
    if (action === "dismissStray") {
      const list = ((await getJSON("grail:unmatched")) || []).filter((x) => x.sig !== String(body.sig || ""));
      await setJSON("grail:unmatched", list);
      return send(res, 200, { ok: true });
    }
    if (action === "tick") return send(res, 200, await (await import("../lib/auto.js")).tick());
    const r = await adminAction(action, body);
    return send(res, r.error ? 400 : 200, r);
  } catch (e) { return send(res, 500, { error: String(e.message || e).slice(0, 160) }); }
}
