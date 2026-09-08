# PowerView BLE for Homey

Drive Hunter Douglas / Luxaflex **PowerView Gen 3** shades from Homey over
Bluetooth Low Energy — the same radio link the PowerView phone app uses — with
no PowerView gateway anywhere in the picture.

Gen 3 dropped the old proprietary RF for standards-based BLE, and every shade
carries its own radio. Homey Pro has a BLE radio too, so it can talk to the
shades directly.

> **Not affiliated with Hunter Douglas or Luxaflex.** The BLE wire format is
> not published by the vendor; this app is built on community reverse
> engineering (see [Credits](#credits)).

## Is this the app you want?

| You have | Use |
| --- | --- |
| Gen 3 shades and a **PowerView Gen 3 Gateway** | The official [Powerview app](https://homey.app/a/nl.luxaflex.powerview/) — it is maintained by Hunter Douglas and works over your network |
| Gen 3 shades and **no gateway** (Bluetooth-only, paired to your phone) | This app |
| Gen 1 / Gen 2 shades (PowerView Hub) | The official app; Gen 1/2 do not speak BLE |

You can also use this app *alongside* a gateway if you would rather Homey drove
the shades itself — it will happily read the home key straight out of the
gateway for you.

## Requirements

- **Homey Pro.** Homey Bridge and Homey Cloud have no BLE radio for apps to
  use, so this app declares itself local-only and will not install there.
- Homey needs to be **within Bluetooth range of each shade**. That is the real
  constraint: BLE range through interior walls is roughly one to two rooms.
- Node-side there are no runtime dependencies; the Homey CLI is only needed to
  install the app.

## The home key

This is the one fiddly part, and it is worth understanding before you start.

A Gen 3 shade that has been **added to a home in the PowerView app** only acts
on commands encrypted with that home's 16-byte key. It will happily accept an
unencrypted command over BLE and then quietly do nothing, which is
indistinguishable from a shade that is stuck — so this app checks for the key
up front and tells you on the device tile when it is missing.

A shade that has **never** been added to a home advertises home ID `0` and takes
commands in the clear. The app works that out from the shade's own
advertisement, so you do not have to tell it which case you are in.

One key covers every shade in a home, so this is a one-time step.

### Getting the key

**From a PowerView Gen 3 Gateway** (easiest, if you have one). During pairing,
choose *Read from gateway* and give it the gateway's hostname or IP. Homey asks
the gateway to relay a key request to one of its shades. Expect it to take
20-30 seconds: the gateway opens its own BLE connections on demand, so the
first attempts usually time out and are retried.

**From the PowerView app on an iPhone.** The app keeps the key in its own
SQLite database, which on iOS is only reachable through a local backup. Back
the phone up in Finder with *Encrypt local backup* **off**, then:

```bash
./scripts/find-homekey-ios.sh
```

It finds the database by its schema rather than its name — the filename is
generated per install, so any name quoted in a forum post is that person's, not
yours — and prints the key without writing it anywhere. `--list` shows which
backups and which apps' data are present, for when nothing is found.

**From the PowerView app on Android.** `hdpv_ble` ships
[`extract_homekey_waydroid.sh`](https://github.com/safepay/hdpv_ble/blob/main/scripts/extract_homekey_waydroid.sh),
which runs the app under Waydroid and reads the same table. Tested on Ubuntu
only. The [Home Assistant thread](https://community.home-assistant.io/t/hunter-douglas-powerview-gen-3-integration/424836/228)
describes the manual route.

**With an ESP32.** The [`hdpv_ble`](https://github.com/safepay/hdpv_ble)
project ships a shade emulator that you add to your PowerView home like a real
shade; it logs the key the app hands it.

### Or skip the key entirely

The key is not the only way in. The shades encrypt with AES-128-CTR and restart
the counter at zero for **every** frame, so the same keystream covers every
message — and the PowerView app's own BLE log records each frame twice, once in
the clear and once as it went over the link. Those are known-plaintext pairs,
and XORing one recovers the keystream.

```bash
node scripts/derive-keystream.js /path/to/blelog.txt
```

That log lives in the app's container, which on iOS means a backup —
`find-homekey-ios.sh --probe` locates it. The keystream goes in the same
settings page as the key and is used in preference to it.

The key itself stays out of reach, since recovering it from the keystream means
inverting AES. It is also not needed: the keystream is what does the work.

However you get it, paste it into **Settings → Apps → PowerView BLE**, or into
the first step of pairing. Spaces, colons and `\xAB` escapes are stripped, so
paste it in whatever shape you have it.

## Installing

This app is not in the Homey App Store. Install it with the
[Homey CLI](https://apps.developer.homey.app/the-basics/getting-started):

```bash
npm install --global homey
homey login
git clone https://github.com/roccowijnsma/homey-panel-koppeling-.git
cd homey-panel-koppeling-
homey app install
```

`homey app run` instead of `install` runs it from your machine with live logs,
which is the better way to see what is going on the first time.

## Adding shades

*Devices → Add device → PowerView BLE → PowerView Gen 3 Shade.*

The first step asks for the home key (skip it if your shades were never added to
a home). Then Homey scans, and every shade it hears is listed, strongest signal
first. A shade is recognised by the manufacturer record it broadcasts, not by
its name, so shades that were never named still show up.

Each shade is created with the capabilities its **type** supports — the type ID
travels in the advertisement, so the app knows whether a shade tilts, has two
rails, or only tilts, before it ever connects.

## What you get

| Capability | Shades |
| --- | --- |
| Position | everything except tilt-only types |
| Tilt | Venetian, Silhouette, Pirouette, Parkland, Facette, Twist, vertical slats |
| Top rail | dual-rail top-down/bottom-up types (8, 9, 33, 47) |
| Open / close / stop | all |
| Battery | all — hardwired shades simply always read 100% |

**Flow cards**

- *Identify the shade* — makes it jog and beep, for telling siblings apart.
- *Activate a scene stored on the shade* — slot 2 is its open scene, slot 3 its
  close scene; other slots hold whatever the PowerView app put there.
- *Set the movement speed* — 0 lets the shade choose; otherwise 10-100.
- *The shade stopped moving* (trigger), *the shade is moving* (condition).

**Per-device settings** cover speed, an optional home key override for anyone
whose Homey reaches two PowerView homes, and read-only shade details.

## How it works

Position, tilt and battery are **never polled**. Every shade broadcasts a
9-byte manufacturer record continuously, and the driver runs one shared BLE scan
(every 60 seconds by default) and hands each result to the device that owns it.
One scan for all shades matters: scanning occupies the radio, and a shade being
scanned cannot be connected to.

Commands are the other direction: the app connects, writes one framed request,
waits for the acknowledgement, and closes the link again — which is what the
shade expects, since it drops the connection itself once it has answered.
Commands are serialised per shade, and two position commands that arrive
together are **merged** rather than queued, so dragging a slider does not put
every intermediate position on the wire, and a top-rail and bottom-rail move
become one command that drives both.

On each fresh connection the app also pushes the current time if the shade
needs it. A shade that loses power stops its clock and leaves its stored
schedules dormant until something tells it the time; a gateway does this daily,
and on a gateway-less install nothing else would.

### Protocol notes

| | |
| --- | --- |
| Service | `0000fdc1-0000-1000-8000-00805f9b34fb` |
| Control characteristic | `cafe1001-c0ff-ee01-8000-a110ca7ab1e0` (write + notify) |
| Advertising company ID | 2073 (`0x0819`), 9-byte record |
| Frame | opcode (LE16), sequence, payload length, payload |
| Encryption | AES-128-CTR, zero counter, restarted per frame — so one keystream serves every frame |
| Lift positions | percent × 100 on the wire, percent × 10 in advertisements |

`lib/protocol.js` carries the byte-level detail and `lib/const.js` the
constants, both with the reasoning written down.

## Limitations

- **Range.** This is the big one. Homey must hear each shade over BLE. If a
  shade sits at the far end of the house, no amount of software fixes that —
  a gateway and the official app will serve you better.
- **Latency.** A command opens a BLE connection, which takes a few seconds.
  Position feedback follows the scan interval, not the movement.
- **Duolite** (dual-fabric) types are mapped from the gateway API's
  front/rear correspondence rather than confirmed on hardware. Treat them as
  experimental.
- **Dual-rail** clamping is confirmed on type 8; the other TDBU types follow the
  same logic but have not been verified individually.
- Homey's BLE stack does not expose write-without-response, which is what the
  reference implementation uses. Writes go out as Homey sends them; if a shade
  ignores commands while reporting no error, that is the first thing to suspect.

## Troubleshooting

**"This shade belongs to a PowerView home…"** — the shade is encrypted and no
key is set. See [The home key](#the-home-key).

**"Out of Bluetooth range"** — Homey has not heard the shade for several scans.
Check the distance, and remember Homey's own radio is inside its case.

**Commands time out** — usually another BLE app on Homey holding the radio, or
range. Watch `homey app run` output; every connection attempt is logged.

**A tilt does nothing** — tilt commands must restate the lift axis, so the app
waits until it has heard the shade's position at least once. Give it a scan
interval and try again.

## Development

```bash
npm install          # Homey CLI, for validation only
npm test             # unit tests: protocol, position mapping, transport
npm run validate     # homey app validate --level publish
node tools/make-images.js   # regenerate the artwork
```

`scripts/find-homekey-ios.sh` is the one piece that cannot be exercised here:
it needs a real iPhone backup and macOS's `plutil`. Its database-finding and
reporting paths are verified against a simulated backup, including the
encrypted-backup and app-not-present cases.

The tests cover the parts worth covering: frame encoding, the AES-CTR round
trip, advertisement decoding against known byte vectors, the position mapping
for every shade family, and the transport's queueing and encryption against a
fake BLE stack.

## Credits

The BLE protocol is not documented by Hunter Douglas. Everything this app knows
about it comes from:

- [`safepay/hdpv_ble`](https://github.com/safepay/hdpv_ble) and its origin
  [`patman15/hdpv_ble`](https://github.com/patman15/hdpv_ble) — the Home
  Assistant integration that worked out the wire format, and documents which
  parts are confirmed on hardware and which are inferred.
- [`sander76/aio-powerview-api`](https://github.com/sander76/aio-powerview-api) —
  the shade type table and capability classes.

## Licence

MIT. See [LICENSE](LICENSE).
