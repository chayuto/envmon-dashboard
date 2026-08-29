/* envmon dashboard — reads the reading_5m view from Supabase and plots it.
 *
 * The token in config.js is a dashboard_reader JWT scoped to that one view. It
 * is public by design: it ships in this page and can be read by anyone, which
 * is exactly why it is not the publishable key (INSERT-only, belongs to the
 * firmware) and not service_role.
 *
 * The polling loop is the reason most of this file exists. Rebuilding a chart
 * every 60 s is the obvious implementation and it silently destroys every
 * interaction the user has performed — you cannot hold a zoom for longer than
 * one refresh. Charts are therefore created once and fed with setData(), and
 * view state (range, hidden rooms) lives outside them, in the URL.
 */
'use strict';

const CFG = window.ENVMON_CONFIG || {};
const THRESHOLD = CFG.humidityThreshold ?? 65;

/* Red is reserved for the mould threshold, so no room borrows it. */
const COLORS = ['#4fc3f7', '#ffd54f', '#81c784', '#ba68c8', '#4dd0e1', '#f06292'];

/* `view` picks the server-side rollup. Five-minute buckets are wasted on a
 * month — 4 sensors burn ~35k rows to draw a 300 px line — and PostgREST hands
 * back at most PAGE rows per request, so the coarse view is what keeps the long
 * ranges to one or two round trips. */
/* `companion` places a rolling set of dotted cursors behind the live one, at
 * step, 2*step, 3*step ... back. Park the crosshair on 06:00 and you get 06:00
 * on every previous day at once, which is the shape of the question here: not
 * "was yesterday worse" but "is this getting better or worse".
 *
 * An offset only means anything when it is shorter than the visible span --
 * beyond that the line falls off the left edge and never appears. So the short
 * views get none, the week steps by a day, and the month steps by a week
 * because 30 daily lines would be a picket fence. */
const RANGES = [
  { id: '6h',  label: '6 h',  hours: 6,       view: 'reading_5m', companion: null },
  { id: '24h', label: '24 h', hours: 24,      view: 'reading_5m', companion: null },
  { id: '7d',  label: '7 d',  hours: 24 * 7,  view: 'reading_1h',
    companion: { step: 86400,     max: 6, unit: 'd' } },
  { id: '30d', label: '30 d', hours: 24 * 30, view: 'reading_1h',
    companion: { step: 7 * 86400, max: 4, unit: 'w' } },
];

/* The floors below are "the smallest difference worth showing": 8 %RH and
 * 1.5 °C are about what you can feel in a room, and a battery that moves less
 * than 10 points over the window has, correctly, nothing to report. */
const Y_RH   = autoRange({ minSpan: 8,   clamp: [0, 100], near: THRESHOLD });
const Y_TEMP = autoRange({ minSpan: 1.5 });
const Y_BATT = autoRange({ minSpan: 10,  clamp: [0, 100] });

/* Enough line elements for the largest `max` above. */
const COMPANION_MAX = 6;

/* PostgREST's hard ceiling per response. Asking for more is silently ignored,
 * which is why this is a paging size and not a limit. */
const PAGE = 1000;

const SYNC = uPlot.sync('envmon');

let range = RANGES[1];
let hidden = new Set();          // macs the user has switched off
let rooms = [];                  // last render's room list
const charts = { rh: null, t: null, b: null };

const $ = (id) => document.getElementById(id);
const fmt1 = (v) => (v == null ? '—' : v.toFixed(1));

/* --- view state in the URL, so a filtered view is shareable ------------- */

function readUrl() {
  const q = new URLSearchParams(location.search);
  const r = RANGES.find((x) => x.id === q.get('range'));
  if (r) range = r;
  const off = q.get('hide');
  if (off) hidden = new Set(off.split(',').filter(Boolean));
}

function writeUrl() {
  const q = new URLSearchParams();
  q.set('range', range.id);
  if (hidden.size) q.set('hide', [...hidden].join(','));
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

/* --- data --------------------------------------------------------------- */

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

async function fetchRows(hours) {
  if (!CFG.supabaseUrl || !CFG.apiKey || CFG.token?.startsWith('PASTE_')) {
    throw new Error(
      'config.js is not filled in.\n\n' +
      'Copy config.example.js to config.js, then set supabaseUrl, apiKey\n' +
      '(the publishable key) and token (a dashboard_reader JWT, minted with\n' +
      'supabase/mint_dashboard_jwt.py in the firmware repo).');
  }
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  // apikey gets past the gateway; the Bearer JWT is what PostgREST SET ROLEs
  // to. Sending the JWT as apikey too is rejected before it reaches Postgres.
  const headers = { apikey: CFG.apiKey, Authorization: `Bearer ${CFG.token}` };

  /* Page until the server returns a short page. A bare `limit` cannot be
   * trusted: PostgREST caps responses at PAGE rows and says nothing about it,
   * so a single request quietly returned the OLDEST ~21 h and dropped
   * everything newer — the chart looked fine and was hours out of date.
   * The sort must be total (bucket, then mac) or rows shift between pages. */
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${CFG.supabaseUrl}/rest/v1/${range.view}` +
                `?select=bucket,mac,label,temp_c,humid,battery` +
                `&bucket=gte.${since}&order=bucket.asc,mac.asc` +
                `&limit=${PAGE}&offset=${offset}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Supabase returned ${res.status}\n\n${await res.text()}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < PAGE) return out;
    if (offset > 200_000) {          // never spin forever on a server change
      console.warn('envmon: stopped paging at', out.length, 'rows');
      return out;
    }
  }
}

/* PostgREST gives one row per (bucket, sensor); uPlot wants columns aligned on
 * a shared x. Rooms that missed a bucket get null, which breaks the line
 * instead of drawing a straight segment across a gap that never happened. */
function toSeries(rows) {
  const times = [...new Set(rows.map((r) => r.bucket))].sort();
  const index = new Map(times.map((t, i) => [t, i]));
  const byMac = new Map();

  for (const r of rows) {
    if (!byMac.has(r.mac)) {
      byMac.set(r.mac, {
        mac: r.mac,
        label: r.label || r.mac.slice(-5),
        humid: new Array(times.length).fill(null),
        temp: new Array(times.length).fill(null),
        batt: new Array(times.length).fill(null),
      });
    }
    const room = byMac.get(r.mac);
    const i = index.get(r.bucket);
    room.humid[i] = r.humid;
    room.temp[i] = r.temp_c;
    room.batt[i] = r.battery;
  }

  const list = [...byMac.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { x: times.map((t) => Date.parse(t) / 1000), rooms: list };
}

function classify(rh) {
  if (rh == null) return '';
  if (rh >= THRESHOLD + 5) return 'bad';
  if (rh >= THRESHOLD) return 'warn';
  return 'ok';
}

/* Least-squares %/day from the battery series, projected to 0 %.
 *
 * The H5075 reports whole percent, so over a short window the series is a
 * staircase of one or two steps and a fit through it is mostly quantisation
 * noise. Refuse to answer until the pack has actually moved MIN_DROP points:
 * a projection off a single step carries no information, and showing one is
 * worse than showing nothing. */
const MIN_DROP = 3;

function batteryLife(room, xs) {
  const pts = [];
  for (let i = 0; i < xs.length; i++) {
    if (room.batt[i] != null) pts.push([xs[i] / 86400, room.batt[i]]);
  }
  if (pts.length < 2) return { pct: pts.length ? pts[0][1] : null };
  const n = pts.length;
  const now = pts[n - 1][1];
  const spanDays = pts[n - 1][0] - pts[0][0];
  if (pts[0][1] - now < MIN_DROP) return { pct: now, spanDays };

  const mx = pts.reduce((a, q) => a + q[0], 0) / n;
  const my = pts.reduce((a, q) => a + q[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  const slope = den ? num / den : 0;          // % per day, negative while draining
  if (slope >= 0) return { pct: now, spanDays };
  return { pct: now, spanDays, perDay: -slope, daysLeft: now / -slope };
}

/* --- cards -------------------------------------------------------------- */

/* One line per card: the level now, and a projection only once it is earned. */
function battLine(room) {
  const b = room.life;
  if (!b || b.pct == null) return 'battery —';
  const pct = `battery ${b.pct}%`;
  if (b.daysLeft == null) return `${pct} · drain rate needs more data`;
  const months = b.daysLeft / 30.44;
  const left = months >= 2 ? `~${months.toFixed(1)} months left`
                           : `~${Math.round(b.daysLeft)} days left`;
  return `${pct} · ${b.perDay.toFixed(2)} %/day · ${left}`;
}

function renderCards() {
  const el = $('cards');
  el.innerHTML = '';
  rooms.forEach((room, i) => {
    const lastIdx = room.humid.reduce((acc, v, n) => (v != null ? n : acc), -1);
    const rh = lastIdx >= 0 ? room.humid[lastIdx] : null;
    const t = lastIdx >= 0 ? room.temp[lastIdx] : null;
    const isHidden = hidden.has(room.mac);

    const card = document.createElement('button');
    card.className = 'card' + (isHidden ? ' muted' : '');
    card.style.setProperty('--seriescolor', COLORS[i % COLORS.length]);
    card.title = isHidden ? 'Show this room' : 'Show only this room';
    card.innerHTML = `
      <div class="name">${room.label}</div>
      <div class="readings">
        <div class="reading">
          <div class="value ${classify(rh)}">${fmt1(rh)}<span class="unit">%</span></div>
          <div class="rlabel">humidity</div>
        </div>
        <div class="reading">
          <div class="value temp">${fmt1(t)}<span class="unit">°C</span></div>
          <div class="rlabel">temperature</div>
        </div>
      </div>
      <div class="batt">${battLine(room)}</div>`;

    /* Clicking a card isolates that room; clicking the isolated one restores
     * everything. The card is the thing you are already looking at when you
     * decide you want it alone, so it is a better filter target than a legend. */
    card.onclick = () => {
      const onlyThis = hidden.size === rooms.length - 1 && !hidden.has(room.mac);
      hidden = onlyThis ? new Set()
                        : new Set(rooms.filter((r) => r !== room).map((r) => r.mac));
      applyHidden();
      renderCards();
      writeUrl();
    };
    el.appendChild(card);
  });
}

/* --- charts ------------------------------------------------------------- */

/* uPlot has no wheel zoom of its own. Anchored on the cursor so the point under
 * the pointer stays put, and deliberately NOT bound to a bare wheel: a chart
 * that eats the scroll wheel makes the page impossible to scroll past. Zoom is
 * opt-in with a held modifier — which is also what a trackpad pinch sends, as
 * the browser synthesises ctrlKey for it. Drag-select still zooms, unmodified.
 *
 * `strength` is per wheel-delta unit rather than per event, so a trackpad's
 * stream of small deltas and a mouse's few large ones land in the same place;
 * `maxStep` stops one flick from swallowing the whole range. */
function wheelZoom({ strength = 0.0015, maxStep = 0.2 } = {}) {
  return {
    hooks: {
      ready: (u) => {
        u.over.addEventListener('wheel', (e) => {
          if (!e.ctrlKey && !e.metaKey) return;   // plain scroll is the page's
          if (!e.deltaY) return;
          e.preventDefault();
          const left = u.cursor.left;
          if (left == null || left < 0) return;
          const pct = left / u.over.clientWidth;
          const xVal = u.posToVal(left, 'x');
          const oldRange = u.scales.x.max - u.scales.x.min;
          const step = Math.max(-maxStep, Math.min(maxStep, e.deltaY * strength));
          const newRange = oldRange * Math.exp(step);
          const min = xVal - pct * newRange;
          u.batch(() => u.setScale('x', { min, max: min + newRange }));
        }, { passive: false });
      },
    },
  };
}

/* Rolling companion cursors: the same clock time one step back, two steps
 * back, and so on, fading with age.
 *
 * These CANNOT be canvas draw hooks. uPlot draws the plot once and moves the
 * real cursor as a DOM overlay, so a canvas line would only update on redraw
 * and would sit still while the mouse moved. They have to be DOM too, driven
 * from setCursor.
 *
 * The step is read live rather than captured, because the range can change
 * without the chart being rebuilt. */
function companionCursor() {
  return {
    hooks: {
      init: [(u) => {
        u.__companions = [];
        for (let k = 0; k < COMPANION_MAX; k++) {
          const line = document.createElement('div');
          line.className = 'u-companion';
          // Older lines fade, so depth reads at a glance and the nearest
          // comparison stays the most prominent.
          line.style.opacity = String(1 - k * 0.13);
          const tag = document.createElement('div');
          tag.className = 'u-companion-tag';
          line.appendChild(tag);
          u.over.appendChild(line);
          u.__companions.push({ line, tag });
        }
      }],
      setCursor: [(u) => {
        const set = u.__companions;
        if (!set) return;
        const cfg = range.companion;
        const left = u.cursor.left;
        const hideAll = () => set.forEach((c) => { c.line.style.display = 'none'; });
        if (!cfg || left == null || left < 0) return hideAll();

        // Anchor on the data point the legend is showing, not the raw pixel:
        // the legend snaps to the nearest bucket, so posToVal here would put
        // the lines a few minutes off the values being compared against.
        const cursorT = u.cursor.idx != null ? u.data[0][u.cursor.idx]
                                             : u.posToVal(left, 'x');
        for (let k = 0; k < set.length; k++) {
          const { line, tag } = set[k];
          const n = k + 1;
          const t = cursorT - n * cfg.step;
          // Past the start of the loaded range there is nothing to point at.
          if (n > cfg.max || t < u.scales.x.min) { line.style.display = 'none'; continue; }
          line.style.display = 'block';
          line.style.left = u.valToPos(t, 'x') + 'px';
          tag.textContent = '\u2212' + n + cfg.unit;
        }
      }],
    },
  };
}

/* Fixed y ranges made the short windows useless: a bedroom sitting between
 * 57 and 59 %RH is a dead flat line inside a 30-100 axis, and every 6 h view
 * looked identical. Scale to the data instead, with two guards.
 *
 * `minSpan` is the floor on how far the axis can close in. Without it a
 * half-percent of sensor noise would be stretched to fill 300 px and every
 * chart would look alarming; with it, a flat line is still drawn flat, which
 * is the honest picture.
 *
 * `clamp` keeps the axis inside what the quantity can actually be (no 104 %
 * humidity tick). It shifts the window rather than truncating it, so the
 * minimum span survives at the extremes -- a battery pinned at 100 % gets
 * 88-100, not a squashed 94-100. */
function autoRange({ minSpan, pad = 0.08, clamp = [-Infinity, Infinity], near = null }) {
  const [clampLo, clampHi] = clamp;
  const base = clampLo === -Infinity ? 0 : clampLo;
  return (u, dataMin, dataMax) => {
    /* Every series hidden: uPlot has no extents to offer. Any axis will do, so
     * long as it is a valid one. */
    if (dataMin == null || dataMax == null) return [base, base + minSpan];

    let lo = dataMin;
    let hi = dataMax;

    /* The reference line is pinned into view from `minSpan` below it upwards,
     * and never let go above it. That asymmetry is the point: a room already
     * over the mould line must be drawn *over the line*, or auto-scaling turns
     * a flat 78 % into an unremarkable flat trace. Well clear underneath, the
     * line is not news and holding it in frame would only flatten the trace. */
    if (near != null && hi >= near - minSpan) {
      lo = Math.min(lo, near);
      hi = Math.max(hi, near);
    }

    const span = Math.max(hi - lo, minSpan);
    const mid = (lo + hi) / 2;
    const p = span * pad;
    lo = mid - span / 2 - p;
    hi = mid + span / 2 + p;

    if (hi > clampHi) { const d = hi - clampHi; lo -= d; hi -= d; }
    if (lo < clampLo) { const d = clampLo - lo; lo += d; hi += d; }
    return [Math.max(lo, clampLo), Math.min(hi, clampHi)];
  };
}

function thresholdLine(value) {
  return {
    hooks: {
      draw: [(u) => {
        /* The y axis follows the data now, so the threshold is not always in
         * frame. Drawing it anyway would paint a red line across the axis
         * labels at whatever edge it fell off. */
        const { min, max } = u.scales.y;
        if (min == null || value < min || value > max) return;
        const y = u.valToPos(value, 'y', true);
        const ctx = u.ctx;
        ctx.save();
        ctx.strokeStyle = '#e53935';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(u.bbox.left, y);
        ctx.lineTo(u.bbox.left + u.bbox.width, y);
        ctx.stroke();
        ctx.restore();
      }],
    },
  };
}

function seriesDefs(valueFmt) {
  return rooms.map((room, i) => ({
    label: room.label,
    stroke: COLORS[i % COLORS.length],
    width: 2,
    spanGaps: false,
    show: !hidden.has(room.mac),
    value: (u, v) => (v == null ? '—' : valueFmt(v)),
  }));
}

function applyHidden() {
  for (const u of [charts.rh, charts.t, charts.b]) {
    if (!u) continue;
    rooms.forEach((room, i) => {
      const want = !hidden.has(room.mac);
      if (u.series[i + 1].show !== want) u.setSeries(i + 1, { show: want });
    });
  }
}

/* Rebuild only when the set of rooms changes. Otherwise feed the existing
 * chart, with resetScales=false so a zoom the user set survives the poll. */
function upsertChart(kind, target, data, valueFmt, yRange, threshold, resetScales) {
  const key = rooms.map((r) => r.mac).join(',');
  const existing = charts[kind];

  if (existing && existing.__key === key) {
    /* resetScales=false is what preserves a zoom across the 60 s poll. It must
     * be true when the window itself changed, or the new data is drawn inside
     * the old range — which looked like "the chart needs two clicks to load".
     *
     * uPlot skips its commit entirely when resetScales is false, so that path
     * has to re-assert the x window itself: without it the poll swapped the
     * data in and never repainted, and the y axis never re-fitted. Re-setting
     * the same min/max is what schedules the redraw. */
    const xs = data[0];
    const { min, max } = existing.scales.x;
    const prev = existing.data[0];

    /* "Live" means the window is still the whole dataset, so it should grow
     * with it. Anything narrower is a zoom the user chose, and is kept. */
    const live = min == null || max == null || !prev.length
                 || (min <= prev[0] && max >= prev[prev.length - 1]);

    if (resetScales === true || !xs.length) {
      existing.setData(data, true);
    } else {
      existing.setData(data, false);
      if (live) existing.setScale('x', { min: xs[0], max: xs[xs.length - 1] });
      else existing.setScale('x', { min, max });
    }
    return;
  }
  if (existing) existing.destroy();

  const el = $(target);
  const u = new uPlot({
    width: el.clientWidth || 900,
    height: 300,
    series: [{ label: 'Time' }, ...seriesDefs(valueFmt)],
    scales: { y: { range: yRange } },
    cursor: { sync: { key: SYNC.key } },
    axes: [
      { stroke: '#8b93a3', grid: { stroke: '#262b36' }, ticks: { stroke: '#262b36' } },
      { stroke: '#8b93a3', grid: { stroke: '#262b36' }, ticks: { stroke: '#262b36' } },
    ],
    plugins: threshold ? [wheelZoom(), companionCursor(), thresholdLine(threshold)]
                       : [wheelZoom(), companionCursor()],
    hooks: {
      /* Legend clicks change visibility inside uPlot; mirror it into our own
       * state so the cards, the URL and the other chart agree. */
      setSeries: [(u2, i, opts) => {
        if (!opts || opts.show === undefined || !rooms[i - 1]) return;
        const mac = rooms[i - 1].mac;
        opts.show ? hidden.delete(mac) : hidden.add(mac);
        applyHidden();
        renderCards();
        writeUrl();
      }],
    },
  }, data, el);

  u.__key = key;
  charts[kind] = u;
}

/* Setting the scale to null does not restore extents in uPlot — it has to be
 * pointed back at the data's own range explicitly. */
function resetZoom() {
  for (const u of [charts.rh, charts.t, charts.b]) {
    if (!u) continue;
    const xs = u.data[0];
    if (xs && xs.length) u.setScale('x', { min: xs[0], max: xs[xs.length - 1] });
  }
}

/* --- main loop ---------------------------------------------------------- */

/* `resetScales` belongs to the caller, not to this function: only the caller
 * knows whether the x window changed (range button) or is the same window
 * one poll later. */
async function refresh({ resetScales = false } = {}) {
  try {
    $('error').hidden = true;
    const rows = await fetchRows(range.hours);

    if (!rows.length) {
      $('empty').hidden = false;
      $('panel-rh').hidden = $('panel-t').hidden = $('panel-b').hidden = true;
      $('cards').innerHTML = '';
      setStatus('no data in range', 'stale');
      return;
    }
    $('empty').hidden = true;
    $('panel-rh').hidden = $('panel-t').hidden = $('panel-b').hidden = false;

    const shaped = toSeries(rows);
    rooms = shaped.rooms;
    for (const r of rooms) r.life = batteryLife(r, shaped.x);
    renderCards();

    upsertChart('rh', 'chart-rh', [shaped.x, ...rooms.map((r) => r.humid)],
                (v) => `${v.toFixed(1)} %`, Y_RH, THRESHOLD, resetScales);
    upsertChart('t', 'chart-t', [shaped.x, ...rooms.map((r) => r.temp)],
                (v) => `${v.toFixed(1)} °C`, Y_TEMP, null, resetScales);
    upsertChart('b', 'chart-b', [shaped.x, ...rooms.map((r) => r.batt)],
                (v) => `${v.toFixed(0)} %`, Y_BATT, null, resetScales);
    applyHidden();

    const newest = new Date(rows[rows.length - 1].bucket);
    setStatus(`updated ${newest.toLocaleTimeString()}`,
              (Date.now() - newest) / 60000 > 20 ? 'stale' : '');
  } catch (err) {
    $('error').hidden = false;
    $('error').textContent = err.message;
    setStatus('error', 'error');
  }
}

function buildControls() {
  const el = $('ranges');
  RANGES.forEach((r) => {
    const b = document.createElement('button');
    b.textContent = r.label;
    b.setAttribute('aria-pressed', String(r.id === range.id));
    b.onclick = () => {
      range = r;
      [...el.querySelectorAll('button[aria-pressed]')].forEach((c) =>
        c.setAttribute('aria-pressed', String(c === b)));
      writeUrl();
      refresh({ resetScales: true });
    };
    el.appendChild(b);
  });

  const reset = document.createElement('button');
  reset.className = 'ghost';
  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = navigator.platform.startsWith('Mac')
    ? 'drag to zoom · ⌘+scroll or pinch to zoom · double-click to reset'
    : 'drag to zoom · ctrl+scroll to zoom · double-click to reset';
  el.appendChild(hint);

  reset.textContent = 'Reset view';
  reset.title = 'Clear zoom and show every room';
  reset.onclick = () => {
    hidden = new Set();
    resetZoom();
    applyHidden();
    renderCards();
    writeUrl();
  };
  el.appendChild(reset);
}

/* Handles for the console and for the browser tests — uPlot draws its axes on
 * canvas, so scale state is not observable from the DOM. */
window.__envmon = {
  charts,
  refresh,
  resetZoom,
  batteryLife,          // exposed for tests: the projection is easy to get wrong
  get rooms() { return rooms; },
  get hidden() { return [...hidden]; },
};

readUrl();
$('thr').textContent = THRESHOLD;
buildControls();
writeUrl();
refresh();
setInterval(() => refresh(), 60_000);   // no args: the poll must not reset scales

/* Resize needs the chart resized, not rebuilt — rebuilding would drop zoom. */
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    for (const [kind, u] of Object.entries(charts)) {
      if (!u) continue;
      const el = $(kind === 'rh' ? 'chart-rh' : 'chart-t');
      u.setSize({ width: el.clientWidth, height: 300 });
    }
  }, 150);
});
