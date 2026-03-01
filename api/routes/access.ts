import { Router, Request, Response } from "express";
import db from "../db";
import { getUserFromToken } from "./auth";

const router = Router();

/**
 * GET /api/access?media_id=
 *
 * SECURED: requires user Bearer token.
 * Creators cannot impersonate users to check their access.
 *
 * Header: Authorization: Bearer <user_token>
 * Query:  media_id
 *
 * Returns { has_access, content_url } if owned,
 *      or { has_access: false, price, thumbnail } if not.
 */
router.get("/", (req: Request, res: Response) => {
    const user = getUserFromToken(req);
    if (!user) return res.status(401).json({
        error: "Unauthorized. Include your user token: Authorization: Bearer <token>",
        hint: "Get a token via POST /api/auth/login with your api_key.",
    });

    const { media_id } = req.query as { media_id?: string };
    if (!media_id) return res.status(400).json({ error: "Missing required query param: media_id." });

    const media: any = db.prepare("SELECT id, title, price, price_per_minute, billing_interval_seconds, thumbnail, content_url FROM media WHERE id=?").get(media_id);
    if (!media) return res.status(404).json({ error: "Media not found." });

    // Flat model: check purchases table
    if (!media.price_per_minute) {
        const purchase: any = db.prepare("SELECT id, purchased_at FROM purchases WHERE user_id=? AND media_id=?").get(user.id, media_id);
        if (purchase) {
            return res.json({
                has_access:  true,
                content_url: media.content_url,
                media_title: media.title,
                purchased_at: purchase.purchased_at,
            });
        }
        return res.json({
            has_access:  false,
            media_id,
            media_title: media.title,
            price:       media.price,
            thumbnail:   media.thumbnail,
        });
    }

    // Timed model: active session with recent heartbeat
    const staleThreshold = (media.billing_interval_seconds ?? 10) * 3;
    const timedSession: any = db.prepare(`
        SELECT id FROM timed_sessions
        WHERE user_id = ? AND media_id = ? AND active = 1
          AND last_heartbeat > datetime('now', '-' || ? || ' seconds')
    `).get(user.id, media_id, staleThreshold);

    if (timedSession) {
        return res.json({
            has_access:  true,
            content_url: media.content_url,
            media_title: media.title,
            session_id:  timedSession.id,
        });
    }

    return res.json({
        has_access:               false,
        media_id,
        media_title:              media.title,
        price_per_minute:         media.price_per_minute,
        billing_interval_seconds: media.billing_interval_seconds ?? 10,
        thumbnail:                media.thumbnail,
    });
});

export default router;
