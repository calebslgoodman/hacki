# ContentPay API 💳
### Stripe for Content Paywalls · HackIllinois 2026

> Pay-once access to digital content — videos, PDFs, courses — backed by a simulated wallet system and a drop-in JavaScript SDK.

---

## Quick Start

```bash
cd api
npm install
npm run dev   # → http://localhost:4000
```

The server seeds demo data on first boot:
- **Demo user** `user_demo` — $50 balance
- **Demo creator** `creator_demo` — wallet at $0
- **Demo media** `media_demo` — "Neon Horizons", $5.00

**Try the demo site:** open `demo/index.html` in your browser.

---

## How It Works

```
User visits creator site → SDK calls GET /api/access
       ↓ not purchased
SDK opens payment modal (iframe)
       ↓ user clicks Pay
POST /api/purchase → debits user, credits platform + creator
       ↓ success
Modal closes, SDK fires onSuccess(contentUrl), video loads
```

**Platform takes 10%** — configurable in `api/seed.ts`.

---

## REST API Reference

Base URL: `http://localhost:4000`

### Wallets

```bash
# Get balance
curl http://localhost:4000/api/wallets/<wallet_id>

# Load funds
curl -X POST http://localhost:4000/api/wallets/<wallet_id>/credit \
  -H "Content-Type: application/json" -d '{"amount": 20}'

# Transaction history
curl http://localhost:4000/api/wallets/<wallet_id>/transactions
```

### Users

```bash
# Create user
curl -X POST http://localhost:4000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"Sam Chen","email":"sam@example.com"}'

# Get user + balance
curl http://localhost:4000/api/users/user_demo

# List purchases
curl http://localhost:4000/api/users/user_demo/purchases
```

### Creators

```bash
# Create creator
curl -X POST http://localhost:4000/api/creators \
  -H "Content-Type: application/json" \
  -d '{"name":"Alex Rivera","email":"alex@example.com"}'

# Revenue stats
curl http://localhost:4000/api/creators/creator_demo/stats

# Transaction history
curl http://localhost:4000/api/creators/creator_demo/transactions
```

### Media

```bash
# Register media (requires api_key from creator account)
curl -X POST http://localhost:4000/api/media \
  -H "Content-Type: application/json" \
  -d '{"api_key":"creator_demo_key","title":"My Course","description":"Learn stuff","price":9.99,"content_url":"https://example.com/course.mp4"}'

# List all media (supports ?creator_id= ?min_price= ?max_price= ?search= ?page= ?limit=)
curl http://localhost:4000/api/media

# Single item
curl http://localhost:4000/api/media/media_demo
```

### Purchase & Access

```bash
# Check access (SDK calls this on every page load)
curl "http://localhost:4000/api/access?user_id=user_demo&media_id=media_demo"
# → { "has_access": false, "price": 5, ... }

# Buy media
curl -X POST http://localhost:4000/api/purchase \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user_demo","media_id":"media_demo"}'
# → { "purchase_id": "...", "content_url": "...", "platform_fee": 0.50, "creator_received": 4.50 }

# Check again (idempotent on re-purchase)
curl "http://localhost:4000/api/access?user_id=user_demo&media_id=media_demo"
# → { "has_access": true, "content_url": "https://..." }

# Create checkout session (for hosted modal)
curl -X POST http://localhost:4000/api/checkout/session \
  -H "Content-Type: application/json" \
  -d '{"user_id":"user_demo","media_id":"media_demo"}'
# → { "session_id": "cs_...", "modal_url": "/api/checkout/modal?session=cs_..." }
```

---

## SDK (Creator Integration)

Embed 2 lines in any website:

```html
<script src="http://localhost:4000/sdk/contentpay.js"></script>
<script>
  ContentPay.init({ baseUrl: "http://localhost:4000" });

  ContentPay.checkAccess({
    userId: "user_demo",
    mediaId: "media_demo",
    onUnlocked: (contentUrl) => loadVideo(contentUrl),
    onLocked: ({ price }) => console.log(`Costs $${price}`),
  });

  // Open the hosted payment modal
  ContentPay.openModal({
    userId: "user_demo",
    mediaId: "media_demo",
    onSuccess: (contentUrl) => loadVideo(contentUrl),
  });
</script>
```

---

## Project Structure

```
hackillinoisproject/
├── api/
│   ├── index.ts           # Express entry point (port 4000)
│   ├── db.ts              # SQLite schema (7 tables)
│   ├── seed.ts            # Demo data + PLATFORM_FEE_RATE
│   └── routes/
│       ├── wallets.ts     # GET balance, POST credit, GET history
│       ├── users.ts       # CRUD + purchases
│       ├── creators.ts    # CRUD + stats + transactions
│       ├── media.ts       # Register + list + get
│       ├── purchase.ts    # Atomic buy with fee split
│       ├── access.ts      # Gate check → returns content_url
│       └── checkout.ts    # Session + hosted payment modal
├── sdk/
│   └── contentpay.js      # Drop-in JS SDK
└── demo/
    ├── index.html         # Creator demo site with locked video
    └── dashboard.html     # Creator earnings dashboard
```

## Error Responses

| Status | When |
|--------|------|
| `400` | Missing or invalid fields |
| `401` | Invalid creator API key |
| `402` | Insufficient wallet balance |
| `404` | Resource not found |
| `409` | Duplicate (user/email already exists) |
| `410` | Checkout session expired or used |

All errors return `{ "error": "descriptive message" }`.
