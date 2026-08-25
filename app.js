/* envmon dashboard — reads the reading_5m view from Supabase and plots it.
 *
 * The token in config.js is a dashboard_reader JWT scoped to that one view. It
 * is public by design: it ships in this page and can be read by anyone, which
 * is exactly why it is not the publishable key (INSERT-only, belongs to the
 * firmware) and not service_role.
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

let range = RANGES[1];
let charts = { rh: null, t: null };

const $ = (id) => document.getElementById(id);
const fmt1 = (v) => (v == null ? '—' : v.toFixed(1));

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

async function fetchRows(hours) {
  if (!CFG.supabaseUrl || CFG.token?.startsWith('PASTE_')) {
    throw new Error(
      'config.js is not filled in.\n\n' +
      'Copy config.example.js to config.js and paste a dashboard_reader JWT.\n' +
      'Mint one with supabase/mint_dashboard_jwt.py in the firmware repo.');
  }
  const since = new Date(Date.now() - hours * 3600e3).toISOString();
  const url = `${CFG.supabaseUrl}/rest/v1/reading_5m` +
              `?select=bucket,mac,label,temp_c,humid` +
              `&bucket=gte.${since}&order=bucket.asc&limit=20000`;

  const res = await fetch(url, {
    headers: { apikey: CFG.token, Authorization: `Bearer ${CFG.token}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase returned ${res.status}\n\n${body}`);
  }
  return res.json();
}

/* PostgREST gives one row per (bucket, sensor); uPlot wants columns aligned on
 * a shared x. Rooms that missed a bucket get null, which breaks the line
 * instead of drawing a straight segment across a gap that never happened. */
function toSeries(rows) {
  const times = [...new Set(rows.map((r) => r.bucket))].sort();
  const index = new Map(times.map((t, i) => [t, i]));

  const rooms = new Map();
  for (const r of rows) {
    if (!rooms.has(r.mac)) {
      rooms.set(r.mac, {
        mac: r.mac,
        label: r.label || r.mac.slice(-5),
        humid: new Array(times.length).fill(null),
        temp: new Array(times.length).fill(null),
      });
    }
    const room = rooms.get(r.mac);
    const i = index.get(r.bucket);
    room.humid[i] = r.humid;
    room.temp[i] = r.temp_c;
  }

  const list = [...rooms.values()].sort((a, b) => a.label.localeCompare(b.label));
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

function renderCards(rooms) {
  const el = $('cards');
  el.innerHTML = '';
  rooms.forEach((room, i) => {
    const lastIdx = room.humid.reduce((acc, v, n) => (v != null ? n : acc), -1);
    const rh = lastIdx >= 0 ? room.humid[lastIdx] : null;
    const t = lastIdx >= 0 ? room.temp[lastIdx] : null;
    const exp = exposure(room);

    const card = document.createElement('div');
    card.className = 'card';
    card.style.setProperty('--seriescolor', COLORS[i % COLORS.length]);
    card.innerHTML = `
      <div class="name">${room.label}</div>
      <div class="rh ${classify(rh)}">${fmt1(rh)}<span style="font-size:16px"> %</span></div>
      <div class="meta">${fmt1(t)} °C</div>
      <div class="exposure">${exp == null ? 'no data'
        : `${Math.round(exp * 100)}% of ${range.label} above ${THRESHOLD}%`}</div>
      <div class="bar"><span style="width:${Math.round((exp || 0) * 100)}%"></span></div>`;
    el.appendChild(card);
  });
}

function seriesDefs(rooms, valueFmt) {
  return rooms.map((room, i) => ({
    label: room.label,
    stroke: COLORS[i % COLORS.length],
    width: 2,
    spanGaps: false,
    value: (u, v) => (v == null ? '—' : valueFmt(v)),
  }));
}

function drawChart(target, existing, data, series, yRange, threshold) {
  if (existing) existing.destroy();
  const el = $(target);
  const opts = {
    width: el.clientWidth || 900,
    height: 300,
    series: [{ label: 'Time' }, ...series],
    scales: { y: yRange ? { range: () => yRange } : {} },
    axes: [
      { stroke: '#8b93a3', grid: { stroke: '#262b36' }, ticks: { stroke: '#262b36' } },
      { stroke: '#8b93a3', grid: { stroke: '#262b36' }, ticks: { stroke: '#262b36' } },
    ],
    hooks: threshold ? {
      draw: [(u) => {
        const y = u.valToPos(threshold, 'y', true);
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
    } : {},
  };
  return new uPlot(opts, data, el);
}

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

    const { x, rooms } = toSeries(rows);
    renderCards(rooms);

    charts.rh = drawChart('chart-rh', charts.rh,
      [x, ...rooms.map((r) => r.humid)],
      seriesDefs(rooms, (v) => `${v.toFixed(1)} %`),
      [30, 100], THRESHOLD);

    charts.t = drawChart('chart-t', charts.t,
      [x, ...rooms.map((r) => r.temp)],
      seriesDefs(rooms, (v) => `${v.toFixed(1)} °C`),
      null, null);

    const newest = new Date(rows[rows.length - 1].bucket);
    const ageMin = (Date.now() - newest) / 60000;
    setStatus(`updated ${newest.toLocaleTimeString()}`,
              ageMin > 20 ? 'stale' : '');
  } catch (err) {
    $('error').hidden = false;
    $('error').textContent = err.message;
    setStatus('error', 'error');
  }
}

function buildRangeButtons() {
  const el = $('ranges');
  RANGES.forEach((r) => {
    const b = document.createElement('button');
    b.textContent = r.label;
    b.setAttribute('aria-pressed', String(r.id === range.id));
    b.onclick = () => {
      range = r;
      [...el.children].forEach((c) =>
        c.setAttribute('aria-pressed', String(c === b)));
      refresh();
    };
    el.appendChild(b);
  });
}

$('thr').textContent = THRESHOLD;
buildRangeButtons();
refresh();
setInterval(refresh, 60_000);
window.addEventListener('resize', () => refresh());
