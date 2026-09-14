'use strict';
/* Contexo — all game logic (vanilla JS, no deps).
 * DOM contract: header #theme-btn #howto-btn #stats-btn; nav #mode-daily #mode-practice #mode-archive;
 * #puzzle-title, #streak-line, canvas#radar, #signal-line,
 * form#guess-form > input#guess-input + button#guess-btn,
 * #hint-btn #giveup-btn #share-btn #challenge-btn #newpractice-btn, ul#guess-list, #toast,
 * modals #modal-howto #modal-stats(#stats-body) #modal-giveup(#giveup-body,#giveup-confirm-btn)
 * #modal-share(pre#share-text,#copy-share-btn).
 * Classes: .open (modals), .active (tabs), .latest (latest row), .shake (invalid input),
 * .band-1 .band-10 .band-25 .band-50 .band-100 .band-150 .band-500 .band-far.
 */

// ---------------- utils ----------------
const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function dateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function todayLocal() { return dateStr(new Date()); }
function parseDate(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function addDays(ds, n) {
  const dt = parseDate(ds);
  dt.setDate(dt.getDate() + n);
  return dateStr(dt);
}
function mondayOf(ds) {
  const dt = parseDate(ds);
  const dow = (dt.getDay() + 6) % 7; // 0 = Monday
  dt.setDate(dt.getDate() - dow);
  return dateStr(dt);
}
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function themeInk() {
  const dark = document.documentElement.dataset.theme !== 'light';
  return cssVar('--ink', dark ? '#e5e7eb' : '#111827');
}

// ---------------- storage ----------------
const store = {
  get(k, fb) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? fb : JSON.parse(v);
    } catch { return fb; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full/blocked */ }
  },
};

// ---------------- state ----------------
let puzzle = null;      // loaded puzzle JSON
let puzzleDate = null;  // YYYY-MM-DD of loaded puzzle
let mode = 'daily';     // 'daily' | 'practice' | 'archive'
let oneOff = false;     // ?d= for a non-today date (no stats/streak effect)
let state = null;       // {guesses:[{w,rank,hint?}], hints, won, gaveUp, scored?, date?}
let vocab = null;       // Set of valid words
let rankMap = new Map();// word -> rank (1..150 ranks, 151..500 tail)
let coordMap = new Map();// word -> [x, y] in [-1, 1]

function freshState() {
  return { guesses: [], hints: 0, won: false, gaveUp: false, scored: false };
}
function stateKey() {
  return mode === 'practice' ? 'contexo:practice' : `contexo:daily:${puzzleDate}`;
}
function saveState() { store.set(stateKey(), state); }
// Only a pure daily game (today's puzzle, no ?d override) touches stats/streak.
function isRealDaily() { return mode === 'daily' && !oneOff; }
// Archive replays a past daily: counts toward stats, never touches the streak.
function isArchive() { return mode === 'archive'; }

function buildLookup() {
  rankMap = new Map();
  puzzle.ranks.forEach((w, i) => rankMap.set(w, i + 1));
  (puzzle.tail || []).forEach((w, i) => rankMap.set(w, 151 + i));
  coordMap = new Map(Object.entries(puzzle.coords || {}));
}
function lookupRank(w) {
  return rankMap.has(w) ? rankMap.get(w) : null; // null => displayed "500+"
}

// ---------------- rank bands / colors / heat ----------------
function bandClass(rank) {
  if (rank === 1) return 'band-1';
  if (rank == null) return 'band-far';
  if (rank <= 10) return 'band-10';
  if (rank <= 25) return 'band-25';
  if (rank <= 50) return 'band-50';
  if (rank <= 100) return 'band-100';
  if (rank <= 150) return 'band-150';
  return 'band-500';
}
function bandColor(rank) {
  if (rank === 1) return '#ffd700';
  if (rank == null) return '#4b5563';
  if (rank <= 10) return '#22c55e';
  if (rank <= 25) return '#84cc16';
  if (rank <= 50) return '#eab308';
  if (rank <= 100) return '#f97316';
  if (rank <= 150) return '#ef4444';
  return '#9ca3af';
}
function heatEmoji(rank) {
  if (rank === 1) return '⭐';
  if (rank == null) return '⬛';
  if (rank <= 10) return '🟩';
  if (rank <= 50) return '🟨';
  if (rank <= 150) return '🟧';
  return '🟥';
}

// ---------------- toast / shake ----------------
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 2600);
}
function shakeInput() {
  const input = $('guess-input');
  input.classList.remove('shake');
  void input.offsetWidth;
  input.classList.add('shake');
}

// ---------------- modals ----------------
const MODAL_IDS = ['modal-howto', 'modal-stats', 'modal-giveup', 'modal-share', 'modal-archive'];
function openModal(m) { m.classList.add('open'); }
function closeModal(m) {
  m.classList.remove('open');
  if (m.id === 'modal-howto') store.set('contexo:seenHowTo', true);
}
function bindModals() {
  MODAL_IDS.forEach((id) => {
    const m = $(id);
    if (!m) return;
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('.modal-close') || e.target.closest('[data-close]')) {
        closeModal(m);
      }
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') MODAL_IDS.forEach((id) => { const m = $(id); if (m) closeModal(m); });
  });
}

// ---------------- fetch ----------------
async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`fetch failed: ${url} (${res.status})`);
  return res.json();
}
async function loadVocab() {
  if (vocab) return;
  try {
    const arr = await fetchJSON('data/vocab.json');
    vocab = new Set(arr);
  } catch {
    vocab = new Set(); // empty => vocab check skipped (offline fallback)
    toast('Word list unavailable — guessing unchecked');
  }
}
async function loadPuzzle(date) {
  // Offline: cache puzzle JSON in localStorage; on fetch failure use cache.
  try {
    const p = await fetchJSON(`data/puzzles/${date}.json`);
    store.set(`contexo:cache:${date}`, p);
    return p;
  } catch (e) {
    const cached = store.get(`contexo:cache:${date}`, null);
    if (cached) {
      toast('Offline — loaded cached puzzle');
      return cached;
    }
    throw e;
  }
}
async function loadIndex() {
  try {
    const idx = await fetchJSON('data/index.json');
    store.set('contexo:cache:index', idx);
    return idx;
  } catch {
    const cached = store.get('contexo:cache:index', null);
    if (cached) return cached;
    throw new Error('puzzle index unavailable');
  }
}

// ---------------- stats / streak ----------------
function getStats() {
  return store.get('contexo:stats', { played: 0, won: 0, counts: [] });
}
function getStreak() {
  const today = todayLocal();
  const mon = mondayOf(today);
  let st = store.get('contexo:streak', null);
  if (!st) st = { current: 0, best: 0, lastWonDate: null, repairsLeft: 1, lastRepairWeek: mon };
  if (st.lastRepairWeek !== mon) { // repairsLeft resets to 1 each Monday
    st.repairsLeft = 1;
    st.lastRepairWeek = mon;
    store.set('contexo:streak', st);
  }
  return st;
}
function saveStreak(st) { store.set('contexo:streak', st); }

function updateStreakWin() {
  const today = todayLocal();
  const st = getStreak();
  const y = addDays(today, -1);
  if (st.lastWonDate === y) st.current += 1;
  else if (st.lastWonDate !== today) st.current = 1;
  st.best = Math.max(st.best, st.current);
  st.lastWonDate = today;
  saveStreak(st);
}
function updateStreakLoss() {
  const st = getStreak();
  st.current = 0;
  saveStreak(st);
}
function scoreGame(wonGame) {
  const s = getStats();
  s.played += 1;
  if (wonGame) {
    s.won += 1;
    s.counts.push(state.guesses.length);
    updateStreakWin();
  } else {
    updateStreakLoss();
  }
  store.set('contexo:stats', s);
}

// Archive scoring: played/won count, but the streak is calendar-daily only
// and is never touched by archive games.
function archiveScoreGame(wonGame) {
  const s = getStats();
  s.played += 1;
  if (wonGame) {
    s.won += 1;
    s.counts.push(state.guesses.length);
  }
  store.set('contexo:stats', s);
}

// ---------------- game flow ----------------
function handleGuess(e) {
  e.preventDefault();
  if (!puzzle || !state || state.won || state.gaveUp) return;
  const input = $('guess-input');
  const w = input.value.trim().toLowerCase();
  if (!w) { shakeInput(); return; }
  if (vocab.size > 0 && !vocab.has(w)) {
    shakeInput();
    toast('Not in word list');
    return;
  }
  if (state.guesses.some((g) => g.w === w)) {
    shakeInput();
    toast('Already guessed — try another word');
    input.select();
    return;
  }
  const rank = lookupRank(w);
  state.guesses.push({ w, rank });
  input.value = '';
  input.focus();
  if (rank === 1) {
    onWin();
  } else {
    saveState();
    render();
  }
}

function onWin() {
  state.won = true;
  if (!state.scored && isRealDaily()) {
    scoreGame(true);
    state.scored = true;
  }
  if (!state.scored && isArchive()) {
    archiveScoreGame(true);
    state.scored = true;
  }
  saveState();
  render();
  toast(`🎉 Correct! The secret was “${puzzle.secret}”`);
  // The win moment is peak share intent — open the share sheet automatically.
  setTimeout(() => {
    if (!puzzle || !state || !state.won) return;
    openShare();
  }, 600);
}

function openShare() {
  if (!puzzle || !state) return;
  const text = buildShareCard();
  if (navigator.share) {
    navigator.share({ text }).catch(() => {
      $('share-text').textContent = text;
      openModal($('modal-share'));
    });
    return;
  }
  $('share-text').textContent = text;
  openModal($('modal-share'));
}

// best = min rank among guesses+hints so far, secret excluded; null ranks count as 500.
// Returns 500 when nothing scored yet.
function bestRank() {
  let best = 500;
  let hasScored = false;
  for (const g of state.guesses) {
    if (g.rank === 1) continue; // secret excluded
    hasScored = true;
    const r = g.rank == null ? 500 : g.rank;
    if (r < best) best = r;
  }
  return hasScored ? best : 500;
}

function handleHint() {
  if (!puzzle || !state || state.won || state.gaveUp) return;
  const best = bestRank();
  if (best <= 2) {
    // Never reveal rank #1 through a hint: at rank #2 the player is one
    // word away, so hints are disabled and they take the winning guess.
    toast('💡 You’re one word away — take the guess!');
    render();
    return;
  }
  const used = new Set(state.guesses.map((g) => g.w));
  let hintWord = null;
  let hintRank = null;
  const target = Math.round(best / 2);
  let bestDist = Infinity;
  // ranks[0] is the secret — never hint it. Ascending scan => ties resolve to the smaller rank.
  for (let i = 1; i < puzzle.ranks.length; i++) {
    const w = puzzle.ranks[i];
    if (used.has(w)) continue;
    const r = i + 1;
    const d = Math.abs(r - target);
    if (d < bestDist) { bestDist = d; hintWord = w; hintRank = r; }
  }
  if (!hintWord) { toast('No more hints'); return; }
  state.guesses.push({ w: hintWord, rank: hintRank, hint: true });
  state.hints += 1;
  saveState();
  render();
  toast(`💡 Hint: “${hintWord}” (#${hintRank})`);
}

function openGiveUp() {
  if (!puzzle || !state || state.won || state.gaveUp) return;
  $('giveup-body').innerHTML =
    '<p>Give up and reveal the secret? This counts as a loss and breaks your streak.</p>';
  $('giveup-confirm-btn').style.display = '';
  openModal($('modal-giveup'));
}

function doGiveUp() {
  if (!puzzle || !state || state.won || state.gaveUp) return;
  state.gaveUp = true;
  if (!state.scored && isRealDaily()) {
    scoreGame(false); // played-not-won, streak breaks
    state.scored = true;
  }
  if (!state.scored && isArchive()) {
    archiveScoreGame(false); // played-not-won, streak untouched
    state.scored = true;
  }
  saveState();
  // Reveal secret + full top-150 list inside the give-up modal.
  const items = puzzle.ranks
    .map((w, i) => `<li><span class="rank-badge ${bandClass(i + 1)}">${i === 0 ? '⭐' : i + 1}</span> ${escapeHtml(w)}</li>`)
    .join('');
  $('giveup-body').innerHTML =
    `<p class="reveal">The secret was <strong>${escapeHtml(puzzle.secret)}</strong></p>` +
    `<ol class="top150">${items}</ol>`;
  $('giveup-confirm-btn').style.display = 'none';
  render();
  toast(`The secret was “${puzzle.secret}”`);
}

// ---------------- signal ----------------
function signalOf(gc) {
  const [wx, wy] = puzzle.answer_coords;
  const d = Math.hypot(wx - gc[0], wy - gc[1]);
  return Math.round((1 - d / 2.828) * 100);
}

// ---------------- rendering ----------------
function renderTitle() {
  const n = puzzle.meta.puzzle_number;
  let t = `Contexo #${n} · ${puzzle.meta.difficulty}`;
  if (mode === 'practice') t = `Contexo #${n} · Practice`;
  else if (mode === 'archive') t = `Contexo #${n} · Archive`;
  $('puzzle-title').textContent = t;
}

function renderStreakLine() {
  const el = $('streak-line');
  const today = todayLocal();
  const st = getStreak();
  el.innerHTML = '';
  const fire = document.createElement('span');
  fire.className = 'streak-fire';
  fire.textContent = `🔥 ${st.current} streak`;
  el.appendChild(fire);
  // Repair offer: lastWonDate is the day before yesterday (one missed day) + repairs left.
  const dby = addDays(today, -2);
  // Repair offer: daily mode only (archive never touches the streak).
  if (mode === 'daily' && st.lastWonDate === dby && st.repairsLeft > 0 && state && !state.won) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'repair-btn';
    btn.textContent = `Repair streak (${st.repairsLeft} left this week)`;
    btn.addEventListener('click', () => {
      const s2 = getStreak();
      s2.lastWonDate = addDays(today, -1);
      s2.repairsLeft -= 1;
      saveStreak(s2);
      renderStreakLine();
      toast('Streak repaired — win today to keep it going 🔥');
    });
    el.appendChild(btn);
  }
}

function renderList() {
  const ul = $('guess-list');
  ul.innerHTML = '';
  if (!state.guesses.length) {
    const li = document.createElement('li');
    li.className = 'guess-empty';
    li.textContent = 'No guesses yet — try a common noun';
    ul.appendChild(li);
    return;
  }
  const sorted = [...state.guesses].sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  const latest = state.guesses[state.guesses.length - 1];
  for (const g of sorted) {
    const li = document.createElement('li');
    li.className = `guess-row ${bandClass(g.rank)}${g === latest ? ' latest' : ''}`;

    // Chronological guess number (list is sorted by rank, so order is otherwise lost).
    const num = document.createElement('span');
    num.className = 'guess-num';
    num.textContent = String(state.guesses.indexOf(g) + 1);

    const badge = document.createElement('span');
    badge.className = 'rank-badge';
    badge.textContent = g.rank === 1 ? '⭐' : (g.rank == null ? '500+' : String(g.rank));

    const word = document.createElement('span');
    word.className = 'guess-word';
    word.textContent = g.w;

    const arrow = document.createElement('span');
    arrow.className = 'guess-arrow';
    const gc = coordMap.get(g.w);
    if (gc) {
      // θ = atan2(wy - gy, wx - gx); render ➤ rotated by -θ CSS degrees (screen y is down).
      const theta = Math.atan2(
        puzzle.answer_coords[1] - gc[1],
        puzzle.answer_coords[0] - gc[0],
      );
      arrow.textContent = '➤';
      arrow.style.transform = `rotate(${-theta * 180 / Math.PI}deg)`;
      arrow.style.color = bandColor(g.rank);
    } else {
      arrow.textContent = '❄️';
    }

    const sig = document.createElement('span');
    sig.className = 'guess-signal';
    sig.textContent = gc ? `Signal ${signalOf(gc)}` : '—';

    li.append(num, badge, word, arrow, sig);
    ul.appendChild(li);
  }
}

function renderSignal() {
  const el = $('signal-line');
  // Persistent result line once the game is over (the toast vanishes in 2.6s).
  if (state.won) {
    el.textContent = `⭐ Secret was “${puzzle.secret}” — ${state.guesses.length} guesses`;
    return;
  }
  if (state.gaveUp) {
    el.textContent = `The secret was “${puzzle.secret}”`;
    return;
  }
  const last = state.guesses[state.guesses.length - 1];
  if (!last) { el.textContent = ''; return; }
  // Live progress header: best rank so far + guess count + latest signal.
  const b = bestRank();
  const bestTxt = b >= 500 ? 'Best —' : `Best #${b}`;
  const gc = coordMap.get(last.w);
  const sig = gc ? `Signal ${signalOf(gc)}` : 'Signal —';
  el.textContent = `${bestTxt} · ${state.guesses.length} guesses · ${sig}`;
}

function renderControls() {
  const over = state.won || state.gaveUp;
  // Hints are unlimited but never reveal rank #1: disabled at rank #2 (one word away).
  const oneAway = !over && bestRank() <= 2;
  const hintOff = over || oneAway;
  $('guess-input').disabled = over;
  $('guess-btn').disabled = over;
  $('hint-btn').disabled = hintOff;
  $('hint-btn').title = oneAway
    ? 'You’re one word away — take the guess!'
    : 'Get a hint word, about half as close as your best guess';
  $('giveup-btn').disabled = over;
  // No empty share cards: heat strip needs at least one guess.
  $('share-btn').disabled = state.guesses.length === 0;
  $('newpractice-btn').hidden = mode !== 'practice';
}

function renderTabs() {
  $('mode-daily').classList.toggle('active', mode === 'daily');
  $('mode-practice').classList.toggle('active', mode === 'practice');
  $('mode-archive').classList.toggle('active', mode === 'archive');
  $('mode-daily').setAttribute('aria-selected', mode === 'daily');
  $('mode-practice').setAttribute('aria-selected', mode === 'practice');
  $('mode-archive').setAttribute('aria-selected', mode === 'archive');
}

function render() {
  if (!puzzle || !state) return;
  renderTitle();
  renderStreakLine();
  renderList();
  renderSignal();
  renderControls();
  renderTabs();
}

// ---------------- stats modal ----------------
function renderStats() {
  const s = getStats();
  const st = getStreak();
  const winPct = s.played ? Math.round((s.won / s.played) * 100) : 0;
  const med = s.counts.length ? median(s.counts) : '–';
  const buckets = [
    ['1', 1, 1], ['2–10', 2, 10], ['11–25', 11, 25],
    ['26–50', 26, 50], ['51–100', 51, 100], ['101+', 101, Infinity],
  ];
  const counts = buckets.map(([, lo, hi]) => s.counts.filter((c) => c >= lo && c <= hi).length);
  const max = Math.max(1, ...counts);
  const rows = buckets.map(([label], i) => `
    <div class="dist-row"><span class="dist-label">${label}</span>` +
    `<span class="dist-bar" style="width:${Math.round((counts[i] / max) * 100)}%"></span>` +
    `<span class="dist-count">${counts[i]}</span></div>`).join('');
  $('stats-body').innerHTML = `
    <div class="stat-grid">
      <div class="stat"><span class="stat-num">${s.played}</span><span class="stat-label">Played</span></div>
      <div class="stat"><span class="stat-num">${s.won}</span><span class="stat-label">Won</span></div>
      <div class="stat"><span class="stat-num">${winPct}%</span><span class="stat-label">Win %</span></div>
      <div class="stat"><span class="stat-num">${st.current}</span><span class="stat-label">Streak</span></div>
      <div class="stat"><span class="stat-num">${st.best}</span><span class="stat-label">Best streak</span></div>
      <div class="stat"><span class="stat-num">${med}</span><span class="stat-label">Median guesses</span></div>
    </div>
    <h3>Guess distribution (wins)</h3>
    <div class="dist">${rows}</div>`;
}

// ---------------- share / challenge ----------------
function buildShareCard() {
  const n = puzzle.meta.puzzle_number;
  const st = getStreak();
  const header = state.gaveUp
    ? `Contexo #${n} · gave up`
    : mode === 'archive'
      ? `Contexo #${n} · Archive`
      : `Contexo #${n} · ${puzzle.meta.difficulty}`;
  const order = state.guesses;
  // Heat strip: one emoji per guess in guess order, capped at 30 then …+N.
  // The winning ⭐ is never cut off: if the winning guess falls past the cap,
  // it takes the 30th slot.
  let shown = order.slice(0, 30);
  if (state.won) {
    const winIdx = order.findIndex((g) => g.rank === 1);
    if (winIdx >= 30) shown = order.slice(0, 29).concat(order[winIdx]);
  }
  const emojis = shown.map((g) => heatEmoji(g.rank)).join('');
  const tail = order.length > 30 ? `…+${order.length - 30}` : '';
  return `${header}\n` +
    `🎯 ${state.guesses.length} guesses · ${state.hints} hints · 🔥 ${st.current} streak\n` +
    `${emojis}${tail}\n` +
    `contexo — guess the secret word`;
}

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* clipboard unavailable */ }
    ta.remove();
    return ok;
  }
}

// ---------------- radar ----------------
const radar = () => $('radar');
let rctx = null;

function sizeRadar() {
  const c = radar();
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth;
  if (!w) return;
  c.width = Math.round(w * dpr);
  c.height = Math.round(w * dpr);
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawRadar(now) {
  requestAnimationFrame(drawRadar);
  const c = radar();
  if (!c || !puzzle || !state) return;
  const w = c.clientWidth;
  if (!w) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr)) sizeRadar();
  const ctx = rctx;
  ctx.clearRect(0, 0, w, w);

  const pad = Math.max(46, w * 0.15);
  const cx = w / 2;
  const cy = w / 2;
  const R = w / 2 - pad;
  const ink = themeInk();
  const line = (x1, y1, x2, y2) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };
  const dot = (x, y, r, color) => {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
  };

  // subtle grid
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  for (const v of [-0.5, 0.5]) {
    line(cx + v * R, cy - R, cx + v * R, cy + R);
    line(cx - R, cy - v * R, cx + R, cy - v * R);
  }
  ctx.restore();

  // border (unit) circle
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = ink;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  // X/Y axes
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1;
  line(cx - R, cy, cx + R, cy);
  line(cx, cy - R, cx, cy + R);
  ctx.restore();

  // pole labels from puzzle axes: negative left/bottom, positive right/top
  ctx.save();
  ctx.fillStyle = ink;
  ctx.globalAlpha = 0.85;
  ctx.font = '11px system-ui, -apple-system, sans-serif';
  ctx.textBaseline = 'middle';
  const ax = puzzle.axes || [];
  if (ax[0]) {
    ctx.textAlign = 'right';
    ctx.fillText(ax[0].negative, cx - R - 6, cy);
    ctx.textAlign = 'left';
    ctx.fillText(ax[0].positive, cx + R + 6, cy);
  }
  if (ax[1]) {
    ctx.textAlign = 'center';
    ctx.fillText(ax[1].positive, cx, cy - R - 10);
    ctx.fillText(ax[1].negative, cx, cy + R + 14);
  }
  ctx.restore();

  // guess dots: px = cx + x*R, py = cy - y*R. NEVER plot the secret.
  const latest = state.guesses[state.guesses.length - 1];
  for (const g of state.guesses) {
    const gc = coordMap.get(g.w);
    if (!gc) continue;
    dot(cx + gc[0] * R, cy - gc[1] * R, g === latest ? 6 : 4.5, bandColor(g.rank));
  }

  // rank-null ("500+") guesses: small gray dots on the border circle,
  // evenly spaced angles in guess order = "off the map".
  const off = state.guesses.filter((g) => g.rank == null);
  off.forEach((g, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / off.length;
    dot(cx + R * Math.cos(a), cy + R * Math.sin(a), 3, '#4b5563');
  });

  // latest-guess pulse ring
  if (latest) {
    const lc = coordMap.get(latest.w);
    if (lc) {
      const t = (now % 1200) / 1200;
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = bandColor(latest.rank);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx + lc[0] * R, cy - lc[1] * R, 7 + t * 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ---------------- mode / puzzle loading ----------------
async function loadDaily(date) {
  mode = 'daily';
  puzzleDate = date;
  puzzle = await loadPuzzle(date);
  state = store.get(`contexo:daily:${date}`, freshState());
  buildLookup();
  render();
}

async function loadPractice(forceNew) {
  mode = 'practice';
  const today = todayLocal();
  const ps = store.get('contexo:practice', null);
  if (!forceNew && ps && ps.date && !ps.won && !ps.gaveUp) {
    // resume in-progress practice game
    puzzleDate = ps.date;
    puzzle = await loadPuzzle(puzzleDate);
    state = ps;
  } else {
    const idx = await loadIndex();
    const pool = (idx.puzzles || []).filter((d) => d !== today);
    if (!pool.length) throw new Error('No practice puzzles available');
    puzzleDate = pool[Math.floor(Math.random() * pool.length)];
    puzzle = await loadPuzzle(puzzleDate);
    state = Object.assign(freshState(), { date: puzzleDate });
    saveState();
  }
  buildLookup();
  render();
}

async function loadArchive(date) {
  // Archive replays a past daily under the SAME per-date state key, so
  // progress persists; scoring counts played/won but never the streak.
  mode = 'archive';
  oneOff = false;
  puzzleDate = date;
  puzzle = await loadPuzzle(date);
  state = store.get(`contexo:daily:${date}`, freshState());
  buildLookup();
  render();
}

function prettyDate(ds) {
  return parseDate(ds).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

function archiveStatus(ds) {
  const st = store.get(`contexo:daily:${ds}`, null);
  if (!st) return '·';
  if (st.won) return '⭐';
  if (st.gaveUp) return '🏳️';
  if (st.guesses && st.guesses.length) return `▶ ${st.guesses.length}`;
  return '·';
}

async function openArchive() {
  const list = $('archive-list');
  list.innerHTML = '<p class="fine">Loading…</p>';
  openModal($('modal-archive'));
  try {
    const idx = await loadIndex();
    const today = todayLocal();
    const dates = (idx.puzzles || []).filter((d) => d < today).sort().reverse();
    if (!dates.length) {
      list.innerHTML = '<p class="fine">No past puzzles yet — check back tomorrow.</p>';
      return;
    }
    const all = (idx.puzzles || []).slice().sort();
    list.innerHTML = '';
    for (const ds of dates) {
      const n = all.indexOf(ds) + 1; // puzzle # = position in the series
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'archive-row';
      btn.innerHTML =
        `<span class="archive-date">${escapeHtml(prettyDate(ds))}</span>` +
        `<span class="archive-num">#${n}</span>` +
        `<span class="archive-status">${escapeHtml(archiveStatus(ds))}</span>`;
      btn.addEventListener('click', async () => {
        closeModal($('modal-archive'));
        try { await loadArchive(ds); }
        catch (e) { toast(`Could not load puzzle: ${e.message}`); }
      });
      list.appendChild(btn);
    }
  } catch (e) {
    list.innerHTML = `<p class="fine">Could not load archive: ${escapeHtml(e.message)}</p>`;
  }
}

async function loadGame() {
  const params = new URLSearchParams(location.search);
  const dParam = params.get('d');
  const today = todayLocal();
  try {
    if (dParam && /^\d{4}-\d{2}-\d{2}$/.test(dParam)) {
      oneOff = dParam !== today; // one-off challenge link: no streak/stats effect
      await loadDaily(dParam);
    } else {
      oneOff = false;
      await loadDaily(today);
    }
  } catch (e) {
    $('puzzle-title').textContent = 'Contexo';
    toast(`Could not load puzzle: ${e.message}`);
  }
}

// ---------------- init ----------------
function initTheme() {
  const t = store.get('contexo:theme', 'dark');
  document.documentElement.dataset.theme = t;
  updateThemeBtn();
}
function updateThemeBtn() {
  const light = document.documentElement.dataset.theme === 'light';
  $('theme-btn').textContent = light ? '☀️' : '🌙';
  $('theme-btn').setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
}

function bindUI() {
  $('guess-form').addEventListener('submit', handleGuess);
  $('hint-btn').addEventListener('click', handleHint);
  $('giveup-btn').addEventListener('click', openGiveUp);
  $('giveup-confirm-btn').addEventListener('click', doGiveUp);

  $('share-btn').addEventListener('click', () => { openShare(); });
  $('copy-share-btn').addEventListener('click', async () => {
    const ok = await copyText($('share-text').textContent);
    toast(ok ? 'Copied to clipboard' : 'Copy failed — long-press to copy manually');
  });

  $('challenge-btn').addEventListener('click', async () => {
    // pathname-aware so challenge links work when hosted under a subpath.
    const url = `${location.origin}${location.pathname}?d=${puzzleDate}`;
    if (navigator.share) {
      try { await navigator.share({ url, title: 'Contexo challenge' }); return; }
      catch { /* fall through to clipboard */ }
    }
    const ok = await copyText(url);
    toast(ok ? 'Challenge link copied' : 'Copy failed — long-press to copy manually');
  });

  $('mode-daily').addEventListener('click', async () => {
    if (mode === 'daily' && !oneOff) return;
    history.replaceState(null, '', location.pathname);
    oneOff = false;
    try { await loadDaily(todayLocal()); } catch (e) { toast(`Could not load puzzle: ${e.message}`); }
  });
  $('mode-practice').addEventListener('click', async () => {
    if (mode === 'practice') return;
    try { await loadPractice(); } catch (e) { toast(`Could not load practice: ${e.message}`); }
  });
  $('mode-archive').addEventListener('click', async () => {
    await openArchive();
  });
  $('newpractice-btn').addEventListener('click', async () => {
    if (mode !== 'practice') return;
    if (state && state.guesses.length && !state.won && !state.gaveUp &&
        !confirm('Start a new practice puzzle? Your current progress will be lost.')) {
      return;
    }
    try { await loadPractice(true); } catch (e) { toast(`Could not load practice: ${e.message}`); }
  });

  $('theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    store.set('contexo:theme', next);
    updateThemeBtn();
  });
  $('howto-btn').addEventListener('click', () => openModal($('modal-howto')));
  $('stats-btn').addEventListener('click', () => {
    renderStats();
    openModal($('modal-stats'));
  });

  window.addEventListener('resize', sizeRadar);
}

async function init() {
  initTheme();
  bindUI();
  bindModals();
  rctx = radar().getContext('2d');
  sizeRadar();
  requestAnimationFrame(drawRadar);
  await loadVocab();
  await loadGame();
  // How-to overlay on first visit.
  if (!store.get('contexo:seenHowTo', false)) openModal($('modal-howto'));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
