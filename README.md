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

**Every axis auto-scales, with a floor on how far it can close in.** A fixed
30–100 % humidity axis made the short windows useless — a room breathing
between 57 and 59 %RH was a dead flat line, and every 6 h view looked the same.
So the axis follows the data, but never narrows below a minimum span (8 %RH,
1.5 °C, 10 % battery). That floor is what stops the other failure: half a
percent of sensor noise stretched across 300 px and read as a crisis.

**The mould line stays pinned in view from 8 %RH below it upwards.** Auto-scaling
alone would render a flat, dangerous 78 % as unremarkable, so the humidity axis
is never allowed to crop the threshold away while a room is near or above it.
Well clear underneath, the line is not news and is let go rather than flattening
the trace to hold it in frame.

**Absolute humidity (g/m³) is the number the house is actually judged on.**
Relative humidity is a ratio against what air can hold at its own temperature,
so it says nothing comparable between two rooms at different temperatures, or
between inside and outside. The two humidity panels are deliberately adjacent
and show the same data: outdoor is the *top* line on the RH chart, peaking near
90 %, and the *bottom* line on the absolute humidity chart. Airing the house at
that moment dries it, and only one of the two charts can tell you so.

**Each card carries a ventilation verdict and a condensation margin.** The
verdict is indoor minus outdoor g/m³ with the temperature cost, because the
recurring question is "should I open a window now" and RH cannot answer it. The
condensation margin is the room's dew point against the **coldest** outdoor
temperature in view, not the current one — condensation is an overnight event,
and a margin measured at midday reads safe until it is too late to act.

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
