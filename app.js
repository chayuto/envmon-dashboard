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
const RANGES = [
  { id: '6h',  label: '6 h',  hours: 6,       view: 'reading_5m' },
  { id: '24h', label: '24 h', hours: 24,      view: 'reading_5m' },
  { id: '7d',  label: '7 d',  hours: 24 * 7,  view: 'reading_1h' },
  { id: '30d', label: '30 d', hours: 24 * 30, view: 'reading_1h' },
];

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

/* A second cursor line, offset from the live one by a fixed interval.
 *
 * This CANNOT be a canvas draw hook: uPlot draws the plot once and moves the
 * real cursor as a DOM overlay, so a canvas line would only update on redraw
 * and would sit still while the mouse moved. It has to be DOM too, positioned
 * from the setCursor hook.
 *
 * Default offset is 24 h back, which is the comparison this dashboard is for:
 * park the cursor on 06:00 today and the dotted line is 06:00 yesterday, so
 * "is this dawn worse than the last one" is a glance instead of arithmetic. */
function companionCursor(offsetSec = 86400) {
  return {
    hooks: {
      init: [(u) => {
        const line = document.createElement('div');
        line.className = 'u-companion';
        const tag = document.createElement('div');
        tag.className = 'u-companion-tag';
        line.appendChild(tag);
        u.over.appendChild(line);
        u.__companion = line;
        u.__companionTag = tag;
      }],
      setCursor: [(u) => {
        const line = u.__companion;
        if (!line) return;
        const left = u.cursor.left;
        if (left == null || left < 0) { line.style.display = 'none'; return; }

        // Anchor on the data point the legend is showing, not the raw pixel:
        // the legend snaps to the nearest bucket, so posToVal here would put
        // the line a few minutes off the value being compared against.
        const cursorT = u.cursor.idx != null ? u.data[0][u.cursor.idx]
                                             : u.posToVal(left, 'x');
        const t = cursorT - offsetSec;
        // Off the left edge once the cursor is within one offset of the start:
        // there is no yesterday to compare against, so show nothing.
        if (t < u.scales.x.min) { line.style.display = 'none'; return; }

        line.style.display = 'block';
        line.style.left = u.valToPos(t, 'x') + 'px';
        u.__companionTag.textContent =
          new Date(t * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
          + ' \u2212' + Math.round(offsetSec / 3600) + 'h';
      }],
    },
  };
}

function thresholdLine(value) {
  return {
    hooks: {
      draw: [(u) => {
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
     * the old range — which looked like "the chart needs two clicks to load". */
    existing.setData(data, resetScales === true);
    return;
  }
  if (existing) existing.destroy();

  const el = $(target);
  const u = new uPlot({
    width: el.clientWidth || 900,
    height: 300,
    series: [{ label: 'Time' }, ...seriesDefs(valueFmt)],
    scales: { y: yRange ? { range: () => yRange } : {} },
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
                (v) => `${v.toFixed(1)} %`, [30, 100], THRESHOLD, resetScales);
    upsertChart('t', 'chart-t', [shaped.x, ...rooms.map((r) => r.temp)],
                (v) => `${v.toFixed(1)} °C`, null, null, resetScales);
    upsertChart('b', 'chart-b', [shaped.x, ...rooms.map((r) => r.batt)],
                (v) => `${v.toFixed(0)} %`, [0, 100], null, resetScales);
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
