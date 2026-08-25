# envmon dashboard

Live view of Govee H5075 humidity/temperature sensors, reading from Supabase.
Companion to the firmware in
[ESP32-C6-Touch-AMOLED-1.8](https://github.com/chayuto/ESP32-C6-Touch-AMOLED-1.8)
(`projects/18_govee_monitor`), which is what puts the readings there.

```
board ──3-min buckets──> Supabase ──reading_5m──> this page
```

Built for one question — **is any room sitting above the mould line?** — rather
than for pretty curves. Everything below follows from that.

## Design notes

**The humidity axis is fixed at 30–100 % with a threshold line at 65 %.**
Auto-scaling is actively misleading here: it renders a 74 → 76 % wiggle as a
mountain range and a flat, dangerous 78 % as unremarkable. Temperature *is*
auto-scaled, because there the shape matters more than the absolute value.

**Each card shows time spent above the threshold, not just the latest reading.**
For damp, a brief spike is nothing and a persistent 78 % is the entire problem —
and the two look almost identical on a line chart.

**Gaps are drawn as gaps.** A sensor that missed a bucket leaves a break in the
line rather than a straight segment across time that was never measured. Weak
sensors do drop advertisements, so this is common and honest.

**Red is reserved for the threshold**, so no room's series borrows it.

## Interaction

| Gesture | Effect |
|---|---|
| Click a room card | show only that room; click it again to restore all |
| Click a legend entry | toggle that room |
| Drag across a chart | zoom the time axis |
| Scroll on a chart | zoom around the pointer |
| Hover | crosshair on **both** charts at the same instant |
| Reset view | clear zoom and show every room |

Zoom and room selection **survive the 60-second poll**. That sounds like a
detail and is the main reason this file is not fifty lines shorter: the obvious
implementation rebuilds the chart on every refresh, which silently throws away
whatever the user was looking at, so you can never hold a zoom for longer than
one minute. Charts are created once and fed with `setData(..., false)`, and
view state lives outside them.

The range and the room filter are kept in the URL, so a filtered view is a
shareable link.

## Setup

```sh
cp config.example.js config.js     # then paste your token
python3 -m http.server 8000        # open http://127.0.0.1:8000
```

`preview.html` runs the whole UI against synthetic data — no token, no
database. Use it to work on the visuals offline.

## The token

`config.js` holds a **`dashboard_reader` JWT**, which can `SELECT` the
`reading_5m` view and nothing else. It ships inside this page and is public by
design.

It is deliberately **not** the Supabase publishable key. Every publishable key
maps to the same `anon` role, so sharing one would weld this dashboard's
credential to the firmware's: rotating a leaked dashboard token would mean
reflashing the board. Separate roles keep them independent.

It is also **not** a secret key — Supabase refuses those from a browser
outright, which is the correct behaviour.

Mint one with `supabase/mint_dashboard_jwt.py` in the firmware repo. The
signing secret stays there; only the minted token belongs here.

## Stack

Static files, no build step: vanilla JS plus a vendored copy of
[uPlot](https://github.com/leeoniya/uPlot) (MIT). Nothing to install, nothing
to keep up to date, and deploying is committing.

No framework, deliberately. Zoom, pan, crosshairs and series toggling belong to
the charting library, not to a UI framework — React would add none of them, and
would hit the same "re-render destroyed the chart's state" problem, solved the
same way with an imperative update. With four sensors and two charts there is
no cross-component state worth a build step. If this ever grows into many views
with saved layouts, that is the point to reconsider.

`window.__envmon` exposes the chart instances, room list and refresh for
console poking; uPlot draws axes to canvas, so scale state is not otherwise
observable.
