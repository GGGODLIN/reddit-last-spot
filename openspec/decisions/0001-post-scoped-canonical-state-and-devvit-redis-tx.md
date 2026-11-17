---
status: accepted
---

# Bind Shared Lot State to Post Identity and Bypass Devvit Redis Transaction Quirks

Each interactive Reddit post owns its canonical parking state under four deterministic post-scoped keys (`meta`, `floors`, `placements`, and `lb`) with Environmental Obstacles materialized at post creation rather than keyed by current UTC date or regenerated on read, and optimistic-concurrency writes read state via the top-level Redis client before `multi()` and verify transaction commit via reply array length plus monotonic integer `revision`.

Keying by current UTC date would silently swap or wipe the board of the submitted Demo Post across UTC midnight and throughout the post-deadline judging window (`2026-12-09` to `2026-12-16`), while regenerating obstacles on read would corrupt existing placements across code updates. Furthermore, `@devvit/redis@0.15.3` deviates from its own documentation: `TxClient.get()` returns `this` instead of a stored value, `TxClient.exec()` returns `[]` instead of `null` on conflict, `TxClient` omits `bitfield`, and Devvit Redis forbids key-space `SCAN` while capping each installation at 20 concurrent transactions. Scoping four deterministic keys per post with pre-`watch` read-only fast rejection, `try/finally` `unwatch()`/`discard()`, and monotonic `revision` verification prevents ghost commits, slot leaks, and cross-day Demo Post drift at the cost of creating a new post for each new daily challenge and deduplicating cross-post streaks by calendar puzzle date.
