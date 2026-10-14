// GET /api/proof?id=<raffle> → everything needed to re-check a draw yourself
import { getRaffle, proofOf } from "../lib/raffles.js";
import { getJSON } from "../lib/redis.js";
import { send, query } from "../lib/http.js";

export default async function handler(req, res) {
  const { id, holders } = query(req);
  const p = proofOf(await getRaffle(String(id || "")));
  if (!p) return send(res, 404, { error: "No finished draw with that id." });
  if (holders) p.holders = (await getJSON(`grail:holders:${id}`)) || [];
  return send(res, 200, p);
}
