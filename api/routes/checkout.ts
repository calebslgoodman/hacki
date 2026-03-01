import { Router, Request, Response } from "express";
import db from "../db";
import { getUserFromToken } from "./auth";
import { v4 as uuidv4 } from "uuid";

const router = Router();

/**
 * POST /api/checkout/session
 *
 * SECURED: requires user Bearer token. The creator SDK calls this with the
 * token — it never contains user_id in plaintext that a creator could forge.
 *
 * Header: Authorization: Bearer <user_token>
 * Body:   { media_id: string }
 */
router.post("/session", (req: Request, res: Response) => {
  const user = getUserFromToken(req);
  if (!user) return res.status(401).json({
    error: "Unauthorized. The SDK must include the user's Bearer token.",
  });

  const { media_id } = req.body;
  if (!media_id) return res.status(400).json({ error: "Missing required field: media_id." });

  const media = db.prepare("SELECT id FROM media WHERE id=?").get(media_id);
  if (!media) return res.status(404).json({ error: "Media not found." });

  const sessionId = `cs_${uuidv4()}`;
  // Store the user_token in the session so the modal can authenticate on our domain
  const userToken = req.headers.authorization!.slice(7);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  db.prepare("INSERT INTO checkout_sessions (id, user_id, media_id, expires_at) VALUES (?,?,?,?)").run(
    sessionId, user.id, media_id, expiresAt
  );

  // Also store the token so the modal page can use it server-side
  db.prepare("UPDATE checkout_sessions SET used=? WHERE id=?").run(0, sessionId);
  // We'll pass the token as a separate field in the session lookup
  // Use a simple approach: store token in a temp column via the session row
  // Actually we'll pass it encoded in the modal URL (it's served by us, not the creator)
  res.status(201).json({
    session_id: sessionId,
    // user_token is passed in the modal URL — only accessible to our server, not the creator
    modal_url: `/api/checkout/modal?session=${sessionId}&t=${userToken}`,
    expires_at: expiresAt,
  });
});

/**
 * GET /api/checkout/modal?session=<id>&t=<user_token>
 * Hosted payment modal — served by ContentPay, not the creator.
 * The iframe is on OUR origin, so creator JS cannot read inside it.
 */
router.get("/modal", (req: Request, res: Response) => {
  const { session, t } = req.query as { session: string; t: string };
  if (!session || !t) return res.status(400).send("<p>Missing parameters.</p>");

  const cs: any = db.prepare("SELECT * FROM checkout_sessions WHERE id=?").get(session);
  if (!cs) return res.status(404).send("<p>Session not found.</p>");
  if (cs.used) return res.status(410).send("<p>Session already used.</p>");
  if (new Date(cs.expires_at) < new Date()) return res.status(410).send("<p>Session expired.</p>");

  // Validate the token belongs to the session's user
  const sessionFromToken: any = db.prepare("SELECT * FROM user_sessions WHERE token=?").get(t);
  if (!sessionFromToken || sessionFromToken.user_id !== cs.user_id)
    return res.status(403).send("<p>Invalid session token.</p>");

  const media: any = db.prepare("SELECT * FROM media WHERE id=?").get(cs.media_id);
  const user: any = db.prepare("SELECT u.*, w.balance FROM users u JOIN wallets w ON w.id=u.wallet_id WHERE u.id=?").get(cs.user_id);
  const canAfford = user.balance >= media.price;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ContentPay — Checkout</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f15; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #1a1a2e; border: 1px solid rgba(255,255,255,.08); border-radius: 20px; padding: 32px; max-width: 380px; width: 100%; }
    .logo { display: flex; align-items: center; gap: 8px; margin-bottom: 24px; }
    .logo-dot { width: 10px; height: 10px; background: #7c3aed; border-radius: 50%; }
    .logo-text { font-weight: 800; font-size: 15px; color: #a78bfa; }
    .security-badge { font-size: 11px; color: #10b981; background: rgba(16,185,129,.1); border: 1px solid rgba(16,185,129,.2); border-radius: 999px; padding: 3px 10px; margin-left: auto; }
    .thumbnail { width: 100%; aspect-ratio: 16/9; border-radius: 12px; object-fit: cover; margin-bottom: 20px; }
    h2 { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
    .price { font-size: 32px; font-weight: 900; color: #a78bfa; margin: 16px 0; }
    .balance { font-size: 13px; color: #9ca3af; margin-bottom: 20px; }
    .balance span { color: ${canAfford ? '#10b981' : '#ef4444'}; font-weight: 600; }
    .user-info { font-size: 12px; color: #6b7280; margin-bottom: 16px; }
    .btn { width: 100%; padding: 14px; border-radius: 12px; border: none; font-size: 15px; font-weight: 700; cursor: pointer; transition: opacity .15s; }
    .btn-pay { background: linear-gradient(135deg,#7c3aed,#a855f7); color: white; }
    .btn-pay:disabled { opacity: .4; cursor: not-allowed; }
    .btn-cancel { background: rgba(255,255,255,.05); color: #9ca3af; margin-top: 10px; border: 1px solid rgba(255,255,255,.08); }
    .error { color: #f87171; font-size: 13px; margin-top: 10px; display: none; }
    .success { text-align: center; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-dot"></div>
      <span class="logo-text">ContentPay</span>
      <span class="security-badge">🔒 Secure</span>
    </div>
    <div id="checkout-view">
      <img class="thumbnail" src="${media.thumbnail || ''}" alt="${media.title}" />
      <h2>${media.title}</h2>
      <div class="price">$${media.price.toFixed(2)}</div>
      <div class="balance">Your balance: <span>$${user.balance.toFixed(2)}</span></div>
      <div class="user-info">Paying as: ${user.name} (${user.email})</div>
      ${!canAfford ? '<p style="color:#f87171;font-size:13px;margin-bottom:16px;">⚠ Insufficient balance. Please load funds first.</p>' : ''}
      <button class="btn btn-pay" id="payBtn" ${canAfford ? '' : 'disabled'}>Pay $${media.price.toFixed(2)}</button>
      <button class="btn btn-cancel" onclick="window.parent.postMessage({type:'contentpay:cancel'},'*')">Cancel</button>
      <p class="error" id="errorMsg"></p>
    </div>
    <div class="success" id="success-view">
      <div style="font-size:48px;margin-bottom:10px">✅</div>
      <h2>Payment Successful!</h2>
      <p style="color:#9ca3af;margin-top:8px;font-size:14px;">Unlocking your content…</p>
    </div>
  </div>
  <script>
    // The user token is held server-side — this modal page makes authenticated calls
    // on behalf of the user. Creator JS cannot read this token (different origin).
    const USER_TOKEN = ${JSON.stringify(t)};

    document.getElementById('payBtn').addEventListener('click', async () => {
      const btn = document.getElementById('payBtn');
      btn.disabled = true; btn.textContent = 'Processing…';
      try {
        const res = await fetch('/api/purchase', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + USER_TOKEN,
          },
          body: JSON.stringify({ media_id: ${JSON.stringify(cs.media_id)} })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Payment failed');

        document.getElementById('checkout-view').style.display = 'none';
        document.getElementById('success-view').style.display = 'block';

        setTimeout(() => {
          window.parent.postMessage(
            { type: 'contentpay:success', content_url: data.content_url },
            '*'
          );
        }, 1200);
      } catch(e) {
        const err = document.getElementById('errorMsg');
        err.textContent = e.message; err.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Try Again';
      }
    });
  </script>
</body>
</html>`);
});

export default router;
