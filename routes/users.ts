import { Router, Request, Response } from "express";
import db from "../db";
import { v4 as uuidv4 } from "uuid";

const router = Router();

/** POST /api/users — Create a new user */
router.post("/", (req: Request, res: Response) => {
    const { name, email } = req.body;
    if (!name || !email)
        return res.status(400).json({ error: "Missing required fields: name, email." });

    const existing = db.prepare("SELECT id FROM users WHERE email=?").get(email);
    if (existing) return res.status(409).json({ error: "Email already registered." });

    const userId = `user_${uuidv4().slice(0, 8)}`;
    const walletId = `wallet_${uuidv4()}`;
    const apiKey = `u_${uuidv4().replace(/-/g, "")}`;

    db.prepare("INSERT INTO wallets (id, owner_id, owner_type, balance) VALUES (?,?,?,?)").run(walletId, userId, "user", 0);
    db.prepare("INSERT INTO users (id, name, email, api_key, wallet_id) VALUES (?,?,?,?,?)").run(userId, name, email, apiKey, walletId);

    const user = db.prepare("SELECT u.*, w.balance FROM users u JOIN wallets w ON w.id=u.wallet_id WHERE u.id=?").get(userId);
    res.status(201).json(user);
});

/** GET /api/users/:id — Get user + wallet balance */
router.get("/:id", (req: Request, res: Response) => {
    const user = db.prepare("SELECT u.*, w.balance, w.id as wallet_id FROM users u JOIN wallets w ON w.id=u.wallet_id WHERE u.id=?").get(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    res.json(user);
});

/** GET /api/users/:id/purchases — List all media a user has purchased */
router.get("/:id/purchases", (req: Request, res: Response) => {
    const user = db.prepare("SELECT id FROM users WHERE id=?").get(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });

    const purchases = db.prepare(`
    SELECT p.id as purchase_id, p.purchased_at, m.id as media_id, m.title, m.description, m.price, m.thumbnail, c.name as creator_name
    FROM purchases p
    JOIN media m ON m.id = p.media_id
    JOIN creators c ON c.id = m.creator_id
    WHERE p.user_id = ?
    ORDER BY p.purchased_at DESC
  `).all(req.params.id);

    res.json({ user_id: req.params.id, total: purchases.length, purchases });
});

export default router;
