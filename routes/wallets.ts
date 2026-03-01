import { Router, Request, Response } from "express";
import db from "../db";

const router = Router();

/** GET /api/wallets/:id — Get wallet balance */
router.get("/:id", (req: Request, res: Response) => {
    const wallet = db.prepare("SELECT * FROM wallets WHERE id=?").get(req.params.id);
    if (!wallet) return res.status(404).json({ error: "Wallet not found." });
    res.json(wallet);
});


/** GET /api/wallets/:id/transactions — Transaction history */
router.get("/:id/transactions", (req: Request, res: Response) => {
    const wallet = db.prepare("SELECT id FROM wallets WHERE id=?").get(req.params.id);
    if (!wallet) return res.status(404).json({ error: "Wallet not found." });

    const txs = db.prepare(
        "SELECT * FROM transactions WHERE from_wallet=? OR to_wallet=? ORDER BY timestamp DESC LIMIT 100"
    ).all(req.params.id, req.params.id);
    res.json({ wallet_id: req.params.id, transactions: txs });
});

export default router;
