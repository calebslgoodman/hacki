import db from "./db";
import { v4 as uuidv4 } from "uuid";

const PLATFORM_FEE_RATE = 0.10; // 10%

export { PLATFORM_FEE_RATE };

function seed() {
    // Platform wallet (always first)
    const existingPlatform = db.prepare("SELECT id FROM wallets WHERE owner_type='platform'").get();
    if (!existingPlatform) {
        db.prepare("INSERT INTO wallets (id, owner_id, owner_type, balance) VALUES (?,?,?,?)").run(
            "wallet_platform", "platform", "platform", 999999
        );
        console.log("✅ Platform wallet created");
    }

    // Demo creator
    const existingCreator = db.prepare("SELECT id FROM creators WHERE id='creator_demo'").get();
    if (!existingCreator) {
        const walletId = `wallet_${uuidv4()}`;
        db.prepare("INSERT INTO wallets (id, owner_id, owner_type, balance) VALUES (?,?,?,?)").run(
            walletId, "creator_demo", "creator", 0
        );
        db.prepare(`INSERT INTO creators (id, name, email, api_key, wallet_id) VALUES (?,?,?,?,?)`).run(
            "creator_demo", "Alex Rivera", "alex@contentpay.dev", "creator_demo_key", walletId
        );
        console.log("✅ Demo creator created (api_key: creator_demo_key)");
    }

    // Demo user — balance reset to $0 on every restart so Stripe card flow is always shown
    const existingUser = db.prepare("SELECT id FROM users WHERE id='user_demo'").get();
    if (!existingUser) {
        const walletId = `wallet_${uuidv4()}`;
        db.prepare("INSERT INTO wallets (id, owner_id, owner_type, balance) VALUES (?,?,?,?)").run(
            walletId, "user_demo", "user", 0
        );
        db.prepare(`INSERT INTO users (id, name, email, api_key, wallet_id) VALUES (?,?,?,?,?)`).run(
            "user_demo", "Sam Chen", "sam@example.com", "user_demo_key", walletId
        );
        console.log("✅ Demo user created (api_key: user_demo_key, balance: $0.00)");
    } else {
        db.prepare("UPDATE wallets SET balance = 0 WHERE owner_id = 'user_demo'").run();
        console.log("✅ Demo user balance reset to $0.00");
    }

    // Demo media — flat pricing
    const existingMedia = db.prepare("SELECT id FROM media WHERE id='media_demo'").get();
    if (!existingMedia) {
        db.prepare(`INSERT INTO media (id, creator_id, title, description, price, content_url, thumbnail) VALUES (?,?,?,?,?,?,?)`).run(
            "media_demo",
            "creator_demo",
            "Neon Horizons",
            "A cyberpunk thriller set in a dystopian megacity. Unlock to watch.",
            5.00,
            "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
            "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=800&q=80"
        );
        console.log("✅ Demo media created (id: media_demo, price: $5.00 flat)");
    }

    // Demo media — pay-per-minute ($0.20/min, billed every 10s, $0.15 entry fee)
    const existingTimedMedia = db.prepare("SELECT id FROM media WHERE id='media_game'").get();
    if (!existingTimedMedia) {
        db.prepare(`INSERT INTO media
            (id, creator_id, title, description, price, price_per_minute, billing_interval_seconds, initial_payment, content_url, thumbnail)
            VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run(
            "media_game",
            "creator_demo",
            "Neon Runner",
            "An infinite runner — pay while you play. $0.15 entry + $0.20/min billed every 10s.",
            0,
            0.20,
            10,
            0.15,
            "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
            "https://images.unsplash.com/photo-1511512578047-dfb367046420?w=800&q=80"
        );
        console.log("✅ Timed media created (id: media_game, $0.15 entry + $0.20/min billed every 10s)");
    } else {
        // Keep demo data in sync with current values
        db.prepare(`UPDATE media SET price_per_minute=?, billing_interval_seconds=?, initial_payment=?, description=? WHERE id='media_game'`)
          .run(0.20, 10, 0.15, "An infinite runner — pay while you play. $0.15 entry + $0.20/min billed every 10s.");
    }

    // Baseball premium content (for calebgoodman.com integration demo)
    const existingBaseballMedia = db.prepare("SELECT id FROM media WHERE id='media_baseball'").get();
    if (!existingBaseballMedia) {
        db.prepare(`INSERT INTO media (id, creator_id, title, description, price, content_url, thumbnail) VALUES (?,?,?,?,?,?,?)`).run(
            "media_baseball",
            "creator_demo",
            "Premium Baseball Analysis",
            "Step 4 — advanced directionality methodology, full confusion matrix, and feature engineering source code.",
            0.67,
            "https://calebgoodman.com/baseball#premium",
            ""
        );
        console.log("✅ Baseball media created (id: media_baseball, price: $0.67 flat)");
    } else {
        db.prepare(`UPDATE media SET price=? WHERE id='media_baseball'`).run(0.67);
    }

    console.log("\n🚀 ContentPay API ready.");
    console.log("   Demo user:    user_demo   / api_key: user_demo_key   ($0.00 — resets on restart)");
    console.log("   Demo creator: creator_demo / api_key: creator_demo_key");
    console.log("   Demo media:   media_demo   ($5.00 flat)");
    console.log("   Timed media:  media_game   ($0.15 entry + $0.20/min, billed every 10s)");
    console.log("   Baseball:     media_baseball ($0.67 flat — calebgoodman.com demo)\n");
}

export default seed;
