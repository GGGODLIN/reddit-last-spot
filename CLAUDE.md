# reddit-last-spot

Entry repository for **Reddit's Game of the Day Hackathon 2026** (`redditgameofday2026.devpost.com`) — **Last Spot**, a shared community valet parking puzzle built on **Reddit Devvit Web v0.15**.

## Competition & Engineering Guardrails

- **No `devvit publish` during the hackathon**: Only run `devvit upload` and install/playtest inside a public test subreddit with `< 200` members (`developers.reddit.com/apps/<app-name>`). Never submit to public App Review before judging concludes.
- **No secrets, tokens, or local home paths**: Never commit `.env*`, `~/.devvit` tokens, or machine-local `/Users/...` paths; `.scratch/` stays strictly gitignored.
- **Devvit Web & Redis runtime truths (`@devvit/*@0.15.3`)**:
  - In `@devvit/redis@0.15.3`, `TxClient.get()` returns `this` (never the value) and `TxClient.exec()` returns an array (never `null`). Always read via top-level `redis` before `multi()`, guard `watch()` with `try/finally` `unwatch()`/`discard()`, and verify `Array.isArray(res) && res.length === expectedCount` plus monotonic `revision`.
  - Do not use `REDDIT` or `SNOO` trademarks/mascots as game assets (`devvit_rules`).
  - Battle-report comments must preview content before posting and reply under a single stickied post log thread rather than spamming top-level comments.
- **No content hashes in custom state**: Do not compute, store, or compare content hashes (`sha256` / `md5` / `checksum` / `digest`) in custom state or receipts; use integer revision numbers.
