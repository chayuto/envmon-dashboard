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
