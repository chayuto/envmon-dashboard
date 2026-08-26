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

const RANGES = [
  { id: '6h',  label: '6 h',  hours: 6 },
  { id: '24h', label: '24 h', hours: 24 },
  { id: '7d',  label: '7 d',  hours: 24 * 7 },
  { id: '30d', label: '30 d', hours: 24 * 30 },
];

const SYNC = uPlot.sync('envmon');

let range = RANGES[1];
let hidden = new Set();          // macs the user has switched off
let rooms = [];                  // last render's room list
const charts = { rh: null, t: null };

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
  const url = `${CFG.supabaseUrl}/rest/v1/reading_5m` +
              `?select=bucket,mac,label,temp_c,humid` +
              `&bucket=gte.${since}&order=bucket.asc&limit=20000`;

  // apikey gets past the gateway; the Bearer JWT is what PostgREST SET ROLEs
  // to. Sending the JWT as apikey too is rejected before it reaches Postgres.
  const res = await fetch(url, {
    headers: { apikey: CFG.apiKey, Authorization: `Bearer ${CFG.token}` },
  });
  if (!res.ok) throw new Error(`Supabase returned ${res.status}\n\n${await res.text()}`);
  return res.json();
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
      });
    }
    const room = byMac.get(r.mac);
    const i = index.get(r.bucket);
    room.humid[i] = r.humid;
    room.temp[i] = r.temp_c;
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

/* Share of the window each room spent above the threshold. For damp this is
 * the number that matters — a brief spike is nothing, a persistent 78 % is the
 * whole problem, and both look similar on a line chart. */
function exposure(room) {
  const seen = room.humid.filter((v) => v != null);
  if (!seen.length) return null;
  return seen.filter((v) => v >= THRESHOLD).length / seen.length;
}

/* --- cards -------------------------------------------------------------- */

function renderCards() {
  const el = $('cards');
  el.innerHTML = '';
  rooms.forEach((room, i) => {
    const lastIdx = room.humid.reduce((acc, v, n) => (v != null ? n : acc), -1);
    const rh = lastIdx >= 0 ? room.humid[lastIdx] : null;
    const t = lastIdx >= 0 ? room.temp[lastIdx] : null;
    const exp = exposure(room);
    const isHidden = hidden.has(room.mac);

    const card = document.createElement('button');
    card.className = 'card' + (isHidden ? ' muted' : '');
    card.style.setProperty('--seriescolor', COLORS[i % COLORS.length]);
    card.title = isHidden ? 'Show this room' : 'Show only this room';
    card.innerHTML = `
      <div class="name">${room.label}</div>
      <div class="rh ${classify(rh)}">${fmt1(rh)}<span class="unit"> %</span></div>
      <div class="meta">${fmt1(t)} °C</div>
      <div class="exposure">${exp == null ? 'no data'
        : `${Math.round(exp * 100)}% of ${range.label} above ${THRESHOLD}%`}</div>
      <div class="bar"><span style="width:${Math.round((exp || 0) * 100)}%"></span></div>`;

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
  for (const u of [charts.rh, charts.t]) {
    if (!u) continue;
    rooms.forEach((room, i) => {
      const want = !hidden.has(room.mac);
      if (u.series[i + 1].show !== want) u.setSeries(i + 1, { show: want });
    });
  }
}

/* Rebuild only when the set of rooms changes. Otherwise feed the existing
 * chart, with resetScales=false so a zoom the user set survives the poll. */
function upsertChart(kind, target, data, valueFmt, yRange, threshold) {
  const key = rooms.map((r) => r.mac).join(',');
  const existing = charts[kind];

  if (existing && existing.__key === key) {
    existing.setData(data, false);
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
    plugins: threshold ? [wheelZoom(), thresholdLine(threshold)] : [wheelZoom()],
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
  for (const u of [charts.rh, charts.t]) {
    if (!u) continue;
    const xs = u.data[0];
    if (xs && xs.length) u.setScale('x', { min: xs[0], max: xs[xs.length - 1] });
  }
}

/* --- main loop ---------------------------------------------------------- */

async function refresh() {
  try {
    $('error').hidden = true;
    const rows = await fetchRows(range.hours);

    if (!rows.length) {
      $('empty').hidden = false;
      $('panel-rh').hidden = $('panel-t').hidden = true;
      $('cards').innerHTML = '';
      setStatus('no data in range', 'stale');
      return;
    }
    $('empty').hidden = true;
    $('panel-rh').hidden = $('panel-t').hidden = false;

    const shaped = toSeries(rows);
    rooms = shaped.rooms;
    renderCards();

    upsertChart('rh', 'chart-rh', [shaped.x, ...rooms.map((r) => r.humid)],
                (v) => `${v.toFixed(1)} %`, [30, 100], THRESHOLD);
    upsertChart('t', 'chart-t', [shaped.x, ...rooms.map((r) => r.temp)],
                (v) => `${v.toFixed(1)} °C`, null, null);
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
      resetZoom();
      writeUrl();
      refresh();
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
  get rooms() { return rooms; },
  get hidden() { return [...hidden]; },
};

readUrl();
$('thr').textContent = THRESHOLD;
buildControls();
writeUrl();
refresh();
setInterval(refresh, 60_000);

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
