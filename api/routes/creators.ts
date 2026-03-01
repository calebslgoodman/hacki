import { Router, Request, Response } from "express";
import db from "../db";
import { v4 as uuidv4 } from "uuid";

const router = Router();

/** POST /api/creators — Register a new creator */
router.post("/", (req: Request, res: Response) => {
    const { name, email } = req.body;
    if (!name || !email)
        return res.status(400).json({ error: "Missing required fields: name, email." });

    const existing = db.prepare("SELECT id FROM creators WHERE email=?").get(email);
    if (existing) return res.status(409).json({ error: "Email already registered." });

    const creatorId = `creator_${uuidv4().slice(0, 8)}`;
    const walletId = `wallet_${uuidv4()}`;
    const apiKey = `c_${uuidv4().replace(/-/g, "")}`;

    db.prepare("INSERT INTO wallets (id, owner_id, owner_type, balance) VALUES (?,?,?,?)").run(walletId, creatorId, "creator", 0);
    db.prepare("INSERT INTO creators (id, name, email, api_key, wallet_id) VALUES (?,?,?,?,?)").run(creatorId, name, email, apiKey, walletId);

    const creator = db.prepare("SELECT c.*, w.balance FROM creators c JOIN wallets w ON w.id=c.wallet_id WHERE c.id=?").get(creatorId);
    res.status(201).json(creator);
});

/** GET /api/creators/:id — Get creator + wallet balance */
router.get("/:id", (req: Request, res: Response) => {
    const creator = db.prepare("SELECT c.*, w.balance, w.id as wallet_id FROM creators c JOIN wallets w ON w.id=c.wallet_id WHERE c.id=?").get(req.params.id);
    if (!creator) return res.status(404).json({ error: "Creator not found." });
    res.json(creator);
});

/** GET /api/creators/:id/stats — Revenue dashboard */
router.get("/:id/stats", (req: Request, res: Response) => {
    const creator = db.prepare("SELECT c.*, w.balance FROM creators c JOIN wallets w ON w.id=c.wallet_id WHERE c.id=?").get(req.params.id) as any;
    if (!creator) return res.status(404).json({ error: "Creator not found." });

    const stats = db.prepare(`
    SELECT
      COUNT(p.id) as total_sales,
      COALESCE(SUM(m.price), 0) as gross_revenue,
      COALESCE(SUM(t.fee), 0) as total_fees_paid,
      COALESCE(SUM(m.price) - SUM(t.fee), 0) as net_revenue
    FROM purchases p
    JOIN media m ON m.id = p.media_id
    JOIN transactions t ON t.id = p.tx_id
    WHERE m.creator_id = ?
  `).get(req.params.id) as any;

    const mediaCount = (db.prepare("SELECT COUNT(*) as count FROM media WHERE creator_id=?").get(req.params.id) as any).count;

    res.json({
        creator_id: req.params.id,
        name: creator.name,
        wallet_balance: creator.balance,
        media_count: mediaCount,
        ...stats,
    });
});

// ── STRIPE INTEGRATION POINT: Creator Payouts ────────────────────────────────
// Add POST /api/creators/:id/withdraw to let creators cash out their balance:
//
// Prerequisites — Stripe Connect onboarding (one-time per creator):
//   POST /api/creators/:id/connect-stripe
//   → stripe.accounts.create({ type: 'express' })
//   → Returns an onboarding link; creator completes KYC (name, bank, SSN/EIN)
//   → Store stripe_account_id on the creators row
//
// Payout flow:
//   POST /api/creators/:id/withdraw { amount_usd }
//   → stripe.transfers.create({
//       amount: Math.round(amount_usd * 100),   // Stripe uses cents
//       currency: 'usd',
//       destination: creator.stripe_account_id,
//     })
//   → db: deduct from creator wallet balance
//   → db: deduct from wallet_platform (platform fronts the transfer)
//   → db: INSERT INTO transactions (type: 'payout')
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/creators/:id/transactions — Creator transaction history */
router.get("/:id/transactions", (req: Request, res: Response) => {
    const creator = db.prepare("SELECT wallet_id FROM creators WHERE id=?").get(req.params.id) as any;
    if (!creator) return res.status(404).json({ error: "Creator not found." });

    const txs = db.prepare(
        "SELECT * FROM transactions WHERE from_wallet=? OR to_wallet=? ORDER BY timestamp DESC LIMIT 100"
    ).all(creator.wallet_id, creator.wallet_id);
    res.json({ creator_id: req.params.id, transactions: txs });
});

export default router;
