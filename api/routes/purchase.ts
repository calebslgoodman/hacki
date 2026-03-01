import { Router, Request, Response } from "express";
import db from "../db";
import { getUserFromToken } from "./auth";
import { PLATFORM_FEE_RATE } from "../seed";
import { v4 as uuidv4 } from "uuid";

const router = Router();

/**
 * POST /api/purchase
 *
 * SECURED: requires a user Bearer token (issued by POST /api/auth/login).
 * Creators CANNOT call this on behalf of users — only the user's own token works.
 *
 * Header: Authorization: Bearer <user_token>
 * Body:   { media_id: string }
 */
router.post("/", (req: Request, res: Response) => {
    const user = getUserFromToken(req);
    if (!user) return res.status(401).json({
        error: "Unauthorized. Include your user token: Authorization: Bearer <token>",
        hint: "Get a token via POST /api/auth/login with your api_key.",
    });

    const { media_id } = req.body;
    if (!media_id) return res.status(400).json({ error: "Missing required field: media_id." });

    const media: any = db.prepare("SELECT m.*, c.wallet_id as creator_wallet_id FROM media m JOIN creators c ON c.id=m.creator_id WHERE m.id=?").get(media_id);
    if (!media) return res.status(404).json({ error: "Media not found." });

    // Idempotency
    const existing: any = db.prepare("SELECT p.*, t.amount FROM purchases p JOIN transactions t ON t.id=p.tx_id WHERE p.user_id=? AND p.media_id=?").get(user.id, media.id);
    if (existing) {
        return res.status(200).json({
            already_purchased: true,
            purchase_id: existing.id,
            content_url: media.content_url,
            purchased_at: existing.purchased_at,
        });
    }

    // Insufficient funds
    if (user.balance < media.price) {
        return res.status(402).json({
            error: "Insufficient wallet balance.",
            required: media.price,
            available: user.balance,
            shortfall: +(media.price - user.balance).toFixed(2),
        });
    }

    const platformFee = +(media.price * PLATFORM_FEE_RATE).toFixed(2);
    const creatorAmount = +(media.price - platformFee).toFixed(2);
    const txId = `tx_${uuidv4()}`;
    const purchaseId = `pur_${uuidv4()}`;

    db.transaction(() => {
        db.prepare("UPDATE wallets SET balance = balance - ? WHERE id=?").run(media.price, user.wallet_id);
        db.prepare("UPDATE wallets SET balance = balance + ? WHERE id='wallet_platform'").run(platformFee);
        db.prepare("UPDATE wallets SET balance = balance + ? WHERE id=?").run(creatorAmount, media.creator_wallet_id);
        db.prepare(`INSERT INTO transactions (id, from_wallet, to_wallet, amount, fee, media_id, type) VALUES (?,?,?,?,?,?,?)`).run(
            txId, user.wallet_id, media.creator_wallet_id, media.price, platformFee, media.id, "purchase"
        );
        db.prepare(`INSERT INTO purchases (id, user_id, media_id, tx_id) VALUES (?,?,?,?)`).run(purchaseId, user.id, media.id, txId);
    })();

    res.status(201).json({
        purchase_id: purchaseId,
        media_id: media.id,
        media_title: media.title,
        amount_charged: media.price,
        platform_fee: platformFee,
        creator_received: creatorAmount,
        fee_rate: `${PLATFORM_FEE_RATE * 100}%`,
        content_url: media.content_url,
        transaction_id: txId,
    });
});

/**
 * DELETE /api/purchase — Revoke access (creator-authenticated).
 * Only the media's own creator can call this.
 *
 * Body: { user_id, media_id, api_key, refund? }
 */
router.delete("/", (req: Request, res: Response) => {
    const { user_id, media_id, api_key, refund = true } = req.body;

    if (!user_id || !media_id || !api_key)
        return res.status(400).json({ error: "Missing required fields: user_id, media_id, api_key." });

    const creator: any = db.prepare("SELECT c.* FROM creators c JOIN media m ON m.creator_id=c.id WHERE c.api_key=? AND m.id=?").get(api_key, media_id);
    if (!creator) return res.status(403).json({ error: "Forbidden: api_key does not match the creator of this media." });

    const purchase: any = db.prepare("SELECT p.*, t.amount FROM purchases p JOIN transactions t ON t.id=p.tx_id WHERE p.user_id=? AND p.media_id=?").get(user_id, media_id);
    if (!purchase) return res.status(404).json({ error: "No purchase record found for this user and media." });

    const user: any = db.prepare("SELECT u.*, w.id as wallet_id FROM users u JOIN wallets w ON w.id=u.wallet_id WHERE u.id=?").get(user_id);

    // ── STRIPE INTEGRATION POINT: Refunds ────────────────────────────────────
    // If the user originally funded their wallet via Stripe, also issue a card refund:
    //   const deposit = db.prepare(
    //     "SELECT stripe_payment_intent_id FROM stripe_deposits WHERE user_id = ? ORDER BY confirmed_at DESC LIMIT 1"
    //   ).get(user_id);
    //   if (deposit?.stripe_payment_intent_id) {
    //     await stripe.refunds.create({
    //       payment_intent: deposit.stripe_payment_intent_id,
    //       amount: Math.round(purchase.amount * 100),  // cents
    //     });
    //   }
    // The internal wallet reversal in the transaction below handles the ledger
    // side regardless of whether the original deposit was Stripe or Solana.
    // ─────────────────────────────────────────────────────────────────────────

    db.transaction(() => {
        db.prepare("DELETE FROM purchases WHERE user_id=? AND media_id=?").run(user_id, media_id);
        if (refund) {
            db.prepare("UPDATE wallets SET balance = balance + ? WHERE id=?").run(purchase.amount, user.wallet_id);
            db.prepare("UPDATE wallets SET balance = balance - ? WHERE id='wallet_platform'").run(purchase.amount);
            db.prepare(`INSERT INTO transactions (id, from_wallet, to_wallet, amount, fee, media_id, type) VALUES (?,?,?,?,?,?,?)`).run(
                `tx_${uuidv4()}`, "wallet_platform", user.wallet_id, purchase.amount, 0, media_id, "refund"
            );
        }
    })();

    res.json({
        message: `Access revoked for user "${user_id}" on media "${media_id}".`,
        refund_issued: refund,
        refund_amount: refund ? purchase.amount : 0,
    });
});

export default router;
