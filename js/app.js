/* app.js — main thread: load data, drive the worker, render UI, persist results. */

const STORAGE_KEY = "wc2026.results.v1";
const ITERATIONS = 10000;
const ROUND_LABELS = { R32: "Round of 32", R16: "Round of 16", QF: "Quarter-final", SF: "Semi-final", F: "Final", win: "Champion" };

let DATA = null;          // { groups, bracket, teamsByCode }
let RESULTS = {};         // fixed real results, keyed by match id
let worker = null;
let SLOTS_FULL = {};      // per-knockout-match { home:[...], away:[...] } distributions
let SLOTS = {};           // per-knockout-match top-occupant view
let bracketMode = "likely"; // "likely" (single occupant) | "super" (superposition)
// Superposition depth per round: show up to `cap` candidates, each ≥ `floor`
// appearance probability — whichever is more restrictive. Deeper rounds spread
// their probability across more teams, so they get a larger cap; the floor keeps
// the long tail of <5% teams out so the list stays readable.
const SUPER_FLOOR = 0.05;
const SUPER_CAP = { round32: 4, round16: 5, quarterfinals: 6, semifinals: 6, final: 6 };

/* ---- load + persistence ---- */
async function loadData() {
  const [teamsRaw, bracket, thirdsAlloc] = await Promise.all([
    fetch("data/teams.json").then(r => r.json()),
    fetch("data/bracket.json").then(r => r.json()),
    fetch("data/thirds-allocation.json").then(r => r.json()),
  ]);
  const groups = {};
  const teamsByCode = {};
  for (const t of teamsRaw.teams) {
    (groups[t.group] ||= []).push(t);
    teamsByCode[t.code] = t;
  }
  DATA = {
    groups, bracket, teamsByCode, snapshot: teamsRaw.snapshot,
    thirdsAllocation: thirdsAlloc.table,
  };
}

function loadResults() {
  try { RESULTS = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
  catch { RESULTS = {}; }
}
function saveResults() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(RESULTS));
}

/* ---- worker ---- */
function runSim() {
  return new Promise((resolve) => {
    if (!worker) worker = new Worker("js/sim.js");
    worker.onmessage = (e) => resolve(e.data);
    worker.postMessage({
      data: { groups: DATA.groups, bracket: DATA.bracket, thirdsAllocation: DATA.thirdsAllocation },
      iterations: ITERATIONS,
      fixedResults: RESULTS,
      seed: 2026,
    });
  });
}

/* ---- match-level prediction (for expanded view + upset detection) ----
 * These mirror sim.js's model so the modal's displayed W/D/L and scoreline match
 * what the simulation actually does. Keep these constants in sync with sim.js. */
const RATING_SCALE = 480;
const BASE_GOALS = 1.45, GOAL_UP = 1.05, GOAL_DOWN = 0.75;
const DISP_BASE = 5, DISP_PIVOT = 1600, DISP_SLOPE = 0.01, DISP_MIN = 2.5, DISP_MAX = 9;
function winExpectancy(rh, ra) { return 1 / (Math.pow(10, -(rh - ra) / RATING_SCALE) + 1); }
function lambdasFromW(W) {
  const s = (W - 0.5) * 2;
  return [Math.max(0.18, BASE_GOALS + GOAL_UP * s), Math.max(0.18, BASE_GOALS - GOAL_DOWN * s)];
}
/* Level-dependent dispersion (see sim.js): weaker matchups are more volatile. */
function dispersionFor(rh, ra) {
  const r = DISP_BASE + ((rh + ra) / 2 - DISP_PIVOT) * DISP_SLOPE;
  return Math.max(DISP_MIN, Math.min(DISP_MAX, r));
}

/* Analytic negative-binomial pmf with mean `lambda` and dispersion `r`, matching
 * the gamma-Poisson sampler in sim.js. Uses a log-gamma for the binomial term. */
function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function goalPmf(lambda, k, r) {
  const logC = logGamma(k + r) - logGamma(r) - logGamma(k + 1);
  return Math.exp(logC + r * Math.log(r / (r + lambda)) + k * Math.log(lambda / (r + lambda)));
}

/* W/D/L derived exactly from the two goal distributions (joint grid), so it
 * agrees with the simulation by construction rather than via an approximation. */
function wdl(rh, ra) {
  const [lh, la] = lambdasFromW(winExpectancy(rh, ra));
  const r = dispersionFor(rh, ra);
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= 12; h++) {
    const ph = goalPmf(lh, h, r);
    for (let a = 0; a <= 12; a++) {
      const p = ph * goalPmf(la, a, r);
      if (h > a) home += p; else if (h === a) draw += p; else away += p;
    }
  }
  return { home, draw, away };
}

function predictedOutcome(teamH, teamA) {
  const p = wdl(teamH.rating, teamA.rating);
  if (p.home >= p.draw && p.home >= p.away) return "home";
  if (p.away >= p.draw && p.away >= p.home) return "away";
  return "draw";
}
/* Most likely *joint* scoreline: the single (h,a) cell with the highest
 * probability over the two independent Poissons. (The mode of each marginal
 * taken separately is the wrong statistic — it collapses every match into
 * 0/1 goals per side. The joint argmax lets lopsided matches show 2-0, 3-0, etc.)
 * Returns the scoreline, its probability, and the expected goals (lambdas). */
function likelyScoreline(teamH, teamA) {
  const [lh, la] = lambdasFromW(winExpectancy(teamH.rating, teamA.rating));
  const r = dispersionFor(teamH.rating, teamA.rating);
  let best = { home: 0, away: 0 }, bestP = -1;
  for (let h = 0; h <= 8; h++) {
    const ph = goalPmf(lh, h, r);
    for (let a = 0; a <= 8; a++) {
      const p = ph * goalPmf(la, a, r);
      if (p > bestP) { bestP = p; best = { home: h, away: a }; }
    }
  }
  return { home: best.home, away: best.away, p: bestP, lh, la };
}

/* ---- rendering ---- */
const fmtPct = (x) => (x * 100).toFixed(1) + "%";

/* Expected standings per group (ranked by xPts, then xGD, then xGF —
 * mirroring the real tiebreakers, applied to expected values). */
function expectedStandings(letter, probs) {
  return DATA.groups[letter].slice().sort((a, b) => {
    const pa = probs[a.code] || {}, pb = probs[b.code] || {};
    return (pb.xPts || 0) - (pa.xPts || 0) ||
           (pb.xGD || 0) - (pa.xGD || 0) ||
           (pb.xGF || 0) - (pa.xGF || 0);
  });
}

/* The 8 groups whose 3rd-placed team is projected to make the best-8 cut.
 * Returns a Set of group letters. The cut ranks each group's expected-3rd team
 * across all groups by the same expected tiebreakers FIFA uses. */
function bestThirdGroups(probs) {
  const thirds = Object.keys(DATA.groups).map((letter) => {
    const third = expectedStandings(letter, probs)[2];
    const p = probs[third.code] || {};
    return { letter, xPts: p.xPts || 0, xGD: p.xGD || 0, xGF: p.xGF || 0 };
  });
  thirds.sort((a, b) => b.xPts - a.xPts || b.xGD - a.xGD || b.xGF - a.xGF);
  return new Set(thirds.slice(0, 8).map((t) => t.letter));
}

function renderGroups(probs) {
  const host = document.getElementById("groups");
  host.innerHTML = "";
  const thirdAdvances = bestThirdGroups(probs);
  for (const letter of Object.keys(DATA.groups).sort()) {
    const teams = expectedStandings(letter, probs);
    const card = document.createElement("div");
    card.className = "group-card";
    card.innerHTML = `<h3>Group ${letter}</h3>`;
    const table = document.createElement("table");
    table.innerHTML =
      `<thead><tr><th>Team</th><th title="Expected points">xPts</th>` +
      `<th title="Expected goal difference">xGD</th>` +
      `<th title="Chance of advancing to the knockout stage">Adv%</th></tr></thead>`;
    const tb = document.createElement("tbody");
    teams.forEach((t, i) => {
      const p = probs[t.code] || {};
      const gd = p.xGD || 0;
      // i 0,1 = expected top two (advance); i 2 = expected third (advances only
      // if this group's third makes the projected best-8 cut)
      const qual = i < 2 ? "q-top2"
                 : (i === 2 && thirdAdvances.has(letter)) ? "q-third" : "";
      const tr = document.createElement("tr");
      if (qual) tr.className = qual;
      tr.innerHTML =
        `<td class="team"><span class="flag">${t.flag}</span>${t.name}</td>` +
        `<td>${(p.xPts || 0).toFixed(1)}</td>` +
        `<td class="${gd >= 0 ? "pos" : "neg"}">${gd >= 0 ? "+" : ""}${gd.toFixed(1)}</td>` +
        `<td>${fmtPct(p.advance || 0)}</td>`;
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    card.appendChild(table);
    host.appendChild(card);
  }
}

function renderOdds(probs) {
  const host = document.getElementById("odds");
  host.innerHTML = "<h3>Title odds</h3>";
  const ranked = Object.entries(probs).sort((a, b) => b[1].win - a[1].win);
  const list = document.createElement("div");
  list.className = "odds-list";
  for (const [code, p] of ranked) {
    if (p.win < 0.001) continue;
    const t = DATA.teamsByCode[code];
    const row = document.createElement("div");
    row.className = "odds-row";
    row.innerHTML =
      `<span class="flag">${t.flag}</span><span class="oname">${t.name}</span>` +
      `<span class="obar"><span class="ofill" style="width:${Math.min(100, p.win * 100 * 4)}%"></span></span>` +
      `<span class="oval">${fmtPct(p.win)}</span>`;
    list.appendChild(row);
  }
  host.appendChild(list);
}

/* Group fixtures, for result entry. Mirrors RR_PAIRS order in sim.js. */
const RR_PAIRS = [[0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2]];
function renderFixtures() {
  const host = document.getElementById("fixtures");
  host.innerHTML = "<h3>Group results — set real scores</h3>";
  for (const letter of Object.keys(DATA.groups).sort()) {
    const teams = DATA.groups[letter];
    const block = document.createElement("div");
    block.className = "fix-group";
    block.innerHTML = `<h4>Group ${letter}</h4>`;
    RR_PAIRS.forEach(([hi, ai], m) => {
      const id = letter + (m + 1);
      const h = teams[hi], a = teams[ai];
      const r = RESULTS[id] || {};
      const p = wdl(h.rating, a.rating);
      const pred = p.home >= p.draw && p.home >= p.away ? "home"
                 : p.away >= p.draw && p.away >= p.home ? "away" : "draw";
      const isReal = Number.isFinite(r.home) && Number.isFinite(r.away);
      let upset = false;
      if (isReal) {
        const actual = r.home > r.away ? "home" : r.home < r.away ? "away" : "draw";
        // A true reversal: the predicted winner lost outright.
        const reversal = (pred === "home" && actual === "away") ||
                         (pred === "away" && actual === "home");
        // A draw against a heavy (>50%) favorite: the underdog beat the odds.
        const heldFavorite = actual === "draw" && (p.home > 0.5 || p.away > 0.5);
        upset = reversal || heldFavorite;
      }
      const row = document.createElement("div");
      row.className = "fixture" + (upset ? " upset" : "");
      // The 5 aligned columns live in an inner grid; the upset badge is a sibling
      // of that grid (not a grid child), so it can never alter column widths.
      row.innerHTML =
        `<div class="fixture-grid">` +
          `<span class="fteam home clickable" data-detail="${id}" title="Match detail">${h.flag} ${h.name}</span>` +
          `<input type="number" min="0" class="score" data-id="${id}" data-side="home" value="${isReal ? r.home : ""}">` +
          `<span class="dash">–</span>` +
          `<input type="number" min="0" class="score" data-id="${id}" data-side="away" value="${isReal ? r.away : ""}">` +
          `<span class="fteam away clickable" data-detail="${id}" title="Match detail">${a.name} ${a.flag}</span>` +
        `</div>` +
        (upset ? `<span class="upset-tag" title="Result beats the model's prediction">⚡ upset</span>` : "");
      row._teams = [h, a, id];
      block.appendChild(row);
    });
    host.appendChild(block);
  }
  host.querySelectorAll("input.score").forEach(inp => {
    inp.addEventListener("change", onScoreChange);
  });
  host.querySelectorAll(".fteam.clickable").forEach(el => {
    el.addEventListener("click", () => {
      const row = el.closest(".fixture");
      const [h, a, id] = row._teams;
      openGroupModal(id, h, a);
    });
  });
}

function onScoreChange(e) {
  const id = e.target.dataset.id;
  const side = e.target.dataset.side;
  const val = e.target.value === "" ? null : parseInt(e.target.value, 10);
  RESULTS[id] = RESULTS[id] || {};
  if (val === null || Number.isNaN(val)) {
    delete RESULTS[id][side];
    if (RESULTS[id].home == null && RESULTS[id].away == null) delete RESULTS[id];
  } else {
    RESULTS[id][side] = val;
  }
  saveResults();
  refresh();
}

/* ---- knockout bracket ---- */
/* Human-readable label for a slot reference, used as a fallback before a
 * match has any simulated occupant (shouldn't happen, but safe). */
function slotRefLabel(ref) {
  if (typeof ref === "string") {
    if (ref[0] === "1") return "Winner " + ref[1];
    if (ref[0] === "2") return "Runner-up " + ref[1];
    if (ref[0] === "W") return "Winner of #" + ref.slice(1);
    if (ref[0] === "L") return "Loser of #" + ref.slice(1);
  } else if (ref && ref.third) {
    return "3rd: " + ref.third.join("/");
  }
  return "?";
}

/* One slot line inside a match box. occ = { code, p } from sim, or null. */
function slotLine(occ, ref, fixedWinnerCode) {
  const div = document.createElement("div");
  div.className = "bslot";
  if (occ && occ.code) {
    const t = DATA.teamsByCode[occ.code];
    const isWinner = fixedWinnerCode && occ.code === fixedWinnerCode;
    if (isWinner) div.classList.add("advancing");
    div.innerHTML =
      `<span class="flag">${t.flag}</span>` +
      `<span class="bteam">${t.name}</span>` +
      `<span class="bp">${(occ.p * 100).toFixed(0)}%</span>`;
  } else {
    div.innerHTML = `<span class="bteam placeholder">${slotRefLabel(ref)}</span>`;
  }
  return div;
}

/* A superposition slot: lists candidates above SUPER_FLOOR, up to `cap`, e.g.
 * France 47% / Senegal 22% / Norway 14%. dist is a [{code,p}] array. */
function superSlotLine(dist, ref, cap) {
  const div = document.createElement("div");
  div.className = "bslot bslot-super";
  const shown = (dist || []).filter((d) => d.p >= SUPER_FLOOR).slice(0, cap);
  if (!shown.length) {
    div.innerHTML = `<span class="bteam placeholder">${slotRefLabel(ref)}</span>`;
    return div;
  }
  div.innerHTML = shown
    .map((d) => {
      const t = DATA.teamsByCode[d.code];
      return `<span class="bcand"><span class="flag">${t.flag}</span>` +
        `<span class="bcand-name">${t.name}</span>` +
        `<span class="bp">${(d.p * 100).toFixed(0)}%</span></span>`;
    })
    .join("");
  return div;
}

function matchBox(m, slots, roundKey) {
  const s = slots[m.match] || {};
  const box = document.createElement("div");
  box.className = "bmatch";
  box.dataset.match = m.match;
  if (bracketMode === "super") {
    const full = SLOTS_FULL[m.match] || {};
    const cap = SUPER_CAP[roundKey] || 4;
    box.classList.add("bmatch-super");
    box.appendChild(superSlotLine(full.home, m.home, cap));
    box.appendChild(superSlotLine(full.away, m.away, cap));
  } else {
    const winnerCode = s.winner ? s.winner.code : null;
    box.appendChild(slotLine(s.home, m.home, winnerCode));
    box.appendChild(slotLine(s.away, m.away, winnerCode));
  }
  box.title = "Click for match detail";
  box.addEventListener("click", () => openKnockoutModal(m));
  return box;
}

/* ---- match detail modal ---- */
function teamChip(code, extra) {
  const t = DATA.teamsByCode[code];
  return `<span class="flag">${t.flag}</span><span class="cname">${t.name}</span>` + (extra || "");
}

function modalShell(titleHtml, bodyEl) {
  closeModal();
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "modal-overlay";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<div class="modal-head"><h3>${titleHtml}</h3>` +
    `<button class="modal-close" aria-label="Close">✕</button></div>`;
  modal.appendChild(bodyEl);
  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  modal.querySelector(".modal-close").addEventListener("click", closeModal);
  document.body.appendChild(overlay);
}
function closeModal() {
  const ex = document.getElementById("modal-overlay");
  if (ex) ex.remove();
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

/* W/D/L bar for a fixed pairing. */
function wdlBar(teamH, teamA) {
  const p = wdl(teamH.rating, teamA.rating);
  return `<div class="wdl">
      <span class="wdl-seg w" style="width:${p.home * 100}%" title="${teamH.name} win">${(p.home * 100).toFixed(0)}%</span>
      <span class="wdl-seg d" style="width:${p.draw * 100}%" title="Draw">${(p.draw * 100).toFixed(0)}%</span>
      <span class="wdl-seg l" style="width:${p.away * 100}%" title="${teamA.name} win">${(p.away * 100).toFixed(0)}%</span>
    </div>`;
}

/* Knockout modal: two superposed sides; click a team to collapse that side and
 * see its expected result vs each likely opponent on the other side. */
function openKnockoutModal(m) {
  const full = SLOTS_FULL[m.match];
  if (!full || (!full.home.length && !full.away.length)) return;
  const body = document.createElement("div");
  body.className = "modal-body";

  const state = { picked: null, side: null }; // collapsed selection

  const render = () => {
    if (!state.picked) {
      // superposition view: both sides' top-3 with appear% and win-this-match%
      body.innerHTML =
        `<p class="modal-hint">Most likely teams in each slot. Click one to see its expected result against the other side.</p>` +
        `<div class="ko-sides">${sideColumn("home", full.home.slice(0, 3))}${sideColumn("away", full.away.slice(0, 3))}</div>`;
      body.querySelectorAll(".ko-team").forEach(el =>
        el.addEventListener("click", () => {
          state.picked = el.dataset.code; state.side = el.dataset.side; render();
        }));
    } else {
      // collapsed: picked team vs each opponent on the other side
      const oppSide = state.side === "home" ? "away" : "home";
      const opponents = full[oppSide].slice(0, 3);
      const picked = DATA.teamsByCode[state.picked];
      const rows = opponents.map(o => {
        const opp = DATA.teamsByCode[o.code];
        // orient the W/D/L from the picked team's perspective
        const [H, A] = state.side === "home" ? [picked, opp] : [opp, picked];
        return `<div class="ko-vs-row">
            <div class="ko-vs-opp">${teamChip(o.code, `<span class="ko-app">appears ${(o.p * 100).toFixed(0)}%</span>`)}</div>
            ${wdlBar(H, A)}
          </div>`;
      }).join("");
      body.innerHTML =
        `<button class="ko-back">← back to both slots</button>` +
        `<div class="ko-picked">${teamChip(state.picked)} <span class="ko-side-tag">${state.side} slot</span></div>` +
        `<p class="modal-hint">Expected result vs each likely opponent (bar oriented as ${picked.name} win / draw / opponent win):</p>` +
        rows;
      body.querySelector(".ko-back").addEventListener("click", () => {
        state.picked = null; state.side = null; render();
      });
    }
  };

  const sideColumn = (side, dist) => {
    const label = side === "home" ? "Home slot" : "Away slot";
    const items = dist.map(d =>
      `<div class="ko-team" data-code="${d.code}" data-side="${side}">
         ${teamChip(d.code)}
         <span class="ko-stats"><span class="ko-app">${(d.p * 100).toFixed(0)}%</span>
         <span class="ko-win" title="Aggregated chance to win this match">win ${(d.win * 100).toFixed(0)}%</span></span>
       </div>`).join("");
    return `<div class="ko-side"><div class="ko-side-label">${label}</div>${items}</div>`;
  };

  render();
  modalShell(`Match #${m.match} — knockout detail`, body);
}

/* Group modal: two fixed teams, W/D/L + most likely scoreline. */
function openGroupModal(id, teamH, teamA) {
  const body = document.createElement("div");
  body.className = "modal-body";
  const real = RESULTS[id];
  const isReal = real && Number.isFinite(real.home) && Number.isFinite(real.away);
  const sl = likelyScoreline(teamH, teamA);
  body.innerHTML =
    `<div class="gm-teams">${teamChip(teamH.code)} <span class="dash">vs</span> ${teamChip(teamA.code)}</div>` +
    wdlBar(teamH, teamA) +
    `<div class="gm-xg">Expected goals <strong>${sl.lh.toFixed(1)} – ${sl.la.toFixed(1)}</strong></div>` +
    `<p class="modal-hint">Most likely exact scoreline ${sl.home}–${sl.away} ` +
    `(only ${(sl.p * 100).toFixed(0)}% — football scores are spread out, so no single line dominates).` +
    (isReal ? ` <span class="gm-real">Actual: ${real.home}–${real.away}</span>` : "") + `</p>`;
  modalShell(`Group match ${id}`, body);
}

const ROUND_COLUMNS = [
  { key: "round32", label: "Round of 32" },
  { key: "round16", label: "Round of 16" },
  { key: "quarterfinals", label: "Quarter-finals" },
  { key: "semifinals", label: "Semi-finals" },
  { key: "final", label: "Final" },
];

function renderBracket(slots) {
  const host = document.getElementById("bracket");
  host.innerHTML = "";
  const head = document.createElement("div");
  head.className = "bracket-head";
  const desc = bracketMode === "super"
    ? `Superposition — the likeliest teams for each slot (more shown in deeper rounds, where the field is wider)`
    : "Most likely occupant of each slot";
  head.innerHTML =
    `<h3>Knockout bracket</h3><span class="bracket-sub">${desc}</span>` +
    `<div class="bracket-toggle">` +
      `<button class="${bracketMode === "likely" ? "on" : ""}" data-mode="likely">Most likely</button>` +
      `<button class="${bracketMode === "super" ? "on" : ""}" data-mode="super">Superposition</button>` +
    `</div>`;
  head.querySelectorAll(".bracket-toggle button").forEach((b) =>
    b.addEventListener("click", () => {
      if (bracketMode === b.dataset.mode) return;
      bracketMode = b.dataset.mode;
      renderBracket(slots); // re-render in place, no re-sim needed
    }));
  host.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "bracket-grid" + (bracketMode === "super" ? " super" : "");
  for (const col of ROUND_COLUMNS) {
    const colEl = document.createElement("div");
    colEl.className = "bcol";
    colEl.innerHTML = `<div class="bcol-head">${col.label}</div>`;
    const matches = col.key === "final" ? [DATA.bracket.final] : DATA.bracket[col.key];
    for (const m of matches) colEl.appendChild(matchBox(m, slots, col.key));
    grid.appendChild(colEl);
  }
  host.appendChild(grid);
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  document.getElementById("status").textContent = "Simulating…";
  const { probabilities, iterations, slots, slotsFull } = await runSim();
  SLOTS_FULL = slotsFull || {};
  SLOTS = slots || {};
  renderGroups(probabilities);
  renderOdds(probabilities);
  renderBracket(slots);
  renderFixtures();
  document.getElementById("status").textContent =
    `${iterations.toLocaleString()} simulations · ${DATA.snapshot}`;
  refreshing = false;
}

async function main() {
  await loadData();
  loadResults();
  document.getElementById("reset").addEventListener("click", () => {
    RESULTS = {}; saveResults(); refresh();
  });
  await refresh();
}

main();
