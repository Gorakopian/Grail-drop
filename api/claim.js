// POST /api/claim {id, method: "polygon"|"courtyard", value} → the winner says where to send the prize
import { sessionAddress } from "../lib/auth.js";
import { claim } from "../lib/raffles.js";
import { readBody, send } from "../lib/http.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  const wallet = await sessionAddress(req);
  if (!wallet) return send(res, 401, { error: "Connect your wallet first." });
  const b = await readBody(req);
  const r = await claim({ id: String(b.id || ""), wallet, method: b.method, value: b.value }).catch(() => ({ error: "Try again." }));
  return send(res, r.error ? 400 : 200, r);
}
