/**
 * ContentPay SDK v1.1.0
 *
 * Security model:
 *  - The user authenticates ONCE with ContentPay.login() using their own api_key.
 *  - The resulting token is stored in sessionStorage on the ContentPay domain
 *    context — creator JavaScript CANNOT read it (different origin in iframe).
 *  - All API calls (checkAccess, openModal) use this token.
 *  - Creators never have access to user tokens, so they cannot charge users
 *    without explicit user consent in the payment modal.
 *
 * Usage:
 *   ContentPay.init({ baseUrl: "http://localhost:4000" });
 *
 *   // User logs in once (e.g. on your auth page)
 *   await ContentPay.login("user_demo_key");
 *
 *   // Check access on every page load
 *   ContentPay.checkAccess({
 *     mediaId: "media_demo",
 *     onUnlocked: (url) => loadVideo(url),
 *     onLocked: ({ price, title }) => showPaywallBtn(price),
 *   });
 */

(function (global) {
    "use strict";

    const STORAGE_KEY = "contentpay_token";
    let _config = { baseUrl: "http://localhost:4000" };
    const _timedIntervals = new Map(); // sessionId → intervalHandle

    // ── Token storage (sessionStorage so it clears on tab close) ──────────────
    function getToken() {
        try { return sessionStorage.getItem(STORAGE_KEY); } catch { return null; }
    }
    function setToken(t) {
        try { sessionStorage.setItem(STORAGE_KEY, t); } catch { }
    }
    function clearToken() {
        try { sessionStorage.removeItem(STORAGE_KEY); } catch { }
    }

    // ── Internal helpers ───────────────────────────────────────────────────────
    async function apiFetch(path, opts = {}) {
        const token = getToken();
        const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const res = await fetch(`${_config.baseUrl}${path}`, { ...opts, headers });
        return { res, data: await res.json() };
    }

    // ── Public API ─────────────────────────────────────────────────────────────
    const ContentPay = {
        /** Initialize with the ContentPay API base URL. */
        init(options = {}) {
            _config = { ..._config, ...options };
        },

        /** Returns true if the user is currently logged in. */
        isLoggedIn() {
            return !!getToken();
        },

        /**
         * Authenticate the user with their personal api_key.
         * Call this on YOUR platform's login page — never on the creator's site.
         *
         * @param {string} apiKey - The user's ContentPay api_key
         * @returns {Promise<{user_id, name, expires_at}>}
         */
        async login(apiKey) {
            const { res, data } = await apiFetch("/api/auth/login", {
                method: "POST",
                body: JSON.stringify({ api_key: apiKey }),
            });
            if (!res.ok) throw new Error(data.error || "Login failed.");
            setToken(data.token);
            return { user_id: data.user_id, name: data.name, expires_at: data.expires_at };
        },

        /** Log the user out and clear the session token. */
        async logout() {
            await apiFetch("/api/auth/logout", { method: "POST" });
            clearToken();
        },

        /**
         * Check whether the current user has purchased a media item.
         * Uses the stored Bearer token — no user_id exposed to creator JS.
         *
         * @param {Object} opts
         * @param {string} opts.mediaId
         * @param {Function} opts.onUnlocked  - Called with (contentUrl) if access granted
         * @param {Function} opts.onLocked    - Called with ({price, title}) if not purchased
         * @param {Function} [opts.onError]   - Called with (error) on failure
         */
        async checkAccess({ mediaId, onUnlocked, onLocked, onError }) {
            if (!getToken()) {
                onError && onError(new Error("Not logged in. Call ContentPay.login(apiKey) first."));
                return;
            }
            try {
                const { res, data } = await apiFetch(`/api/access?media_id=${mediaId}`);
                if (!res.ok) throw new Error(data.error || "Access check failed.");
                if (data.has_access) onUnlocked && onUnlocked(data.content_url);
                else onLocked && onLocked({
                    price:                    data.price,
                    pricePerMinute:           data.price_per_minute,
                    billingIntervalSeconds:   data.billing_interval_seconds,
                    title:                    data.media_title,
                    thumbnail:                data.thumbnail,
                });
            } catch (err) {
                console.error("[ContentPay] checkAccess error:", err);
                onError && onError(err);
            }
        },

        /**
         * Start a pay-per-minute timed session for the given media.
         * Fires a heartbeat on the server every `billing_interval_seconds`
         * (returned from the server on start) to debit the wallet.
         *
         * @param {Object}   opts
         * @param {string}   opts.mediaId
         * @param {Function} opts.onTick      - Called each heartbeat with { balance, chargedThisTick, totalCharged, sessionDurationSeconds }
         * @param {Function} opts.onExpired   - Called when wallet is empty and session ends
         * @param {Function} [opts.onError]   - Called on network/auth errors
         * @returns {Promise<{ sessionId, contentUrl, stop }>}
         */
        async startTimedSession({ mediaId, onTick, onExpired, onError }) {
            if (!getToken()) {
                const err = new Error("Not logged in. Call ContentPay.login(apiKey) first.");
                onError && onError(err);
                throw err;
            }
            const { res, data } = await apiFetch("/api/timed/start", {
                method: "POST",
                body: JSON.stringify({ media_id: mediaId }),
            });
            if (!res.ok) {
                const err = new Error(data.error || "Could not start timed session.");
                onError && onError(err);
                throw err;
            }

            const { session_id, content_url, billing_interval_seconds } = data;
            const intervalMs = (billing_interval_seconds ?? 10) * 1000;

            const handle = setInterval(async () => {
                try {
                    const { res: hbRes, data: hbData } = await apiFetch("/api/timed/heartbeat", {
                        method: "POST",
                        body: JSON.stringify({ session_id }),
                    });
                    if (!hbRes.ok) throw new Error(hbData.error || "Heartbeat failed.");

                    if (!hbData.active) {
                        clearInterval(handle);
                        _timedIntervals.delete(session_id);
                        onExpired && onExpired();
                    } else {
                        onTick && onTick({
                            balance:                hbData.balance,
                            chargedThisTick:        hbData.charged_this_tick,
                            totalCharged:           hbData.total_charged,
                            sessionDurationSeconds: hbData.session_duration_seconds,
                        });
                    }
                } catch (err) {
                    console.error("[ContentPay] heartbeat error:", err);
                    onError && onError(err);
                }
            }, intervalMs);

            _timedIntervals.set(session_id, handle);

            return {
                sessionId:  session_id,
                contentUrl: content_url,
                stop: () => this.endTimedSession(session_id),
            };
        },

        /**
         * End a timed session and stop billing.
         * @param {string} sessionId
         */
        async endTimedSession(sessionId) {
            if (_timedIntervals.has(sessionId)) {
                clearInterval(_timedIntervals.get(sessionId));
                _timedIntervals.delete(sessionId);
            }
            try {
                await apiFetch("/api/timed/end", {
                    method: "POST",
                    body: JSON.stringify({ session_id: sessionId }),
                });
            } catch (err) {
                console.error("[ContentPay] endTimedSession error:", err);
            }
        },

        /**
         * Open the hosted ContentPay payment modal (iframe).
         * The modal runs on OUR domain — creator JS cannot read inside it.
         * Payment only happens when the USER clicks "Pay Now" inside the modal.
         *
         * @param {Object} opts
         * @param {string} opts.mediaId
         * @param {Function} opts.onSuccess - Called with (contentUrl) after payment
         * @param {Function} [opts.onClose] - Called when user cancels
         */
        async openModal({ mediaId, onSuccess, onClose }) {
            if (!getToken()) {
                console.error("[ContentPay] User must be logged in before opening modal.");
                return;
            }
            try {
                // Create a server-side session that carries the user token — creator never sees it
                const { res, data } = await apiFetch("/api/checkout/session", {
                    method: "POST",
                    body: JSON.stringify({ media_id: mediaId }),
                });
                if (!res.ok) throw new Error(data.error || "Could not create session.");

                // Build overlay + iframe (runs on ContentPay domain — creator JS blocked by CORS)
                const overlay = document.createElement("div");
                Object.assign(overlay.style, {
                    position: "fixed", inset: "0", background: "rgba(0,0,0,0.75)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    zIndex: "99999", backdropFilter: "blur(4px)",
                });

                const iframe = document.createElement("iframe");
                Object.assign(iframe.style, {
                    width: "420px", maxWidth: "95vw", height: "520px",
                    border: "none", borderRadius: "20px", boxShadow: "0 25px 60px rgba(0,0,0,.6)",
                });
                iframe.src = `${_config.baseUrl}${data.modal_url}`;

                overlay.appendChild(iframe);
                document.body.appendChild(overlay);

                const close = () => {
                    if (document.body.contains(overlay)) document.body.removeChild(overlay);
                };

                const handleMessage = (event) => {
                    if (event.origin !== _config.baseUrl) return; // strict origin check
                    if (event.data?.type === "contentpay:success") {
                        close(); window.removeEventListener("message", handleMessage);
                        onSuccess && onSuccess(event.data.content_url);
                    } else if (event.data?.type === "contentpay:cancel") {
                        close(); window.removeEventListener("message", handleMessage);
                        onClose && onClose();
                    }
                };
                window.addEventListener("message", handleMessage);
                overlay.addEventListener("click", (e) => {
                    if (e.target === overlay) {
                        close(); window.removeEventListener("message", handleMessage);
                        onClose && onClose();
                    }
                });
            } catch (err) {
                console.error("[ContentPay] openModal error:", err);
            }
        },

        // ── Solana ─────────────────────────────────────────────────────────────

        /** Returns the connected Phantom wallet address, or null if not connected. */
        getWalletAddress() {
            return window.solana?.publicKey?.toString() ?? null;
        },

        /**
         * Connect the user's Phantom wallet and link it to their ContentPay account.
         * @returns {Promise<string>} The connected wallet address
         */
        async connectWallet() {
            if (!window.solana?.isPhantom) {
                throw new Error("Phantom wallet not found. Install it at https://phantom.app");
            }
            const resp = await window.solana.connect();
            const walletAddress = resp.publicKey.toString();
            if (getToken()) {
                try {
                    await apiFetch("/api/solana/connect", {
                        method: "POST",
                        body: JSON.stringify({ wallet_address: walletAddress }),
                    });
                } catch {}
            }
            return walletAddress;
        },

        /**
         * Send SOL from the user's Phantom wallet to the ContentPay platform,
         * then credit the USD equivalent to their internal balance.
         *
         * Requires window.solanaWeb3 — load @solana/web3.js CDN script before calling.
         *
         * @param {number} amountSOL
         * @returns {Promise<{ usd_credited, new_balance, sol_received, sol_price }>}
         */
        async fundWithSOL(amountSOL) {
            if (!window.solanaWeb3) throw new Error("@solana/web3.js not loaded.");
            if (!window.solana?.publicKey) throw new Error("Wallet not connected. Call ContentPay.connectWallet() first.");
            if (!getToken()) throw new Error("Not logged in. Call ContentPay.login(apiKey) first.");

            const web3 = window.solanaWeb3;
            const { data: config } = await apiFetch("/api/solana/config");
            const solConnection = new web3.Connection(config.network, "confirmed");
            const { blockhash } = await solConnection.getLatestBlockhash();

            const tx = new web3.Transaction({
                recentBlockhash: blockhash,
                feePayer: window.solana.publicKey,
            }).add(
                web3.SystemProgram.transfer({
                    fromPubkey: window.solana.publicKey,
                    toPubkey:   new web3.PublicKey(config.wallet),
                    lamports:   Math.round(amountSOL * web3.LAMPORTS_PER_SOL),
                })
            );

            const { signature } = await window.solana.signAndSendTransaction(tx);
            await solConnection.confirmTransaction(signature, "confirmed");

            const { res, data } = await apiFetch("/api/solana/deposit", {
                method: "POST",
                body: JSON.stringify({ tx_signature: signature, expected_sol: amountSOL }),
            });
            if (!res.ok) throw new Error(data.error || "Deposit verification failed.");
            return data;
        },
    };

    global.ContentPay = ContentPay;
})(window);
