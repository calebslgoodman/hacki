import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import db from "../db";
import { getUserFromToken } from "./auth";
import { PLATFORM_FEE_RATE } from "../seed";

const router = Router();

// ── POST /api/timed/start ────────────────────────────────────────────────────
router.post("/start", (req: Request, res: Response) => {
    const user = getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized." });

    const { media_id } = req.body;
    if (!media_id) return res.status(400).json({ error: "Missing required field: media_id." });

    const media: any = db.prepare(`
        SELECT m.*, c.wallet_id as creator_wallet_id
        FROM media m JOIN creators c ON c.id = m.creator_id
        WHERE m.id = ?
    `).get(media_id);
    if (!media) return res.status(404).json({ error: "Media not found." });
    if (!media.price_per_minute) return res.status(400).json({ error: "This media uses flat pricing. Use POST /api/purchase instead." });

    const initialPayment = media.initial_payment ?? 0;
    const required = initialPayment + media.price_per_minute;

    // Require enough for the entry fee + at least 1 minute of billing
    if (user.balance < required) {
        return res.status(402).json({
            error: "Insufficient balance to start a timed session.",
            required,
            initial_payment: initialPayment,
            rate_per_minute: media.price_per_minute,
            available: user.balance,
        });
    }

    // Close any stale or pre-existing active session for this user + media
    db.prepare("UPDATE timed_sessions SET active = 0 WHERE user_id = ? AND media_id = ? AND active = 1")
      .run(user.id, media_id);

    const sessionId = `ts_${uuidv4().replace(/-/g, "")}`;

    // Charge initial payment upfront (if set)
    let balanceAfterEntry = user.balance;
    if (initialPayment > 0) {
        const platformFee   = +(initialPayment * PLATFORM_FEE_RATE).toFixed(6);
        const creatorAmount = +(initialPayment - platformFee).toFixed(6);
        db.transaction(() => {
            db.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?").run(initialPayment, user.wallet_id);
            db.prepare("UPDATE wallets SET balance = balance + ? WHERE id = 'wallet_platform'").run(platformFee);
            db.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?").run(creatorAmount, media.creator_wallet_id);
            db.prepare(`INSERT INTO transactions (id, from_wallet, to_wallet, amount, fee, media_id, type)
                        VALUES (?,?,?,?,?,?,?)`)
              .run(`tx_${uuidv4()}`, user.wallet_id, media.creator_wallet_id, initialPayment, platformFee, media_id, "timed_entry");
        })();
        balanceAfterEntry = +(user.balance - initialPayment).toFixed(2);
    }

    db.prepare(`
        INSERT INTO timed_sessions (id, user_id, media_id, started_at, last_heartbeat, total_charged, active)
        VALUES (?, ?, ?, datetime('now'), datetime('now'), ?, 1)
    `).run(sessionId, user.id, media_id, initialPayment);

    return res.status(201).json({
        session_id:               sessionId,
        balance:                  balanceAfterEntry,
        initial_payment:          initialPayment,
        rate_per_minute:          media.price_per_minute,
        billing_interval_seconds: media.billing_interval_seconds ?? 10,
        content_url:              media.content_url,
    });
});

// ── POST /api/timed/heartbeat ────────────────────────────────────────────────
router.post("/heartbeat", (req: Request, res: Response) => {
    const user = getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized." });

    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: "Missing required field: session_id." });

    const session: any = db.prepare(`
        SELECT ts.*, m.price_per_minute, m.billing_interval_seconds, m.creator_id,
               c.wallet_id as creator_wallet_id
        FROM timed_sessions ts
        JOIN media m ON m.id = ts.media_id
        JOIN creators c ON c.id = m.creator_id
        WHERE ts.id = ? AND ts.user_id = ?
    `).get(session_id, user.id);

    if (!session) return res.status(404).json({ error: "Session not found." });
    if (!session.active) return res.json({ active: false, balance: user.balance, total_charged: session.total_charged });

    const now = new Date().toISOString();
    const lastHb = new Date(session.last_heartbeat).getTime();
    const elapsedSeconds = Math.max(0, (Date.now() - lastHb) / 1000);
    const charge = +((elapsedSeconds / 60) * session.price_per_minute).toFixed(6);

    // Insufficient funds — end session
    if (user.balance < charge) {
        db.prepare("UPDATE timed_sessions SET active = 0 WHERE id = ?").run(session_id);
        db.prepare("UPDATE wallets SET balance = 0 WHERE id = ? AND balance < ?").run(user.wallet_id, charge);
        return res.json({ active: false, balance: 0, total_charged: session.total_charged });
    }

    const platformFee     = +((charge * PLATFORM_FEE_RATE)).toFixed(6);
    const creatorAmount   = +(charge - platformFee).toFixed(6);
    const sessionDuration = Math.round((Date.now() - new Date(session.started_at).getTime()) / 1000);

    // Optimistic-lock: only update if last_heartbeat hasn't changed (prevents double-billing)
    const result = db.transaction(() => {
        const updated = db.prepare(`
            UPDATE timed_sessions
            SET last_heartbeat = ?, total_charged = total_charged + ?
            WHERE id = ? AND active = 1 AND last_heartbeat = ?
        `).run(now, charge, session_id, session.last_heartbeat);

        if (updated.changes === 0) return null; // duplicate heartbeat — skip

        db.prepare("UPDATE wallets SET balance = balance - ? WHERE id = ?").run(charge, user.wallet_id);
        db.prepare("UPDATE wallets SET balance = balance + ? WHERE id = 'wallet_platform'").run(platformFee);
        db.prepare("UPDATE wallets SET balance = balance + ? WHERE id = ?").run(creatorAmount, session.creator_wallet_id);
        db.prepare(`INSERT INTO transactions (id, from_wallet, to_wallet, amount, fee, media_id, type)
                    VALUES (?,?,?,?,?,?,?)`)
          .run(`tx_${uuidv4()}`, user.wallet_id, session.creator_wallet_id, charge, platformFee, session.media_id, "timed");

        return charge;
    })();

    if (result === null) {
        // Duplicate heartbeat — return current state without re-charging
        return res.json({ active: true, balance: user.balance, charged_this_tick: 0, total_charged: session.total_charged, session_duration_seconds: sessionDuration });
    }

    const newBalance = +(user.balance - charge).toFixed(2);
    return res.json({
        active:                 true,
        balance:                newBalance,
        charged_this_tick:      +charge.toFixed(4),
        total_charged:          +(session.total_charged + charge).toFixed(4),
        session_duration_seconds: sessionDuration,
    });
});

// ── POST /api/timed/end ──────────────────────────────────────────────────────
router.post("/end", (req: Request, res: Response) => {
    const user = getUserFromToken(req);
    if (!user) return res.status(401).json({ error: "Unauthorized." });

    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: "Missing required field: session_id." });

    const session: any = db.prepare("SELECT * FROM timed_sessions WHERE id = ? AND user_id = ?").get(session_id, user.id);
    if (!session) return res.status(404).json({ error: "Session not found." });

    db.prepare("UPDATE timed_sessions SET active = 0 WHERE id = ?").run(session_id);

    return res.json({
        message:       "Session ended.",
        session_id,
        total_charged: +session.total_charged.toFixed(4),
    });
});

export default router;
