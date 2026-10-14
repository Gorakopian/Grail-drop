// GET /api/treasury → the fees wallet's balance (read from Solana), what's reserved for free spots, what's available
import { treasuryStatus } from "../lib/raffles.js";
import { solUsd } from "../lib/solana.js";
import { treasury } from "../lib/config.js";
import { send } from "../lib/http.js";

export default async function handler(req, res) {
  try { return send(res, 200, { ...(await treasuryStatus()), entryWallet: treasury(), solUsd: await solUsd() }); }
  catch { return send(res, 500, { error: "Couldn't read the treasury. Try again." }); }
}
