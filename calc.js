// Roll-up maths: handicaps, Stableford points, countback, the draw and the
// payout split. Pure functions (no DOM), so they can be tested with node.
//
// Handicaps follow the World Handicap System formulas:
//   Course Handicap  = Handicap Index x (Slope / 113) + (Course Rating - Par)
//   Playing Handicap = Course Handicap x allowance (95% for individual
//                      Stableford / stroke play), rounded to the nearest whole.
// The unrounded Course Handicap is used when applying the allowance. If a
// course has no slope/rating entered, slope 113 and rating = par are assumed
// (so Course Handicap = Handicap Index), and the app says so.

/** Round to the nearest whole number, .5 away from zero (+2.5 -> 3, -2.5 -> -3). */
export function roundHalfAway(x) {
  return Math.sign(x) * Math.round(Math.abs(x));
}

export function courseHandicapRaw(index, tee) {
  const slope = Number(tee?.slope) || 113;
  const par = parTotal(tee);
  const rating = Number.isFinite(Number(tee?.rating)) && tee?.rating !== '' && tee?.rating != null ? Number(tee.rating) : par;
  return index * (slope / 113) + (par != null && rating != null ? rating - par : 0);
}

export function playingHandicap(index, tee, allowancePct = 95) {
  if (!Number.isFinite(Number(index))) return 0;
  return roundHalfAway(courseHandicapRaw(Number(index), tee) * (allowancePct / 100));
}

export function parTotal(tee) {
  if (!tee?.par?.length || tee.par.some((p) => !Number(p))) return null;
  return tee.par.reduce((a, b) => a + Number(b), 0);
}

/**
 * Strokes received on each hole for a playing handicap, by stroke index.
 * Plus handicaps (negative) give strokes back, starting from the highest index.
 */
export function strokesPerHole(ph, si) {
  const n = si.length;
  return si.map((s) => {
    s = Number(s);
    if (ph >= 0) return Math.floor(ph / n) + (s <= ph % n ? 1 : 0);
    const back = -ph;
    return -(Math.floor(back / n) + (s > n - (back % n) ? 1 : 0)) || 0;
  });
}

/** Stableford points for one hole. gross null/'' = no score (picked up) = 0 points. */
export function stablefordHole(gross, par, strokes) {
  if (gross === null || gross === undefined || gross === '' || !Number(gross)) return 0;
  return Math.max(0, Number(par) + strokes + 2 - Number(gross));
}

/** Per-hole Stableford points for a card. */
export function stablefordCard(holes, tee, ph) {
  const strokes = strokesPerHole(ph, tee.si);
  return tee.par.map((par, i) => stablefordHole(holes?.[i], par, strokes[i]));
}

/** Countback segments for a round of n holes (UK convention: last 9, 6, 3, 1). */
export function countbackSegments(n) {
  return n === 18 ? [9, 6, 3, 1] : [Math.round(n * 2 / 3), Math.round(n / 3), 1].filter((x, i, a) => x > 0 && a.indexOf(x) === i);
}

/**
 * Rank entries. Each entry: { id, points, holePoints?: number[], back9?: number }.
 * ties: 'countback' (break ties on the back holes, then share if still level)
 *       or 'share' (tied players share the places' prize money).
 * Returns entries with .pos (1-based, shared positions keep the same number)
 * and .tieGroup (entries sharing a position have the same tieGroup).
 */
export function rank(entries, ties = 'countback') {
  const key = (e) => {
    const k = [e.points];
    if (ties === 'countback') {
      if (e.holePoints?.length) {
        const n = e.holePoints.length;
        for (const seg of countbackSegments(n)) k.push(e.holePoints.slice(n - seg).reduce((a, b) => a + b, 0));
      } else if (Number.isFinite(e.back9)) {
        k.push(e.back9);
      }
    }
    return k;
  };
  const withKey = entries.map((e) => ({ ...e, _k: key(e) }));
  const cmp = (a, b) => {
    for (let i = 0; i < Math.max(a._k.length, b._k.length); i++) {
      const d = (b._k[i] ?? -1) - (a._k[i] ?? -1);
      if (d) return d;
    }
    return 0;
  };
  withKey.sort(cmp);
  let pos = 0;
  let group = -1;
  return withKey.map((e, i) => {
    if (i === 0 || cmp(withKey[i - 1], e) !== 0) {
      pos = i + 1;
      group++;
    }
    const { _k, ...rest } = e;
    return { ...rest, pos, tieGroup: group };
  });
}

/** Split an amount by percentages into rounding units; any remainder goes to the first share. */
export function splitAmount(total, percents, unit = 1) {
  const sum = percents.reduce((a, b) => a + b, 0) || 1;
  const shares = percents.map((p) => Math.floor(((total * p) / sum) / unit + 1e-9) * unit);
  const rest = +(total - shares.reduce((a, b) => a + b, 0)).toFixed(2);
  if (shares.length) shares[0] = +(shares[0] + rest).toFixed(2);
  return shares;
}

/**
 * Prize money for ranked players.
 * places: percentages for 1st, 2nd, 3rd... ; ranked: output of rank().
 * Tied players (same tieGroup) share the combined money of the places they span.
 * Returns Map id -> amount.
 */
export function placePayouts(ranked, pot, places, unit = 1) {
  const n = Math.min(places.length, ranked.length);
  const amounts = splitAmount(pot, places.slice(0, n), unit);
  const out = new Map();
  let i = 0;
  while (i < ranked.length && i < n) {
    const g = ranked[i].tieGroup;
    let j = i;
    while (j < ranked.length && ranked[j].tieGroup === g) j++;
    const covered = amounts.slice(i, Math.min(j, n));
    const money = covered.reduce((a, b) => a + b, 0);
    const each = Math.floor(money / (j - i) / 0.01) * 0.01;
    let left = +(money - each * (j - i)).toFixed(2);
    for (let k = i; k < j; k++) {
      let amt = +each.toFixed(2);
      if (left > 0) {
        const extra = Math.min(left, 0.01);
        amt = +(amt + extra).toFixed(2);
        left = +(left - extra).toFixed(2);
      }
      out.set(ranked[k].id, amt);
    }
    i = j;
  }
  return out;
}

/** Twos pot: each two (gross score of 2 on a hole) earns one equal share. */
export function twosPayouts(twosByPlayer, pot, unit = 0.01) {
  const total = [...twosByPlayer.values()].reduce((a, b) => a + b, 0);
  const out = new Map();
  if (!total || !pot) return { out, rollover: pot || 0, shares: total };
  const perShare = Math.floor(pot / total / unit) * unit;
  let paid = 0;
  for (const [id, n] of twosByPlayer) {
    if (!n) continue;
    const amt = +(perShare * n).toFixed(2);
    out.set(id, amt);
    paid += amt;
  }
  return { out, rollover: +(pot - paid).toFixed(2), shares: total };
}

/** Group sizes as even as possible, none bigger than size (13 in 4s -> 4,3,3,3). */
export function groupSizes(n, size = 4) {
  if (n <= 0) return [];
  const g = Math.ceil(n / size);
  return Array.from({ length: g }, (_, i) => Math.floor(n / g) + (i < n % g ? 1 : 0));
}

export function shuffle(arr, rnd = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * The draw. players: [{ id, index }].
 * mode 'random' = random groups; 'balanced' = each group gets a spread of
 * handicaps (snake order by handicap, then shuffled within groups).
 */
export function makeDraw(players, size = 4, mode = 'random', rnd = Math.random) {
  const sizes = groupSizes(players.length, size);
  const groups = sizes.map(() => []);
  if (mode === 'balanced') {
    const sorted = [...players].sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
    // Snake through groups, skipping ones already full.
    let gi = 0;
    let dir = 1;
    for (const p of sorted) {
      let tries = 0;
      while (groups[gi].length >= sizes[gi] && tries++ < groups.length * 2) {
        gi += dir;
        if (gi >= groups.length || gi < 0) { dir = -dir; gi += dir; }
      }
      groups[gi].push(p.id);
      gi += dir;
      if (gi >= groups.length || gi < 0) { dir = -dir; gi += dir; }
    }
    return shuffle(groups.map((g) => shuffle(g, rnd)), rnd);
  }
  const order = shuffle(players.map((p) => p.id), rnd);
  let k = 0;
  return sizes.map((s) => order.slice(k, (k += s)));
}

/** Tee times as "HH:MM" strings from a start time and an interval in minutes. */
export function teeTimes(start, interval, count) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(start || '');
  if (!m) return [];
  let t = Number(m[1]) * 60 + Number(m[2]);
  return Array.from({ length: count }, () => {
    const s = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    t += Number(interval) || 0;
    return s;
  });
}

/** Payment-request link to the organiser's own account (the app never holds money). */
export function paymentLink(provider, handle, amount, currency = 'GBP') {
  const h = encodeURIComponent((handle || '').trim().replace(/^@/, ''));
  if (!h) return null;
  const a = Number(amount).toFixed(2);
  if (provider === 'paypal') return `https://paypal.me/${h}/${a}${currency}`;
  if (provider === 'monzo') return `https://monzo.me/${h}/${a}`;
  if (provider === 'revolut') return `https://revolut.me/${h}`;
  return null;
}

export function money(x, currency = 'GBP') {
  const sym = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : currency === 'USD' ? '$' : '';
  const v = Number(x) || 0;
  return `${sym}${Number.isInteger(v) ? v : v.toFixed(2)}`;
}
