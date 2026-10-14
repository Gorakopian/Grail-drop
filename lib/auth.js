// Sign in with a Solana wallet: the wallet signs a short message, we check the
// signature (ed25519) and hand out a session token. Signing never moves funds.
import { createPublicKey, verify, randomBytes } from "node:crypto";
import { redis } from "./redis.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

export function base58Decode(str) {
  if (typeof str !== "string" || !str) throw new Error("bad base58");
  let bytes = [0];
  for (const ch of str) {
    const v = MAP[ch];
    if (v === undefined) throw new Error("bad base58");
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of str) { if (ch === "1") bytes.push(0); else break; }
  return Buffer.from(bytes.reverse());
}

export const isAddress = (s) => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && (() => {
  try { return base58Decode(s).length === 32; } catch { return false; }
})();

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export function verifySignature(address, message, signature) {
  try {
    const pub = base58Decode(address);
    if (pub.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, signature);
  } catch { return false; }
}

export function signInMessage(address, nonce, host) {
  return [
    `Sign in to GRAIL DROP${host ? " (" + host + ")" : ""}`,
    "",
    "This only proves you own this wallet. It costs nothing and cannot move any funds.",
    "",
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${new Date().toISOString()}`,
  ].join("\n");
}

export async function createNonce(address, host) {
  const nonce = randomBytes(12).toString("hex");
  const message = signInMessage(address, nonce, host);
  await redis("SET", `grail:nonce:${nonce}`, JSON.stringify({ address, message }), "EX", 300);
  return { nonce, message };
}

export async function finishSignIn(address, nonce, signatureB64) {
  const raw = await redis("GET", `grail:nonce:${nonce}`);
  if (!raw) return { error: "Sign-in expired. Try again." };
  await redis("DEL", `grail:nonce:${nonce}`);
  const { address: expected, message } = JSON.parse(raw);
  if (expected !== address) return { error: "Wallet changed during sign-in. Try again." };
  let sig;
  try { sig = Buffer.from(String(signatureB64), "base64"); } catch { return { error: "Bad signature." }; }
  if (!verifySignature(address, message, sig)) return { error: "Signature didn't match this wallet." };
  const token = randomBytes(24).toString("base64url");
  await redis("SET", `grail:sess:${token}`, address, "EX", 30 * 86400);
  return { token, address };
}

const bearer = (req) => /^Bearer\s+([A-Za-z0-9_-]{20,64})$/.exec(req.headers?.authorization || req.headers?.Authorization || "")?.[1];
export async function sessionAddress(req) {
  const t = bearer(req);
  return t ? (await redis("GET", `grail:sess:${t}`)) || null : null;
}
export async function signOut(req) {
  const t = bearer(req);
  if (t) await redis("DEL", `grail:sess:${t}`);
}
