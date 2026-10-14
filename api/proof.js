// GET /api/proof?id=<raffle>[&holders=1] → everything needed to recheck a draw yourself
import { getRaffle, proofOf } from "../lib/raffles.js";
import { send, query } from "../lib/http.js";

export default async function handler(req, res) {
  const { id, holders } = query(req);
  const p = await proofOf(await getRaffle(String(id || "")), !!holders);
  if (!p) return send(res, 404, { error: "No finished draw with that id." });
  return send(res, 200, p);
}
