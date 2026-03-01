# SolStream — Decentralized Pay-Per-View Media POC

> **Hackathon POC**: A minimal, end-to-end proof of concept where users pay SOL to unlock and stream decentralized media — built on Solana Devnet with Anchor and Next.js.

---

## 1. Tech Stack

| Layer | Technology |
|---|---|
| Blockchain | Solana (Devnet) |
| Smart Contracts | Anchor (Rust) |
| Frontend | Next.js 14 (App Router) + Tailwind CSS |
| Wallet | Solana Wallet Adapter (Phantom / Solflare) |
| Video Hosting | Livepeer (streaming) or Arweave (permanent CID) |
| Video Player | Video.js |

---

## 2. Anchor Program

### 2.1 Accounts & Data Structures

```rust
// Global content registry — one PDA per content item
#[account]
pub struct ContentRecord {
    pub title: String,           // e.g. "Episode 1: Pilot"
    pub price_lamports: u64,     // price in lamports (e.g. 10_000_000 = 0.01 SOL)
    pub media_cid: String,       // Livepeer playback ID or Arweave CID
    pub streamer: Pubkey,        // wallet that receives payments
    pub content_id: u64,         // unique numeric ID
    pub bump: u8,
}

// Per-user access record — one PDA per (user, content_id) pair
#[account]
pub struct UserAccess {
    pub owner: Pubkey,
    pub content_id: u64,
    pub purchased_at: i64,       // Unix timestamp
    pub bump: u8,
}
```

### 2.2 Instructions

| Instruction | Signer | Description |
|---|---|---|
| `initialize_content(title, price_lamports, media_cid)` | Streamer | Creates a `ContentRecord` PDA. Seeds: `[b"content", content_id]` |
| `purchase_content(content_id)` | User (buyer) | Transfers SOL from user → streamer vault; creates `UserAccess` PDA. Seeds: `[b"access", user_pubkey, content_id]` |
| `validate_access(content_id)` | Anyone | Read-only account fetch — returns whether `UserAccess` PDA exists for caller |

### 2.3 Transfer Logic
- Use `system_program::transfer` for native SOL payments.
- No SPL token for the POC — keep it simple.
- The streamer's wallet is the direct recipient (no escrow needed for the POC).

---

## 3. Frontend Flow

### 3.1 Pages & Components

```
/app
  page.tsx          — Library grid (Netflix-style)
  /watch/[id]
    page.tsx        — Single content page with access guard + video player
/components
  ContentCard.tsx   — Thumbnail, title, price, "Unlock" button
  VideoPlayer.tsx   — Video.js wrapper, only mounts if access confirmed
  WalletButton.tsx  — Wallet connect/disconnect
/hooks
  useContentList.ts — Fetches all ContentRecord PDAs from the program
  useHasAccess.ts   — Derives UserAccess PDA and checks if it exists on-chain
  usePurchase.ts    — Builds + sends purchase_content transaction
```

### 3.2 Key UX Flow

1. User connects wallet (Phantom / Solflare).
2. Library page fetches all `ContentRecord` accounts and renders cards.
3. User clicks **"Unlock"** on a card → `purchase_content` TX fires.
4. After TX confirms, `useHasAccess` returns `true`.
5. `VideoPlayer` mounts and begins streaming the Livepeer/Arweave asset.

---

## 4. Design — Dark Cinema Theme

- Background: deep charcoal (`#0a0a0f`)
- Accent: electric violet (`#7c3aed`) with gold hover (`#f59e0b`)
- Cards: glassmorphism panels with subtle glow on hover
- Typography: `Inter` (body) + `Cinzel` (headings)
- Animations: framer-motion card entrance + purchase success confetti

---

## 5. POC Scope (What to Skip)

- ❌ No subscription model — single one-time purchase per content item
- ❌ No time-gated expiry on `UserAccess`
- ❌ No USDC payments (SOL only)
- ❌ No admin dashboard for adding new content (hardcode 3-4 sample items)
- ❌ No Blinks integration (optional stretch goal only)

---

## 6. Step-by-Step Build Order

1. **`anchor init solstream`** — scaffold the Anchor workspace.
2. Define `ContentRecord` and `UserAccess` structs in `state.rs`.
3. Implement `initialize_content` → write a test to create a content item.
4. Implement `purchase_content` → write a test to simulate a purchase.
5. Deploy program to Devnet: `anchor deploy --provider.cluster devnet`.
6. **`npx create-next-app@latest frontend`** — scaffold the Next.js app.
7. Install: `@solana/web3.js`, `@solana/wallet-adapter-*`, `@project-serum/anchor`, `video.js`, `framer-motion`.
8. Build `useContentList` hook — deserialize program accounts.
9. Build `useHasAccess` hook — derive PDA and check existence.
10. Build `usePurchase` hook — construct and send TX.
11. Assemble Library and Watch pages with the Cinema theme.
12. Wire up Video.js only when access is confirmed.