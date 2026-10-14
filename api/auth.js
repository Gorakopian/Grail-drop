// POST /api/auth?step=nonce {address} → {nonce,message} · step=verify {address,nonce,signature} → {token} · step=logout
import { createNonce, finishSignIn, isAddress, signOut } from "../lib/auth.js";
import { readBody, send, query } from "../lib/http.js";
import { hasDatabase } from "../lib/redis.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Use POST." });
  if (!hasDatabase() && process.env.VERCEL) return send(res, 503, { error: "The database isn't connected yet." });
  const { step } = query(req);
  const body = await readBody(req);
  try {
    if (step === "nonce") {
      if (!isAddress(body.address)) return send(res, 400, { error: "That's not a Solana wallet address." });
      return send(res, 200, await createNonce(body.address, req.headers?.host));
    }
    if (step === "verify") {
      if (!isAddress(body.address) || !body.nonce || !body.signature) return send(res, 400, { error: "Missing sign-in details." });
      const r = await finishSignIn(body.address, String(body.nonce), body.signature);
      return send(res, r.error ? 401 : 200, r);
    }
    if (step === "logout") { await signOut(req); return send(res, 200, { ok: true }); }
    return send(res, 400, { error: "Unknown step." });
  } catch { return send(res, 500, { error: "Sign-in failed. Try again." }); }
}
