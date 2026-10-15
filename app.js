// Roll-Up: organise a golf roll-up on one phone. Everything is stored on the
// device (localStorage); nothing is sent anywhere and no money is handled.
import * as C from './calc.js';

const KEY = 'rollup.v1';
const app = document.getElementById('app');

// ── State ───────────────────────────────────────────────────────────────────
const blank = () => ({ settings: { organiser: '', payProvider: '', payHandle: '', currency: 'GBP' }, players: [], courses: [], events: [] });
let S = load();
function load() {
  try { return { ...blank(), ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return blank(); }
}
function save() { localStorage.setItem(KEY, JSON.stringify(S)); }

const uid = () => Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 0) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Number(v));
const today = () => new Date().toISOString().slice(0, 10);
const cur = () => S.settings.currency || 'GBP';
const m = (x) => C.money(x, cur());

const player = (id) => S.players.find((p) => p.id === id);
const course = (id) => S.courses.find((c) => c.id === id);
const event = (id) => S.events.find((e) => e.id === id);
function teeOf(ev) {
  const c = course(ev.courseId);
  return c?.tees.find((t) => t.id === ev.teeId) || c?.tees[0] || null;
}
const holeDataOk = (tee) => tee && tee.par.length && tee.par.every((p) => num(p) > 0) &&
  [...tee.si].map(Number).sort((a, b) => a - b).every((s, i) => s === i + 1);

function newEvent() {
  const last = S.events[S.events.length - 1];
  const ev = {
    id: uid(), name: 'Roll-up', date: today(), courseId: last?.courseId || S.courses[0]?.id || null, teeId: last?.teeId || null,
    allowance: last?.allowance ?? 95, entryFee: last?.entryFee ?? 5, twosFee: last?.twosFee ?? 0,
    placeMode: last?.placeMode || 'percent', places: last?.places || [50, 30, 20], fixed: last?.fixed || [30, 20, 10],
    unit: last?.unit ?? 1, ties: last?.ties || 'countback',
    groupSize: last?.groupSize || 4, drawMode: last?.drawMode || 'random', startTime: '', interval: 10,
    scoreMode: last?.scoreMode || 'totals', entrants: [], groups: [], scores: {}, sidePrizes: [],
  };
  S.events.push(ev);
  save();
  return ev;
}
function newCourse(name = 'New course') {
  const c = { id: uid(), name, tees: [newTee('Yellow')] };
  S.courses.push(c);
  save();
  return c;
}
function newTee(name) {
  return { id: uid(), name, par: Array(18).fill(4), si: Array.from({ length: 18 }, (_, i) => i + 1), slope: '', rating: '' };
}

// ── Results maths for an event ──────────────────────────────────────────────
function compute(ev) {
  const tee = teeOf(ev);
  const holesOk = holeDataOk(tee);
  const rows = ev.entrants.map((en) => {
    const p = player(en.pid) || { name: '?' };
    const ph = C.playingHandicap(num(en.index), tee, num(ev.allowance, 95));
    const sc = ev.scores[en.pid] || {};
    let points = null;
    let holePoints = null;
    let twos = num(sc.twos, 0);
    if (ev.scoreMode === 'holes' && holesOk) {
      const entered = (sc.holes || []).some((g) => g !== '' && g != null);
      if (entered) {
        holePoints = C.stablefordCard(sc.holes, tee, ph);
        points = holePoints.reduce((a, b) => a + b, 0);
        twos = (sc.holes || []).filter((g) => Number(g) === 2).length;
      }
    } else if (sc.points !== '' && sc.points != null) {
      points = num(sc.points);
    }
    return { id: en.pid, name: p.name, index: en.index, ph, points, holePoints, back9: sc.back9 === '' || sc.back9 == null ? undefined : num(sc.back9), twos, paid: !!en.paid };
  });
  const scored = rows.filter((r) => r.points != null);
  const ranked = C.rank(scored, ev.ties);
  const n = ev.entrants.length;
  const mainPot = num(ev.entryFee) * n;
  const sideTotal = ev.sidePrizes.reduce((a, s) => a + num(s.amount), 0);
  const placePot = Math.max(0, mainPot - sideTotal);
  const plan = prizePlan(ev, placePot);
  const placeMoney = C.placePayoutsFromAmounts(ranked, plan.amounts);
  const twosPot = num(ev.twosFee) * n;
  const tw = C.twosPayouts(new Map(scored.map((r) => [r.id, r.twos])), twosPot);
  const winnings = new Map();
  const add = (id, amt) => { if (id && amt) winnings.set(id, +((winnings.get(id) || 0) + amt).toFixed(2)); };
  for (const [id, a] of placeMoney) add(id, a);
  for (const [id, a] of tw.out) add(id, a);
  for (const s of ev.sidePrizes) add(s.winner, num(s.amount));
  return { tee, holesOk, rows, ranked, mainPot, sideTotal, placePot, plan, placeMoney, twosPot, tw, winnings, allIn: n > 0 && scored.length === n };
}

/**
 * The money for 1st, 2nd, 3rd... before anyone has a score:
 * percentages of the pot, fixed amounts, or auto (more places for bigger fields).
 */
function prizePlan(ev, placePot) {
  const n = ev.entrants.length;
  const mode = ev.placeMode || 'percent';
  if (mode === 'fixed') {
    const amounts = (ev.fixed || []).map((x) => num(x));
    const total = amounts.reduce((a, b) => a + b, 0);
    return { mode, amounts, pct: null, total, left: +(placePot - total).toFixed(2) };
  }
  const pct = mode === 'auto' ? C.autoPlaces(n) : (ev.places || []).filter((x) => x > 0);
  const k = Math.max(1, Math.min(pct.length, n || pct.length));
  const amounts = C.splitAmount(placePot, pct.slice(0, k), num(ev.unit, 1));
  return { mode, amounts, pct, total: placePot, left: 0 };
}

// ── Router ──────────────────────────────────────────────────────────────────
window.addEventListener('hashchange', render);
function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return parts;
}

function render() {
  const [a, id, tab] = route();
  let html;
  if (a === 'settings') html = viewSettings();
  else if (a === 'courses') html = viewCourses();
  else if (a === 'course' && course(id)) html = viewCourse(course(id));
  else if (a === 'event' && event(id)) html = viewEvent(event(id), tab || 'setup');
  else html = viewHome();
  app.innerHTML = html;
}
// Re-render but keep the cursor in the field being typed in.
function rerender() {
  const el = document.activeElement;
  const key = el?.dataset?.k;
  const pos = el && 'selectionStart' in el ? (() => { try { return el.selectionStart; } catch { return null; } })() : null;
  render();
  if (key) {
    const again = app.querySelector(`[data-k="${CSS.escape(key)}"]`);
    if (again) {
      again.focus();
      try { if (pos != null) again.setSelectionRange(pos, pos); } catch { /* not a text field */ }
    }
  }
}

// ── Views ───────────────────────────────────────────────────────────────────
function viewHome() {
  const evs = [...S.events].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return `
  <h1>Your roll-ups</h1>
  <button data-act="new-event" style="width:100%">+ New roll-up</button>
  <div class="card mt">
    ${evs.length ? evs.map((e) => `
      <div class="list-item">
        <a href="#/event/${e.id}/${e.entrants.length ? 'results' : 'setup'}"><b>${esc(e.name)}</b><br>
        <span class="muted">${esc(e.date)} · ${esc(course(e.courseId)?.name || 'No course')} · ${e.entrants.length} players</span></a>
        <span class="pill">${m(num(e.entryFee) * e.entrants.length)} pot</span>
      </div>`).join('') : '<p class="muted">No roll-ups yet. Start one above.</p>'}
  </div>
  <div class="row"><a class="btn secondary" href="#/courses">Courses (${S.courses.length})</a><a class="btn secondary" href="#/settings">Players & settings</a></div>`;
}

function viewSettings() {
  const s = S.settings;
  return `
  <h1>Settings</h1>
  <div class="card">
    <h2>You (the organiser)</h2>
    <label>Your name</label><input data-k="set.organiser" data-set="organiser" value="${esc(s.organiser)}" placeholder="e.g. Matt">
    <label>Collect entries via (optional)</label>
    <select data-set="payProvider">
      ${[['', 'Cash only'], ['paypal', 'PayPal.me'], ['monzo', 'Monzo.me'], ['revolut', 'Revolut.me']].map(([v, l]) => `<option value="${v}" ${s.payProvider === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select>
    ${s.payProvider ? `<label>Your ${s.payProvider} username</label><input data-k="set.payHandle" data-set="payHandle" value="${esc(s.payHandle)}" placeholder="e.g. mattfirth">
    <p class="muted">Players pay <b>you</b> directly through your own link. Test your link once before sharing it.</p>` : ''}
    <label>Currency</label>
    <select data-set="currency">${['GBP', 'EUR', 'USD'].map((c) => `<option ${s.currency === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
  </div>
  <div class="card">
    <h2>Regular players (${S.players.length})</h2>
    ${S.players.map((p) => `<div class="list-item"><span>${esc(p.name)}</span>
      <span class="row" style="flex:0 0 auto"><input style="width:80px" inputmode="decimal" data-k="pl.${p.id}" data-player-index="${p.id}" value="${esc(p.index)}" aria-label="Handicap index">
      <button class="small danger" data-act="del-player" data-id="${p.id}">✕</button></span></div>`).join('') || '<p class="muted">Players you add to roll-ups are remembered here.</p>'}
  </div>
  <div class="card">
    <h2>Backup</h2>
    <p class="muted">Everything is stored on this phone only. Save a backup file now and then.</p>
    <div class="row"><button class="secondary" data-act="export">Save backup</button><label class="btn secondary" style="margin:0">Restore<input type="file" accept=".json" data-act="import" hidden></label></div>
  </div>`;
}

function viewCourses() {
  return `
  <h1>Courses</h1>
  <button data-act="new-course" style="width:100%">+ Add a course</button>
  <div class="card mt">${S.courses.map((c) => `<div class="list-item"><a href="#/course/${c.id}"><b>${esc(c.name)}</b></a>
    <span class="muted">${c.tees.length} tee${c.tees.length > 1 ? 's' : ''}</span></div>`).join('') || '<p class="muted">No courses yet.</p>'}</div>`;
}

function viewCourse(c) {
  return `
  <h1>${esc(c.name)}</h1>
  <div class="card">
    <label>Course name</label><input data-k="c.name" data-course="${c.id}" data-cfield="name" value="${esc(c.name)}">
  </div>
  ${c.tees.map((t) => {
    const ok = holeDataOk(t);
    return `<div class="card">
      <div class="row"><input data-k="t.${t.id}.name" data-tee="${c.id}:${t.id}" data-tfield="name" value="${esc(t.name)}" aria-label="Tee name">
      <button class="small danger" style="flex:0 0 auto" data-act="del-tee" data-id="${c.id}:${t.id}">Remove tee</button></div>
      <div class="row">
        <div><label>Slope rating</label><input inputmode="decimal" data-k="t.${t.id}.slope" data-tee="${c.id}:${t.id}" data-tfield="slope" value="${esc(t.slope)}" placeholder="e.g. 128"></div>
        <div><label>Course rating</label><input inputmode="decimal" data-k="t.${t.id}.rating" data-tee="${c.id}:${t.id}" data-tfield="rating" value="${esc(t.rating)}" placeholder="e.g. 70.6"></div>
      </div>
      <p class="muted">Par ${C.parTotal(t) ?? '?'} · Slope and course rating are on the scorecard or the club's handicap board. Without them, playing handicaps use the index only.</p>
      ${ok ? '' : '<div class="warn">Stroke indexes must use each number 1-18 once. Needed only for hole-by-hole scoring.</div>'}
      <table><tr><th>Hole</th><th>Par</th><th>Stroke index</th></tr>
      ${t.par.map((p, i) => `<tr><td>${i + 1}</td>
        <td><input inputmode="numeric" data-k="t.${t.id}.p${i}" data-hole="${c.id}:${t.id}:par:${i}" value="${esc(p)}"></td>
        <td><input inputmode="numeric" data-k="t.${t.id}.s${i}" data-hole="${c.id}:${t.id}:si:${i}" value="${esc(t.si[i])}"></td></tr>`).join('')}
      </table></div>`;
  }).join('')}
  <div class="row"><button class="secondary" data-act="add-tee" data-id="${c.id}">+ Add tee</button>
  <button class="danger" data-act="del-course" data-id="${c.id}">Delete course</button></div>`;
}

function viewEvent(ev, tab) {
  const tabs = [['setup', 'Setup'], ['players', `Players (${ev.entrants.length})`], ['draw', 'Draw'], ['scores', 'Scores'], ['results', 'Results']];
  const body = { setup: evSetup, players: evPlayers, draw: evDraw, scores: evScores, results: evResults }[tab] || evSetup;
  return `
  <h1>${esc(ev.name)} <span class="muted">${esc(ev.date)}</span></h1>
  <nav class="tabs">${tabs.map(([k, l]) => `<a href="#/event/${ev.id}/${k}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('')}</nav>
  ${body(ev)}`;
}

const evField = (ev, f, label, attrs = '') => `<label>${label}</label><input data-k="ev.${f}" data-ev="${ev.id}" data-f="${f}" value="${esc(ev[f])}" ${attrs}>`;
const evSelect = (ev, f, label, opts) => `<label>${label}</label><select data-ev="${ev.id}" data-f="${f}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(ev[f]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

function evSetup(ev) {
  const c = course(ev.courseId);
  const tee = teeOf(ev);
  return `
  <div class="card">
    ${evField(ev, 'name', 'Name')}
    ${evField(ev, 'date', 'Date', 'type="date"')}
    <label>Course</label>
    <div class="row"><select data-ev="${ev.id}" data-f="courseId">
      <option value="">No course (handicap index only)</option>
      ${S.courses.map((x) => `<option value="${x.id}" ${x.id === ev.courseId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
    </select><button class="small secondary" style="flex:0 0 auto" data-act="new-course-from" data-id="${ev.id}">+ New</button></div>
    ${c ? evSelect(ev, 'teeId', 'Tee', c.tees.map((t) => [t.id, t.name])) : ''}
    ${c && tee && (!tee.slope || !tee.rating) ? `<div class="warn">No slope / course rating for this tee yet, so playing handicaps use the handicap index only. <a href="#/course/${c.id}">Add them</a></div>` : ''}
  </div>
  <div class="card">
    <h2>Format</h2>
    ${evSelect(ev, 'scoreMode', 'Scores are entered as', [['totals', 'Total points per player (quickest)'], ['holes', 'Hole by hole (app works out points)']])}
    ${ev.scoreMode === 'holes' && !holeDataOk(tee) ? '<div class="warn">Hole-by-hole needs the course\'s par and stroke index for every hole.</div>' : ''}
    ${evField(ev, 'allowance', 'Handicap allowance %', 'inputmode="decimal"')}
    ${evSelect(ev, 'ties', 'Ties', [['countback', 'Countback (back 9, 6, 3, last hole)'], ['share', 'Share the prize money']])}
  </div>
  <div class="card">
    <h2>Money</h2>
    <div class="row"><div>${evField(ev, 'entryFee', `Entry (${cur()})`, 'inputmode="decimal"')}</div><div>${evField(ev, 'twosFee', `2s pot entry (${cur()}, 0 = none)`, 'inputmode="decimal"')}</div></div>
    ${prizesEditor(ev)}
    <h2 class="mt">Side prizes <span class="muted">(taken from the main pot)</span></h2>
    ${ev.sidePrizes.map((s, i) => `<div class="row"><input data-k="sp.${i}.n" data-side="${ev.id}:${i}:name" value="${esc(s.name)}" placeholder="e.g. Nearest the pin">
      <input style="flex:0 0 90px" inputmode="decimal" data-k="sp.${i}.a" data-side="${ev.id}:${i}:amount" value="${esc(s.amount)}" placeholder="${cur()}">
      <button class="small danger" style="flex:0 0 auto" data-act="del-side" data-id="${ev.id}:${i}">✕</button></div>`).join('')}
    <button class="small secondary mt" data-act="add-side" data-id="${ev.id}">+ Add side prize</button>
  </div>
  <a class="btn" style="width:100%" href="#/event/${ev.id}/players">Next: players →</a>
  <button class="danger mt" style="width:100%" data-act="del-event" data-id="${ev.id}">Delete this roll-up</button>`;
}

function prizesEditor(ev) {
  const r = compute(ev);
  const plan = r.plan;
  const mode = ev.placeMode || 'percent';
  const n = ev.entrants.length;
  const presets = [['100', 'Winner takes all'], ['60,40', '60 / 40'], ['50,30,20', '50 / 30 / 20'], ['40,30,20,10', '40 / 30 / 20 / 10']];
  let rows = '';
  if (mode === 'percent') {
    rows = ev.places.map((p, i) => `<div class="row"><span style="flex:0 0 44px"><b>${C.ordinal(i + 1)}</b></span>
      <input inputmode="decimal" data-k="pl.${i}" data-place="${ev.id}:${i}" value="${esc(p)}" aria-label="${C.ordinal(i + 1)} %"><span style="flex:0 0 20px">%</span>
      <span style="flex:0 0 64px;text-align:right" class="muted">${n ? m(plan.amounts[i] ?? 0) : ''}</span>
      <button class="small danger" style="flex:0 0 auto" data-act="del-place" data-id="${ev.id}:${i}" ${ev.places.length < 2 ? 'disabled' : ''}>✕</button></div>`).join('');
    const sum = ev.places.reduce((a, b) => a + num(b), 0);
    rows += `<div class="row mt"><button class="small secondary" style="flex:0 0 auto" data-act="add-place" data-id="${ev.id}">+ Add a place</button>
      <span class="muted" style="text-align:right">${sum === 100 ? 'Adds up to 100%' : `Adds up to ${sum}%; shares are scaled to the whole pot`}</span></div>
      <div class="row mt" style="flex-wrap:wrap">${presets.map(([v, l]) => `<button class="small secondary" style="flex:0 0 auto" data-act="preset" data-id="${ev.id}" data-preset="${v}">${l}</button>`).join('')}</div>`;
  } else if (mode === 'fixed') {
    rows = (ev.fixed || []).map((a, i) => `<div class="row"><span style="flex:0 0 44px"><b>${C.ordinal(i + 1)}</b></span>
      <input inputmode="decimal" data-k="fx.${i}" data-fixed="${ev.id}:${i}" value="${esc(a)}" aria-label="${C.ordinal(i + 1)} prize">
      <button class="small danger" style="flex:0 0 auto" data-act="del-fixed" data-id="${ev.id}:${i}" ${(ev.fixed || []).length < 2 ? 'disabled' : ''}>✕</button></div>`).join('');
    rows += `<button class="small secondary mt" data-act="add-fixed" data-id="${ev.id}">+ Add a place</button>
      <p class="muted">Prizes ${m(plan.total)} of a ${m(r.placePot)} pot${n ? '' : ' (pot grows as players are added)'}.</p>
      ${n && plan.left < 0 ? `<div class="warn">Prizes are ${m(-plan.left)} more than the pot.</div>` : ''}
      ${n && plan.left > 0 ? `<p class="muted">${m(plan.left)} left over (e.g. carry it to next time).</p>` : ''}`;
  } else {
    rows = `<p class="muted">Pays more places as more people play (about one place per 4 players, up to 6).</p>
      <p>${n ? plan.pct.slice(0, plan.amounts.length).map((p, i) => `${C.ordinal(i + 1)} ${p}% (${m(plan.amounts[i])})`).join(' · ') : 'Add players to see the split.'}</p>`;
  }
  return `
    ${evSelect(ev, 'placeMode', 'Prizes', [['percent', 'Percentage of the pot'], ['fixed', `Fixed amounts (${cur()})`], ['auto', 'Auto: by number of players']])}
    <div class="mt">${rows}</div>
    ${mode !== 'fixed' ? evSelect(ev, 'unit', 'Round prizes to', [[1, `Whole ${cur() === 'GBP' ? 'pounds' : 'units'}`], [0.5, '50p / 0.50'], [0.01, 'Exact']]) : ''}`;
}

function evPlayers(ev) {
  const inIds = new Set(ev.entrants.map((e) => e.pid));
  const others = S.players.filter((p) => !inIds.has(p.id)).sort((a, b) => a.name.localeCompare(b.name));
  const unpaid = ev.entrants.filter((e) => !e.paid).length;
  const tee = teeOf(ev);
  return `
  <div class="card">
    <h2>Add a new player</h2>
    <div class="row"><input data-k="np.name" id="np-name" placeholder="Name"><input id="np-index" style="flex:0 0 90px" inputmode="decimal" placeholder="Index"><button style="flex:0 0 auto" data-act="add-new-player" data-id="${ev.id}">Add</button></div>
    ${others.length ? `<h2 class="mt">Regulars</h2><div class="row" style="flex-wrap:wrap">${others.map((p) => `<button class="small secondary" style="flex:0 0 auto" data-act="add-player" data-id="${ev.id}:${p.id}">+ ${esc(p.name)}</button>`).join('')}</div>` : ''}
  </div>
  <div class="card">
    <h2>In this roll-up: ${ev.entrants.length} · pot ${m(num(ev.entryFee) * ev.entrants.length)}${unpaid ? ` · <span style="color:var(--bad)">${unpaid} unpaid</span>` : ''}</h2>
    <table><tr><th>Player</th><th class="num">Index</th><th class="num">Plays off</th><th>Paid</th><th></th></tr>
    ${ev.entrants.map((e) => `<tr><td>${esc(player(e.pid)?.name)}</td>
      <td class="num"><input style="width:70px" inputmode="decimal" data-k="en.${e.pid}" data-entrant="${ev.id}:${e.pid}" value="${esc(e.index)}"></td>
      <td class="num">${C.playingHandicap(num(e.index), tee, num(ev.allowance, 95))}</td>
      <td><input type="checkbox" data-paid="${ev.id}:${e.pid}" ${e.paid ? 'checked' : ''}></td>
      <td><button class="small danger" data-act="remove-entrant" data-id="${ev.id}:${e.pid}">✕</button></td></tr>`).join('')}
    </table>
    ${payLinksBlock(ev)}
  </div>
  <a class="btn" style="width:100%" href="#/event/${ev.id}/draw">Next: the draw →</a>`;
}

function payLinksBlock(ev) {
  const s = S.settings;
  const fee = num(ev.entryFee) + num(ev.twosFee);
  const link = C.paymentLink(s.payProvider, s.payHandle, fee, cur());
  if (!link) return `<p class="muted mt">Collecting by bank? Add your PayPal.me, Monzo.me or Revolut.me username in <a href="#/settings">Settings</a> to share a payment link.</p>`;
  const msg = `${ev.name} ${ev.date}: entry is ${m(fee)}. Pay ${s.organiser || 'me'} here: ${link}`;
  return `<div class="mt"><p class="muted">Payment link (players pay you directly): <a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a></p>
    <button class="secondary" data-act="share" data-text="${esc(msg)}">Share payment link</button></div>`;
}

function evDraw(ev) {
  const times = C.teeTimes(ev.startTime, ev.interval, ev.groups.length);
  const drawn = new Set(ev.groups.flat());
  const missing = ev.entrants.filter((e) => !drawn.has(e.pid));
  const text = drawText(ev);
  return `
  <div class="card">
    <div class="row">
      <div>${evSelect(ev, 'groupSize', 'Group size', [[2, '2-balls'], [3, '3-balls'], [4, '4-balls']])}</div>
      <div>${evSelect(ev, 'drawMode', 'Draw', [['random', 'Random'], ['balanced', 'Balanced by handicap']])}</div>
    </div>
    <div class="row"><div>${evField(ev, 'startTime', 'First tee time (optional)', 'type="time"')}</div><div>${evField(ev, 'interval', 'Minutes between groups', 'inputmode="numeric"')}</div></div>
    <button class="mt" style="width:100%" data-act="draw" data-id="${ev.id}">${ev.groups.length ? 'Re-draw' : 'Make the draw'}</button>
  </div>
  ${missing.length && ev.groups.length ? `<div class="warn">Not in the draw yet: ${missing.map((e) => esc(player(e.pid)?.name)).join(', ')}. Re-draw to include them.</div>` : ''}
  ${ev.groups.map((g, gi) => `<div class="group"><h3><span>Group ${gi + 1}</span><span class="muted">${times[gi] || ''}</span></h3>
    ${g.map((pid) => `<div class="list-item"><span>${esc(player(pid)?.name)} <span class="muted">(${esc(ev.entrants.find((e) => e.pid === pid)?.index ?? '')})</span></span>
      <select style="width:auto" data-move="${ev.id}:${pid}">${ev.groups.map((_, k) => `<option value="${k}" ${k === gi ? 'selected' : ''}>Group ${k + 1}</option>`).join('')}</select></div>`).join('')}
  </div>`).join('')}
  ${ev.groups.length ? `<button class="secondary" style="width:100%" data-act="share" data-text="${esc(text)}">Share the draw (WhatsApp etc.)</button>` : ''}
  <a class="btn mt" style="width:100%" href="#/event/${ev.id}/scores">Next: scores →</a>`;
}

function drawText(ev) {
  const times = C.teeTimes(ev.startTime, ev.interval, ev.groups.length);
  return `⛳ ${ev.name}, ${ev.date}${course(ev.courseId) ? ` at ${course(ev.courseId).name}` : ''}\n` +
    ev.groups.map((g, i) => `\nGroup ${i + 1}${times[i] ? ` (${times[i]})` : ''}: ${g.map((pid) => player(pid)?.name).join(', ')}`).join('');
}

function evScores(ev) {
  const r = compute(ev);
  if (!ev.entrants.length) return '<div class="card"><p class="muted">Add players first.</p></div>';
  if (ev.scoreMode === 'holes' && r.holesOk) {
    const [, , , pick] = route();
    const pid = ev.entrants.some((e) => e.pid === pick) ? pick : ev.entrants[0].pid;
    const row = r.rows.find((x) => x.id === pid);
    const sc = ev.scores[pid]?.holes || [];
    const pts = C.stablefordCard(sc, r.tee, row.ph);
    const strokes = C.strokesPerHole(row.ph, r.tee.si);
    return `
    <div class="card">
      <label>Player</label>
      <select data-pick="${ev.id}">${r.rows.map((x) => `<option value="${x.id}" ${x.id === pid ? 'selected' : ''}>${esc(x.name)}${x.points != null ? ` · ${x.points} pts` : ''}</option>`).join('')}</select>
      <p class="muted">Plays off ${row.ph}. Leave a hole blank if they picked up (0 points).</p>
      <div class="holes">${r.tee.par.map((p, i) => `<div class="hole"><div class="h">H${i + 1} · par ${p} · SI ${r.tee.si[i]}${strokes[i] ? ` · +${strokes[i]}` : ''}</div>
        <input inputmode="numeric" data-k="h.${pid}.${i}" data-gross="${ev.id}:${pid}:${i}" value="${esc(sc[i] ?? '')}">
        <div class="pts">${sc[i] ? `${pts[i]} pt${pts[i] === 1 ? '' : 's'}` : ''}</div></div>`).join('')}</div>
      <p class="big mt">${pts.reduce((a, b) => a + b, 0)} points</p>
    </div>
    <a class="btn" style="width:100%" href="#/event/${ev.id}/results">See results →</a>`;
  }
  return `
  <div class="card">
    ${ev.scoreMode === 'holes' ? '<div class="warn">This course has no par / stroke index, so enter total points instead.</div>' : ''}
    <table><tr><th>Player</th><th class="num">Points</th><th class="num">Back 9</th>${num(ev.twosFee) ? '<th class="num">2s</th>' : ''}</tr>
    ${r.rows.map((x) => `<tr><td>${esc(x.name)} <span class="muted">(${x.ph})</span></td>
      <td class="num"><input style="width:64px" inputmode="numeric" data-k="pt.${x.id}" data-score="${ev.id}:${x.id}:points" value="${esc(ev.scores[x.id]?.points ?? '')}"></td>
      <td class="num"><input style="width:64px" inputmode="numeric" data-k="b9.${x.id}" data-score="${ev.id}:${x.id}:back9" value="${esc(ev.scores[x.id]?.back9 ?? '')}" placeholder="opt."></td>
      ${num(ev.twosFee) ? `<td class="num"><input style="width:48px" inputmode="numeric" data-k="tw.${x.id}" data-score="${ev.id}:${x.id}:twos" value="${esc(ev.scores[x.id]?.twos ?? '')}"></td>` : ''}</tr>`).join('')}
    </table>
    <p class="muted mt">Back 9 points are only used to break ties by countback.</p>
  </div>
  <a class="btn" style="width:100%" href="#/event/${ev.id}/results">See results →</a>`;
}

function evResults(ev) {
  const r = compute(ev);
  if (!ev.entrants.length) return '<div class="card"><p class="muted">Add players first.</p></div>';
  const posLabel = (x) => {
    const tied = r.ranked.filter((y) => y.tieGroup === x.tieGroup).length > 1;
    return `${tied ? '=' : ''}${x.pos}`;
  };
  const unpaid = r.rows.filter((x) => !x.paid);
  const winners = [...r.winnings.entries()].sort((a, b) => b[1] - a[1]);
  return `
  ${!r.allIn ? `<div class="warn">Waiting for ${ev.entrants.length - r.ranked.length} score${ev.entrants.length - r.ranked.length === 1 ? '' : 's'}. Prizes update as scores come in.</div>` : ''}
  <div class="card">
    <h2>Leaderboard</h2>
    <table><tr><th>Pos</th><th>Player</th><th class="num">HC</th><th class="num">Pts</th><th class="num">Prize</th></tr>
    ${r.ranked.map((x) => `<tr class="${x.pos === 1 ? 'pos1' : ''}"><td>${posLabel(x)}</td><td>${esc(x.name)}</td><td class="num">${x.ph}</td><td class="num"><b>${x.points}</b></td>
      <td class="num">${r.winnings.get(x.id) ? m(r.winnings.get(x.id)) : ''}</td></tr>`).join('')}
    </table>
  </div>
  <div class="card">
    <h2>The money</h2>
    <p>Main pot: <b>${m(r.mainPot)}</b> (${ev.entrants.length} × ${m(ev.entryFee)})${r.sideTotal ? ` · side prizes ${m(r.sideTotal)} · places ${m(r.placePot)}` : ''}</p>
    <p class="muted">Prizes: ${r.plan.amounts.map((a, i) => `${C.ordinal(i + 1)} ${m(a)}`).join(' · ') || 'none'}${r.plan.mode === 'fixed' && r.plan.left ? ` · ${r.plan.left > 0 ? `${m(r.plan.left)} left over` : `${m(-r.plan.left)} short`}` : ''}</p>
    ${r.twosPot ? `<p>2s pot: <b>${m(r.twosPot)}</b> · ${r.tw.shares} two${r.tw.shares === 1 ? '' : 's'}${r.tw.rollover ? ` · <b>${m(r.tw.rollover)} rolls over</b>` : ''}</p>` : ''}
    ${ev.sidePrizes.length ? ev.sidePrizes.map((s, i) => `<label>${esc(s.name || 'Side prize')} (${m(s.amount)}) won by</label>
      <select data-sidewin="${ev.id}:${i}"><option value="">Not decided</option>${r.rows.map((x) => `<option value="${x.id}" ${s.winner === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`).join('') : ''}
    <h2 class="mt">Pay out</h2>
    ${winners.length ? winners.map(([id, a]) => `<div class="list-item"><span>${esc(player(id)?.name)}</span><b>${m(a)}</b></div>`).join('') : '<p class="muted">No winners yet.</p>'}
    ${unpaid.length ? `<p class="mt" style="color:var(--bad)">Still to pay their entry: ${unpaid.map((x) => esc(x.name)).join(', ')}</p>` : '<p class="muted mt">Everyone has paid.</p>'}
  </div>
  <button style="width:100%" data-act="share" data-text="${esc(resultsText(ev, r))}">Share results</button>`;
}

function resultsText(ev, r) {
  const lines = r.ranked.map((x) => `${x.pos}. ${x.name} ${x.points} pts${r.winnings.get(x.id) ? ` · ${m(r.winnings.get(x.id))}` : ''}`);
  const extra = [];
  if (r.twosPot) extra.push(r.tw.shares ? `2s: ${[...r.tw.out.entries()].map(([id, a]) => `${player(id)?.name} ${m(a)}`).join(', ')}` : `No 2s, ${m(r.twosPot)} rolls over`);
  for (const s of ev.sidePrizes) if (s.winner) extra.push(`${s.name || 'Side prize'}: ${player(s.winner)?.name} ${m(s.amount)}`);
  return `⛳ ${ev.name} results, ${ev.date}\nPot ${m(r.mainPot)}\n\n${lines.join('\n')}${extra.length ? `\n\n${extra.join('\n')}` : ''}`;
}

// ── Actions ─────────────────────────────────────────────────────────────────
function addEntrant(ev, p) {
  if (ev.entrants.some((e) => e.pid === p.id)) return;
  ev.entrants.push({ pid: p.id, index: p.index ?? '', paid: false });
}

app.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.dataset.act === 'import') return;
  const [a, b2, c2] = (b.dataset.id || '').split(':');
  const act = b.dataset.act;
  if (act === 'new-event') { const ev = newEvent(); location.hash = `#/event/${ev.id}/setup`; return; }
  if (act === 'del-event' && confirm('Delete this roll-up?')) { S.events = S.events.filter((x) => x.id !== a); save(); location.hash = '#/'; return; }
  if (act === 'new-course') { const c = newCourse(); location.hash = `#/course/${c.id}`; return; }
  if (act === 'new-course-from') { const c = newCourse(); const ev = event(a); ev.courseId = c.id; ev.teeId = c.tees[0].id; save(); location.hash = `#/course/${c.id}`; return; }
  if (act === 'del-course' && confirm('Delete this course?')) { S.courses = S.courses.filter((x) => x.id !== a); save(); location.hash = '#/courses'; return; }
  if (act === 'add-tee') { course(a).tees.push(newTee('White')); }
  if (act === 'del-tee') { const c = course(a); if (c.tees.length > 1) c.tees = c.tees.filter((t) => t.id !== b2); }
  if (act === 'add-place') event(a).places.push(10);
  if (act === 'del-place') { const ev = event(a); if (ev.places.length > 1) ev.places.splice(Number(b2), 1); }
  if (act === 'add-fixed') { const ev = event(a); ev.fixed = ev.fixed || []; ev.fixed.push(5); }
  if (act === 'del-fixed') { const ev = event(a); if (ev.fixed.length > 1) ev.fixed.splice(Number(b2), 1); }
  if (act === 'preset') { const ev = event(a); ev.placeMode = 'percent'; ev.places = b.dataset.preset.split(',').map(Number); }
  if (act === 'add-side') event(a).sidePrizes.push({ name: 'Nearest the pin', amount: 5, winner: '' });
  if (act === 'del-side') event(a).sidePrizes.splice(Number(b2), 1);
  if (act === 'add-player') addEntrant(event(a), player(b2));
  if (act === 'remove-entrant') { const ev = event(a); ev.entrants = ev.entrants.filter((x) => x.pid !== b2); ev.groups = ev.groups.map((g) => g.filter((x) => x !== b2)).filter((g) => g.length); }
  if (act === 'add-new-player') {
    const name = document.getElementById('np-name').value.trim();
    const index = document.getElementById('np-index').value.trim();
    if (!name) return;
    let p = S.players.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!p) { p = { id: uid(), name, index }; S.players.push(p); } else if (index) p.index = index;
    addEntrant(event(a), p);
  }
  if (act === 'del-player' && confirm('Remove from regular players?')) S.players = S.players.filter((x) => x.id !== a);
  if (act === 'draw') {
    const ev = event(a);
    ev.groups = C.makeDraw(ev.entrants.map((x) => ({ id: x.pid, index: num(x.index) })), num(ev.groupSize, 4), ev.drawMode);
  }
  if (act === 'share') return share(b.dataset.text);
  if (act === 'export') return exportData();
  void c2;
  save();
  render();
});

app.addEventListener('input', (e) => {
  const t = e.target;
  const d = t.dataset;
  if (d.set) S.settings[d.set] = t.value;
  else if (d.playerIndex) { const p = player(d.playerIndex); p.index = t.value; }
  else if (d.course) course(d.course)[d.cfield] = t.value;
  else if (d.tee) { const [c, id] = d.tee.split(':'); course(c).tees.find((x) => x.id === id)[d.tfield] = t.value; }
  else if (d.hole) { const [c, id, f, i] = d.hole.split(':'); course(c).tees.find((x) => x.id === id)[f][Number(i)] = t.value; }
  else if (d.ev) {
    const ev = event(d.ev);
    if (d.f === 'places') ev.places = t.value.split(/[ ,/]+/).map(Number).filter((x) => x > 0);
    else if (d.f === 'courseId') { ev.courseId = t.value || null; ev.teeId = course(t.value)?.tees[0]?.id || null; }
    else ev[d.f] = t.tagName === 'SELECT' && ['groupSize', 'unit'].includes(d.f) ? Number(t.value) : t.value;
    if (d.f === 'placeMode' && t.value === 'fixed' && !ev.fixed?.length) ev.fixed = [30, 20, 10];
  } else if (d.place) { const [id, i] = d.place.split(':'); event(id).places[Number(i)] = t.value === '' ? '' : num(t.value); }
  else if (d.fixed) { const [id, i] = d.fixed.split(':'); event(id).fixed[Number(i)] = t.value === '' ? '' : num(t.value); }
  else if (d.side) { const [id, i, f] = d.side.split(':'); event(id).sidePrizes[Number(i)][f] = t.value; }
  else if (d.sidewin) { const [id, i] = d.sidewin.split(':'); event(id).sidePrizes[Number(i)].winner = t.value; }
  else if (d.entrant) {
    const [id, pid] = d.entrant.split(':');
    const en = event(id).entrants.find((x) => x.pid === pid);
    en.index = t.value;
    const p = player(pid);
    if (p) p.index = t.value; // remember their latest index
  } else if (d.paid) { const [id, pid] = d.paid.split(':'); event(id).entrants.find((x) => x.pid === pid).paid = t.checked; }
  else if (d.score) { const [id, pid, f] = d.score.split(':'); const ev = event(id); ev.scores[pid] = { ...(ev.scores[pid] || {}), [f]: t.value }; }
  else if (d.gross) {
    const [id, pid, i] = d.gross.split(':');
    const ev = event(id);
    const sc = (ev.scores[pid] = ev.scores[pid] || {});
    sc.holes = sc.holes || Array(18).fill('');
    sc.holes[Number(i)] = t.value.replace(/\D/g, '');
  } else if (d.move) {
    const [id, pid] = d.move.split(':');
    const ev = event(id);
    ev.groups = ev.groups.map((g) => g.filter((x) => x !== pid));
    ev.groups[Number(t.value)].push(pid);
  } else if (d.pick) { location.hash = `#/event/${d.pick}/scores/${t.value}`; return; }
  else return;
  save();
  rerender();
});

app.addEventListener('change', (e) => {
  if (e.target.dataset.act !== 'import') return;
  const f = e.target.files?.[0];
  if (!f) return;
  f.text().then((txt) => {
    try {
      const data = JSON.parse(txt);
      if (!Array.isArray(data.events)) throw new Error('not a Roll-Up backup');
      if (confirm('Replace everything on this phone with the backup?')) { S = { ...blank(), ...data }; save(); location.hash = '#/'; render(); }
    } catch (err) { alert(`Couldn't read that file: ${err.message}`); }
  });
});

async function share(text) {
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch { /* cancelled */ }
  try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
}

function exportData() {
  const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rollup-backup-${today()}.json`;
  a.click();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
render();
