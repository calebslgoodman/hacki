import { Router, Request, Response } from "express";
import db from "../db";
import { v4 as uuidv4 } from "uuid";

const router = Router();

const SESSION_TTL_HOURS = 24;

/**
 * POST /api/auth/login
 *
 * Users authenticate with their api_key to get a session token.
 * This token is what the SDK stores — the creator site NEVER sees it.
 *
 * Body: { api_key: string }
 * Returns: { token, user_id, name, expires_at }
 */
router.post("/login", (req: Request, res: Response) => {
    const { api_key } = req.body;
    if (!api_key) return res.status(400).json({ error: "Missing required field: api_key." });

    const user: any = db.prepare("SELECT id, name, email FROM users WHERE api_key=?").get(api_key);
    if (!user) return res.status(401).json({ error: "Invalid api_key." });

    // Invalidate any existing sessions for this user
    db.prepare("DELETE FROM user_sessions WHERE user_id=?").run(user.id);

    const token = `ut_${uuidv4().replace(/-/g, "")}`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();

    db.prepare("INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?,?,?)").run(token, user.id, expiresAt);

    res.json({ token, user_id: user.id, name: user.name, expires_at: expiresAt });
});

/**
 * POST /api/auth/logout
 * Invalidates the session token.
 * Header: Authorization: Bearer <token>
 */
router.post("/logout", (req: Request, res: Response) => {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: "No token provided." });
    db.prepare("DELETE FROM user_sessions WHERE token=?").run(token);
    res.json({ message: "Logged out." });
});

export function extractToken(req: Request): string | null {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) return auth.slice(7);
    return null;
}

/**
 * Resolves the authenticated user from a Bearer token in the request.
 * Returns the user row or null if invalid/expired.
 */
export function getUserFromToken(req: Request): any | null {
    const token = extractToken(req);
    if (!token) return null;

    const session: any = db.prepare("SELECT * FROM user_sessions WHERE token=?").get(token);
    if (!session) return null;
    if (new Date(session.expires_at) < new Date()) {
        db.prepare("DELETE FROM user_sessions WHERE token=?").run(token); // clean up
        return null;
    }

    return db.prepare("SELECT u.*, w.balance, w.id as wallet_id FROM users u JOIN wallets w ON w.id=u.wallet_id WHERE u.id=?").get(session.user_id);
}

export default router;
