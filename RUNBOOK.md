# Runbook - Homey Energy Insights

Handover document for this repository. It is written so that a different developer, or a different
AI assistant with no memory of how this was built, can pick the work up without re-deriving any of
the reasoning. It records **what exists, why it is built that way, what has actually been verified,
and what has not**.

- App id: `com.homey.energyinsights` - version `1.0.0` - Homey SDK v3
- Branch: `claude/homey-energy-insights-app-isy2dw`
- Last verified state: `homey app validate --level publish` passes, 35/35 tests pass.

---

## 1. Status at a glance

| Area | State |
|---|---|
| App manifest, Flow cards, capabilities, driver, widget | Complete, composed, validated at `publish` level |
| Data collection across all devices | Complete (`lib/DeviceMonitor.js`) |
| Timeline storage with a fixed memory budget | Complete (`lib/SampleBuffer.js`, `lib/TimelineStore.js`) |
| Peak detection + "why" attribution | Complete (`lib/EventDetector.js`), unit tested |
| Dashboard (settings page) | Complete, rendered and reviewed in Chromium |
| Dashboard widget | Complete, rendered and reviewed in Chromium |
| Flow cards wired to listeners | Complete, exercised by the integration test |
| Web API | Complete, exercised by the integration test |
| **Run on real Homey hardware** | **Never done - see section 11** |

---

## 2. Quick start

```bash
npm install
npm test                  # 35 tests, pure Node, no Homey needed
npm run validate          # homey app validate --level publish
npm run build             # composes .homeycompose/ -> app.json, then validates
npm start                 # homey app run  (requires `homey login` and a Homey on the network)
```

Regenerating screenshots and artwork needs a Chromium:

```bash
npx playwright install chromium     # or export CHROMIUM_PATH=/path/to/chrome
npm run preview                     # -> tools/preview/out/
npm run assets                      # overwrites the committed PNGs
```

`app.json` is **generated** from `.homeycompose/` by `homey app build`. Edit the compose sources,
never `app.json` directly - a test (`test/assets.test.js`) fails if the two drift apart.

---

## 3. Repository map

```
app.js                    Orchestrator: sampling loop, Flow cards, persistence, public methods
api.js                    Web API handlers (routes declared in .homeycompose/app.json -> "api")
app.json                  GENERATED manifest - do not hand-edit
.homeycompose/            Manifest sources
  app.json                Identity, permissions, images, API routes
  flow/{triggers,conditions,actions}/*.json   One file per Flow card; filename = card id
  capabilities/*.json     Custom capabilities (energy_peak_reason, energy_self_sufficiency)
lib/
  constants.js            Tiers, defaults, hard limits, marker types and colour keys
  util.js                 clamp/round/format/formatWatts/ema/uid/startOfDay
  SampleBuffer.js         Columnar typed-array ring buffer + peak-preserving decimation
  TimelineStore.js        Three resolution tiers fed from one sample; range queries
  NumericRing.js          Tiny Float32 ring for per-device power history
  MarkerStore.js          Bounded, deduplicated, persisted annotation store
  DeviceMonitor.js        homey-api wiring: capability instances, roles, device events
  EnergyAggregator.js     Device readings -> usage/solar/net + today's statistics
  EventDetector.js        Peak detection, attribution ("why"), solar and feed-in events
drivers/energy-insights/  Virtual mirror device (driver.js, device.js, driver.compose.json)
settings/                 Dashboard: index.html, style.css, dashboard.js, timeline-chart.js
widgets/energy-timeline/  Dashboard widget: widget.compose.json, api.js, public/, preview-*.png
locales/{en,nl}.json      UI strings and the marker/reason templates
test/                     35 tests: detector, storage, packaging, full app integration
tools/preview/            Headless Chromium harnesses for screenshots and artwork
assets/                   App icon, store images, capability icons
```

---

## 4. Runtime architecture

```
Homey devices
     │  measure_power / onoff capability instances (push, never polled)
     ▼
DeviceMonitor ──────────────┐
  Map<id, record>           │ 'onoff' event ──► app.addMarker()  (immediate)
  record.history (ring)     │
     │                      │
     │  every sampleInterval (default 5s) app._tick():
     ▼
EnergyAggregator.aggregate(devices)  ──► totals {consumption, solar, net, unmetered, …}
     │                                        │
     ├──► TimelineStore.ingest()              ├──► EventDetector.update()
     │      live / mid / day tiers            │      peaks + attribution, solar, feed-in
     │                                        ▼
     │                                   events ──► MarkerStore.add() + Flow triggers
     ▼
app.getState() ──► realtime broadcast ──► settings page + widget
                └► app.events ──────────► mirror device capabilities
```

Two rules hold this together:

1. **Capability changes never write to storage.** They only update the in-memory device record.
   Storage happens once per tick. A chatty energy meter therefore costs the same as a quiet one.
2. **Every buffer is pre-allocated.** Nothing in the hot path grows with uptime.

---

## 5. Design decisions and why

### 5.1 Fixed-cadence sampling instead of event-driven writes
A P1 meter can report ten times a second. Writing each report to the timeline would make both the
sample count and the render cost depend on which hardware the user owns. Instead, capability
listeners only update `record.power`, and `app._tick()` takes one consistent cross-section of the
whole house every `sampleInterval` seconds. Peaks are not lost: the bucket keeps the maximum
(see 5.3).

### 5.2 Three storage tiers, all pre-allocated
`TIERS` in `lib/constants.js`:

| Tier | Interval | Capacity | Span | Bytes |
|---|---|---|---|---|
| `live` | 5 s | 1080 | 1.5 h | 25.9 kB |
| `mid` | 60 s | 720 | 12 h | 17.3 kB |
| `day` | 300 s | 576 | 48 h | 13.8 kB |

**Total 57 024 bytes, constant for the life of the app.** Every sample is fed to all three tiers;
each tier accumulates into the bucket it is filling and commits one averaged sample per bucket.
`TimelineStore.query()` picks the finest tier that both covers the requested window and does not
blow the point budget, and appends the tier's uncommitted bucket so the live view is never one
bucket behind.

### 5.3 Decimation keeps maxima, not averages
`SampleBuffer.read()` averages the three series per output bucket but carries the **maximum**
consumption in a separate `peak` column. Zooming out to 24 hours therefore cannot hide a spike -
which is the entire point of this app. The chart draws that column as a faint envelope above the
usage line, and only when it actually differs from the average.

### 5.4 Two energy balance models
In `lib/EnergyAggregator.js`:

- **With a grid meter** (a device whose role is `grid`): the meter is authoritative for `net`, and
  `usage = net + solar + batteryDischarge - batteryCharge`. What the metered consumers do not
  explain is reported as `unmetered`, and the peak explanation can name it instead of blaming the
  wrong device.
- **Without one**: `usage = Σ consumers + batteryCharge` and `net = usage - solar - batteryDischarge`.

Battery discharge counts as production and battery charge as consumption, which is what makes the
net figure physically correct in both models.

### 5.5 Role detection, and why it is overridable
`DeviceMonitor._detectRole()` uses, in order: device class `solarpanel` -> solar; class `battery`
or `energy.homeBattery` -> battery; `energy.cumulative` or a cumulative import/export capability ->
grid; then name and driver hints (`HINTS` regexes, English and Dutch); otherwise consumer. Hints
are a heuristic and will be wrong for someone, so the Devices tab writes an override into
`homey.settings` under `deviceRoles` and that always wins.

### 5.6 Peak detection against a frozen baseline
A fixed threshold alone fires constantly in a 2 kW home and never in a 200 W one. `EventDetector`
keeps an exponential baseline (120 s time constant, frame-rate independent via `util.ema`), and a
peak needs **both** `value >= peakThreshold` **and** `value - baseline >= peakDelta`. While a peak
is active the baseline is **frozen** - otherwise the peak drags its own reference upwards and ends
early. The peak ends at 90% of the threshold (hysteresis), and `peakCooldown` stops one long load
from producing a burst of markers.

### 5.7 How the "why" sentence is built
`EventDetector.explain()`:

1. Ask `DeviceMonitor.getDeltas(steps)` for every metered device's change over the attribution
   window (default 60 s), sorted by biggest riser.
2. Drop solar and grid devices - they are not loads.
3. A drop in solar production raises net import exactly like a device switching on, so it competes
   for the explanation as `solarDrop` on equal terms in the share calculation.
4. Devices that hold >= 15% of the rise (max two) get named. Phrasing is "starting" when the device
   fired an `onoff` event inside the window or came up from standby, otherwise "ramping up".
5. With a grid meter, an unexplained rise is attributed to `Unmetered load`.
6. The sentence is assembled from `reason.*` templates in `locales/`, filled by `util.format`.

Placeholders are `{single braces}` and are substituted by this app, not by Homey's i18n backend.
That is deliberate: it keeps the locale files portable and a missing key degrades to readable text
instead of throwing.

### 5.8 Solar peaks are reported after the turn-around
Reporting "a new solar maximum" whenever production sets a record would place a marker on *every
sample of a rising curve*. Instead the maximum is held and only annotated once production drops to
85% of it, and the marker is placed at the **time the maximum occurred**, not at confirmation time.
A later maximum is annotated again only if it beats the reported one by 10% or 30 minutes have
passed (`SOLAR_PEAK_*` constants in `lib/EventDetector.js`). This was found by a failing test; see
`test/detector.test.js` - "reports solar milestones and feed-in transitions".

### 5.9 A hand-written canvas chart instead of Chart.js
The annotation layer is the product. Markers need their own lane, clustering, hit testing, shape
encoding and a tooltip that can carry a sentence. `settings/timeline-chart.js` is ~900 lines with
no dependencies, redraws on a dirty flag via `requestAnimationFrame`, is device-pixel-ratio aware,
and supports pan, zoom, live-follow and touch. That is smaller than the library would have been
and gives full control over how peaks are drawn.

### 5.10 The widget has its own copy of the chart
Homey serves widget assets from `widgets/<id>/public/` and a widget cannot reach the settings
folder, so `timeline-chart.js` is duplicated there. `test/assets.test.js` compares the two files
byte for byte and fails if they drift. **After editing `settings/timeline-chart.js`, run:**

```bash
cp settings/timeline-chart.js widgets/energy-timeline/public/timeline-chart.js
```

### 5.11 Persistence is deliberately small
`app._persist()` writes the coarsest tier, the markers and today's statistics to
`homey.settings`. Homey settings are a key/value store, not a database, so the payload is size
checked against `LIMITS.maxPersistBytes` (256 kB); over budget it sheds markers first, then keeps
markers only. It runs every 5 minutes and on `unload`.

### 5.12 Memory warnings are handled
`homey.on('memwarn')` clears the live tier and halves the marker capacity. Homey warns before it
starts killing apps; this is the app giving memory back while staying useful.

---

## 6. The colour system

Series and marker colours were **validated, not chosen by eye**, with the palette validator from
the `dataviz` skill (`scripts/validate_palette.js`, OKLab ΔE ×100).

| Role | Light | Dark |
|---|---|---|
| Power usage | `#2a78d6` | `#3987e5` |
| Solar production | `#eda100` | `#c98500` |
| Net grid power | `#1baf7a` | `#199e70` |
| Peak (reserved status colour) | `#e34948` | `#d93a39` |

All-pairs results for that four-colour set: light **PASS** (worst CVD ΔE 6.9 red↔aqua deutan,
worst normal-vision ΔE 20.8); dark **PASS** (worst CVD ΔE 7.4 red↔aqua deutan, worst normal-vision
ΔE 16.6). Both CVD figures sit in the 6-8 band, which is only legal with a **secondary encoding** -
which is why:

- peaks are drawn as a **diamond**, everything else as a **circle**;
- events that mark an *ending* (`device_off`, `solar_end`, `feed_in_end`) are drawn as an
  **outline** instead of a fill;
- every marker also appears as text in the event list and the tooltip.

The light-mode contrast WARN for amber (2.11:1) and teal (2.74:1) is answered by the **relief
rule**: the legend shows each series' live value as a direct label, and the event list is a
readable table of every marker.

Other decisions that came out of this:

- **Net grid power is one hue, not red-for-import / green-for-export.** Polarity is already
  encoded perfectly by position relative to the zero line, and red-vs-green is the one pair
  colour-blind viewers cannot separate.
- **Markers are coloured by domain, not per type** - device events wear the usage colour, solar
  events the solar colour, grid events the net colour - so a marker points at the line it explains.
  Five hues side by side cannot pass the all-pairs floors; four plus a neutral can.
- **Text never wears a series colour.** Tooltip rows carry a swatch and the text stays in ink.

To re-validate after changing any colour, from the `dataviz` skill directory:

```bash
node scripts/validate_palette.js "#2a78d6,#eda100,#1baf7a,#e34948" --mode light --pairs all
node scripts/validate_palette.js "#3987e5,#c98500,#199e70,#d93a39" --mode dark  --pairs all
```

All values live in `settings/style.css` as `--ei-*` custom properties (and a second copy inside
`widgets/energy-timeline/public/index.html`, since a widget cannot load that stylesheet). The
canvas reads them through `getComputedStyle`, so there is no theme logic in JavaScript.

---

## 7. Flow cards

| Kind | Id | Arguments | Notes |
|---|---|---|---|
| Trigger | `power_peak_above` | `watts` | Run listener compares `state.watts >= args.watts`. Tokens include `reason`. |
| Trigger | `device_caused_spike` | `device` (autocomplete) | Autocomplete is served from `DeviceMonitor.snapshot()`; `__any__` matches every attributed spike. |
| Trigger | `solar_peak_reached` | - | Fires at turn-around confirmation (5.8). |
| Trigger | `feed_in_started` | - | Fires when net crosses below `-solarStartThreshold`. |
| Trigger | `marker_added` | - | Fires for **every** marker, including ones added by the action below. |
| Condition | `usage_higher_than_solar` | `margin` | The card the brief asked for. |
| Condition | `is_feeding_in` | - | |
| Condition | `series_above` | `series`, `watts` | consumption / solar / net. |
| Action | `add_marker` | `label`, `colour` | Returns a `watts` token. |
| Action | `set_peak_threshold` | `watts` | Writes through `app.setConfig()`. |

Autocomplete was chosen over Homey's built-in `device` argument type because the app already owns
the authoritative device list and can offer an "any device" entry.

---

## 8. Web API

Routes are declared in `.homeycompose/app.json` under `"api"` and implemented in `/api.js`.
The dashboard fetches `/timeline` once per range change and then follows realtime events.

| Method | Path | Purpose |
|---|---|---|
| GET | `/state` | Live totals + today's statistics |
| GET | `/timeline?from=&to=&points=` | Series + markers for a window |
| GET | `/markers?from=&to=&types=` | Markers only |
| POST | `/markers` | Add a custom marker (`{label, color?, t?, watts?}`) |
| DELETE | `/markers/:id` | Remove one |
| DELETE | `/markers` | Clear all |
| GET | `/devices` | Tracked devices, roles, current power |
| PUT | `/devices/:id/role` | Override a role |
| GET / PUT | `/config` | Read / patch configuration (unknown keys dropped, values clamped) |
| GET | `/diagnostics` | Buffer occupancy, bytes, heap |

Realtime events broadcast to open dashboards: `state` (throttled to 1/s), `marker`,
`markers-changed`, `config`, `devices`.

---

## 9. Configuration

Stored in `homey.settings` under `config`, merged over `DEFAULTS` and clamped on every read by
`app._loadConfig()` - a bad value can never reach the sampling loop.

| Key | Default | Clamp | Meaning |
|---|---|---|---|
| `sampleInterval` | 5 | 2-60 s | Timeline cadence |
| `peakThreshold` | 3000 | 50-100000 W | Peak level |
| `peakDelta` | 750 | 0-100000 W | Minimum rise above baseline |
| `peakSource` | `consumption` | `consumption`\|`net` | What peaks are measured on |
| `peakCooldown` | 120 | 10-3600 s | Minimum gap between peaks |
| `attributionWindow` | 60 | 10-600 s | Look-back for the "why" |
| `minMarkerPower` | 150 | 0-100000 W | Below this, on/off is not annotated |
| `markerRetentionHours` | 48 | 1-168 h | Marker age limit |
| `markerCapacity` | 400 | 10-1000 | Marker count limit |
| `trackDeviceSwitches` | true | | Device on/off markers |
| `trackSolarEvents` | true | | Solar and feed-in markers |
| `solarStartThreshold` | 50 | 1-10000 W | "Solar is producing" level |
| `debug` | false | | Verbose broadcast errors |

Other stored keys: `deviceRoles` (role overrides), `snapshot` (persisted timeline + markers).

---

## 10. Test suite

`npm test` - 35 tests, no Homey, no network.

| File | Covers |
|---|---|
| `test/detector.test.js` | Peak attribution wording, two-device peaks, cooldown, solar/feed-in events, sub-threshold silence, unmetered attribution |
| `test/storage.test.js` | Ring wrap-around, peak-preserving decimation, tier selection, point caps, the 128 kB memory budget, snapshot round trip, marker caps/dedupe/ordering |
| `test/assets.test.js` | Widget chart copy is in sync, every manifest image exists, `app.json` matches the compose sources, every Flow card is referenced by `app.js` |
| `test/app.test.js` | **Boots the real `app.js`** against stubbed `homey` / `homey-api` modules: discovery, roles, sampling, markers, peak explanation, all Flow listeners, the whole Web API, clamping, broadcasts, persistence, restore, listener cleanup |

`test/stubs/` holds the fake Homey runtime. `test/app.test.js` swaps the modules in by patching
`Module._resolveFilename` before `app.js` is required, so the app is exercised exactly as Homey
would load it. Extend the stubs rather than mocking around them.

---

## 11. What has NOT been verified

Be honest about this with whoever continues:

1. **The app has never run on a Homey.** Everything was verified by the CLI validator, the test
   suite and Chromium renders. No device, firmware or real webview has executed this code.
2. **`homey-api` calls are written against the documented v3 surface** (`HomeyAPI.createAppAPI`,
   `devices.getDevices`, `devices.connect`, `makeCapabilityInstance`, the `device.create/delete/update`
   events). They are stubbed in tests, not proven against the real package at runtime. This is the
   single most likely place for a first-run failure, and `DeviceMonitor.start()` is wrapped so a
   failure there logs instead of taking the app down.
3. **Settings-page and widget bridges.** `/homey.js` with `data-origin="settings"` / `"widget"`,
   `Homey.api(...)` callbacks, `Homey.on(...)` realtime, `Homey.getSettings()` in the widget and
   `data-i18n` auto-translation are used as documented. The renders used a stub of that bridge.
4. **Homey's `data-i18n` auto-translation.** Every element also carries readable English text, so a
   failure degrades to English rather than to blanks.
5. **Widget preview image dimensions.** `preview-light.png` / `preview-dark.png` are 800×480 (400×240
   at 2×). The validator only checks that they exist.
6. **Device-class heuristics** (`HEAVY_CLASSES`, `HINTS`) are reasonable but unproven against a
   real, messy device list.

---

## 12. First-run checklist on real hardware

```bash
homey login
npm start                       # homey app run, watch the console
```

1. Does `Monitoring N device(s)` appear, with N matching your metered devices?
2. Open the app settings. Does the chart fill within a minute, and does the Live dot stay teal?
3. Devices tab: are solar and the grid meter detected correctly? Fix roles and confirm they stick.
4. Switch on something heavy. Expect a `device_on` marker immediately, and a peak marker with a
   sentence naming that device within one attribution window.
5. Add the widget to a dashboard; confirm it renders and refreshes.
6. Build a Flow on "A power peak occurred above 2000 W" and check the `reason` token.
7. Leave it running a day, then check `/diagnostics`: `timelineBytes` must still read 57024.

---

## 13. Backlog / next steps

Ordered by value, none of it started:

1. **Run it on hardware** and work through section 12.
2. **Battery as a fourth series.** The aggregator already computes charge and discharge; storing it
   would mean a fourth column in `SampleBuffer` and a fourth legend entry.
3. **Per-device timelines.** `DeviceMonitor` keeps only a 24-sample ring per device. A "top movers"
   panel or a per-device sparkline would need its own bounded store - keep the memory discipline.
4. **Export.** A CSV or JSON download of a window, straight from the existing query path.
5. **Cost.** Multiply net import/export by a tariff so peaks can be priced; the Dutch capacity
   tariff is a natural fit for `peakSource: 'net'`.
6. **Insights-backed history.** Homey's own Insights hold far more history than 48 hours; the day
   tier could be seeded from `getInsightsLogEntries` at boot.
7. **Locale coverage.** `nl` is complete; other languages only need `locales/<code>.json`.

---

## 14. Conventions for whoever continues

- **Edit `.homeycompose/`, never `app.json`.** Run `npm run build` to regenerate.
- **Keep every buffer bounded.** If a new feature needs storage, give it a capacity and a test that
  proves it stops growing, the way `test/storage.test.js` does.
- **Nothing in the sampling loop may allocate per device per tick** beyond the existing rings.
- **After touching `settings/timeline-chart.js`, copy it to the widget** (5.10).
- **Re-run the palette validator** before changing any chart colour (section 6).
- Comments explain *why*. The code already says what it does.
- Run `npm test && npm run validate` before every commit.
