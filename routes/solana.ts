import { Router, Request, Response } from "express";
import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair } from "@solana/web3.js";
import { v4 as uuidv4 } from "uuid";
import db from "../db";
import { getUserFromToken } from "./auth";

const router = Router();

// ── Solana connection ─────────────────────────────────────────────────────────
const SOLANA_NETWORK = "https://api.mainnet-beta.solana.com";
const connection = new Connection(SOLANA_NETWORK, "confirmed");

// ── Platform Keypair ──────────────────────────────────────────────────────────
// For devnet demo: generate a fresh keypair each startup (or load from env).
// For production: set SOLANA_PLATFORM_SECRET to JSON array of secret key bytes.
let platformKeypair: Keypair;
if (process.env.SOLANA_PLATFORM_SECRET) {
    try {
        platformKeypair = Keypair.fromSecretKey(
            Buffer.from(JSON.parse(process.env.SOLANA_PLATFORM_SECRET))
        );
        console.log("🔑 Loaded platform keypair from SOLANA_PLATFORM_SECRET");
    } catch {
        console.warn("⚠️  Failed to parse SOLANA_PLATFORM_SECRET — generating ephemeral keypair");
        platformKeypair = Keypair.generate();
    }
} else {
    platformKeypair = Keypair.generate();
    console.log("⚠️  No SOLANA_PLATFORM_SECRET set — using ephemeral keypair (devnet only)");
}
export const PLATFORM_SOL_ADDRESS = platformKeypair.publicKey.toBase58();
console.log(`🌟 Platform Solana wallet (devnet): ${PLATFORM_SOL_ADDRESS}`);

// ── SOL/USD price cache (60s TTL) ─────────────────────────────────────────────
let _priceCache = { usd: 0, fetchedAt: 0 };
async function getSolPrice(): Promise<number> {
    if (Date.now() - _priceCache.fetchedAt < 60_000 && _priceCache.usd > 0) {
        return _priceCache.usd;
    }
    try {
        const r = await fetch(
            "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
        );
        const d = await r.json() as any;
        _priceCache = { usd: d.solana.usd, fetchedAt: Date.now() };
        return _priceCache.usd;
    } catch {
        // Fallback: return last known price or a conservative devnet estimate
        return _priceCache.usd || 150;
    }
}

// ── GET /api/solana/config — public, no auth ──────────────────────────────────
router.get("/config", (_req: Request, res: Response) => {
    res.json({
        wallet:  PLATFORM_SOL_ADDRESS,
        network: SOLANA_NETWORK,
    });
});

// ── GET /api/solana/blockhash — proxy latest blockhash (avoids browser 403) ──
router.get("/blockhash", async (_req: Request, res: Response) => {
    try {
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        res.json({ blockhash, lastValidBlockHeight });
    } catch (err: any) {
        res.status(502).json({ error: "Failed to fetch blockhash.", detail: err.message });
    }
});

// ── GET /api/solana/price — current SOL/USD price ─────────────────────────────
router.get("/price", async (_req: Request, res: Response) => {
    const usd = await getSolPrice();
    res.json({ sol_usd: usd });
});

// ── POST /api/solana/connect — link Phantom wallet address to user ────────────
router.post("/connect", (req: Request, res: Response) => {
    const user = getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized." });

    const { wallet_address } = req.body;
    if (!wallet_address) return res.status(400).json({ error: "Missing required field: wallet_address." });

    try {
        new PublicKey(wallet_address); // validates base58 encoding
    } catch {
        return res.status(400).json({ error: "Invalid Solana wallet address." });
    }

    db.prepare("UPDATE users SET solana_wallet = ? WHERE id = ?").run(wallet_address, user.id);
    res.json({ message: "Wallet linked.", wallet: wallet_address });
});

// ── STRIPE INTEGRATION POINT: User Deposits ──────────────────────────────────
// Replace or supplement this endpoint with a Stripe-backed deposit flow:
//
// 1. Client calls POST /api/stripe/create-intent { amount_usd }
//    → Server: stripe.paymentIntents.create({ amount: cents, currency: 'usd' })
//    → Returns: { client_secret } to the client
//
// 2. Client confirms payment with Stripe.js (card UI, Apple Pay, Google Pay, etc.)
//
// 3. Stripe fires webhook → POST /api/stripe/webhook
//    Event: payment_intent.succeeded
//    → Verify webhook signature: stripe.webhooks.constructEvent(rawBody, sig, secret)
//    → Credit user's internal wallet using the same db.transaction() logic below
//    → Record in a `stripe_deposits` table (idempotency key: payment_intent.id)
//
// The internal wallet credit logic further down stays completely unchanged —
// only the source of the confirmed amount changes (Stripe cents → USD vs SOL → USD).
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /api/solana/deposit — verify on-chain tx, credit internal balance ────
router.post("/deposit", async (req: Request, res: Response) => {
    const user = getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized." });

    const { tx_signature, expected_sol } = req.body;
    if (!tx_signature) return res.status(400).json({ error: "Missing required field: tx_signature." });

    // Idempotency: one credit per on-chain tx
    const existing = db.prepare("SELECT id FROM solana_deposits WHERE tx_signature = ?").get(tx_signature);
    if (existing) return res.status(409).json({ error: "Transaction already credited." });

    // Fetch confirmed transaction from Solana
    let tx: any;
    try {
        tx = await connection.getTransaction(tx_signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });
    } catch (err: any) {
        return res.status(502).json({ error: "Failed to fetch transaction from Solana.", detail: err.message });
    }

    if (!tx) return res.status(400).json({ error: "Transaction not found. It may still be processing — try again in a few seconds." });
    if (tx.meta?.err) return res.status(400).json({ error: "Transaction failed on-chain.", detail: tx.meta.err });

    // Find platform wallet in account keys and calculate SOL received
    const keys: PublicKey[] =
        (tx.transaction.message as any).staticAccountKeys ??
        (tx.transaction.message as any).accountKeys;

    const idx = keys.findIndex((k: PublicKey) => k.toBase58() === PLATFORM_SOL_ADDRESS);
    if (idx === -1) return res.status(400).json({ error: "Platform wallet was not a recipient of this transaction." });

    const lamportsReceived = tx.meta!.postBalances[idx] - tx.meta!.preBalances[idx];
    if (lamportsReceived <= 0) return res.status(400).json({ error: "Platform wallet balance did not increase in this transaction." });

    const solReceived = lamportsReceived / LAMPORTS_PER_SOL;

    // Sanity check: received amount must be within 5% of expected (accounts for tx fees)
    if (expected_sol > 0 && solReceived < expected_sol * 0.95) {
        return res.status(400).json({
            error: `Amount mismatch: expected ~${expected_sol} SOL, received ${solReceived.toFixed(6)} SOL.`,
        });
    }

    // Convert to USD and credit internal wallet
    const solPrice = await getSolPrice();
    const usdAmount = +(solReceived * solPrice).toFixed(2);

    db.transaction(() => {
        db.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?")
          .run(usdAmount, user.wallet_id);
        db.prepare(`INSERT INTO solana_deposits (id, user_id, tx_signature, sol_amount, usd_credited, sol_price)
                    VALUES (?,?,?,?,?,?)`)
          .run(`sdep_${uuidv4()}`, user.id, tx_signature, solReceived, usdAmount, solPrice);
        db.prepare(`INSERT INTO transactions (id, from_wallet, to_wallet, amount, fee, type)
                    VALUES (?,?,?,?,?,?)`)
          .run(`tx_${uuidv4()}`, "solana_onramp", user.wallet_id, usdAmount, 0, "solana_deposit");
    })();

    const updated = db.prepare("SELECT balance FROM wallets WHERE id = ?").get(user.wallet_id) as any;
    res.json({
        message:     `Credited $${usdAmount.toFixed(2)} to your ContentPay balance.`,
        sol_received: solReceived,
        sol_price:    solPrice,
        usd_credited: usdAmount,
        new_balance:  updated.balance,
    });
});

export default router;
