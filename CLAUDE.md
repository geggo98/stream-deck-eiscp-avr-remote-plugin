# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stream Deck plugin ("eISCP AV Receiver Remote Control") for remote controlling AV receivers that speak the ISCP (Integra Serial Control Protocol) over Ethernet (eISCP). Compatible with many Pioneer, Onkyo and Integra network receivers; this is an independent project, not affiliated with or endorsed by those manufacturers. The version lives in `package.json` (the manifest version is derived from it).

## Development Commands

- `npm run watch` - Development mode with hot-reload; automatically restarts the Stream Deck plugin after builds
- `npm run build` - Production build with minification via Rollup

**Environment:** Uses Nix `devenv` with Node.js 24. Direnv loads the environment automatically when entering the directory.

### Devenv

This project uses [devenv](https://devenv.sh) for reproducible development environments. The environment is defined in `devenv.yaml` and `devenv.nix`.

To verify the environment is working (warnings can be ignored):
```bash
devenv shell -- node --version
```

If direnv is configured, the environment loads automatically when entering the directory. Otherwise, activate it manually with `devenv shell`.

Use `nix search nixpkgs ...` to search for packages (`nixpkgs` is required) and `devenv search ...` to search for options of the `devenv.nix` file. Test your changes with `devenv shell -- pwd`.

## Architecture

### Stream Deck Plugin Architecture

The plugin follows Elgato's Stream Deck SDK architecture:

```
Stream Deck App → Plugin (Node.js) → Action Classes → Settings/Events
                      ↓
               Property Inspector (Web UI) ← User Settings
```

### Key Components

1. **Entry Point** (`src/plugin.ts`) - Initializes Stream Deck connection, registers actions, configures logging
2. **Actions** (`src/actions/`) - Action classes extending `SingletonAction` or `Action` from `@elgato/streamdeck`
3. **Manifest** (`de.schwetschke.sd.eiscp-avr-remote.sdPlugin/manifest.json`) - Plugin metadata, action definitions, requirements
4. **Property Inspectors** (`de.schwetschke.sd.eiscp-avr-remote.sdPlugin/ui/`) - HTML settings panels using SDPI Components v4

### Action Pattern

Actions use TypeScript decorators and extend `SingletonAction` (via the shared
bases in `src/actions/eiscp-action-base.ts`). Handlers take a single event
argument:

```typescript
@action({ UUID: uuidFor("action-name") })
class MyAction extends SingletonAction<Settings> {
  override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> { ... }
  override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> { ... }
}
```

**Critical:** Action UUIDs must match between TypeScript decorators and
`manifest.json`. For dedicated actions both come from `catalog.ts` (`uuidFor`
only accepts known catalog ids, so typos fail to compile).

### Build System

- **Tool:** Rollup with TypeScript compilation
- **Entry:** `src/plugin.ts`
- **Output:** `de.schwetschke.sd.eiscp-avr-remote.sdPlugin/bin/plugin.js`
- **Watch mode:** Generates source maps, disables minification, auto-restarts plugin

## Important Notes

- **Plugin ID:** `de.schwetschke.sd.eiscp-avr-remote`
- **Node.js requirement:** Plugin targets the Node.js 24 runtime (manifest `Nodejs.Version` 24), which needs Stream Deck 7.1+ (`Software.MinimumVersion` 7.1); dev env also uses Node 24
- **Debug mode:** the `Nodejs.Debug` key is **absent** from the committed
  manifest and from everything `npm run build` produces. `"enabled"` opens a Node
  inspector port (local code execution into the plugin process) and flips the SDK
  to TRACE, so it must never ship. **Do not write `"disabled"`** — Stream Deck
  then refuses to launch the plugin at all: the process exits with code 1 before
  any JS runs, so nothing lands in the plugin's own log and it just looks dead
  (the app log says `Process stopped (unexpected): code=0x00000001`, then
  eventually `Plugin is unstable an was disabled`). `npm run watch` adds
  `"enabled"` for the dev loop (`sync-manifest-version.ts --debug`);
  `npm run build` removes the key again. `npm run verify:manifest` gates
  `npm run pack` and CI, and a pre-commit hook (`forbid-debug-manifest` in
  `devenv.nix`) blocks committing the key in any form.
- **A plugin that will not start:** check
  `~/Library/Logs/ElgatoStreamDeck/StreamDeck.log` for
  `[de.schwetschke.sd.eiscp-avr-remote]`. An empty plugin log plus exit code 1
  there means the failure is before the SDK logger loads — usually the manifest,
  not the code. Once Stream Deck has marked the plugin unstable it stops
  launching it, and `npx streamdeck restart` will not clear that; restart the
  Stream Deck app.
- **Build output ignored:** `*.sdPlugin/bin` is gitignored, plugin source is tracked
- **Logging:** "info" by default; set `EISCP_DEBUG` to get "trace" (see
  `plugin.ts`). TRACE dumps every WebSocket frame, i.e. full settings objects,
  LAN IPs and the learned-name map, into the plugin's log files. With music playing
  it also means ~1 800 cover-art frames per second reaching the log path, so never
  log a metadata payload — only counts, sizes and a truncated hash.
- **Inbound text is decoded as UTF-8, not ASCII.** Node's `"ascii"` decoder *masks*
  the high bit instead of rejecting it, so every byte ≥ 0x80 silently became a
  different, plausible letter ("Björk" → "BjC6rk"). The spec declares the
  text-carrying commands as "64 Unicode letters [UTF-8 encoded]". Three decode sites
  share the rule (`decodePacket`, the raw-ISCP path in `transport.ts`, and the `FLD`
  hex payload); pure-ASCII payloads decode byte-identically, which is why the switch
  moved no existing test. `sanitiseDeviceText` (`device-text.ts`) is the single
  sanitising boundary and filters C0/DEL rather than "non-ASCII" — an ASCII-only
  filter would delete exactly what that fix preserves.
- **No default device IP:** `resolveDeviceIp` returns `undefined` when neither
  the action settings nor the global settings carry an IP; actions then show
  "No IP" / alert and send nothing. There is deliberately no baked-in fallback.
  The *last used* receiver is remembered (`GlobalSettings.lastDevice`, written by
  `rememberDevice` when an action binds to an IP it chose itself) and pre-fills a
  freshly added action — but only into **that action's own** `deviceIp`
  (`deviceIpToAdopt` / `EiscpActionBase.syncDeviceMemory`), so the dropdown shows
  what the action actually steers. Adoption happens only while both `deviceIp`
  and `customIp` are `undefined` ("never touched"); a deliberately emptied
  selection is `""` and stays empty. The plugin-wide `deviceIp` fallback that
  `resolveDeviceIp` still honours is read-only — nothing writes it.
- **Global settings are one shared object — write them only through
  `updateGlobalSettings`** (`eiscp-base.ts`). `names` (learned names) and
  `lastDevice` live side by side, so every writer merges over the others' values,
  and both ways of getting that merge wrong have already destroyed data:
  - Writing **before the initial load** persists a snapshot with everything else
    missing. The cache is empty until `getGlobalSettings()` resolves, which is
    after `connect()`, i.e. after the first action binds. This wiped a real
    user's learned-name map. Hence the gate, which `plugin.ts` opens **only on a
    successful load** — if we could not read the settings we must not replace
    them.
  - Writing over `getCachedGlobalSettings()` **without putting the result back**
    leaves the next writer merging over a superseded snapshot. Stream Deck does
    not echo the plugin's own `setGlobalSettings` back as
    `didReceiveGlobalSettings`, so nothing else refreshes that cache during a
    session: `name-store.persist()` wrote `names`, and the next `lastDevice`
    write then rolled the session's learned names back.

  The funnel closes both: it waits for the gate, serialises all writers against
  each other, applies the patch to the live cache and updates the cache *before*
  the round trip. `tests/global-settings.test.ts` asserts the semantics **and**
  greps `src/` to keep `plugin.ts` the only direct `setGlobalSettings` caller.
  Readers use the bounded `waitForGlobalSettings()`, so a failed load costs a
  pre-fill, not the bind.
- **Never call `action.getSettings()` to service a PI request.** It is a
  WebSocket round trip whose `didReceiveSettings` reply also reaches the action's
  own handler, so merely opening a PI would re-enter `onDidReceiveSettings` and
  re-bind. Actions record what they already have
  (`rememberActionSettings`/`getRememberedActionSettings`, cleared on
  `onWillDisappear`) and the Device IP handler pins from that.
- **Adapter layer must not import `@elgato/streamdeck`:** importing the SDK
  rotates its log files as a module side effect, which races between parallel
  test processes. `src/adapter/**` logs via `src/adapter/logging.ts`
  (`scopedLogger`); the plugin entry point injects the SDK logger. The same
  rule applies to test files: keep them free of transitive SDK imports (the
  SDK-free extractions `pi-device-list.ts`, `sweep.ts`, `device-tracker.ts`
  exist for exactly this).
- **Typecheck surface:** `npm run typecheck` uses `tsconfig.typecheck.json`
  (src + tests + scripts); the build's `tsconfig.json` covers src only.
- **Toolchain pins:** `typescript` stays on **6.x** and Dependabot is told to skip its
  majors. TypeScript 7 type-checks this project cleanly and every test passes under
  it — and the build still breaks, because typescript@7 exports no compiler API from
  its package root (only `./unstable/*`) while `@rollup/plugin-typescript`
  destructures `ModuleKind` from a bare import at module scope. Two consequences
  worth remembering: **a green `npm run typecheck` says nothing about a compiler
  bump** — only `npm run build` does — and 6.0.3 is the last 6.x, so this pin sits on
  a closed line. The removal conditions are written where the rule is
  (`.github/dependabot.yml`). The way out, if it ever gets urgent, is moving the
  bundle step off the compiler API. Four routes were built and measured —
  **`docs/bundler-analysis-2026-07.md`** has the numbers, the two footguns and the
  recommendation. What separates them is **which transpiler**, because the emit
  semantics are the risk:
  - **esbuild lineage preserves them** — `rollup-plugin-esbuild` (10 changed lines,
    bundle 1.75 % *smaller*), plain `esbuild` (−9 %), and `bun build` (build ~100×
    faster) all emit standard two-argument decorators and `define` class fields,
    verified by runtime probe against `tsc`, and all three build byte-identically
    under typescript 6 and 7.
  - **oxc and swc do not.** Vite 8 transpiles with oxc, which has no TC39
    standard-decorator transform at all: its default output is raw `@action(…) class`
    syntax that Node cannot parse, emitted with exit code 0 and no warning, and its
    only knob (`decorator.legacy`) gives one-argument calls with no context object.
    Every swc variant does the same. That would break the 27 `@action` classes at
    runtime, and **no test would notice** — nothing here ever looks at the bundle.
  - Leaving Rollup costs more than the config: it tree-shakes `zod`'s locale barrel
    (`export * as locales`, 114 KB) and `to-json-schema`, which esbuild-style DCE
    cannot drop — the bun bundle is +103 % and plain esbuild needs a `sideEffects`
    override keyed to `@elgato/utils`' internal file paths to avoid 2.19×.

  `tests/bundle-artifact.test.ts` guards the part that no other test could see: the
  built bundle parses, carries the standard decorator context, and gets far enough to
  register every action. Note what it had to work around — `registerAction` throws
  for a UUID missing from the manifest, but the plugin's `uncaughtException` net
  swallows that and **still exits 0**, so the exit code is not a signal; the log line
  `passive name discovery registered` is, because `plugin.ts` only reaches it after
  every registration. One of its four cases exists solely to prove the others can
  fail.

## Receiver power state on the deck

Every key and dial reflects what the receiver actually is, because all three
states used to look identical — and a press even produced a green checkmark for a
command the receiver dropped:

| state | key | dial | how it is known |
|---|---|---|---|
| **on** (`PWR 01`) | unchanged | unchanged | the `PWR` frame, immediately |
| **standby** (`PWR 00`) | icon dimmed (`key-dim.svg`) | icon + texts at `DIM_OPACITY` | the `PWR` frame, immediately |
| **offline** (unplugged, unreachable) | dimmed **+ title `Offline`** | dimmed + `Offline` | connect/send failure at once, else the heartbeat |

- `src/adapter/eiscp/device-status.ts` holds both halves: `nextState` is a pure
  reducer over everything observable (a `PWR` value, any message, connect,
  disconnect, connect failure, a failed probe), and `DeviceStatusTracker` wires it
  to the ConnectionManager's two observers plus a `PWR` heartbeat. Started in
  `plugin.ts` next to the name discovery.
- **State changes are event-driven, never polled for.** A `PWR` frame — including
  the one the receiver sends after the plugin powers it on — flips every bound
  action at once. `HEARTBEAT_MS` (30 s) exists only for the case nothing
  announces: a receiver that vanishes leaves a half-open socket, and kernel TCP
  keep-alive needs minutes. While offline it probes with a 5/10/30/60 s backoff,
  so a receiver that comes back is picked up without a key press.
- **Subscribing is how interest is declared**: `onStatus(host, cb)` starts that
  host's heartbeat and the last unsubscribe stops it — a profile nobody looks at
  costs nothing.
- **The decoration is a pure function of the status inside the normal render**, not
  a separate write. That is deliberate: `Offline` cannot outlive the outage,
  because the next render recomputes it (`statusTitle`, `keyImageFor`,
  `feedbackStatusStyle`). Stuck degraded titles have been a real bug here twice
  (`3e0b685`), and the earlier fix was to add a clearing path — this removes the
  need for one. Repaints always render from the ConnectionManager's **cache**; a
  status change is not a value change, and querying an offline receiver only
  stalls.
- The **Power key is never dimmed in standby** — it is the one key that works
  there. When the receiver is unreachable it dims like everything else.
- Dials keep no state of their own: the five `buildFeedback` implementations return
  a payload and `DialActionBase.sendFeedback` applies the decoration once. Every
  item gets an **explicit** opacity, including `1`, because a layout keeps what it
  was last given.
- **Wake on press** (`GlobalSettings.wakeOnPress`, default on, switchable in every
  PI): in standby a press first sends `PWR 01` and waits for the receiver's own
  confirmation (`waitForStatus`, 3 s cap) before the real command. Best-effort by
  design — a slow or failed wake still sends. With it switched off, a press that
  the receiver will ignore shows `showAlert` instead of `showOk` (`reportPress`).
- The PI's checkbox writes through `sendToPlugin` → `setWakeOnPress` →
  `updateGlobalSettings`, **not** sdpi-components' `global` attribute: a
  `global`-bound input keeps its own snapshot of the whole settings object and
  writes all of it back, so toggling it in a PI that was open while the plugin
  learned names would revert them. Same failure class as the funnel exists for.

## Now-playing metadata and cover art

Measured on the reference VSX-S520D under **AirPlay** on 2026-07-26, and several of
these findings contradict what this file used to say. The numbers matter, so they are
here rather than in a commit message.

| Fact | Consequence |
|---|---|
| `NTI`/`NAT`/`NAL` **do** arrive unsolicited on every track change, ~90 ms apart | The old note "this firmware never sends NTI/NAT/NAL" came from a capture taken while *browsing a list*, not while playing. No polling is needed. |
| The AirPlay-specific family `ATI`/`AAT`/`AAL`/`ATM`/`AST` ("Airplay Model Only") **times out on all five** | The NET/USB commands are the working path. A spec-derived implementation would have built the wrong one. |
| The **cover arrives ~760 ms before the text** | By the time a track change is detectable from the text, the art is already in hand — so the trigger is the text, and nothing has to wait. |
| A cover is **45 217 B or 97 357 B** (JPEG 512×512) | The pre-existing `raw-dump.bin` fixture at 20 752 B is the *smallest* of three samples. A 64 KB cap would truncate real art. |
| 368/792 frames of 246 hex characters, **792 frames in 443 ms**, median gap 0 ms | ~1 800 frames/s. Nothing may render or log per frame. |
| `NJA QSTN` answers **`"BMP"`**, not `ENA`/`DIS` | The enable state reads back as an image-type token. |
| `NTM` ticks once a second; `NMS` field `t` says whether the time means anything, field `s` whether seeking is allowed (measured `x` = **not** allowed) | The progress bar is device-backed, not estimated. `NTR` is `----/----` under AirPlay and unusable. |
| **`NMS` cannot be obtained by asking.** `prime()` queries it and gets nothing usable; the receiver volunteers it **on a track change, ~94 ms after the cover** (measured 2026-08-09, 11:20:36.326 → .420) | `timeDisplay` therefore stays `unknown` for the whole of the track a plugin restart lands in. `overlayProgress` treats `unknown` as "nobody has told us" and believes `NTM`'s numbers, rejecting only the stated-meaningless `off` and `elapsed`. Without that a restart mid-track meant no progress at all until the song ended. |
| `NMS` field `ii` and `NLT` service are **`44`**, which the spec does not assign | Do not map service ids you cannot look up. |
| `FLD` shows the **track title** during AirPlay | Confirms why the name-store's metadata veto exists; it now runs continuously while music plays. |

Structure of the code:

- **`jacket-art.ts`** — a bounded state machine with a pure core (`nextArtState`) plus
  a per-host accumulator. Caps come from the measurements, not the spec's maxima.
  Three rules that each cost something to learn: hex is validated **before** decoding
  (`Buffer.from(x,"hex")` does not throw, it silently stops at the first bad pair);
  the container is taken from the **magic bytes**, not the declared `t` (the vendor
  workbook ships two different `t` enumerations); and `t=2` (URL) is **never
  followed** — the payload is a peer-chosen address.
- **`now-playing.ts`** — pure parsers plus a tracker over the ConnectionManager's
  observers. The interest gate is the first statement in the message handler, because
  during a transfer it runs ~1 800 times a second: a plugin with no now-playing
  element does nothing at all. `primed` must be a per-host **flag**, not "was the
  state empty" — the initial fill is three messages, so only the first looks empty and
  the other two would register as track changes.
- **`onTrackChange` is separate from `onUpdate` precisely so `NTM` cannot trigger it.**
  A once-a-second tick re-triggering a short display would mean it never goes away.

### Cover art over HTTP — and why the plugin never sets the mode

Measured 2026-07-27. The receiver serves its cover from its own web server:

```
GET http://<ip>/album_art.cgi   →  200, image/jpeg, valid JPEG 512×512
```

- **No authentication** (`GET /` is 401, this path is not).
- **It follows the track immediately**: a skip, and the very first request already
  returned the new picture (49 742 B → 119 487 B). The widely repeated "static,
  non-refreshing image" is client-side caching — request with `no-store`.
- It answers with a **non-standard `Content-size` header, not `Content-Length`.** That
  is where the folklore about "the image contains headers, strip the first three
  lines" comes from: a client that does not parse HTTP properly keeps the header block.
  It is also why **nothing may bound the download from the headers** — on this device
  there is no declared length at all, so `art-http.ts` streams with a hard cap and
  aborts. `response.arrayBuffer()` is unusable here: it buffers the whole body before
  anything can check the size, so an endless stream would decide how much memory the
  process spends. A mutation test pins this (replacing the streaming read makes the
  "never finishes the body" case take the full 5 s timeout instead of aborting).
- The plugin **never sends `NJALINK`/`NJABMP`/`NJAENA`/`NJADIS`.** Per the vendor
  workbook the setting is device-wide ("If Jacket Art is disable from one of
  controllers, All controllers cannot display Jacket Art"), and the manufacturer's own
  app very likely uses it too — a plugin asserting its preferred mode would fight every
  other controller for it. Both modes are simply served: a `t=2` frame is fetched over
  HTTP, inline frames are reassembled. `tests/art-http.test.ts` greps `src/` to keep it
  that way.
- **The announced URL is not followed as given.** Only its path is taken; the request
  always goes to the receiver the plugin is already connected to. The address is
  device-controlled input.
- Verified end to end against the unit in both modes: in data mode the inline transfer
  won (`frames=406`) and the HTTP copy was silently deduplicated by content hash; in
  LINK mode the announcement was followed (`frames=0`, 79 808 B).

**Never query `NJA`.** Measured twice: while art is streaming, `NJA QSTN` comes back
with a *chunk of the image* rather than the mode token, because `queryCommand`
correlates on the three-character command name alone and the first NJA frame to arrive
settles it.

### The Now Playing key: getting out of the cover's way

The key used to draw the play glyph over the cover and set the track and artist as its
title, unconditionally — between them there was very little picture left. Each
decoration now has to earn its place, and the **defaults changed for keys that already
exist**, which is the point rather than a side effect.

- `np-key-settings.ts` holds the whole rule set, SDK-free so it is testable.
  `glyphFor` draws the glyph only when there is no cover *or* `playStatus` is explicitly
  `pause`/`stop` — an **unknown** play status draws nothing, because guessing puts the
  glyph back over every cover, which is the complaint. `textIsVisible` is the one piece
  of state the key keeps: a mode, a deadline, and a press override that a track change
  clears.
- **The migration reads only `showGlyph: false`.** A stored `true` was also the old
  default, so it cannot be told apart from "never opened the panel"; honouring it would
  leave every existing key exactly as covered up as before.
- **A bind opens the text window.** `onTrackChange` deliberately never fires for the
  first track it sees, so an `onChange` key placed mid-song would otherwise show a cover
  and nothing else — and since every Property Inspector change is a re-bind, this is
  also what lets someone see the setting they just changed.
- **The key no longer joins the generic short track-change display** (`watchTrackChanges`
  is overridden to nothing, and its PI hides the setting). That display would paint a
  *different* face — no progress, its own glyph rule — over the one key that already
  shows the track.
- **What it logs is keyed on change, never on the tick.** This key repaints once a
  second, so anything written per render would bury the log it is meant to explain.
  Four things are recorded, each only when it differs from the last: the configuration
  it bound with (`noteBind` — a slider drag is a stream of re-binds), what it has to
  draw from (`noteFace`, keyed by `faceLogKey`), a press, and — in the tracker —
  a change of `playStatus`. **`faceLogKey` deliberately excludes the elapsed time**;
  putting it in turns a five-minute track into 300 lines, and `tests/np-key-settings.test.ts`
  pins that. The face line is what answers the two questions this key actually generates
  ("why is there no ring", "why is the ring that colour"), and it earned its keep within
  a minute of shipping: it is what surfaced the `NMS` finding above.

### Progress on a key: a ring, a bar, and a colour taken from the cover

A key has no layout, so the elapsed fraction has to become part of the composed image.

- **The ring's perimeter is computed, not declared.** `pathLength` is not in SVG Tiny
  1.2, which is roughly what Qt implements, and this file already records one attribute
  Qt ignored (`preserveAspectRatio`). `ringGeometry` returns the closed form for a
  rounded rectangle and the dash pattern is in absolute units. A full ring is drawn
  plain, because a dash pattern with a zero-length gap is undefined in a partial
  renderer and "full" happens at the end of every track. **The bar is the fallback** if
  `stroke-dasharray` turns out not to be honoured — it is two rectangles and depends on
  nothing.
- **`PROGRESS_STEPS = 100` is load-bearing, not cosmetic.** It is what keeps
  `writeKeyImage`'s de-duplication working now that something repaints at 1 Hz: a step
  is ~1.5 px on the physical key, so two ticks inside one step compose to the identical
  string and nothing is written. `composeShared`'s cache had to be bounded for the same
  reason (`MAX_COMPOSITIONS_PER_ART`) — the progress is part of the picture, so every
  step of it was another ~173 KB entry.
- **The colour comes from the picture, and from the *darkened* picture.** `image-luma.ts`
  reads only the DC coefficient of each 8×8 block — the block's average — which is an
  eight-times smaller image and all a colour decision needs. `effectiveScrim` is exported
  from `cover-image.ts` so the colour and the composer cannot disagree about how dark the
  backdrop will be.
- **`progress-colour.ts` maximises the worst case, and that is the whole rule.** Three
  candidates (white, mid grey `#808080`, black); the winner is the one that stands
  furthest off the backdrop along all but the worst 10 % of the band. Grey can only win
  on a cover that spans both ends, which is exactly what it is for — on an even backdrop
  the better of white and black is always ≥ 0.5 away and grey is ≤ 0.5 by definition.
  Two things it replaced, both wrong when rendered:
  - **Three brightness bands with a light grey in the middle.** With the default scrim a
    bright sleeve lands near 0.53, which the middle band answered with `#B3B3B3` — 0.17
    apart, and on screen that is no ring at all. Rendered against the real receiver's
    artwork before and after; the picture is what settled it.
  - **Section averages over the ring's four sides.** They *hide* a top-to-bottom split,
    because the left and right sides each contain both halves and average to the middle.
    The band's cell distribution keeps the split visible, which is why the sampling is
    per cell with a 10 % tolerance rather than four means.

  A consequence worth knowing before it looks like a bug: **at the default scrim a
  black-and-white cover gets a white ring, not grey.** 0.45 darkening pulls the bright
  half to ~0.54, so white stands 0.46 off it and 0.98 off the dark half — measurably and
  visibly the better choice. Grey wins once the scrim is turned down.
- **The decoder is our own on purpose.** `jpeg-js`, the obvious dependency, last shipped
  in June 2022 and carries CVE-2022-25851 (infinite loop, CVSS 7.5) and CVE-2020-8175.
  Both are **DoS, not RCE** — pure JavaScript cannot corrupt memory — so the mitigations
  that matter are caps and a `try/catch`, not a sandbox, and a worker thread would cost
  more than the decoding. Baseline JPEG and BMP only; progressive, arithmetic or
  malformed answers `undefined`, which means white, which is always an acceptable colour.
  Node's test runner strips types without transforming them, so **no constructor
  parameter properties** — that is why `BitReader` assigns its fields by hand.

### What the hardware accepts for a composed image

Established by probing a throwaway action on a real Stream Deck +, one axis at a time.
**The SDK documentation is wrong on the first point.**

| wrapping | image reference | renders |
|---|---|---|
| base64 data URI | `xlink:href` + `href` | yes |
| base64 data URI | `href` only | **yes** |
| raw SVG string | `xlink:href` + `href` | **no** |
| raw SVG string | `href` only | no |

- `setImage`'s docs say a plain SVG string is accepted. For a composed image it is
  **not**, and the failure is silent — the key falls back to its manifest icon, which
  reads as "the plugin forgot to paint".
- `xlink:href` is unnecessary and **doubles the payload** (the data URI appears once
  per attribute): 346 KB vs 173 KB for the same 97 KB cover.
- A nested `<image href="data:image/jpeg;base64,…">` does render, and that is the only
  way to get two layers into one key image — native image libraries are out of reach
  because Rollup bundles the plugin into a single file.
- Load: four keys repainted from one event cost 5–8 ms of write time even at 346 KB
  each. The write path is not the bottleneck.
- Untried and worth one probe if payload size ever matters: percent-encoding the outer
  SVG instead of base64-wrapping it should save the remaining 33 %.

**The touch strip is physically continuous** — verified against a background image
spanning all four segments, which crosses the boundaries with no visible offset. So
slices sit on exact multiples of `STRIP_SEGMENT_WIDTH` with no bezel correction. It is
a device property, not a documented guarantee, hence one named constant.

### Where the space actually runs out

Not the cover: album art is square and fits into part of a single 200×100 segment.
**Long titles are the constraint** — beside a 92 px cover only ~98 px remain, about
eleven characters, and "Taylor Swift" is twelve. So every extra strip segment buys
*text* width (`rolesForGroupSize`), and `spreadCover` was removed once the layout only
ever assigned one cover segment: unreachable configuration is worse than none.
`composeCoverImage` still slices and is still tested for it.

`text-fit.ts` shrinks through a size ladder, then splits across segments at **word**
boundaries, and only then clips — the layout offers no font family (so the width
estimate is an estimate, biased pessimistic) and no marquee at all. The order of
preference throughout the feature is **spread, then shrink, then clip**.

### Cooperating panels across adjacent dials

Adjacent dials with the track-change display switched on become **one** display: one
panel shows the cover, the others the title, artist and album, and the whole row comes
back together. Membership *is* the opt-in — a neighbour that does not want it breaks
the run rather than leaving a hole. `contiguousGroups` splits on a column gap **and on
a change of `host`**: two receivers on one deck have no shared "what is playing".

- **`enabled` is settable at runtime**, and that is what makes this affordable.
  `FeedbackPayloadItem` is `Partial<Omit<T, "key"|"rect"|"type">>` — only those three
  are immutable — so `layouts/np-panel.json` carries the dial's own face *and* the
  panel and switches between them with `enabled`. There is **no `setFeedbackLayout`
  per track change**; it happens once per bind and only for dials that opted in.
- **A layout switch has no undo**, so `manifestLayout()` reads the original from
  `encoderLayoutFor` (`catalog.ts`) — the same table the manifest is generated from.
  Restoring a `$B1` dial to `$A1` would cost it its progress bar for good.
- **`rolesForGroupSize` alone never spread on real hardware.** It gives the title a
  second segment only from **five** panels up; a Stream Deck + has **four**. So
  `planPanels` plans against the strings that are playing: surplus goes to whichever of
  title/artist is too long, and the album gives way to it. A leftover panel is `"none"`
  and keeps its own face — cutting a one-word title in half, or leaving a blank segment
  mid-row, both look like a crash.
- **The group takes the longest duration any member is set to.** A row that came up
  together and then fell apart panel by panel reads as a fault, not as a setting.
- The overlay now freezes the receiver's **state**, not the finished picture. Still a
  snapshot (the 1 Hz `NTM` cannot get in), but the face is built at render time — which
  is what lets a dial become the cover when its left-hand neighbour is pulled out
  mid-display.
- **The schema's overlap rule is per layout; the one that bites is per face.** Items
  sharing a `zOrder` may not overlap, and this layout deliberately overlaps *across*
  z-orders. That legality hid a real collision: the lone-dial role shows an artist line
  and an elapsed time at once, and those two rects sat on top of each other.
  `tests/layout-json.test.ts` builds every role and checks what it actually switches on
  — plus that every key the code writes exists, because Stream Deck ignores an unknown
  key in silence and the panel just would not appear.

### The Now Playing dial — a permanent display on the same layout

`np-panel.json` carries **three** faces now, still switched only with `enabled`: the
dial's own (`icon`/`label`/`value`/`indicator`, z 10), the cooperating panel
(`cover`/`line1`/`line2`, z 20) and the permanent one, which is the panel plus the
`time` and `progress` items that had been reserved for it. `buildNowPlayingFace`
(`strip-panel.ts`) builds it; `DialActionBase.standingFace` is the hook that puts it on
the strip **ahead of** any track-change display, so a dial that shows the track
permanently cannot interrupt itself.

- **A layout bar reads 0…100 unless it declares a `range`**, and this one does not. The
  face speaks in fractions because that is what `overlayProgress` means, so `panelItems`
  converts. Getting it wrong shows a bar frozen at 1 %, which looks like a stalled
  transfer rather than a units bug.
- **`fit: "cover"`, the opposite of the cooperating panels** — deliberately. There the
  picture *is* the content and cropping it in half is the failure; here it is a backdrop
  behind four lines of text, and `contain` would letterbox a backdrop.
- **The manifest declares `$B1` and the switch happens at runtime.** A custom layout
  named in a manifest `Encoder.layout` is untried in this plugin and its failure mode is
  silence — feedback written into items that do not exist. `setFeedbackLayout` at bind is
  the path that has been verified on hardware, so `wantsPanelLayout()` returns `true` and
  `$B1` stays the honest restore target.
- **The dial path had no image de-duplication, because nothing painted at 1 Hz before.**
  `NTM` ticks once a second and a composed cover is ~173 KB; `dedupeCover` drops only the
  `value` and still writes `enabled`/`opacity`, which is the one place a layout item
  keeping its last value is the mechanism rather than the hazard.
- **The action readout is the only face that lights both halves at once**: cover from the
  panel half, the dial's own items over it (`PanelFace.withOwnFace`, which is what stops
  `sendFeedback` taking its usual early return). It darkens the cover to at least
  `ACTION_SCRIM_FLOOR` — the user's scrim is chosen for a 24 px bold title, and the
  readout puts an 18 px value there instead.
- **It never joins a cooperating group.** `showOnTrackChange` *is* that membership
  (`joinStrip`), so the setting is hidden from this dial's Property Inspector rather than
  merely ignored — `renderDeviceIp(id, { trackChange: false })`.
- **Only the user's own turn or press starts the readout.** A value arriving from the
  receiver is not evidence of a user action — it may be the infrared remote — and having
  someone else's volume change interrupt the track display was explicitly not wanted. An
  incoming value only *extends* a window that is already open.

**The pre-fill cooldown must not outlive the state it was protecting.** `prime()` refuses
to ask again within `PRIME_COOLDOWN_MS` (60 s) so that eight elements binding at once cost
the receiver one round of questions. But `bind()` calls `clearSubs` **before** it
re-subscribes, so a host watched by a single element drops to zero listeners for an
instant on every re-bind — and *any* Property Inspector change is a re-bind.
`dropIfUnwatched` then deleted the whole state and the cover, and the re-subscribing
element was refused its pre-fill: a permanent now-playing display went blank until the
next track change, minutes away. `forgetHost` now clears `primedAt` with the state, on
both the unwatched and the eviction path. This bit the shipped **now-playing key** too —
same pattern, less visible, because a key that loses its cover still looks like a key.
`tests/now-playing.test.ts` pins both halves: primed again after a drop, still refused
while somebody is watching.

### Not cutting through somebody's face

`fit: "cover"` on a 200×100 segment shows the **middle half** of a square sleeve — source
rows 128…384 of 512 — and a head in the top or bottom quarter gets sliced. Human face
detection is not something a viewer can switch off, so a bisected head reads as a fault
while a bisected guitar reads as a crop. `face-crop.ts` moves that window; `keepFacesWhole`
(default on, one checkbox in the Now Playing dial's PI) is the way out when it guesses
wrong.

- **The crop is ours**, which is why this is affordable at all: `artElement` already
  computes the geometry itself because Qt ignores `preserveAspectRatio`, so the whole
  feature is one term in one line (`ComposeOptions.focusY`, −1 top … +1 bottom). It is a
  pure function of the cover and the box, both already in `composeShared`'s cache key, so
  **the cache does not grow**.
- **The evidence is free.** `scan()` carried a DC predictor for every component and threw
  Cb/Cr away one line before storing them; and the AC coefficients were being decoded and
  discarded, so keeping the low 4×4 corner is a *store*, not extra decoding. A 4×4 corner
  reconstructs as 4×4 samples per block — **half** scale, not quarter — because averaging
  pixel pairs folds into the cosine constants (`DETAIL_COS`). Verified by rendering a real
  512² cover's `detail` image: the sleeve's title is legible at 256², which it is not if
  the zig-zag, the sign extension or the scale factor is wrong.
- **Two detectors, because they fail on different sleeves.** Skin chrominance
  (Chai/Ngan) finds people at any angle in a colour photograph; the LBP cascade finds
  frontal faces in black-and-white, in duotone and in drawings. Neither covers the other.
- **The flatness test is *relative*, and that is not a refinement.** With an absolute
  threshold the same synthetic face was found at Fitzpatrick I and IV and refused at VI:
  sRGB puts ~147 levels between cheek and pupil on light skin and ~59 on dark skin for the
  same reflectances, so "16 levels of spread" quietly asks darker-skinned subjects to be
  more contrasty to be seen at all. Dividing by the region's own mean removes the scale.
  `tests/face-crop.test.ts` pins seven tones down to one that only just clears the lower
  luminance bound.
- **Three rules, and the second does nearly all the work.** Minimise face cut, then
  maximise face shown, then stay near the middle. Rule one rarely fires: the window is
  half the picture, so its extreme positions are disjoint and any single region can simply
  be stepped around — "two faces, one has to go" resolves at zero cost and rule two picks
  the larger. Without rule two the minimiser "saves" a straddling face by pushing it out of
  frame, which was the first thing it tried.
- **A region taller than the window is excluded from the cut cost.** It is cut wherever the
  window goes, so what it contributes is a constant with a tilt on it — and the tilt is
  enough to drown out a region that can be rescued. Measured: on a real portrait the
  subject's hand and the desk below him formed one tall skin region three times the face's
  area, and minimising total cut moved the crop *away* from the face to lose slightly less
  desk. Such regions still count towards rule two, which is what places the window over as
  much of a too-tall face as it can.
- **Two constants were set by reasoning, and seven real sleeves refuted both.** In the
  first configuration — `MIN_NEIGHBOURS = 4`, regions from 5 cells up — **three of the four
  covers with faces moved the wrong way**, one of them the full ±1. The causes were
  separate and both instructive:
  - **Requiring agreement bought silence, not safety.** At three or four the cascade found
    *nothing* on either big-single-face cover; at one it found both and still found nothing
    on either faceless cover. Few windows agree about a **large** face because the step
    grows with the scale. Fixing that instead was measured and rejected: stepping by
    `scale` on a 1.1 ladder cost 7× the time (520 ms vs 73 ms), still missed the hardest
    cover, and invented a false positive on a black-and-white abstract that had been clean.
  - **Tiny regions were swinging the whole crop.** A 7-cell patch of shadow, and an 8-cell
    piece of the *lettering*, each moved a cover the full ±1. The floor now follows from
    the premise — this exists because a **big** face gets sliced, so anything under 2 % of
    the picture does not get a vote.
- **The 24×24 cascade, not the 45×45 "improved" one.** Measured through this plugin's own
  half-resolution path against a real portrait: at 45×45 the window cannot see a face
  smaller than ~18 % of the cover's height and found nothing; at 24×24 it found the face
  with four agreeing detections and still found nothing on a faceless sleeve. Reach won,
  because small faces are exactly what the colour test cannot help with either.
- **Measured, not estimated:** the cascade costs **55–74 ms once per cover** and the
  placement **0.001–0.010 ms per repaint**, so the 1 Hz display pays nothing. The one-off
  lands *after* the art transfer rather than during it — the cover arrives ~760 ms before
  the text that triggers the repaint — and even inside a transfer 70 ms of blocked event
  loop buffers ~19 KB against `MAX_RECEIVE_BUFFER_BYTES` (256 KB).
- **`npm run probe:focus -- <folder|receiver-ip>`** is the only honest test of any of this:
  it writes a contact sheet of each cover with the regions drawn on it and both crops
  composed by the real composer. Every threshold here is a starting value that a sleeve can
  disprove — use it rather than arguing. Nothing it reads belongs in this repository.
- **What the colour test is worth on real album art is: much less than it looks.** Two
  measured failures, both structural rather than tunable. On a warm-toned sleeve the face
  is correctly found as skin — and so are the neck, the bare shoulder and the background,
  as one connected mass covering 47 % of the picture, which the "that is a backdrop"
  cap then discards *whole*; what survives is the lettering. On a duotone sleeve the
  subject is lit blue and only 4 % of cells pass the test at all. Colour cannot separate a
  face from its own neck — that is what the cascade is for. On the seven sleeves measured
  the colour path changed no decision the cascade did not already make, and before the
  floor above it caused every wrong one. It is kept for the cases the cascade structurally
  cannot reach (profiles, tilted heads, BMP covers, which have no `detail` image), not
  because it has earned its keep on evidence.
- **A crude ink drawing of a face is found, and that is not luck.** EMF's *Schubert Dip* is
  a black-and-white caricature; the colour test sees 1 % skin and returns nothing, and the
  cascade fires four times, one of them square in the middle of the face. An LBP feature
  compares only the *ordering* of brightness in a neighbourhood — dark eye socket, lighter
  cheek, dark mouth — and a caricature exaggerates precisely that ordering. It works
  **because** it is a caricature, not despite it.
  Worth knowing how thin that is, though: all four detections are single windows. Under the
  configuration of an hour earlier this sleeve found nothing at all. It rests entirely on
  the lowered agreement threshold.
- **Still not solved:** faces below ~48 source pixels (four figures in the corners of an
  M People sleeve are ~10 px — nothing sees those), and heads tilted far enough that a
  frontal cascade will not match. Both find nothing and leave the crop centred, which is
  what it did before.
- **`tests/fixtures` contains no artwork.** The sleeves this was measured against are
  copyrighted. What *is* committed is `cover-corpus.json`: Wikimedia Commons file titles,
  their licences and where each one's crop ought to go. `probe:focus` takes the manifest,
  fetches through `scripts/lib/commons-cache.ts` and prints a verdict per entry, exiting
  non-zero when one lands in the wrong place.
  - **Fetching is somebody else's donated infrastructure**, so: cached images are never
    re-requested (not even revalidated — a title plus a width names one immutable image, so
    a second run makes *zero* requests), requests are serial and at least a second apart
    however many callers there are, `429`/`503` and `Retry-After` are obeyed, and the
    User-Agent carries a contact address because Wikimedia's policy requires it.
  - **Two URL facts, both measured:** an arbitrary thumbnail width from
    `upload.wikimedia.org/.../thumb/.../512px-…` answers **400** ("Use thumbnail sizes
    listed on…"); `Special:FilePath/<name>?width=N` answers 200 and is what is used.
  - **Corpus entries must be roughly square**, and this is not fussiness: the same NASA
    portrait decides **`up` at 512×512 and `down` at 960×1200**. A taller picture shows a
    smaller share of its own height and turns up a different set of regions, so a
    non-square entry tests a geometry the receiver never sends and reports a verdict that
    means nothing.
  - **English Wikipedia is not a source.** It hosts album covers as non-free "fair use";
    only files on Commons are free.
  - **An entry may carry `knownGap`**, and one does. A corpus holding only cases the code
    passes teaches nobody anything; a known gap shows on the sheet, does not fail the run,
    and — the useful half — is reported loudly if it ever starts *passing*, because the
    note has then become a lie.
  - **The corpus found two real bugs within minutes of first containing real photographs,
    both in code that 978 synthetic tests were happy with:**
    1. **A scan carrying one component is not interleaved.** Greyscale JPEGs routinely
       declare `2x2` sampling anyway — every Library of Congress scan in the Gottlieb jazz
       collection does — and reading that as interleaved demands four blocks per MCU over
       an MCU grid half as wide and half as tall: 4352 blocks against 4221 present, the
       reader runs off the end, and the cover is "unreadable". The suite's own encoder
       wrote `1x1`, which is legal, common, and exactly the case that already worked.
    2. **`coverFocus` gave up on a greyscale cover before the cascade ran.** It returned
       "no colour" and stopped — so a black-and-white sleeve got no face detection at all,
       while the cascade, which is the *entire* answer for black-and-white, reads
       brightness and never wanted chroma. A test asserted that behaviour, so the bug was
       pinned rather than caught.

### A source that loses its input says nothing on the way out

Move the input away from a streaming source and the metadata frames simply **stop**.
There is no "stopped" message, so there is nothing to react to — and anything that treats
the last thing it was told as still true goes on naming a song that ended when the user
switched to the Blu-ray player. On a short display that is a wrong flash; on the permanent
one it is forever.

**This is not observable on the reference VSX-S520D.** That unit hops back to its network
input by itself while music is still arriving, so the input never stays away long enough.
`tests/fixtures/now-playing-capture.json` was recorded while playing and contains no `SLI`
frame at all. It is therefore modelled in the double rather than captured:
`startMockReceiver({ playback: { input, title, artist, album, tickMs } })` plays on one
input and goes silent — with no farewell — the moment `SLI` moves elsewhere.
`tests/now-playing-input-change.test.ts` drives the real tracker over a real socket
against it, and its first test asserts the *premise* (nothing is announced), so the rest
cannot end up proving something easier than the real problem.

The input change is the only signal there is, so `applyInput` uses it, with two guards
that each cost something to get wrong:

- **Only a change counts.** `SLI` is broadcast on connect and on power-on, and the offline
  backoff reconnects every few seconds — treating every frame as a change blanks a display
  that is perfectly correct.
- **`SLI` is in `PRIME_COMMANDS`** although it is not metadata. Without a first value the
  first change is indistinguishable from the first sighting and is missed — a gap the test
  found, not a precaution.

Nothing is queried after a clear: a receiver whose source is still playing announces again
by itself when the input returns (asserted), and priming there would put seven queries on
the wire for every step of an Auto-Discover sweep, which cycles every input on a receiver
that allows one connection.

### Generated files contain only generated content

`specValueLabels`/`matchesSpecValue` used to sit at the end of the *generated*
`command-registry.ts`. Any `npm run generate` deleted them silently; it surfaced only
when the build failed on a missing export. They now live in `spec-labels.ts`, and
`tests/command-registry.test.ts` asserts the generated file exports exactly the ten
symbols the generator emits.

## Security invariants

The plugin parses unauthenticated LAN traffic, so the network-facing code carries
invariants that are easy to undo by accident. `SECURITY.md` has the threat model
and `docs/security-review-2026-07.md` the full findings; the load-bearing rules:

- **Bound anything that comes off the wire.** `MAX_FRAME_BYTES` (protocol),
  `MAX_RECEIVE_BUFFER_BYTES` (transport), device/datagram caps (discovery), name
  and entry caps (`name-store`). Exceeding a limit tears the connection down —
  fail loudly, never grow quietly.
- **`ReceiveBuffer` is the only accumulator.** Do not reintroduce
  `Buffer.concat([buffer, chunk])` per `data` event (quadratic) or hand out
  `subarray` views of it (they pin the whole allocation).
- **Untrusted text is escaped or clamped at every output.** `truncateForLog` for
  logs; the sanitisers in `discover.ts` and `name-store.ts` for anything rendered
  or persisted. ASCII decoding masks the high bit rather than rejecting, so
  control bytes genuinely arrive.
- **`encodePacket` is the outbound validation boundary** (3-char command,
  printable bounded parameter). A parameter containing CR would smuggle a second
  ISCP command into one frame.
- **Regexes over wire data must be linear.** Anchored trailing-run patterns
  backtrack quadratically; `stripTerminators` was a real ReDoS found by fuzzing.
- **The plugin is the delivery path for foreign image data into a native decoder it
  does not own.** Cover bytes go to Stream Deck as a `data:image/jpeg` URI and are
  decoded there by Qt; a receiver on the LAN only has to announce a cover to reach it.
  `stripJpegMetadata` removes APP0–APP15 on receipt (both the inline and the HTTP path,
  so the content hashes still match) — the cheapest step of the staged answer in
  `SECURITY.md`. **COM is kept deliberately**: no structure to misparse, and it is where
  benign bulk lives — the anonymised capture fixture pads its covers to the recorded
  lengths with COM segments, and stripping those collapsed two recorded transfers into
  one 141-byte image.
- **Decoding cover pixels stays in our own bounded code.** See the note on
  `image-luma.ts` above for why a dependency was rejected and why a worker thread would
  not have helped.
- **`Nodejs.Debug` must be absent in a release manifest** — not `"disabled"`; see
  the note above.
- **PI text needs an explicit colour, and that goes for every plain element, not
  just hints.** Plain text in a Property Inspector inherits black, which is
  invisible on the dark panel; sdpi-components themes only its own components.
  Use the shared `.pi-hint` / `.pi-warn` / `.pi-names-header` classes in
  `ui/eiscp-pi.css` and never dim hints with `opacity`. A hand-rolled
  `class="sdpi-item-label"` does **not** help — that class is markup sdpi styles
  inside its own shadow DOM, so a `<div>` wearing it outside is unstyled black,
  which is how the name editor's headings shipped unreadable. The *font* inherits
  the same way: the webview default is Times New Roman, so `eiscp-pi.css` states
  sdpi's own stack on `body` — their components keep their shadow-DOM rule.
- **The manual-IP escape hatch must not depend on the plugin.** The Device IP
  dropdown is filled by a plugin round-trip; if the plugin is down the PI still
  has to let the user type an address (`renderDeviceIp`'s watchdog and "Enter IP
  manually" button).
- **New fuzz findings go into `tests/fixtures/fuzz-corpus.json`**, not just a fix.

## Testing without hardware

`tests/helpers/mock-receiver.ts` is a fixture-driven TCP double of the
VSX-S520D (answers from `tests/fixtures/command-responses.json`, captured from
the real unit via `npm run capture:responses`; ignores SPA/SPB/DIR like the
real device; echoes sets with UP/DOWN/TG semantics). Transport, client, and
ConnectionManager behaviour tests run against it — prefer it over ad-hoc
`net.createServer` mocks.

**The double has a power state, and it is explicit.** `startMockReceiver`
defaults to a receiver that is **on** (`power: "on"`, which overrides the
captured map's `PWR 00`) because the fixture was recorded in standby while the
old double still honoured every set — a receiver that behaves that way does not
exist. The standby behaviour is selectable, since not every receiver is alike:

- `power: "on" | "standby"` — `PWR` sets always work, so a test can wake it.
- `standbySets: "ignore" | "echo" | "accept"` — dropped in silence (the measured
  VSX-S520D), acknowledged with the *unchanged* value, or applied anyway.
- `standbyWakeCommands` (default `["SLI"]`) — sets that power the unit on and are
  then applied, which is what the real one does with an input change.
- `silent: true` — connects and never answers (the half-open receiver).
- `refuseConnections: true` — a port with nothing behind it (ECONNREFUSED).
- `autoReturn: { input, afterMs, mode?, display?, ignoresPause? }` — **the only thing this double does
  that nobody asked for.** A moment after the input moves away from `input`, it goes back
  there and announces the input, then a listening mode, then display text. Everything else
  here is an answer to a request, which is exactly why the two learned-name defects were
  invisible until they had been persisted. `display` is a *list* because a real display
  scrolls: consecutive reads must differ, or the sweep's majority rule is entitled to
  believe the reading (a frozen readout is a persistent one, which is a different receiver).
  `tests/auto-return.test.ts` is the only test that wires the real sweep, the real name
  store and a real socket together — `sweep.test.ts` fakes the receiver and
  `sweep-capture.test.ts` fakes the store, and neither can express a frame the receiver
  sent on its own initiative. `NTC PAUSE` disarms the hop and `NTC PLAY` re-arms it (and
  the double broadcasts `NST`, as the real one does, since `NTC` echoes nothing);
  `ignoresPause: true` is the receiver for which that is not true, which is what keeps the
  detect-and-report path tested.

For behaviour the synthetic echo cannot express, the mock also **replays recorded
wire traffic**: `startMockReceiver({ replay, replayTimeScale })` groups a captured
frame list into request/response exchanges and answers each repetition of a
request with what the real device said *that* time round (`replayTimeScale: 0`
keeps the captured order but drops the captured waits, so CI stays fast).

- **`npm run capture:names`** (`scripts/capture-name-discovery.ts`) records both
  Auto-Discover sweeps into `tests/fixtures/name-discovery-capture.json`. Unlike
  `capture:responses` it **changes receiver state** (it cycles every input and
  listening mode), so it snapshots/restores power, input, mode and refuses to run
  without `EISCP_ALLOW_STATE_CHANGES=1`. Stop the plugin first — the receiver
  allows a single connection. The sweep is driven by the plugin's own `runSweep`,
  so the recording is what production sends, not an imitation.
- `tests/sweep-capture.test.ts` runs `runSweep` against that recording. It covers
  what no synthetic mock reproduces: `UP` walks the receiver's own input order
  (`10 → 01 → 02 → 11 …`, not a numeric sequence), the input **name (FLD) arrives
  ~1 s before the code** (the reason SLI names are queried instead of learned
  passively, and why the sweep suppresses passive SLI learning), unrelated
  commands broadcast mid-step, and the listening-mode name *lags* its code.
- The fixture contains whatever the display showed at capture time, including a
  radio station name where a tuner input was selected — re-capture rather than
  hand-editing if that matters.
- **The display does not belong to the input alone.** "Volume      14" and
  "Bass : +2" are shaped exactly like the "<input>  <volume>" readout — label,
  padding, trailing digits — so `endsWithVolume` cannot tell them apart, and the
  passive pairer stored them as input names: a real user ended up with an input
  called "Bass : +", and replaying `standby-behaviour-capture.json` through the
  store produced three inputs called "Volume". `noteDisplayChange` now records when
  a command took the display over (`MVL`/`AMT`/`TFR`/…), and `displayIsBusy` gives
  the display to whichever change was **more recent** — a fixed window cannot
  separate the two real cases, both measured off the same `SLI 10`:
  `+40 ms → "BD/DVD       1"` (learn) versus `+1915 ms, but 18 ms after MVL →
  "Volume      14"` (refuse). A tie counts as busy: a missing name costs one clean
  input change, a wrong one persists. `tests/name-store-capture.test.ts` replays the
  recording and fails without the guard.
- **The number at the end of that readout is the volume, and checking it is what
  separates a track title from an input name.** Found in the wild after the veto above
  was in place: the Input encoder read **"at is Love ("**. The display is 14 characters
  wide and *scrolls*, so a title lands in it ending in a digit often enough — and no
  command owns the display then, because the **source** wrote it. Nothing in the shape
  can tell the two apart; the number can. Every digit-terminated FLD in
  `standby-behaviour-capture.json` ends in the `MVL` in force at that moment (`0E` →
  "GAME        14", `02` → "CBL/SAT      2"), and "at is Love (7" against a volume of
  14 does not. So `noteDisplayChange` now takes the parameter as well and remembers
  `MVL`; both the passive branch and the sweep's `recordSli` check it. **An unknown
  volume vetoes nothing** — `name-discovery-capture.json` contains no `MVL` at all, and
  a receiver that never announces one has to stay learnable. It also catches
  "Bass : +2" a second time, independently.
- **A playing source is not a mode name either.** Same disease on the LMD branch,
  found in the wild: listening mode `82` was learned as **"...Baby One M"** — a
  scrolling track title clipped to the display width — while the user had not touched
  the mode. A mode name is any FLD that does *not* end in digits inside
  `LMD_WINDOW_MS`, and an `LMD` event is no proof of a user action: the receiver
  re-broadcasts it on an input change (recorded: `SLI 10` at 28600 ms, `LMD 80` at
  28640 ms) and switches modes by itself when the source format changes. So
  `METADATA_COMMANDS` (`NJA`, `NLS`, `NLT`, `NTM`, `NFI`, `NTI`, `NAT`, `NAL`) vetoes
  the mode branch as well. Three things about that list:
  - it comes from **what the unit actually sends** during playback (`raw-dump.bin`:
    NJA 169×, NLS 45×) — this firmware never sends `NTI`/`NAT`/`NAL`, so a
    spec-derived list would have missed the case completely;
  - **text, art and time only.** The status flags of the same family (`NDS` "a device
    is present", `NST` "playing") are excluded: they say nothing about the display,
    and including `NDS` broke a test that rightly insists an unrelated broadcast must
    not block learning;
  - it fires only on the sources that behave this way (DAB, USB, NET) and only while
    they play, so everything else keeps learning passively.
- **That veto only sees the moments a source *announces* something, and the gaps are
  wider than the window.** So the transport is asked directly: while `NST` says a source
  is playing, the mode branch refuses every reading. Measured in `input-hop-capture.json`
  (AirPlay playing): the display scrolls the track title one frame every ~300 ms —
  "100% Pure Lov", "% Pure Love", " Pure Love" — and **not one of them ends in a digit**,
  so every single one is routed to the mode branch, where the trailing-volume rule that
  saves the input branch does not exist. In a mode sweep, where an `LMD` opens a window
  every few seconds, those frames land inside one; replaying the recorded titles that way
  stores a title as a mode name, which is what `tests/name-store-capture.test.ts` now
  asserts against (with a control run proving the frames are eligible). Three notes:
  - **`NST` is still not a metadata command.** It says nothing about *the display*, which
    is why it stays out of `METADATA_COMMANDS`; it answers a different question — is a
    source playing at all — and that one it answers exactly.
  - **Unknown is not "no".** `NST` is broadcast only when the transport changes, so a
    plugin that connected mid-playback has never seen one, and an unparseable value is no
    evidence either. Both leave the guard off; `runSweep` therefore queries `NST` before a
    mode sweep, and that answer arms the store through the message observer. Same lesson
    as `quietenForSweep`, which learned it the expensive way.
  - **The cost, stated: while a source plays, listening-mode names are not learned at
    all** — including by Auto-Discover. So the sweep reports `sourcePlaying`, and the PI
    says "a source was playing… pause it and run Auto-Discover again" instead of asking
    whether the receiver is switched on. The receiver reports `NST Sxx` the moment the
    input leaves the source, so the input sweep is unaffected.
- **An input change is a display change, and that veto could not see it.** With AirPlay
  playing, moving the input away makes this receiver hop back to it by itself a few
  seconds later — device-controlled, so another model may not. Mode `82` ("DTS
  Neural:X") was then renamed **"Airplay"**, because the display briefly shows the
  service name. `displayIsBusy` cannot help here twice over: the metadata stopped while
  the input was away, so its ordering rule (`ownChangeAt <= at`) hands the display to
  the newer `LMD`; and that `LMD` is the receiver's own answer to the input change, so
  it is *always* newer. The signal is the input change itself, and the two populations
  do not overlap — timed from the last input change, across every `LMD` in both
  recordings:

  | the receiver's own | the user's |
  |---|---|
  | 9, 9, 10, 13, 13, 15, 36, 40, 70, 255, 337 ms | 2410 ms (`LMD 80` → `00`, "    Stereo    ") |

  Nothing at all was measured in between, so `INPUT_ECHO_MS` (800 ms) is picked from
  the **gap** rather than as a margin around one side. 3000 ms was the first attempt and
  the standby recording refuted it: it swallowed that "Stereo", a name the passive
  learner is meant to get. The flag is set when the `LMD` arrives, not when its `FLD`
  does — by then the two are only correlated — and re-checked at the `FLD` for an input
  change that lands in between. `inputChangedAt` is recorded **before** the sweeping
  early return, since Auto-Discover changes the input twelve times and the receiver
  answers each one.
- **A second layer: a text that names the currently selected input is not a mode name.**
  Timing-independent, and it needs **exact** equality rather than `matchesSpecValue`,
  whose prefix rule would veto the mode "Game-RPG" while the `GAME` input is selected.
  Worth knowing before it is mistaken for the fix: it does **not** catch the case above.
  `specValueLabels("SLI","2D")` is `["AIPLAY"]` — a typo in the vendor workbook — and
  this unit reaches AirPlay through `SLI 2B` ("NET") anyway.
- **The name store logs, and only on change.** It logged nothing at all, so the day this
  bug was reported the plugin's log had no record of a name ever being learned. One line
  when a name is stored or replaced (`LMD 82: "DTS Neural:X" -> "Airplay"` — the line
  that answers *when*), and one deduped line for the refusals above. The metadata veto
  stays silent deliberately: it fires on every track of every stream.
- The sweep's `recordSli` had **no** format check at all — its `query("FLD")` is
  settled by the first FLD to arrive, solicited or not — and is now subject to the
  volume/tone veto. **Not to the metadata veto**, deliberately: the recorded SLI sweep
  contains 35 metadata frames because it steps onto NET/USB while they stream, so
  vetoing there would make those inputs permanently unnameable. The sweep asks the
  display a question at a moment it chose and has the majority loop behind it; passive
  learning only overhears and has to be stricter. What no format rule can fix is the tuner: with `SLI 24/33` selected the
  display genuinely shows the station ("FM 87.50MHz", "TEDDY"), so those *are* what
  the receiver reports for that input.
- **So the user gets the last word, and three slots are pre-filled.** `nameFor` resolves
  **the user's own name ▸ a pre-filled default ▸ the learned name ▸ the registry**, all
  per host. `DEFAULT_NAMES` gives `SLI 24/25/33` the names "FM", "AM" and "DAB" —
  the three the tuner case above proves no amount of sweeping can get right. Details
  worth keeping straight:
  - **A pre-fill is not a write.** It applies with nothing stored, so it works whether or
    not the editor is ever opened; the learned station name stays in the store beside it.
  - **A stored entry always beats the pre-fill, including one switched off** — that is
    how a user says "show me the station after all". `use` is stored *separately from the
    text*, so switching back and forth is not a retype, and an empty name clears the
    entry (which restores the pre-fill).
  - **`hasLearnedName` stays learned-only.** It is what the sweep counts, and a
    hand-typed name must not dress up "8 of 12 named" as the receiver's work.
  - **`seen` records every option code the receiver reports**, sweeps included, and is
    persisted alongside the names. Its whole point is the codes with *no* name: a tuner
    input never learns one, and without a record that the code exists there would be
    nothing to hang a hand-typed name on.
  - **A typed name reaches the deck through `onNamesChanged`.** A learned one only ever
    repainted because it rides on an `FLD` frame the ConnectionManager broadcasts anyway;
    a name from the PI produces no frame, hence `watchNames` (the key cyclers) and
    `rerendersOnNameChange()` (the dials).
  - Names, user names and seen codes are written in **one** patch by the store's single
    debounced writer — see the `updateGlobalSettings` doc comment for why a second writer
    for the same subject loses data.
- **The sweep measures a doubtful reading again** (`learnInputName` in `sweep.ts`).
  A trustworthy reading is taken once — the normal case, one query. Otherwise it
  re-reads, and from `MAJORITY_AT` (3) readings on the most frequent text wins, up
  to `MAX_NAME_SAMPLES` (5), `RESAMPLE_MS` (800 ms) apart. That works because the
  input readout is the **persistent** one: a transient pushes it aside for ~1.5 s,
  so three readings outlast one transient rather than all three catching it. A
  majority is stronger evidence than either check the store applies, so the winner
  is stored `{ corroborated: true }` even if it still disagrees with the spec — a
  tie stores nothing. Limitation: something rewriting the display for the *whole*
  window (a volume dial turned during a sweep) can win, and re-running Auto-Discover
  on a quiet receiver is the cure.
- **Auto-Discover against a receiver that steers itself.** The sweep's only evidence that
  its `UP` landed is that the cached value changed — and an unsolicited frame lands in the
  same cache. So a receiver that hops back to its playing network input a few seconds after
  the input leaves it *ends the sweep*: the hop is an exact `current === start`, which reads
  as a wrap. Measured against the double (`autoReturn`, hop at 60 ms): **2 steps, 2 options,
  0 named** — and before this it was reported as a clean run, so the Property Inspector asked
  whether the receiver was switched on about a receiver that was awake and playing. Three
  answers, none of which pretends the sweep can tell the two frames apart:
  - `learnInputName` re-reads the input code beside every FLD sample and drops the sample if
    it moved — that is the "name of input X stored for code Y" case, which the display's
    1-2 s code lag makes wide;
  - `runSweep` re-reads the code after each reading window and says so (`WARN … the receiver
    is moving on its own`);
  - both set `interrupted`, which rides the `done` message to the PI: *"Stopped early — the
    receiver kept changing the input by itself. Try again with playback stopped."*
  A sweep that outruns the hop (each step re-arms the receiver's timer) still completes
  normally, which is why this is a report rather than a refusal.
- **So the input sweep quietens the receiver first** (`quietenForSweep`, SLI only — the mode
  sweep never leaves the input and is untouched): `PWR` check, `NTC PAUSE`, snapshot, `AMT 01`,
  wait, walk, restore input, resume, unmute. Four things about it are load-bearing:
  - **Mute, never `MVL 00`.** `trailingNumberIsVolume` asks whether a digit-terminated readout
    ends in the *current* volume; at volume 0 that degrades to "must end in a run of zeros",
    which "Loveless 2.0" and every other `.0` boundary satisfies — setting the volume to zero
    switches off the guard for exactly the sweep that needs it. The `MVL` **query** stays and is
    not wasted: neither recorded sweep contains an `MVL` frame, so `s.volume` is `undefined` and
    that guard is dormant during sweeps today. Asking arms it.
  - **The cached `NST` is not enough on its own.** The receiver broadcasts it only when
    the transport *changes*, so a plugin that connected while the music was already
    playing has never seen one — measured on the first live sweep, which reported "not
    playing" about a source that was, paused it, and then honoured its own safe default
    by not resuming. An empty cache is a question: `NST QSTN` does answer (the hop
    capture snapshots it as `Pxx`), so ask, and only treat *no answer* as no evidence.
  - **"Was it playing?" comes from `NST`, not from `metadataAt`.** `METADATA_COMMANDS` includes
    `NLS`/`NLT`/`NFI`, which arrive when a network source is merely *browsed*: the recorded sweep
    of an **idle** receiver has 29 `NLS` + 4 `NLT` + 2 `NFI` and no `NJA`/`NTM` at all, so a
    "metadata arrived recently" heuristic reports *playing* for a silent unit — and Auto-Discover
    would start music nobody asked for. `NST` is broadcast unsolicited and the ConnectionManager
    caches every message, so `parsePlayStatus(getCached(host, "NST"))` costs nothing and cannot
    make that mistake. No `NST`, no resume.
  - **Nothing is asserted that cannot be observed.** `NTC` answers no query (confirmed on
    hardware) and `send` resolves at the write, so the pause is never checked; a failed `AMT`
    query means no mute at all (never change what you cannot put back); and in **standby** every
    one of `NTC`/`MVL`/`AMT` is swallowed while `SLI` is honoured *and powers the unit on* — so
    the receiver is woken first and put back afterwards, or the sweep would assert a mute that
    never landed and then walk the inputs at full volume.
  - **The unmute is last and the resume waits.** `NTC` addresses the *selected* network source,
    so resuming before the input is confirmed back talks to the wrong one and re-creates the hop;
    and if the resume fails, a receiver left silent reads as broken hardware while a source left
    paused is one button.

- **What the hop actually looks like, measured** (`npm run capture:hop` →
  `tests/fixtures/input-hop-capture.json`, taken with AirPlay playing). Two runs, one input
  step and two quick ones:

  | | one step | two quick steps |
  |---|---|---|
  | our `SLI` landed | 1128 ms (`29` USB) | 1545 ms (`2E` BT AUDIO) |
  | receiver hopped back to `2B` | 9545 ms (**+8.4 s**) | 9404 ms (**+7.9 s**) |
  | its own `LMD 82` after the hop | +10 ms | **+780 ms** |
  | `FLD "   AirPlay    "` | +28 ms | +790 ms |
  | `NST` play again | +606 ms | +1406 ms |
  | volume | `MVL 00` +2291 ms | `MVL 0A` +3107 ms, then `MVL 00` +3182 ms |

  Three things fell out of it, and two of them changed the code:
  - **`INPUT_ECHO_MS` was nearly too small.** Every earlier sample of the receiver's own
    `LMD` was under 340 ms; this recording caught one at **780 ms**, twenty milliseconds
    inside the 800 ms window. Widened to **1500 ms** — still clear of the 2410 ms
    deliberate mode change, but now sitting in the middle of the gap instead of at the
    edge of what had been seen. `tests/name-store-capture.test.ts` reads the worst gap out
    of the fixture, so a slower receiver fails the test rather than silently disarming the
    guard.
  - **At volume 0 this receiver prints `Min`, not a number**: `"NET        Min"`,
    `"BT AUDIO   Min"`, `"Volume     Min"`. That is the measurement that settles the
    mute-versus-`MVL 00` question for good — with the volume at zero the input readout
    stops ending in digits, `endsWithVolume` fails, and every readout would be routed to
    the *mode* branch instead. A sweep that set the volume to 0 could not name anything.
  - **The volume drop is not the input change.** It lands ~1.7 s after `NST` reports
    playing again, in both runs, and the second run shows the receiver first restoring its
    own level (`MVL 0A`) and something overriding it **75 ms later** (`MVL 00`). That is
    the AirPlay sender pushing its own volume as the session re-attaches — the plugin has
    no absolute volume set anywhere in its code.

  **The premise — that a paused source stops the hop — is device knowledge, not measured here.**
  It is modelled in the double (`autoReturn` honours `NTC PAUSE`), and the other kind of receiver
  is modelled too (`autoReturn.ignoresPause`), because the detect-and-report path above is what
  is left if the premise turns out to be false. A live probe settles it in 30 seconds: pause,
  move the input, watch.
- **`corroborated` may excuse a busy display; it may not excuse the volume rule.** A majority
  establishes *which text* was on the display, never that the text is an input readout. A
  frozen scrolling title reads identically three times running and wins a majority by
  definition — measured, it stored "at is Love (" through that path while every other guard
  was in place. And a **rejected** reading no longer votes at all: three identical rejects
  used to reach `MAJORITY_AT` and come back as `corroborated`, which is the escalation itself.
- **What the sweep logs, and why it is at INFO.** A sweep is rare, explicitly asked for and
  disruptive, so one line per step is proportionate — and it is the only record of the path
  the run actually took. Every termination now says which of the four it was; before, all
  four were silent and the `done` line read identically for a complete run and a truncated
  one. **The disrupted run used to write fewer lines than the healthy one.**
- **`EISCP_DEBUG=1` did nothing on a release build, and `log.debug` is unreachable there.**
  The SDK builds the plugin logger with `minimumLevel: isDebugMode() ? "trace" : "debug"`,
  `isDebugMode()` is true only under `--inspect` (i.e. only `npm run watch`), and
  `Logger.setLevel` does not clamp an out-of-range level — it **resets to `"info"`**. So
  asking for `"trace"` off the watch loop silently gave INFO. `plugin.ts` now asks for
  `"debug"` (and honours `EISCP_LOG_LEVEL`), and anything that has to be visible in a shipped
  build belongs at INFO. Careful with root-level `"debug"`: `connection-manager` logs one line
  per decoded frame there, i.e. ~1800/s during a cover transfer.
- **"A tie stores nothing" was not true, and it is the other half of "at is Love (".**
  The sampling loop stored *every* reading it took and then logged "leaving it unnamed".
  A scrolling title reads differently each time, so no majority can ever emerge — and
  the last sample stayed in the store, from a sweep that reported nothing. Samples are
  now taken `{ tentative: true }`: the outcome is reported, and a reading the spec does
  not recognise is not stored until a majority corroborates it. An honest relabel
  ("BT AUDIO") is unaffected, because a persistent display wins its majority.
- **What counts as doubtful comes out of the protocol spec, not out of guesses.**
  `specValueLabels` / `matchesSpecValue` (`command-registry.ts`) read the labels
  from the generated registry — the *description* is the useful field, since
  `SLI 10` is `name: "dvd"` but `description: "sets DVD, BD/DVD"`, and "BD/DVD" is
  exactly what the panel shows. Measured against the real unit it accepts nine of
  twelve inputs outright (including "CBL/SAT" for "CBL, SAT" and "FM 87.50MHz" for
  "FM") and flags three: the corrupted name, the DAB input showing a station, and
  one honest relabel ("BT AUDIO" where the spec says "BLUETOOTH"). Two of three
  flags are worth a second look and the third costs one reading — which is why a
  mismatch **never vetoes**, it only asks for corroboration. `recordSli` returns
  `doubtful` in that case and still stores the name.
- **`npm run capture:hop`** (`scripts/capture-input-hop.ts`) records what the receiver
  does *on its own* when the input is taken away from a playing network source: the hop
  back, the mode it announces with it, the display text, and any volume it changes
  without being asked. Two runs (one input step, then two quickly, to catch the race)
  with a 25 s watch each. State-changing, so it snapshots power/input/volume/mute,
  restores them, and refuses to run without `EISCP_ALLOW_STATE_CHANGES=1`. Cover-art
  frames are folded into one entry per run (`collapseArt`) — 1909 of the 2199 frames
  were `NJA`, and left expanded the fixture was eight times larger than every other
  capture while proving nothing extra.
- **`npm run capture:standby`** (`scripts/capture-standby-behaviour.ts`) measures
  what a set does in standby versus awake, as `query — set — wait — query`, so
  "the receiver ignored it" is observed rather than assumed. Also state-changing
  (`EISCP_ALLOW_STATE_CHANGES=1`, snapshot/restore, volume hard-capped at 2, and
  the unit is held at that volume while awake). It re-establishes the power state
  **before every probe** — the first version did not, and one `SLI` set woke the
  unit and silently turned the rest of the "standby" phase into an awake one.
- `tests/standby-capture.test.ts` asserts the recording itself (so the hardware
  truth is executable, and a re-capture of a differently-behaving device fails
  loudly) and then requires the mock's synthetic standby model to reproduce it.

## Property Inspector (PI) notes

PIs are static HTML in `*.sdPlugin/ui/` using SDPI Components v4
(`sdpi-components.dev`); shared helpers live in `ui/eiscp-pi.js`.

- The **option-name editor** (`ui/name-editor.js`, in `discover.html` and
  `dial-discover.html`) lists one row per option: the code, the user's own name, and
  underneath it what the receiver called it — always visible, since that is the thing
  the checkbox switches between. Four rules it lives by:
  - **Plain elements, not sdpi-components.** These names are plugin-persisted globals,
    and a `global`-bound input writes the whole settings object back from its own
    snapshot — the failure `pi-wake.ts` exists to prevent, and this panel is the one
    that is open while Auto-Discover learns names. It also sidesteps the `sdpi-select`
    upgrade trap below entirely.
  - **Rows are built with the DOM, never `innerHTML`.** Every name in them came off the
    network.
  - **The plugin resolves the host from `getRememberedActionSettings`**, never
    `action.getSettings()` — this request fires when the panel *opens*, and that round
    trip's `didReceiveSettings` re-enters the action's own handler and re-binds it.
  - The list is requested on open, when the effective IP changes, and when a sweep
    reports `done` (a sweep is what fills it); writes are debounced and answered with
    the value **as stored**, which is not always what was typed.

- **`sdpi-select` only picks up `<option>`s from DOM mutations that happen
  AFTER the component upgraded** (verified empirically against sdpi-components
  v4, 2026-07-19). Consequences:
  - Static markup options work — but only because `sdpi-components.js` loads
    in the `<head>`, so the parser streams the options in after the element
    upgraded. Keep that load order.
  - `appendChild`/`innerHTML` on an *already-upgraded* select works too (this
    is why `buildParamSelect` in `ui/eiscp-pi.js` works).
  - Options that are already children at upgrade time are NEVER rendered.
    That was the real "empty dropdown" bug: injecting a complete
    `<sdpi-select>…<option>…</sdpi-select>` via `innerHTML` upgrades the
    element with its options pre-existing — the dropdown stays empty. The
    same applies to options kept across a rebuild (e.g. `data-keep` options
    present since before the upgrade stay invisible).
  - For dynamic lists the **`datasource`** round-trip remains the robust path
    (the component renders its own items); the Device IP dropdown uses it.
- The **Device IP** dropdown is a datasource:
  `<sdpi-select setting="deviceIp" datasource="getDevices" hot-reload>`. The plugin
  answers via `handleDeviceListMessage` (`src/actions/pi-devices.ts`, pure logic
  in `pi-device-list.ts`) and replies `{ event: "getDevices", items: [...] }`
  (items are grouped `{label, children:[{label,value}]}` or flat
  `{label,value}`). The list always carries the remembered receiver, the asking
  action's own selection (`pinned` — a value missing from the items renders as an
  empty field) and a "Custom IP…" entry; a blocked discovery (e.g. the macOS
  local-network firewall) is labelled "Discovery failed — check Local Network
  permission" instead of pretending the LAN is empty.
- **The reply is immediate; the scan pushes afterwards.** `planDeviceListReply`
  answers from the cache plus `pinned` right away (stale-while-revalidate) and
  only then starts the 2.5 s broadcast, whose result is pushed as a second
  `getDevices` message — `hot-reload` makes `sdpi-select` re-render it *without* a
  new request. Awaiting discovery first was the reason every action added after
  the 8 s cache TTL expired opened its PI on "Scanning the network…" (that TTL is
  always cold by the time a user drags in the next key). The loading text is left
  for the genuine cold start, where there is nothing to show.
- **A `getDevices` message without `items` blanks the dropdown.** The hot-reload
  subscriber renders `payload.items` from *any* message whose `event` matches the
  datasource name, so status must ride on the items message as an extra field
  (`{event, items, scanning}`), never as a separate event. `ui/eiscp-pi.js` reads
  `scanning` to show the "Scanning for more devices…" hint.
- The handler is served from the shared `EiscpActionBase.onSendToPlugin`, so every
  action's PI gets it. Actions that override `onSendToPlugin` (the learned-name
  cyclers/dials, for Auto-Discover) **must call `super.onSendToPlugin`**.

## Device discovery

- eISCP broadcast (ECN) discovery lives in `src/adapter/eiscp/discover.ts`
  (`discoverEiscpDevices`): UDP 60128, query `!1ECNQSTN` / `!pECNQSTN`, responses
  `!1ECN<model>/<port>/<area><id>`; the discovered `host` is the responder's source
  IP. Only non-internal interfaces are scanned (loopback is skipped).
- **`npm run dummy:discovery`** (`scripts/dummy-eiscp-discovery.ts`, `--count N`)
  runs a local server implementing the ECN protocol, so the Device IP dropdown can
  be tested with several fake receivers without owning multiple units. They share
  this machine's IP per interface; distinct models keep entries distinguishable.

## Testing the live Property Inspector (CDP)

Stream Deck exposes Chrome DevTools Protocol at `http://127.0.0.1:23654`;
`…/json/list` lists the open PI webview. This endpoint belongs to the **Stream
Deck app** (it is the app process that listens on 23654) and is independent of
the plugin's `Nodejs.Debug` setting — PI debugging keeps working with debug mode
off. `Nodejs.Debug: "enabled"` is a different thing: it adds
`--inspect=127.0.0.1:<port>` to the *plugin's* Node process, which is why it
must not ship. Attach a
CDP browser (e.g. the `web-browser` skill, `connect 23654`) to inspect and
drive the live PI. The webview title depends on the PI HTML:
"eISCP Settings" (`dedicated.html`, `discover.html`), "eISCP Button Settings"
(`eiscp-button.html`), "eISCP Dial Settings" (`eiscp-dial.html`,
`dial-press.html`, `dial-discover.html`), "eISCP Dial Indicator Settings",
"eISCP Toggle Settings", "Transport Settings" (`transport.html`). Caveats:

- The PI webview exists **only while its action is selected**; a plugin restart
  closes it.
- PI HTML/JS edits (`*.sdPlugin/ui/`) take effect on a PI reload — no build needed.
  Plugin (`src/`) changes need `npm run build` then
  `npx streamdeck restart de.schwetschke.sd.eiscp-avr-remote`.

## Live test receiver

A real Pioneer **VSX-S520D** is on the LAN at `10.2.0.32` (also the dev CLI's
default host; the plugin itself has no default IP). Verify wire behaviour with
the maintained CLI (`npm run eiscp -- state` / `mute toggle` / `mode STEREO`),
not ad-hoc `createClient` scripts that `send()` then `query()` — those race and
give false negatives (state events lag a set by ~1.5 s; poll instead). The
hardware suite (`EISCP_TEST_HOST=10.2.0.32 npm run test:eiscp:integration`)
snapshots the receiver state, powers it on when needed, and restores
everything afterwards. Device quirks worth knowing:

- Ignores `DIR` (Direct) and `SPA`/`SPB` — queries to them time out; use
  `LMD` listening modes instead.
- Keeps only **one eISCP connection**: a second connect makes it drop the
  first. Never hold two connections in tests. Since the power-state heartbeat
  arrived this bites harder: the plugin now reconnects on its own after ~5 s
  (measured), so it takes the connection back from a CLI or capture script
  instead of staying idle. Stop the plugin, do not just hope it is quiet.
- Selecting the TUNER input (`SLI 26`) makes it report the active band
  (FM = `24` / AM = `25`), never `26` itself.
- **In network standby it answers every query but drops sets in silence** — no
  echo, no state change, nothing on the display. Measured, with one exception:
  `SLI` (input selection) *powers the unit on* and is applied, which is why it
  and `PWR` are the `STANDBY_HONOURED_COMMANDS`. A query after the set is the
  only way to tell; the write itself succeeds either way.
  (`tests/fixtures/standby-behaviour-capture.json`, `npm run capture:standby`.)
- Right after a power-on `LMD` reads `N/A` for a moment, and setting `MVL`
  auto-unmutes (`!1AMT00` arrives before the `!1MVL..` echo).
- **`N/A` is also how it refuses a value it does not implement**, and `RES`
  (Monitor Out Resolution) is the case that matters. Measured 2026-08-08 — and
  it contradicts the spec, which lists eleven resolutions and marks every one of
  them `set1`:

  | sent | answer | front panel |
  |---|---|---|
  | `RES 00` | `!1RES00` | — (back to the input readout) |
  | `RES 01` | `!1RES01` | **`Upscaling:Auto`** |
  | `RES 05`, `RES 06`, `RES 08` | `!1RESN/A`, value unchanged | — |

  So this unit implements exactly **two** of the eleven: `01` is the menu's
  "1080p → 4K Upscaling: **Auto**" and `00` is **Off**. The spec's own 4K value,
  `RES 08` ("4K Upcaling (HDMI Output Only)"), is **rejected here** — building
  the `upscale-4k` key off the enumeration would have produced a key that does
  nothing, silently, because a refused set still looks like a delivered one. The
  registry keeps all eleven values because it is model-generic; the dedicated key
  pins the measured pair (`tests/dial-catalog.test.ts`).
  Consequence for the user, and the reason the tooltip says so: with upscaling on
  the receiver stops accepting 4K at its **inputs**; off, 4K passes through.
- **`RES` reports back only what the protocol set — never what the front panel
  did, and it never broadcasts.** This is the sharper half of the same finding and
  it cost an afternoon of chasing an "inverted" key that was rendering correctly
  all along. Measured 2026-08-08, connection provably alive throughout (the `PWR`
  heartbeat kept answering on either side of it):

  | step | `RES QSTN` afterwards |
  |---|---|
  | upscaling switched to **Off in the receiver's own OSD** | **`01`** — unchanged |
  | `RES 00` sent over ISCP | `00` |
  | `RES 01` sent over ISCP | `01` |

  The unit *applies* the OSD change (its display writes `Upscaling:Off `, the menu
  agrees) and still answers `01`. So the ISCP-visible value is a shadow of the
  protocol path alone. Two consequences:
  - **A re-query cannot repair the key.** `bindKey` already queries on every
    appear, and the query returns the same stale shadow — so a page or profile
    switch does not fix it either. There is no way to read the true state at all.
  - **The only trace of an out-of-band change is the `FLD` display text**
    (`Upscaling:Off ` / `Upscaling:Auto`), which is model- and wording-specific.

  The key is therefore authoritative for changes *it* made, which is the normal
  case, and can show a stale state after someone uses the receiver's own remote.
  Do not "fix" this by polling `RES`: polling returns the shadow value too.
- **`SPR` (Super Resolution) behaves nothing like its neighbour, and every claim
  below is measured** (2026-08-08) because the pessimistic reading of `RES` would
  have said not to build the dial at all:

  | sent | answer | front panel |
  |---|---|---|
  | `SPR UP` while `RES 00` | `!1SPRN/A`, value unchanged | **`Not Available `** |
  | `SPR UP` while `RES 01` | `!1SPR03` after ~80 ms | `Super Res   :3` (~108 ms) |
  | `SPR 01` | `!1SPR01` | `Super Res   :1` |
  | `SPR 1` | **`!1SPRN/A`** | — |

  Three things follow, and each one killed an objection to the dial:
  - **Liveness needs no guessing.** The receiver *says* the setting is dead. That
    matters because `SPR QSTN` answers `02` whether upscaling is on or off, so the
    query never could have told you — but a rotation always does.
  - **It echoes its own sets**, unlike `RES`, which broadcasts nothing at all. That
    is the subscription `DialActionBase` repaints from; without it the strip would
    freeze after every rotation.
  - **Two digits are mandatory.** `SPR 1` is refused, so `normalizeParam`'s padding
    is load-bearing and `SPR` must never join `NO_HEX_PAD`.

  The registry entry needs three lines in the generator and nothing more: `"SPR"`
  in `INCLUDED_COMMANDS`, a `CODE_CATEGORY`, and `STEPPER_MAX: 3` — without that
  last one it inherits the default 24 and a 0-3 setting paints as a bar stuck in
  the left eighth. Do **not** expand the range key into `00`..`03`: `extractValues`
  skipping it is what keeps `formatCommandValue` from rendering the range's shared
  name `no-0-3` as the level.

  Still unverified, so not in any tooltip: **wrap-around**. It is inferred from
  `description: "sets Super Resolution Wrap-Around Up"`, and that phrase is
  boilerplate in this YAML — it is attached to `AMT TG` and `DIR TG`, which are
  toggles, and to `SPB UP` on a unit that ignores `SPB` entirely.
- **`UPS` is not what its name suggests.** It is called "Upsampling" and its
  `QSTN` description even reads "gets The Upscaling State" — but it is *audio*
  (x1/x2/x4/x8). The video control is `RES`.
- **Its timing is not deterministic, and that is not noise — it is the reason the
  sweep polls instead of waiting a fixed delay.** Measured across the captured sweep
  steps (`tests/fixtures/name-discovery-capture.json`):
  - `SLI` codes arrive **1103–2044 ms** after `UP` — a 1.9× spread, and the worst case
    already eats 68 % of `MAX_WAIT_MS` (3000 ms). Anything slower is indistinguishable
    from "the value did not change".
  - `LMD` codes arrive in **76–205 ms** — an order of magnitude faster, same command
    shape — while their *names* lag 46–436 ms.
  - One `LMD UP` was **never answered at all**, which is why the recorded sweep is 9
    steps over 8 modes.
  - For `SLI` the display name arrives ~50 ms after `UP` while the code takes 1–2 s, so
    the name leads its code by a factor of 20–40. That is the mis-pairing the passive
    learner cannot avoid and the reason the sweep queries `FLD` explicitly.

  Consequence for tests: assert *relationships* and values read out of the fixture, not
  counts typed in by hand — a re-capture may legitimately produce different totals.
