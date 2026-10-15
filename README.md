# SLOT

Raffles for real collectibles (watches, sneakers, Pokémon packs) bought on Courtyard, for memecoin holders.

**Rules**
- Entries pay for the prize: spots × price ≈ prize + ~10%. The coin's fees only pay extras (free holder spots, bonus raffles).
- Fill or refund: the draw only happens when every spot is sold; otherwise everyone is refunded.
- Holders only (once `TOKEN_MINT` is set): hold `MIN_HOLD` (2M) tokens for `HOLD_HOURS` (24h). Max spots per wallet per raffle (default 2).
- 2 free holder spots per raffle (configurable 0–5): when it fills, random wallets holding ≥ `MIN_HOLD` get them. Same chance for everyone, nobody wins twice. Wallets holding >5% of supply (curve, pools) are skipped.
- The free spots are paid from the fees wallet (`FEES_WALLET`, e.g. the pump.fun creator wallet): free spots × spot price is reserved when a raffle opens. Not enough fees → fewer or no free spots, the raffle still runs. The Treasury page shows balance, reserved and available, read from Solana.
- Provably fair: spots and the holder list are frozen first; the hash of a Solana block ~40 slots later picks the winner. `/api/proof?id=` has everything to recheck it; the page can recheck it in the browser.
- No money moves automatically. Spot payments go to the treasury wallet; refunds and prizes are paid by the admin from that wallet (the admin panel builds the refund transaction for Phantom).

**Setup (Vercel)**
1. New project from this repo; Storage → connect the same Upstash database as the other apps.
2. Env vars: `HELIUS_API_KEY`. After launch: `TOKEN_MINT`, `TOKEN_SYMBOL`. `FEES_WALLET`. Optional: `TREASURY_WALLET`, `ADMIN_WALLETS`, `BLOCKED_COUNTRIES` (e.g. `BE,FR`), `MIN_HOLD`, `HOLD_HOURS`, `EXCLUDE_HOLDERS`.
3. Settings → Deployment Protection → Vercel Authentication off; add a domain.
4. Open the site with the admin wallet → Admin panel → create a raffle.

**Legal**: paid raffles are lotteries in many countries (Belgium and France included). Get legal advice and use `BLOCKED_COUNTRIES` before launching.

Dev: `npm test` · `npm run dev`
