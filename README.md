# World Cup 2026 — Bracket Estimates

An interactive, fully static HTML5 viewer that forecasts the 2026 FIFA World Cup
from FIFA ratings, and lets you enter real match results to update the model as
the tournament unfolds. No backend, no build step — open `index.html` through any
static file server.

## Running

The app fetches JSON and spawns a Web Worker, so it needs to be served over
HTTP (not opened as a `file://`). Any static server works:

```sh
python3 -m http.server 8765
# then open http://localhost:8765
```

## How the model works

**Per match.** The FIFA rating difference `d` gives a win-expectancy on the
0–1 points scale, following the FIFA formula but with a steeper scale:

```
W = 1 / (10^(-d / 480) + 1)
```

idea.md's formula uses `600`, which is the FIFA *ranking-points exchange* scale.
That's too flat for *match* win probability (it makes a 200-pt gap only a ~0.68
favorite, when both intuition and recent results say it should be clearer), so the
model steepens it to `480`. See **Tuning** below.

We turn `W` into two Poisson goal means and draw a scoreline. The favorite *gains*
more goals than the underdog *loses*, so the match total rises with the mismatch —
real blowouts are higher-scoring, not just skewed. Draws emerge naturally when the
two means are close (the "closeness-based" draw model). Knockout ties that finish
level are settled by a shootout weighted toward the stronger side (pulled toward
50/50). The model is calibrated to recent World Cup averages: even matches total
~2.9 goals, big favorites win ~60–70%.

**Group stage.** Each group's six matches are simulated, producing a full table
with the real FIFA tiebreakers: points → goal difference → goals scored →
head-to-head. The eight best third-placed teams across all groups are ranked the
same way to fill the Round of 32.

**Knockout.** The bracket is propagated using the 2026 slotting rules. Because we
simulate the *whole* tournament thousands of times (default 10,000), every team's
probability of reaching each round — and every champion probability — falls out of
the simulation frequencies, naturally accounting for *all* possible opponents and
the chance each pairing actually happens.

**Expected group standings.** Each group card shows, per team, the *expected*
final-table values averaged across all simulations — expected points (`xPts`) and
expected goal difference (`xGD`, also expected GF/GA are computed) — alongside the
advancement probability. These are decimals (like expected goals): e.g. a team
projected at 5.3 points / +2.1 GD. Teams are ranked by `xPts`, giving a projected
final table. (Sanity: each group's `xGD` sums to 0, and `xPts` sums to ≤18 — 18 if
no match is ever drawn, less as draws occur.)

Rows are highlighted to show the projected qualification cut-line, in two tiers:
the **top two** of each group (darker — they advance directly), and the group's
**third-placed team when it makes the projected best-8 cut** (lighter). The cut is
a genuine cross-group comparison: each group's expected-3rd team is ranked against
all 11 others by the same tiebreakers FIFA uses (xPts → xGD → xGF), and the top 8
get the highlight — so exactly 8 of the 12 thirds are marked, and a strong group's
third can advance while a weak group's third does not. The engine exposes the
underlying route probabilities per team (`pFirst`, `pSecond`, `pThirdQ`); as a
correctness check, `pThirdQ` summed over all teams equals exactly 8.

**Knockout bracket view.** The bracket is drawn as a left-to-right tree (R32 →
Final), with a two-way mode toggle:

- *Most likely* (default) — each slot shows its single most likely occupant and
  the probability that team fills it, with the projected advancer highlighted.
- *Superposition* — each slot shows its likeliest occupants as a set (e.g.
  `France 47% / Senegal 22% / Norway 14%`), an honest picture of the uncertainty.
  Depth is **per-round**: up to `SUPER_CAP` candidates (R32:4, R16:5, QF/SF/Final:6),
  each at least a flat `SUPER_FLOOR` (5%) likely — whichever is more restrictive.
  The per-round **cap** does the work of widening deeper rounds (their probability
  is spread across more teams — a final slot is fed by half the bracket). The 5%
  **floor** only actually bites in R32/R16; from the QF on, every shown candidate is
  already above 5%, so the cap alone governs depth and a lower (or per-round) floor
  would change nothing there. This mode also reconciles a subtlety in the
  single-occupant view: a team can be likely to *advance overall* yet not *lead any
  single slot* (its chances split across routes), so it can be absent from the "most
  likely" tree but present here.

Both are *marginal* views — each percentage is independently the chance that team
reaches that specific slot, so a slot's most-likely team can differ from the team
with higher overall title odds. The "most likely" mode is also the easiest way to
verify the bracket wiring against a published bracket.

As real group results are entered, both modes sharpen toward certainty: once a
group is decided, its teams' qualification routes collapse, so the superposition
candidate sets shrink and the bracket becomes a confident projection.

**Match detail (click any match).** A modal popover gives per-match detail:

- *Group matches* (click a team name in the results list) — the two fixed teams'
  win / draw / loss split and the **expected goals** for each side (the honest
  measure of dominance), plus the most likely exact scoreline as a footnote and
  the actual result if one has been entered. Note: even a lopsided match shows a
  modest "most likely scoreline" (e.g. 1–0) because football scores are diffuse —
  no single exact line is ever very probable — which is why expected goals leads.
- *Knockout matches* (click a bracket box) — the **superposition** view: the three
  most likely teams in each slot, each with its appearance probability and its
  *aggregated* chance of winning that match (summed over all possible opponents).
  Click a team on either side to **collapse** that side to that team and see its
  expected result (W/D/L) against each likely opponent on the other side — i.e.
  "if it really is France here, here's how it fares against whoever it draws."

The aggregated win chance follows idea.md's weighting: for a team in a slot,
`P(win this match) = Σ_opponents P(opponent fills the other slot) × P(beat them)`,
which already folds in the chance the team itself reaches the match.

**Real results.** Enter a scoreline for any group match and it's fixed in the
simulation (that match always plays out as entered) while everything unplayed stays
randomized. Results persist to `localStorage`. A result is flagged as an ⚡ upset
only when it's a *true reversal* — the predicted winner loses outright. Results
involving a draw (predicted or actual) are not flagged, to keep the highlighting
focused on genuinely surprising outcomes.

## Data

- `data/teams.json` — 48 teams, groups, and FIFA points (snapshot: **11 June 2026**).
- `data/bracket.json` — knockout slotting (R32 → Final).
- `data/thirds-allocation.json` — FIFA Annex C lookup: all 495 combinations of which
  8 groups produce qualifying thirds → which third plays each winner-vs-third R32
  match.
- `data/results.json` — optional seed results (empty by default).

## Bracket correctness

The full knockout structure is verified against FIFA's official 2026 regulations:

- The **16 Round-of-32 match definitions** match the regulations' match list exactly.
- The **8 best third-placed teams** are allocated via FIFA's real **Annex C table**
  (`data/thirds-allocation.json`) — keyed on the *set* of 8 groups whose thirds
  qualify, with all 495 possible combinations present (so no fallback heuristic is
  ever used). `resolveSlot()` in `js/sim.js` looks up this table per simulation.
- The **R16 / QF / SF / final / third-place** cross-links match regulations §12.7–12.11.

(Earlier versions used a greedy heuristic for the third allocation, which respected
each slot's permitted-group set but didn't reproduce FIFA's exact pairings. That is
now replaced by the official table.)

## Tuning

The constants below control match scoring. They live at the top of `js/sim.js`,
and are mirrored in `js/app.js` (for the modal's W/D/L and scoreline display) —
**keep the two copies in sync.**

- `BASE_GOALS` (1.45) — mean goals per team in an even match.
- `GOAL_UP` (1.05) — goals the favorite *gains* per unit of supremacy `(2W−1)`.
- `GOAL_DOWN` (0.75) — goals the underdog *loses* per unit of supremacy.
  Because `GOAL_UP > GOAL_DOWN`, the match total grows with the mismatch.
- `RATING_SCALE` (480) — steepness of the win-probability curve (smaller = steeper).

**Goal distribution — over-dispersed and level-dependent.** Goals are drawn from a
negative binomial (a gamma-Poisson mixture), *not* a plain Poisson, so the goal
distribution has a fatter tail (variance ≈ `mean + mean²/r`) — blowouts like 5–1
and 7–1 are plausible. The dispersion `r` is **level-dependent**: it is the one
place absolute team quality enters an otherwise purely-relative model.

- `DISP_BASE` (5) — `r` at the pivot rating.
- `DISP_PIVOT` (1600) — matchup-average rating where `r = DISP_BASE`.
- `DISP_SLOPE` (0.01) — `+r` per rating point above the pivot. **Set to 0 for a
  level-blind model** (constant dispersion).
- `DISP_MIN` / `DISP_MAX` (2.5 / 9) — clamp.

So a top-quality matchup (avg ~1760) gets `r ≈ 6.6` (more predictable), while a
low-quality one (avg ~1295) gets `r ≈ 2.5` (more chaotic — blowouts *and* shocks
both more common). This captures the well-documented "weaker teams are more
erratic" effect. It barely moves W/D/L or title odds — it mainly fattens goal
tails for weak matchups, making weak groups slightly more upset-prone over many
sims. The *shape* (weaker = more volatile) is empirically grounded; the slope and
pivot are a reasoned default, **not fitted to data**.

### Design decision: no nonlinear rating-delta weighting

We considered making a large rating gap worth *more than proportionally* more than
a small one (e.g. "600 points = more than 2× the effect of 300"). We did **not**
add this: the win-probability curve is already nonlinear and *saturating* (logistic),
so 600 points is in fact worth **less** than 2× 300 (≈1.45×) — the favorite is
already winning ~81% at 300 points and can't exceed 100%. This is the standard,
empirically-validated behavior of rating systems. The dimension where a bigger gap
*does* keep paying off — margin of victory / blowout size — is handled separately by
`GOAL_UP`/`GOAL_DOWN` and the goal dispersion, not the win curve.

Representative output (current calibration):

| Rating gap | Example | W / D / L | Expected goals |
|---|---|---|---|
| 0 | even | 38 / 24 / 38 | 1.4 – 1.4 |
| 200 | Switzerland–Qatar | 56 / 22 / 22 | 1.9 – 1.1 |
| 400 | big favorite | 67 / 18 / 15 | 2.2 – 0.9 |
| 504 | Germany–Curaçao* | 65 / 19 / 16 | 2.3 – 0.9 |

\* With the negative binomial, a favorite at xG 2.3 now scores 7+ about **2.7%** of
the time (vs 0.9% under Poisson) — so a 7–1 is uncommon but no longer a freak.

To make favorites stronger (hotter totals), raise `GOAL_UP` and/or lower
`RATING_SCALE`. To make scorelines wilder (more blowouts and shocks), lower
`GOAL_DISPERSION`. The original calibration (`BASE_GOALS` 1.30, symmetric ±1.6
split, `RATING_SCALE` 600, plain Poisson) held the total fixed *and* had too thin
a tail — a clear favorite could only reach ~1.6–1.0 and 5+ goal games were nearly
impossible.

### A note on model validation

This calibration was sanity-checked against early real results. The takeaway: the
**W/D/L odds were already well-calibrated** — entered "surprises" (Türkiye 0–2
Australia, Côte d'Ivoire 1–0 Ecuador) were both ~33% events the model had priced
correctly, not failures. The only genuine miss was the **goal tail** (Germany 7–1,
Sweden 5–1 being near-impossible), which the negative binomial addresses. Note one
case no goal-model can fix: Sweden 5–1 Tunisia happened between teams the FIFA
ratings rate as nearly equal (1510 vs 1476) — when the *input ratings* say "even"
but reality is a rout, that's a limitation of the rating snapshot, not the scoring
model.
