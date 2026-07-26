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
  LAN IPs and the learned-name map, into the plugin's log files.
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
    Every swc variant does the same. That would break the 25 `@action` classes at
    runtime, and **no test would notice** — nothing here ever looks at the bundle.
  - Leaving Rollup costs more than the config: it tree-shakes `zod`'s locale barrel
    (`export * as locales`, 114 KB) and `to-json-schema`, which esbuild-style DCE
    cannot drop — the bun bundle is +103 % and plain esbuild needs a `sideEffects`
    override keyed to `@elgato/utils`' internal file paths to avoid 2.19×.

  `tests/bundle-artifact.test.ts` guards the part that no other test could see: the
  built bundle parses, carries the standard decorator context, and gets far enough to
  register all 25 actions. Note what it had to work around — `registerAction` throws
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
- **`Nodejs.Debug` must be absent in a release manifest** — not `"disabled"`; see
  the note above.
- **PI hint text needs an explicit colour.** Plain text in a Property Inspector
  inherits black, which is invisible on the dark panel; sdpi-components themes
  only its own components. Use the shared `.pi-hint` / `.pi-warn` classes in
  `ui/eiscp-pi.css` and never dim hints with `opacity`.
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
- The sweep's `recordSli` had **no** format check at all — its `query("FLD")` is
  settled by the first FLD to arrive, solicited or not — and is now subject to the
  same veto. What no format rule can fix is the tuner: with `SLI 24/33` selected the
  display genuinely shows the station ("FM 87.50MHz", "TEDDY"), so those *are* what
  the receiver reports for that input.
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
