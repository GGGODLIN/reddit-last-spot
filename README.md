# Last Spot

**Last Spot** is a 30–45 second shared community valet parking puzzle built on [Reddit Devvit Web v0.15](https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_overview) (`@devvit/web@0.15.3`, React 19, Tailwind CSS 4, Hono serverless, Devvit Redis) for [Reddit's Game of the Day Hackathon 2026](https://redditgameofday2026.devpost.com/).

Every daily post opens a shared underground garage floor pre-seeded to 50–70% obstacle density (`6–10` open standard stalls on a `6x6` mobile-safe grid). Instead of playing a solitary puzzle with a detached leaderboard, every driver parks their official daily vehicle directly onto the post's shared **Live Floor**—leaving concrete parked silhouettes, callsign plates, and preset window notes for everyone who arrives next.

### Live Hackathon Links

- **Live Playable Demo Post**: [Last Spot — Daily Valet Shift (`r/last_spot_valet_dev2`)](https://www.reddit.com/r/last_spot_valet_dev2/comments/1xzr9mp/last_spot_daily_valet_shift_20261118/)
- **Playtest Subreddit (`< 200` members, `dr-admin-approve` installed)**: [r/last_spot_valet_dev2](https://www.reddit.com/r/last_spot_valet_dev2/)
- **Devvit App Directory Listing (Unpublished Playtest Build)**: [developers.reddit.com/apps/last-spot-valet](https://developers.reddit.com/apps/last-spot-valet)

---

## Gameplay Loop: The 3-Step Valet Shift

1. **Feed-Safe Inline `Splash` Preview (`splash.html`)**
   - Renders the active floor badge (`B1`), stall occupancy thumbnail, remaining standard-stall count, and a single **Start Valet Shift** button synchronously from `context.postData` with **`0` `/api/*` network calls on mount**.
   - Preserves `touch-action: pan-y` to prevent feed scroll traps and launches expanded mode synchronously via `requestExpandedMode(event.nativeEvent, 'game')`.
2. **Warm-Up Bay 1 (`2x1` Sedan) & Warm-Up Bay 2 (`3x1` Van)**
   - Two deterministic 10–15 second solo bays calibrate spatial intuition across `{0, 1}` and `{0, 1, 2}` **Wasted Stalls** before the player touches the shared community floor.
3. **Step 3 — Shared `Live Floor` Official Lock**
   - **Two-Step Anti-Fat-Finger Controls**: Tap any open cell (`>= 44x44px` at `288px` mobile width, zero internal scrollbars) to preview, tap again or press **Rotate 90°** to toggle orientation, and press **Park & Lock Spot** to commit.
   - **Exact Standard Stall Capacity (`ν(G)`) & Visual Proof**: An `Int32Array` augmenting-path bipartite solver computes exact remaining `2x1` domino capacity `ν(G)` in `< 0.1 ms`. Immediately after locking a spot, a `0.8s` **Ghost-Stall Repack** overlay draws dashed `2x1` frames over surviving stalls and places orange hazard cones on any newly isolated **Dead Spots**—explaining the score visually without requiring graph theory.
   - **Elevator Bonus**: Placements with `0` Wasted Stalls earn a Manhattan-distance bonus (`+2` per step saved toward the `ELEV` bay).
   - **Last Spot Hero & Overflow Floors (`B1 [Full] / B2 [Live]`)**: Claiming the final available stall (`ν(G') === 0`) crowns the player **Last Spot Hero** on `B1`, seals `B1` as an inspectable Archived Floor, and atomically opens `B2` (`<= 50` floors) in the same Redis transaction so latecomers and judges always have a playable Live Floor.
   - **Logged-Out `VISITOR_HOLD` Handoff**: Logged-out visitors and incognito judges play all three steps against the real Live Floor snapshot, view a full `VISITOR_HOLD` result drawer, and can tap **Sign in to Lock Spot** to persist `{ postId, floorNumber, cells }` in `localStorage` before `showLoginPrompt()` and promote their spot upon reload.
   - **Spoiler-Safe Stickied Battle Reports**: Players preview a coordinate-free Battle Report with optional preset window notes and reply under the post's single stickied `Daily Lot Log` comment (`hSetNX`-deduplicated, with automatic lock release and clipboard/share-sheet fallback on rate limits).

---

## Architecture & Devvit Web v0.15 Safeguards

Domain terminology and architectural trade-offs are documented in [openspec/glossary.md](/openspec/glossary.md), [ADR-0001 (Post-Scoped Canonical State & Devvit Redis Transactions)](/openspec/decisions/0001-post-scoped-canonical-state-and-devvit-redis-tx.md), and [ADR-0002 (Three-Step Valet Shift & Standard Stall Capacity Loss)](/openspec/decisions/0002-three-step-valet-shift-and-standard-stall-capacity-loss.md).

- **`src/shared/domain/` — Zero-SDK-Dependency Domain Engine**: Pure TypeScript implementation of seeded obstacle generation (`seedrandom`), `Int32Array` bipartite `2x1` capacity solving, `wastedStalls = (ν(G) - ν(G \ p)) - Δ_min` evaluation, and UTC calendar-deduplicated streaks—shared identically across Hono server transactions and React client previews.
- **`src/server/lib/redis-tx.ts` — Safe Devvit Redis Optimistic Concurrency**: In `@devvit/redis@0.15.3`, `TxClient.get()` returns `this` (never the value) and `TxClient.exec()` returns `[]` (never `null`) on watched-key contention. `runAtomicRedisTransaction` performs pre-`multi` reads via top-level `redis`, enforces `try / finally` `unwatch()` + `discard()` so none of the installation's 20 transaction slots leak, and verifies `Array.isArray(rawReplies) && rawReplies.length === expectedCmdCount` alongside monotonic integer `revision` increments (`409 SPOT_TAKEN` vs `409 LOT_UPDATED_RETRY_PREVIEW`).
- **`src/server/lib/lot-store.ts` & `src/server/app.ts` — Post-Scoped Four-Key Isolation**: Every post isolates mutable state strictly under `s1:post:{postId}:{meta,floors,placements,lb}` (`< 256` byte `postData`), paired with a 5-second non-personalized `GET /api/lot-summary` cache, an Express-free Hono Journeys telemetry adapter (`/api/telemetry/journey`), `nx`-locked daily cron creation (`/internal/scheduler/daily-post`), single-post reset (`/internal/menu/ops-reset-lot` & `onPostDelete`), and 3-minute moderator invariant verification (`/internal/menu/ops-health` -> `ops.health_receipt`).
- **`src/client/` — Dual-Entrypoint Tactile Garage UI**: 100% locally bundled CSS and SVG silhouettes (`splash.tsx`, `game.tsx`, `ParkingBoard.tsx`, `ShiftResult.tsx`) with zero external font/CDN imports and zero platform mascot/trademark assets.

---

## Local Setup, Verification & Playtest Deployment

### Prerequisites

- Node.js `>= 24.0.0`
- Authenticated personal Reddit developer account (`npx devvit login`)

### Install, Typecheck, Test & Build

```bash
npm ci
npm run test:types
npm test
npm run build
```

The automated Vitest + `fast-check` suite exercises both public seams:
- **Seam 1 (`src/server/__tests__/`)**: Manifest-to-Hono route bijection, transaction conflict injection, Conditional Property-Based Testing (`P1..P5`) against an independent recursive backtracking domino-packing oracle, stickied Battle Report deduplication/fallback, Express-free server bundle verification, and isolated single-post resets.
- **Seam 2 (`src/client/__tests__/`)**: Zero-fetch inline `Splash` mount & `touch-action: pan-y`, 3-step shift progression, two-step preview/rotate/confirm lock, Dead Spot cone rendering, `B1/B2` floor tab switching, `VISITOR_HOLD` `localStorage` promotion/recovery, and Battle Report preview confirmation.

### Upload & Install to a `< 200`-Member Public Test Subreddit

> **Hackathon Compliance Note**: Never run `devvit publish` prior to the end of hackathon judging. Deploy exclusively via `devvit upload` and `devvit install` on a `< 200`-member public test subreddit.

```bash
npx devvit upload
npx devvit install <your-test-subreddit>
npx devvit logs <your-test-subreddit>
```

Once installed, open the test subreddit moderator menu and click **Create Last Spot Post** to publish a live playable post with its stickied `Daily Lot Log` comment, and click **Last Spot Ops Health** to emit a structured `ops.health_receipt` verification log.

---

## License

Licensed under the [Apache License 2.0](/LICENSE).
