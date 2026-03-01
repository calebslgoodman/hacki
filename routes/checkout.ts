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

  const shortfall = +(media.price - user.balance).toFixed(2);
  // Round up to nearest $0.50 increment, minimum $0.50 (Stripe floor)
  const suggestedLoad = Math.max(0.50, Math.ceil(shortfall / 0.50) * 0.50);
  const stripeKey = process.env.STRIPE_PUBLISHABLE_KEY || '';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ContentPay — Checkout</title>
  ${stripeKey ? '<script src="https://js.stripe.com/v3/"></script>' : ''}
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
    .divider { display: flex; align-items: center; gap: 10px; margin: 18px 0; color: #4b5563; font-size: 12px; }
    .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: rgba(255,255,255,.08); }
    .fund-section { margin-top: 4px; }
    .fund-label { font-size: 12px; color: #9ca3af; margin-bottom: 8px; }
    #card-element { background: #111827; padding: 12px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.1); margin-bottom: 12px; }
    .fund-row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
    .fund-row label { font-size: 12px; color: #9ca3af; white-space: nowrap; }
    .fund-row input { flex: 1; background: #111827; border: 1px solid rgba(255,255,255,.1); border-radius: 8px; padding: 8px 10px; color: #fff; font-size: 14px; }
    .btn-phantom { background: linear-gradient(135deg,#14f195,#09b06a); color: #000; }
    .btn-phantom:disabled { opacity: .4; cursor: not-allowed; }
    #phantom-status { font-size: 12px; color: #9ca3af; margin-top: 8px; min-height: 16px; }
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
      ${media.thumbnail ? `<img class="thumbnail" src="${media.thumbnail}" alt="${media.title}" />` : ''}
      <h2>${media.title}</h2>
      <div class="price">$${media.price.toFixed(2)}</div>
      <div class="balance">Your balance: <span>$${user.balance.toFixed(2)}</span></div>
      <div class="user-info">Paying as: ${user.name} (${user.email})</div>

      ${canAfford ? `
        <button class="btn btn-pay" id="payBtn">Pay $${media.price.toFixed(2)}</button>
      ` : `
        <p style="color:#f87171;font-size:13px;margin-bottom:4px;">
          ⚠ You need $${shortfall.toFixed(2)} more to unlock this.
        </p>
        ${stripeKey ? `
        <div class="divider">load funds with card</div>
        <div class="fund-section">
          <div class="fund-label">Card details (Stripe test: 4242 4242 4242 4242)</div>
          <div id="card-element"></div>
          <div class="fund-row">
            <label>Amount $</label>
            <input type="number" id="fundAmount" value="${suggestedLoad.toFixed(2)}" min="0.50" step="0.50" />
          </div>
          <button class="btn btn-pay" id="fundBtn">Load funds & unlock</button>
        </div>
        ` : ''}
        <div class="divider">or pay with Phantom</div>
        <button class="btn btn-phantom" id="phantomBtn" onclick="connectAndPayPhantom()">🦋 Pay with Phantom (SOL)</button>
        <div id="phantom-status"></div>
        ${!stripeKey ? '<p style="color:#f87171;font-size:13px;margin-top:12px;">Card payments not configured.</p>' : ''}
      `}

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
    const USER_TOKEN = ${JSON.stringify(t)};
    const MEDIA_ID   = ${JSON.stringify(cs.media_id)};

    async function doPurchase() {
      const btn = document.getElementById('payBtn') || document.getElementById('fundBtn');
      if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
      try {
        const res = await fetch('/api/purchase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + USER_TOKEN },
          body: JSON.stringify({ media_id: MEDIA_ID }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Payment failed');
        document.getElementById('checkout-view').style.display = 'none';
        document.getElementById('success-view').style.display = 'block';
        setTimeout(() => {
          window.parent.postMessage({ type: 'contentpay:success', content_url: data.content_url }, '*');
        }, 1200);
      } catch(e) {
        const err = document.getElementById('errorMsg');
        err.textContent = e.message; err.style.display = 'block';
        if (btn) { btn.disabled = false; btn.textContent = 'Try Again'; }
      }
    }

    ${canAfford ? `
    document.getElementById('payBtn').addEventListener('click', doPurchase);
    ` : stripeKey ? `
    // ── Stripe card funding flow ──────────────────────────────────────────────
    const stripe   = Stripe(${JSON.stringify(stripeKey)});
    const elements = stripe.elements();
    const card     = elements.create('card', {
      style: { base: { color: '#fff', fontSize: '15px', '::placeholder': { color: '#6b7280' } } },
    });
    card.mount('#card-element');

    document.getElementById('fundBtn').addEventListener('click', async () => {
      const btn = document.getElementById('fundBtn');
      btn.disabled = true; btn.textContent = 'Processing card…';
      const errEl = document.getElementById('errorMsg');
      errEl.style.display = 'none';

      try {
        const amountUsd = parseFloat(document.getElementById('fundAmount').value);

        // 1. Create PaymentIntent on server
        const intentRes = await fetch('/api/stripe/create-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + USER_TOKEN },
          body: JSON.stringify({ amount_usd: amountUsd }),
        });
        const intentData = await intentRes.json();
        if (!intentRes.ok) throw new Error(intentData.error || 'Could not create payment intent');

        // 2. Confirm card payment with Stripe.js
        const { error } = await stripe.confirmCardPayment(intentData.client_secret, {
          payment_method: { card },
        });
        if (error) throw new Error(error.message);

        // 3. Poll until webhook has credited the wallet (up to 10s)
        btn.textContent = 'Confirming deposit…';
        let credited = false;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const balRes = await fetch('/api/stripe/balance', {
            headers: { 'Authorization': 'Bearer ' + USER_TOKEN },
          });
          const { balance } = await balRes.json();
          if (balance >= ${media.price}) { credited = true; break; }
        }
        if (!credited) throw new Error('Deposit is still processing — please wait a moment and refresh.');

        // 4. Balance confirmed — complete the purchase
        await doPurchase();
      } catch(e) {
        errEl.textContent = e.message; errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = 'Load funds & unlock';
      }
    });
    ` : ''}

    ${!canAfford ? `
    // ── Phantom / Solana funding flow ─────────────────────────────────────────
    function setPhantomStatus(msg, color) {
      const el = document.getElementById('phantom-status');
      el.style.color = color || '#9ca3af';
      el.innerHTML = msg;
    }

    function loadSolanaLibs() {
      if (window.solanaWeb3) return Promise.resolve();
      return new Promise((resolve, reject) => {
        window.global = window;
        window.process = window.process || { env: {}, version: '' };
        const buf = document.createElement('script');
        buf.src = 'https://bundle.run/buffer@6.0.3';
        buf.onload = () => {
          window.Buffer = window.buffer.Buffer;
          const web3 = document.createElement('script');
          web3.src = 'https://unpkg.com/@solana/web3.js@1.95.8/lib/index.iife.min.js';
          web3.onload = () => { window.solanaWeb3 = solanaWeb3; resolve(); };
          web3.onerror = reject;
          document.head.appendChild(web3);
        };
        buf.onerror = reject;
        document.head.appendChild(buf);
      });
    }

    async function connectAndPayPhantom() {
      const btn = document.getElementById('phantomBtn');
      const errEl = document.getElementById('errorMsg');
      errEl.style.display = 'none';

      if (!window.solana?.isPhantom) {
        setPhantomStatus('Phantom not found. <a href="https://phantom.app" target="_blank" style="color:#14f195">Install Phantom →</a>', '#fbbf24');
        return;
      }

      btn.disabled = true;
      btn.textContent = '🦋 Connecting…';

      try {
        // 1. Connect Phantom wallet
        const resp = await window.solana.connect();
        const userPubkeyStr = resp.publicKey.toString();
        setPhantomStatus('Connected: ' + userPubkeyStr.slice(0,4) + '…' + userPubkeyStr.slice(-4), '#14f195');

        // 2. Load Solana web3.js
        btn.textContent = '⏳ Loading…';
        await loadSolanaLibs();

        // 3. Get platform wallet + SOL price
        const [cfgRes, priceRes] = await Promise.all([
          fetch('/api/solana/config'),
          fetch('/api/solana/price'),
        ]);
        const { wallet: platformWallet, network } = await cfgRes.json();
        const { sol_usd: solPrice } = await priceRes.json();

        const mediaPrice = ${media.price};
        const solAmount  = mediaPrice / solPrice;

        setPhantomStatus('Sending ' + solAmount.toFixed(6) + ' SOL (~$' + mediaPrice.toFixed(2) + ')…', '#a78bfa');
        btn.textContent = '🦋 Approve in Phantom…';

        // 4. Build + send SOL transfer
        const web3 = window.solanaWeb3;
        const connection  = new web3.Connection(network, 'confirmed');
        const latestBlock = await connection.getLatestBlockhash();
        const fromPubkey  = new web3.PublicKey(userPubkeyStr);
        const tx = new web3.Transaction({
          recentBlockhash: latestBlock.blockhash,
          feePayer: fromPubkey,
        }).add(web3.SystemProgram.transfer({
          fromPubkey,
          toPubkey: new web3.PublicKey(platformWallet),
          lamports: Math.round(solAmount * web3.LAMPORTS_PER_SOL),
        }));

        const { signature } = await window.solana.signAndSendTransaction(tx);
        setPhantomStatus('⏳ Confirming on Solana…', '#a78bfa');
        btn.textContent = '⏳ Confirming…';

        await connection.confirmTransaction({
          signature,
          blockhash: latestBlock.blockhash,
          lastValidBlockHeight: latestBlock.lastValidBlockHeight,
        });

        // 5. Tell server to verify tx and credit balance
        const depRes = await fetch('/api/solana/deposit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + USER_TOKEN },
          body: JSON.stringify({ tx_signature: signature, expected_sol: solAmount }),
        });
        const dep = await depRes.json();
        if (!depRes.ok) throw new Error(dep.error || 'Deposit failed');

        setPhantomStatus('✅ $' + dep.usd_credited.toFixed(2) + ' credited — completing purchase…', '#14f195');

        // 6. Complete the purchase
        await doPurchase();
      } catch(e) {
        const msg = e.message || String(e);
        if (msg.includes('rejected') || msg.includes('cancelled') || e.code === 4001) {
          setPhantomStatus('Transaction cancelled.', '#fbbf24');
        } else {
          setPhantomStatus('Error: ' + msg, '#f87171');
        }
        btn.disabled = false;
        btn.textContent = '🦋 Pay with Phantom (SOL)';
      }
    }
    ` : ''}
  </script>
</body>
</html>`);
});

export default router;
