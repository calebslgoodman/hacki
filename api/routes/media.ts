import { Router, Request, Response } from "express";
import db from "../db";
import { v4 as uuidv4 } from "uuid";

const router = Router();

/** POST /api/media — Register media (requires creator_id or api_key in body) */
router.post("/", (req: Request, res: Response) => {
    const { creator_id, api_key, title, description, price, price_per_minute, billing_interval_seconds, initial_payment, content_url, thumbnail } = req.body;

    // Auth: accept either creator_id or api_key
    let creator: any;
    if (api_key) {
        creator = db.prepare("SELECT * FROM creators WHERE api_key=?").get(api_key);
    } else if (creator_id) {
        creator = db.prepare("SELECT * FROM creators WHERE id=?").get(creator_id);
    }
    if (!creator) return res.status(401).json({ error: "Invalid creator credentials." });

    if (!title || !content_url)
        return res.status(400).json({ error: "Missing required fields: title, content_url." });

    const isFlat  = typeof price === "number" && price > 0 && !price_per_minute;
    const isTimed = typeof price_per_minute === "number" && price_per_minute > 0 && (!price || price === 0);
    if (!isFlat && !isTimed) {
        return res.status(400).json({
            error: "Specify exactly one pricing model: price > 0 (flat) OR price_per_minute > 0 with price = 0 (timed).",
        });
    }

    const mediaId    = `media_${uuidv4().slice(0, 8)}`;
    const finalPrice = isFlat ? price : 0;
    const finalPpm   = isTimed ? price_per_minute : null;
    const finalInterval = isTimed ? (billing_interval_seconds ?? 10) : null;
    const finalInitialPayment = isTimed ? (typeof initial_payment === "number" && initial_payment >= 0 ? initial_payment : 0) : 0;

    db.prepare(`INSERT INTO media (id, creator_id, title, description, price, price_per_minute, billing_interval_seconds, initial_payment, content_url, thumbnail)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(mediaId, creator.id, title.trim(), description?.trim() ?? "", finalPrice, finalPpm, finalInterval, finalInitialPayment, content_url.trim(), thumbnail?.trim() ?? "");

    const media = db.prepare("SELECT * FROM media WHERE id=?").get(mediaId);
    res.status(201).json(media);
});

/** GET /api/media — List all media (optional ?creator_id= filter) */
router.get("/", (req: Request, res: Response) => {
    const { creator_id, min_price, max_price, search, page = "1", limit = "20" } = req.query as Record<string, string>;

    let query = `SELECT m.*, c.name as creator_name FROM media m JOIN creators c ON c.id=m.creator_id WHERE 1=1`;
    const params: (string | number)[] = [];

    if (creator_id) { query += " AND m.creator_id=?"; params.push(creator_id); }
    if (min_price) { query += " AND m.price >= ?"; params.push(parseFloat(min_price)); }
    if (max_price) { query += " AND m.price <= ?"; params.push(parseFloat(max_price)); }
    if (search) { query += " AND (m.title LIKE ? OR m.description LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }

    const total = (db.prepare(`SELECT COUNT(*) as count FROM (${query})`).get(...params) as any).count;
    const pageN = Math.max(1, parseInt(page));
    const limitN = Math.min(100, parseInt(limit));
    query += " ORDER BY m.created_at DESC LIMIT ? OFFSET ?";
    params.push(limitN, (pageN - 1) * limitN);

    const items = db.prepare(query).all(...params);
    res.json({ data: items, pagination: { page: pageN, limit: limitN, total, total_pages: Math.ceil(total / limitN) } });
});

/** GET /api/media/:id — Single media item */
router.get("/:id", (req: Request, res: Response) => {
    const media = db.prepare("SELECT m.*, c.name as creator_name FROM media m JOIN creators c ON c.id=m.creator_id WHERE m.id=?").get(req.params.id);
    if (!media) return res.status(404).json({ error: "Media not found." });
    res.json(media);
});

export default router;
