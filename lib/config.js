// Settings. Anything here can be overridden with an environment variable in Vercel.
const env = process.env;
const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

export const BRAND = "GRAIL DROP";
export const ADMIN_WALLETS = list(env.ADMIN_WALLETS).length ? list(env.ADMIN_WALLETS) : ["7r7YLo6P4KbqR2v9vFsUfcS2X4VrSkmE93PqWgtLvawW"];
export const treasury = () => env.TREASURY_WALLET || ADMIN_WALLETS[0];
export const isAdmin = (w) => !!w && ADMIN_WALLETS.includes(w);

// Holder gate
export const tokenMint = () => (env.TOKEN_MINT || "").trim() || null;
export const tokenSymbol = () => env.TOKEN_SYMBOL || "GRAIL";
export const MIN_HOLD = Number(env.MIN_HOLD || 2_000_000);     // tokens you must hold to buy spots
export const HOLD_HOURS = Number(env.HOLD_HOURS || 24);         // ...for at least this long
export const MAX_HOLDER_SHARE = 0.05;                           // wallets with >5% of supply (pools, curve, devs) can't win the free spot
export const excludedHolders = () => list(env.EXCLUDE_HOLDERS);

// Raffles
export const RESERVE_SECONDS = 300;   // a reserved spot is held 5 minutes while you pay
export const DRAW_DELAY_SLOTS = 40;   // the winner comes from a Solana block ~15 s after the raffle fills
export const blockedCountries = () => list(env.BLOCKED_COUNTRIES).map((c) => c.toUpperCase());
export const LAMPORTS = 1_000_000_000;
