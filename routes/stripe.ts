import { Router, Request, Response } from "express";
import Stripe from "stripe";
import db from "../db";
import { getUserFromToken } from "./auth";
import { v4 as uuidv4 } from "uuid";

const router = Router();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2023-10-16",
});

/**
 * POST /api/stripe/create-intent
 * Authenticated user loads their ContentPay wallet via card.
 * Returns a client_secret the frontend uses with Stripe.js to confirm payment.
 *
 * Header: Authorization: Bearer <user_token>
 * Body:   { amount_usd: number }  — minimum $0.50 (Stripe floor)
 */
router.post("/create-intent", async (req: Request, res: Response) => {
    const user = getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized." });

    let { amount_usd } = req.body;
    amount_usd = parseFloat(amount_usd);
    if (!amount_usd || isNaN(amount_usd) || amount_usd < 0.50)
        return res.status(400).json({ error: "Minimum deposit is $0.50." });

    try {
        const intent = await stripe.paymentIntents.create({
            amount: Math.round(amount_usd * 100), // Stripe uses cents
            currency: "usd",
            // Metadata carries user context into the webhook — never exposed to creator JS
            metadata: {
                user_id: user.id,
                wallet_id: (user as any).wallet_id,
            },
        });

        res.json({
            client_secret: intent.client_secret,
            payment_intent_id: intent.id,
            amount_usd,
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/stripe/balance
 * Returns the current wallet balance for the authenticated user.
 * Used by the modal to poll for balance update after card payment.
 *
 * Header: Authorization: Bearer <user_token>
 */
router.get("/balance", (req: Request, res: Response) => {
    const user = getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized." });

    const wallet = db.prepare("SELECT balance FROM wallets WHERE id = ?")
        .get((user as any).wallet_id) as any;
    res.json({ balance: wallet.balance });
});

/**
 * POST /api/stripe/webhook
 * Stripe fires this when payment_intent.succeeded.
 * MUST be mounted with express.raw() — see index.ts.
 * Credits the user's internal wallet, records in stripe_deposits for idempotency.
 */
export async function stripeWebhookHandler(req: Request, res: Response) {
    const sig = req.headers["stripe-signature"] as string;
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
        console.error("STRIPE_WEBHOOK_SECRET not set");
        return res.status(500).json({ error: "Webhook secret not configured." });
    }

    let event: Stripe.Event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err: any) {
        console.error("Webhook signature failed:", err.message);
        return res.status(400).json({ error: `Webhook error: ${err.message}` });
    }

    if (event.type === "payment_intent.succeeded") {
        const intent = event.data.object as Stripe.PaymentIntent;
        const { user_id, wallet_id } = intent.metadata;
        const amountUsd = intent.amount / 100;

        // Idempotency — ignore duplicate webhook deliveries
        const existing = db.prepare(
            "SELECT id FROM stripe_deposits WHERE payment_intent_id = ?"
        ).get(intent.id);

        if (!existing && user_id && wallet_id) {
            db.transaction(() => {
                db.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?")
                    .run(amountUsd, wallet_id);
                db.prepare(
                    "INSERT INTO stripe_deposits (id, user_id, payment_intent_id, amount_usd) VALUES (?,?,?,?)"
                ).run(`sdep_${uuidv4()}`, user_id, intent.id, amountUsd);
                db.prepare(
                    "INSERT INTO transactions (id, from_wallet, to_wallet, amount, fee, type) VALUES (?,?,?,?,?,?)"
                ).run(`tx_${uuidv4()}`, "stripe_onramp", wallet_id, amountUsd, 0, "stripe_deposit");
            })();
            console.log(`✅ Stripe deposit: $${amountUsd.toFixed(2)} → wallet ${wallet_id} (user ${user_id})`);
        }
    }

    res.json({ received: true });
}

export default router;
