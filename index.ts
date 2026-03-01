import express from "express";
import cors from "cors";
import path from "path";
import db from "./db";
import seed from "./seed";

// Routes
import authRoutes from "./routes/auth";
import walletRoutes from "./routes/wallets";
import userRoutes from "./routes/users";
import creatorRoutes from "./routes/creators";
import mediaRoutes from "./routes/media";
import purchaseRoutes from "./routes/purchase";
import accessRoutes from "./routes/access";
import checkoutRoutes from "./routes/checkout";
import timedRoutes from "./routes/timed";
import solanaRoutes from "./routes/solana";
import stripeRoutes, { stripeWebhookHandler } from "./routes/stripe";

const app = express();
const PORT = process.env.PORT || 4000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());

// Stripe webhook MUST use raw body (before global express.json) for sig verification
app.post(
    "/api/stripe/webhook",
    express.raw({ type: "application/json" }),
    stripeWebhookHandler
);

app.use(express.json());

// Serve the SDK and demo site as static files
app.use("/sdk",  express.static(path.join(__dirname, "sdk")));
app.use("/demo", express.static(path.join(__dirname, "..", "demo")));
app.use("/",     express.static(path.join(__dirname, "..", "frontend")));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/wallets", walletRoutes);
app.use("/api/users", userRoutes);
app.use("/api/creators", creatorRoutes);
app.use("/api/media", mediaRoutes);
app.use("/api/purchase", purchaseRoutes);
app.use("/api/access", accessRoutes);
app.use("/api/checkout", checkoutRoutes);
app.use("/api/timed", timedRoutes);
app.use("/api/solana", solanaRoutes);

app.use("/api/stripe", stripeRoutes);

// The modal page is served directly (not under /api)
app.get("/modal", (req, res) => {
    // Delegate to the checkout router's modal handler
    const session = req.query.session;
    res.redirect(`/api/checkout/modal?session=${session}`);
});

// ── Health check (moved off / so static index.html serves there) ──────────────
app.get("/api", (_req, res) => {
    res.json({
        name: "ContentPay API",
        version: "1.0.0",
        endpoints: [
            "POST /api/users",
            "GET  /api/users/:id",
            "GET  /api/users/:id/purchases",
            "POST /api/auth/login",
            "POST /api/auth/logout",
            "GET  /api/wallets/:id",
            "POST /api/wallets/:id/credit",
            "POST /api/creators",
            "GET  /api/creators/:id",
            "POST /api/media",
            "GET  /api/media",
            "GET  /api/media/:id",
            "POST /api/purchase",
            "GET  /api/access?user_id=&media_id=",
            "POST /api/checkout/session",
        ],
    });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: "Endpoint not found." });
});

// ── Start ─────────────────────────────────────────────────────────────────────
seed();
app.listen(PORT, () => {
    console.log(`\n🎬 ContentPay API running at http://localhost:${PORT}`);
    console.log(`   Demo site: http://localhost:${PORT}/demo`);
    console.log(`   SDK:       http://localhost:${PORT}/sdk/contentpay.js\n`);
});
