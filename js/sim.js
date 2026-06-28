/* sim.js — Monte Carlo tournament engine.
 *
 * Model:
 *  - Per match, the FIFA rating difference d gives a win-expectancy
 *      W = 1 / (10^(-d/600) + 1)        (idea.md)
 *    W is on the 0..1 "points" scale (1 win, 0.5 draw, 0 loss).
 *  - We convert W into two Poisson means (lambdaHome, lambdaAway) anchored to a
 *    base goals-per-team level, then draw a scoreline. Draws emerge naturally
 *    when the two lambdas are close (the "closeness-based" draw model).
 *  - The favorite GAINS more goals than the underdog loses (GOAL_UP > GOAL_DOWN),
 *    so the match total rises with the mismatch — real blowouts are higher-scoring,
 *    not just skewed. This is the standard bivariate-Poisson-style mapping used
 *    for football forecasting, calibrated to recent World Cup averages
 *    (~2.9 goals/game in even games, favorites winning ~55-70%).
 *
 * Calibration note: RATING_SCALE is 480, NOT the 600 from idea.md's formula.
 * The FIFA 600 governs ranking-points *exchange*, which is too flat for *match
 * win probability* — a 200-pt gap should make a clearer favorite than W=0.68.
 * 480 steepens the curve to match observed WC outcomes. (See README "Tuning".)
 *
 * Everything below is pure and deterministic given a seeded RNG, so the same
 * fixed (real) results always reproduce, while unplayed matches are randomized.
 */

const BASE_GOALS = 1.45;   // mean goals per team in an even WC match
const GOAL_UP = 1.05;      // goals the favorite gains per unit of (2W-1)
const GOAL_DOWN = 0.75;    // goals the underdog loses per unit of (2W-1)
const RATING_SCALE = 480;  // win-probability curve steepness (see note above)

// Negative-binomial size r: smaller = fatter goal tail (variance = mean+mean^2/r).
// This is now LEVEL-DEPENDENT: weaker matchups are more volatile (smaller r, more
// chaos/upsets), stronger matchups more predictable (larger r). This captures the
// well-documented "weak teams are more erratic" effect; the model is otherwise
// purely relative (only the rating *difference* matters), so this is the one place
// absolute quality enters. The shape (weaker = more volatile) is empirically
// grounded; the exact slope/pivot are a reasoned default, not fitted to data.
const DISP_BASE = 5;        // r at the pivot rating
const DISP_PIVOT = 1600;    // matchup-average rating where r = DISP_BASE
const DISP_SLOPE = 0.01;    // +r per rating point above the pivot (0 = level-blind)
const DISP_MIN = 2.5, DISP_MAX = 9; // clamp r to a sane range

function dispersionFor(ratingH, ratingA) {
  const avg = (ratingH + ratingA) / 2;
  const r = DISP_BASE + (avg - DISP_PIVOT) * DISP_SLOPE;
  return Math.max(DISP_MIN, Math.min(DISP_MAX, r));
}

/* ---- FIFA rating updates from real group results ----
 * FIFA's official formula: P_new = P_old + I * (W_actual - W_expected), where
 * W_expected uses FIFA's own 600-point scale (NOT the model's tuned RATING_SCALE),
 * W_actual is 1 / 0.5 / 0 for win / draw / loss, and I is the match importance.
 * Group stage (and Round of 16) use I = 50; quarter-finals onward use I = 60.
 * Ratings evolve match-by-match in matchday order, as FIFA applies them.
 * (FIFA has a minor edge case where a team isn't dropped below its pre-match
 * points after some losses; we apply the clean formula, which is exact for the
 * common win/draw/loss group cases.) */
const FIFA_RATING_SCALE = 600;
const FIFA_I_GROUP = 50;
function fifaExpectation(ratingTeam, ratingOpp) {
  return 1 / (Math.pow(10, -(ratingTeam - ratingOpp) / FIFA_RATING_SCALE) + 1);
}

/* Given the base team list and the fixed real group results, return a map
 * code -> updated rating. Teams with no played games keep their base rating. */
function updatedRatings(groups, fixedResults) {
  const cur = {}; // code -> working rating (starts at base)
  for (const teams of Object.values(groups)) for (const t of teams) cur[t.code] = t.rating;
  for (const [letter, teams] of Object.entries(groups)) {
    for (let m = 0; m < RR_PAIRS.length; m++) {
      const id = letter + (m + 1);
      const res = fixedResults[id];
      if (!res || !Number.isFinite(res.home) || !Number.isFinite(res.away)) continue;
      const [hi, ai] = RR_PAIRS[m];
      const hCode = teams[hi].code, aCode = teams[ai].code;
      const rh = cur[hCode], ra = cur[aCode];
      const wh = res.home > res.away ? 1 : res.home < res.away ? 0 : 0.5;
      const wa = 1 - wh;
      cur[hCode] = rh + FIFA_I_GROUP * (wh - fifaExpectation(rh, ra));
      cur[aCode] = ra + FIFA_I_GROUP * (wa - fifaExpectation(ra, rh));
    }
  }
  return cur;
}

/* ---- RNG: mulberry32, seedable for reproducibility ---- */
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Win-expectancy from rating difference (idea.md formula). */
function winExpectancy(ratingHome, ratingAway) {
  const d = ratingHome - ratingAway;
  return 1 / (Math.pow(10, -d / RATING_SCALE) + 1);
}

/* Map win-expectancy W -> (lambdaHome, lambdaAway).
 * s = 2W-1 in [-1, 1] is the signed supremacy. The favorite gains GOAL_UP*s
 * while the underdog loses only GOAL_DOWN*s, so the total rises with |s|. */
function lambdasFromW(W) {
  const s = (W - 0.5) * 2;
  let lh = BASE_GOALS + GOAL_UP * s;
  let la = BASE_GOALS - GOAL_DOWN * s;
  return [Math.max(0.18, lh), Math.max(0.18, la)];
}

/* Draw a Poisson sample (Knuth) — fine for the small means used here. */
function poisson(lambda, rng) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rng(); } while (p > L);
  return k - 1;
}

/* Gamma(shape, scale=1) via Marsaglia-Tsang. Used as the mixing distribution
 * for over-dispersed (negative-binomial) goal counts. shape r > 0. */
function gamma(shape, rng) {
  if (shape < 1) {
    // boost: Gamma(shape) = Gamma(shape+1) * U^(1/shape)
    return gamma(shape + 1, rng) * Math.pow(rng() || 1e-12, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      // standard normal via Box-Muller
      const u1 = rng() || 1e-12, u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/* Negative-binomial goal count with mean `lambda` and dispersion `r`, drawn as a
 * gamma-Poisson mixture: scale the mean by a Gamma(r, 1/r) multiplier (mean 1,
 * variance 1/r), then draw Poisson. r -> infinity recovers the plain Poisson. */
function negBinomial(lambda, r, rng) {
  const mult = gamma(r, rng) / r; // Gamma(r, 1/r): mean 1, variance 1/r
  return poisson(lambda * mult, rng);
}

/* Simulate one match -> { home, away } goals.
 * If a fixed real result exists, return it unchanged. */
function simMatch(teamH, teamA, rng, fixed) {
  if (fixed && Number.isFinite(fixed.home) && Number.isFinite(fixed.away)) {
    return { home: fixed.home, away: fixed.away, real: true };
  }
  const W = winExpectancy(teamH.rating, teamA.rating);
  const [lh, la] = lambdasFromW(W);
  const r = dispersionFor(teamH.rating, teamA.rating);
  return {
    home: negBinomial(lh, r, rng),
    away: negBinomial(la, r, rng),
    real: false,
  };
}

/* Knockout: like simMatch but never a draw — settle level games with a
 * lambda-weighted shootout (slightly favors the stronger side). */
function simKnockout(teamH, teamA, rng, fixed) {
  const r = simMatch(teamH, teamA, rng, fixed);
  if (r.home !== r.away) return r;
  // A draw in regulation must be settled on penalties. If the user entered a
  // level result they must also pick the shootout winner (simMatch doesn't copy
  // it, so read it off the fixed result here); otherwise simulate the shootout.
  if (r.real && fixed && (fixed.shootoutWinner === "home" || fixed.shootoutWinner === "away")) {
    r.shootoutWinner = fixed.shootoutWinner;
    return r;
  }
  const W = winExpectancy(teamH.rating, teamA.rating);
  // pull toward 50/50 for penalties
  const pHome = 0.5 + (W - 0.5) * 0.5;
  r.shootoutWinner = rng() < pHome ? "home" : "away";
  return r;
}

/* ---- Group stage ---- */
/* Round-robin fixture order for a group of 4 (indices into the group array).
 * Produces 6 matches A1..A6. */
const RR_PAIRS = [
  [0, 1], [2, 3],  // matchday 1
  [0, 2], [1, 3],  // matchday 2
  [0, 3], [1, 2],  // matchday 3
];

function blankRow(team) {
  return { team, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, GD: 0, Pts: 0, h2h: {} };
}

function applyResult(rowH, rowA, gh, ga) {
  rowH.P++; rowA.P++;
  rowH.GF += gh; rowH.GA += ga; rowA.GF += ga; rowA.GA += gh;
  if (gh > ga) { rowH.W++; rowH.Pts += 3; rowA.L++; }
  else if (gh < ga) { rowA.W++; rowA.Pts += 3; rowH.L++; }
  else { rowH.D++; rowA.D++; rowH.Pts++; rowA.Pts++; }
  rowH.GD = rowH.GF - rowH.GA; rowA.GD = rowA.GF - rowA.GA;
  // record head-to-head points for tiebreaks
  rowH.h2h[rowA.team.code] = (rowH.h2h[rowA.team.code] || { pts: 0, gd: 0, gf: 0 });
  rowA.h2h[rowH.team.code] = (rowA.h2h[rowH.team.code] || { pts: 0, gd: 0, gf: 0 });
  rowH.h2h[rowA.team.code].gd += gh - ga; rowH.h2h[rowA.team.code].gf += gh;
  rowA.h2h[rowH.team.code].gd += ga - gh; rowA.h2h[rowH.team.code].gf += ga;
  if (gh > ga) rowH.h2h[rowA.team.code].pts += 3;
  else if (gh < ga) rowA.h2h[rowH.team.code].pts += 3;
  else { rowH.h2h[rowA.team.code].pts++; rowA.h2h[rowH.team.code].pts++; }
}

/* Sort a group table applying FIFA tiebreakers (overall, then h2h among tied). */
function rankGroup(rows) {
  const byOverall = (a, b) =>
    b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF;
  rows.sort(byOverall);
  // resolve ties via head-to-head among the tied subset
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length &&
      rows[j].Pts === rows[i].Pts && rows[j].GD === rows[i].GD && rows[j].GF === rows[i].GF) j++;
    if (j - i > 1) {
      const tied = rows.slice(i, j);
      tied.sort((a, b) => {
        const ha = a.h2h[b.team.code], hb = b.h2h[a.team.code];
        if (ha && hb) {
          if (hb.pts !== ha.pts) return hb.pts - ha.pts;
          if (hb.gd !== ha.gd) return hb.gd - ha.gd;
          if (hb.gf !== ha.gf) return hb.gf - ha.gf;
        }
        return 0; // would be disciplinary/lots; treat as stable
      });
      for (let k = 0; k < tied.length; k++) rows[i + k] = tied[k];
    }
    i = j;
  }
  return rows;
}

function simGroup(groupLetter, teams, rng, fixedResults) {
  const rows = teams.map(blankRow);
  for (let m = 0; m < RR_PAIRS.length; m++) {
    const [hi, ai] = RR_PAIRS[m];
    const id = groupLetter + (m + 1);
    const res = simMatch(teams[hi], teams[ai], rng, fixedResults[id]);
    applyResult(rows[hi], rows[ai], res.home, res.away);
  }
  rankGroup(rows);
  return rows; // index 0 = winner, 1 = runner-up, 2 = third, 3 = fourth
}

/* ---- Best 8 of 12 third-placed teams ---- */
function rankThirds(thirds) {
  // thirds: array of { row, group }
  return thirds
    .slice()
    .sort((a, b) =>
      b.row.Pts - a.row.Pts || b.row.GD - a.row.GD || b.row.GF - a.row.GF)
    .slice(0, 8);
}

/* ---- Knockout bracket ---- */
/* Resolve a slot reference ("1A", "2C", "W74", "L101", {third:[...]}) to a team.
 * Third slots use the FIFA Annex C assignment precomputed in ctx.thirdAssign
 * (keyed on match number). The greedy permitted-set walk remains only as a
 * defensive fallback if the table is missing or a key isn't found. */
function resolveSlot(slot, ctx, matchNo) {
  if (typeof slot === "string") {
    if (slot[0] === "1") return ctx.groupWinners[slot[1]];
    if (slot[0] === "2") return ctx.groupRunners[slot[1]];
    if (slot[0] === "W") return ctx.winners[slot.slice(1)];
    if (slot[0] === "L") return ctx.losers[slot.slice(1)];
  } else if (slot && slot.third) {
    if (ctx.thirdAssign[matchNo]) return ctx.thirdAssign[matchNo];
    // fallback: greedy walk of the permitted-group set
    for (const g of slot.third) {
      if (ctx.thirdByGroup[g] && !ctx.usedThirds.has(g)) {
        ctx.usedThirds.add(g);
        return ctx.thirdByGroup[g];
      }
    }
    for (const g of Object.keys(ctx.thirdByGroup)) {
      if (!ctx.usedThirds.has(g)) { ctx.usedThirds.add(g); return ctx.thirdByGroup[g]; }
    }
  }
  return null;
}

function playRound(matches, ctx, rng, fixedResults) {
  for (const m of matches) {
    const h = resolveSlot(m.home, ctx, m.match);
    const a = resolveSlot(m.away, ctx, m.match);
    if (!h || !a) continue;
    // Knockout uses post-group-stage updated ratings (ctx.koRating), while the
    // team identity (code/flag/group) is unchanged. simMatch reads `.rating`, so
    // pass rating-overridden views without mutating the shared team objects.
    const hk = ctx.koRating ? { ...h, rating: ctx.koRating[h.code] ?? h.rating } : h;
    const ak = ctx.koRating ? { ...a, rating: ctx.koRating[a.code] ?? a.rating } : a;
    const res = simKnockout(hk, ak, rng, fixedResults[m.match]);
    const homeWon = res.home > res.away ||
      (res.home === res.away && res.shootoutWinner === "home");
    ctx.winners[m.match] = homeWon ? h : a;
    ctx.losers[m.match] = homeWon ? a : h;
    // record which round each surviving team reached
    ctx.reached[ctx.winners[m.match].code] = ctx.roundIndex;
    // record who filled each slot of this match (for bracket occupancy stats)
    ctx.matchFills[m.match] = {
      home: h.code, away: a.code, winner: ctx.winners[m.match].code,
    };
  }
}

/* Run ONE full tournament. Returns per-team round reached + the champion. */
function simTournament(data, rng, fixedResults) {
  const { groups, bracket } = data;
  const groupWinners = {}, groupRunners = {}, thirds = [];
  const groupStats = {}; // code -> { Pts, GD, GF, GA } for this sim's final table

  for (const [letter, teams] of Object.entries(groups)) {
    const rows = simGroup(letter, teams, rng, fixedResults);
    groupWinners[letter] = rows[0].team;
    groupRunners[letter] = rows[1].team;
    thirds.push({ row: rows[2], group: letter });
    for (const row of rows) {
      groupStats[row.team.code] = { Pts: row.Pts, GD: row.GD, GF: row.GF, GA: row.GA };
    }
  }

  const qualifiedThirds = rankThirds(thirds);
  const thirdByGroup = {};
  for (const t of qualifiedThirds) thirdByGroup[t.group] = t.row.team;

  // FIFA Annex C: which group's 3rd-placed team plays each winner-vs-third R32
  // match is fixed by the SET of 8 groups that produced qualifying thirds.
  // thirdAssign maps matchNumber -> the team assigned to that match's third slot.
  const thirdAssign = {};
  const key = Object.keys(thirdByGroup).sort().join("");
  const row = data.thirdsAllocation && data.thirdsAllocation[key];
  if (row) {
    for (const [matchNo, group] of Object.entries(row)) {
      thirdAssign[matchNo] = thirdByGroup[group];
    }
  }

  const ctx = {
    groupWinners, groupRunners, thirdByGroup, thirdAssign,
    usedThirds: new Set(), winners: {}, losers: {},
    reached: {}, roundIndex: 0, matchFills: {},
    koRating: data.koRating, // updated ratings for the knockout stage (or undefined)
  };

  // mark group qualifiers as having reached R32 (round 0)
  for (const t of [...Object.values(groupWinners), ...Object.values(groupRunners),
                   ...Object.values(thirdByGroup)]) {
    ctx.reached[t.code] = 0;
  }

  ctx.roundIndex = 1; playRound(bracket.round32, ctx, rng, fixedResults);
  ctx.roundIndex = 2; playRound(bracket.round16, ctx, rng, fixedResults);
  ctx.roundIndex = 3; playRound(bracket.quarterfinals, ctx, rng, fixedResults);
  ctx.roundIndex = 4; playRound(bracket.semifinals, ctx, rng, fixedResults);
  ctx.roundIndex = 5; playRound([bracket.final], ctx, rng, fixedResults);

  const champion = ctx.winners[bracket.final.match];
  // per-team group finishing route this sim: 1st, 2nd, or qualified-3rd
  const finish = {};
  for (const [, t] of Object.entries(groupWinners)) finish[t.code] = "first";
  for (const [, t] of Object.entries(groupRunners)) finish[t.code] = "second";
  for (const [, t] of Object.entries(thirdByGroup)) finish[t.code] = "thirdQ";
  return {
    reached: ctx.reached,
    champion: champion ? champion.code : null,
    matchFills: ctx.matchFills,
    groupStats,
    finish,
  };
}

/* Aggregate N tournaments -> probabilities. */
function runMonteCarlo(data, iterations, fixedResults, seed) {
  const rng = makeRng(seed || 12345);
  const codes = [];
  for (const teams of Object.values(data.groups)) for (const t of teams) codes.push(t.code);

  // Compute post-group-stage updated ratings ONCE (they depend only on the fixed
  // real results, not on any random simulation) and use them for the knockout.
  const koRating = updatedRatings(data.groups, fixedResults || {});
  data = { ...data, koRating };

  // reachedCount[code][roundIndex] = times that team reached >= that round
  const reachedCount = {};
  const titleCount = {};
  for (const c of codes) { reachedCount[c] = [0, 0, 0, 0, 0, 0]; titleCount[c] = 0; }

  // slotCounts[matchId][slot][code] = times that code filled that slot
  // slot is one of "home", "away", "winner"
  // winBy[matchId][code] = times that code won this match (from either side)
  const slotCounts = {};
  const winBy = {};
  const bump = (mid, slot, code) => {
    const m = (slotCounts[mid] ||= {});
    const s = (m[slot] ||= {});
    s[code] = (s[code] || 0) + 1;
  };

  // running sums of each team's final group-table stats, for expected values
  const statSums = {};
  // finishCount[code] = { first, second, thirdQ } group-qualification route tallies
  const finishCount = {};
  for (const c of codes) {
    statSums[c] = { Pts: 0, GD: 0, GF: 0, GA: 0 };
    finishCount[c] = { first: 0, second: 0, thirdQ: 0 };
  }

  for (let i = 0; i < iterations; i++) {
    const { reached, champion, matchFills, groupStats, finish } = simTournament(data, rng, fixedResults);
    for (const c of codes) {
      const r = reached[c];
      if (r === undefined) continue;
      for (let k = 0; k <= r; k++) reachedCount[c][k]++;
    }
    if (champion) titleCount[champion]++;
    for (const [mid, f] of Object.entries(matchFills)) {
      bump(mid, "home", f.home);
      bump(mid, "away", f.away);
      bump(mid, "winner", f.winner);
      const w = (winBy[mid] ||= {});
      w[f.winner] = (w[f.winner] || 0) + 1;
    }
    for (const [code, s] of Object.entries(groupStats)) {
      const acc = statSums[code];
      acc.Pts += s.Pts; acc.GD += s.GD; acc.GF += s.GF; acc.GA += s.GA;
    }
    for (const [code, route] of Object.entries(finish)) finishCount[code][route]++;
  }

  // Helper: turn a counts map into a sorted [{ code, p }] list (descending).
  const distOf = (counts) =>
    Object.entries(counts)
      .map(([code, n]) => ({ code, p: n / iterations }))
      .sort((a, b) => b.p - a.p);

  // `slots`: compact top-occupant view (used by the bracket render).
  // `slotsFull`: per-side distribution (top few) + per-team win-this-match prob,
  //              used by the match-detail modal and the superposition bracket view.
  //              Kept at 6 so a threshold filter (e.g. >10%) has enough candidates
  //              in the busier early rounds; the modal slices this back to 3.
  const TOP_N = 6;
  const slots = {};
  const slotsFull = {};
  for (const [mid, perSlot] of Object.entries(slotCounts)) {
    slots[mid] = {};
    for (const [slot, counts] of Object.entries(perSlot)) {
      slots[mid][slot] = distOf(counts)[0] || { code: null, p: 0 };
    }
    const wins = winBy[mid] || {};
    const winProb = (code) => (wins[code] || 0) / iterations;
    const sideDist = (slot) =>
      (slotCounts[mid][slot] ? distOf(slotCounts[mid][slot]) : [])
        .slice(0, TOP_N)
        .map((d) => ({ ...d, win: winProb(d.code) }));
    slotsFull[mid] = {
      home: sideDist("home"),
      away: sideDist("away"),
    };
  }

  const out = {};
  for (const c of codes) {
    const s = statSums[c];
    out[c] = {
      // reachedCount[c][k] = times the team reached >= round-index k, where
      // index 0 = qualified from the group (Round of 32), 1 = Round of 16, etc.
      // So `advance` (qualified from group) is index 0; reaching the *next* round
      // (winning the R32 match) is index 1, and so on.
      advance: reachedCount[c][0] / iterations, // qualified from group stage
      R32: reachedCount[c][0] / iterations,     // = advance (reached the R32)
      R16: reachedCount[c][1] / iterations,     // reached the Round of 16
      QF:  reachedCount[c][2] / iterations,
      SF:  reachedCount[c][3] / iterations,
      F:   reachedCount[c][4] / iterations,
      win: titleCount[c] / iterations,
      // expected final group-table stats (decimals, like xG)
      xPts: s.Pts / iterations,
      xGD:  s.GD / iterations,
      xGF:  s.GF / iterations,
      xGA:  s.GA / iterations,
      // probability of qualifying via each group-finish route
      pFirst:  finishCount[c].first  / iterations,
      pSecond: finishCount[c].second / iterations,
      pThirdQ: finishCount[c].thirdQ / iterations,
    };
  }
  return { iterations, probabilities: out, slots, slotsFull, koRating };
}

/* ---- Worker plumbing ---- */
if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.onmessage = (e) => {
    const { data, iterations, fixedResults, seed } = e.data;
    const result = runMonteCarlo(data, iterations || 10000, fixedResults || {}, seed);
    self.postMessage(result);
  };
}

/* Allow Node/test import too. */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    winExpectancy, lambdasFromW, simGroup, rankGroup, rankThirds,
    runMonteCarlo, simTournament, makeRng,
  };
}
