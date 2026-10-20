// GET /api/tick → one round of the background loop (lib/auto.js). Called every 5 minutes by
// .github/workflows/tick.yml (and once a day by Vercel Cron as a backup). Safe to call by anyone, any time:
// it only moves things forward, never pays twice, and only one round runs at a time.
import { tick } from "../lib/auto.js";
import { hasDatabase, getJSON } from "../lib/redis.js";
import { send } from "../lib/http.js";

export default async function handler(req, res) {
  if (!hasDatabase() && process.env.VERCEL) return send(res, 503, { error: "The database isn't connected yet." });
  try {
    const last = await getJSON("grail:lastTick").catch(() => null);
    if (last && Date.now() / 1000 - last.at < 30) return send(res, 200, { skipped: "ran_recently", at: last.at }); // anyone can call this: keep it cheap
    return send(res, 200, await tick());
  }
  catch (e) { return send(res, 500, { error: String(e.message || e).slice(0, 160) }); }
}
