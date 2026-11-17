---
status: accepted
---

# Use a Three-Step Valet Shift with Sedan and Van Footprints Measured Against Standard Stall Capacity

Each daily session runs as a 30–45 second three-step Valet Shift (two solo Warm-Up Bays mixing `2x1` sedans and `3x1` vans, followed by one official placement on the 70–80% pre-filled Live Floor), and Wasted Stalls for any placement `p` on empty-cell graph `G` is defined against exact bipartite `2x1` Standard Stall Capacity `ν(G)` relative to the minimum unavoidable footprint cost `Δ_min = min_{q in valid(G)} (ν(G) - ν(G \ q))`, yielding `wastedStalls = (ν(G) - ν(G \ p)) - Δ_min`.

A pure single-drop `2x1` placement ends in four seconds (failing Reddit's first tie-breaker, Delightful UX, on low-traffic judging subreddits) and is mathematically restricted to `ν(G) - ν(G') in {1, 2}` (`0` or `1` wasted stall, making `2+` unreachable dead code). Measuring both `2x1` sedans and `3x1` vans against polynomial-time bipartite `2x1` Standard Stall Capacity keeps server verification under `0.1 ms` (avoiding NP-hard general tile-packing search), preserves intuitive `2x1` ghost-stall repack overlays with Dead Spot hazard cones, and produces genuine `{0, 1, 2}` Wasted Stalls gradations plus Elevator Bonus tie-breaking.
