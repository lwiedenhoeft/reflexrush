# ⚡ ReflexRush

A competitive, browser-based reaction game with pixel-art aesthetics and addictive mechanics. Press the green stimulus as fast as possible — avoid red and yellow decoys. Climb levels, beat your own record, and dominate the weekly leaderboard.

**Live:** deployed via Vercel (auto-deploy on push to `main`)
**Backend:** Supabase (PostgreSQL leaderboard with weekly resets)

---

## Gameplay

- A colored stimulus appears on screen — **only press on green**
- Red stimuli are decoys: ignore them (they don't count toward your round total)
- You get **5 rounds per level**
- Each level is faster and may introduce new distractions
- Your **level reached** is the primary score; average reaction time is shown at the end as a tiebreaker
- Individual reaction times are hidden to keep flow — only your average is revealed

### Level Progression

| Level | Name | Display Time |
|-------|------|-------------|
| 1 | AUFWAERMEN | 1200 ms |
| 2 | WARM | 1000 ms |
| 3 | FLOTT | 850 ms |
| 4 | SCHARF | 700 ms |
| 5 | BLITZ | 600 ms |
| 6 | REFLEX | 500 ms |
| 7 | PROFI | 420 ms |
| 8 | JENSEITS | 350 ms |
| 9+ | Auto-scaling | −20 ms per level (min 250 ms) |

To add a new level, append one object to the `LEVELS` array in `lib/levels.ts`.

### Liga System

| Liga | Avg. Reaction Time |
|------|--------------------|
| 🏆 PRO | < 180 ms |
| 🥇 GOLD | 180 – 220 ms |
| 🥈 SILBER | 220 – 300 ms |
| 🥉 BRONZE | 300 – 400 ms |
| 🎮 ROOKIE | > 400 ms |

---

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Language:** TypeScript
- **Styling:** CSS custom properties + `clamp()` for responsive sizing, Press Start 2P font
- **Audio:** Web Audio API (no external library)
- **Backend:** Supabase (PostgreSQL)
- **Hosting:** Vercel
- **CI:** GitHub Actions (type-check + build on push/PR to `main`)

---

## Local Development

### Prerequisites

- Node.js 20+
- A Supabase project (see setup below)

### 1. Clone and install

```bash
git clone https://github.com/your-username/reflexrush.git
cd reflexrush
npm install
```

### 2. Set up environment variables

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and fill in your Supabase credentials:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

### 3. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

> **Note:** The game works without Supabase credentials — the leaderboard will simply be disabled. Set `reactStrictMode: false` is intentional (it prevents double-firing of game timers in development).

---

## Supabase Setup

### Option A — Supabase CLI (recommended)

This approach lets you manage the schema via version-controlled migrations.

#### 1. Install the Supabase CLI

```bash
# macOS
brew install supabase/tap/supabase

# npm (all platforms)
npm install -g supabase

# verify
supabase --version
```

#### 2. Log in and link your project

```bash
supabase login
# Opens browser for OAuth — paste the token when prompted

supabase link --project-ref your-project-ref
# Find your project ref in: Supabase Dashboard → Project Settings → General
```

#### 3. Apply the schema

```bash
supabase db push --db-url "postgresql://postgres:[YOUR-PASSWORD]@db.your-project.supabase.co:5432/postgres"
```

Or run the SQL file directly:

```bash
supabase db execute --file supabase-schema.sql \
  --db-url "postgresql://postgres:[YOUR-PASSWORD]@db.your-project.supabase.co:5432/postgres"
```

#### 4. Verify

```bash
supabase db diff  # should show no pending changes
```

---

### Option B — Supabase Dashboard (manual)

1. Go to your Supabase project → **SQL Editor**
2. Paste the contents of `supabase-schema.sql`
3. Click **Run**

---

### Upgrading an existing schema

If you deployed an earlier version without the `max_level` column, run this migration:

```sql
ALTER TABLE scores ADD COLUMN max_level INTEGER NOT NULL DEFAULT 1;
DROP INDEX IF EXISTS idx_scores_week_leaderboard;
CREATE INDEX idx_scores_week_leaderboard
  ON scores (week_start, max_level DESC, average_ms ASC);
```

---

## Vercel Deployment

The repo is connected to a Vercel project — every push to `main` auto-deploys.

Add the following environment variables in **Vercel → Project Settings → Environment Variables**:

| Variable | Value |
|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Your Supabase anon key |

---

## GitHub Actions CI

The pipeline (`.github/workflows/deploy.yml`) runs on every push and pull request to `main`:

1. **Type-check** — `tsc --noEmit`
2. **Build** — `npm run build`

Add the same two Supabase variables as **repository secrets** in **GitHub → Settings → Secrets and variables → Actions**:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

---

## Project Structure

```
reflexrush/
├── app/
│   ├── globals.css        # CSS variables, animations, pixel-art styles
│   ├── layout.tsx         # Root layout
│   └── page.tsx           # Game logic and UI (single-page app)
├── lib/
│   ├── levels.ts          # Level configs — edit here to add/tune levels
│   ├── leagues.ts         # Liga thresholds + localStorage persistence
│   └── supabase.ts        # Supabase client + leaderboard queries
├── supabase-schema.sql    # Database schema
├── .env.local.example     # Environment variable template
├── .github/
│   └── workflows/
│       └── deploy.yml     # CI pipeline
├── next.config.js
└── tsconfig.json
```

---

## Psychological Mechanics

| Mechanic | Implementation |
|----------|---------------|
| **Quantifiable self-efficacy** | Liga badge + level shown prominently; personal delta vs. best score |
| **Social comparison** | "Du hast [Name] überholt!" banner on leaderboard submission |
| **Tiered micro-goals** | Liga system (ROOKIE → PRO) with ms-to-next displayed |
| **Loss aversion** | Rank-loss alert on app start if your position dropped since last visit |
| **Near-miss** | Highlighted near-misses at level boundaries to encourage one-more-try |
| **Instant respawn** | No result screen — auto-advances in 250–400 ms after each reaction |
| **Flow state** | Individual times hidden; only average revealed at end |
| **Micro-feedback** | "!" / "!!" / "!!!" flash feedback scaled to reaction speed |
