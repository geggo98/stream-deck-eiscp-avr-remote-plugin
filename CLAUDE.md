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
- **Debug mode:** **disabled** in the committed manifest and in everything
  `npm run build` produces. `Nodejs.Debug: "enabled"` opens a Node inspector
  port (local code execution into the plugin process) and flips the SDK to
  TRACE, so it must never ship. `npm run watch` turns it on for the dev loop
  (`sync-manifest-version.ts --debug`); `npm run build` turns it back off.
  `npm run verify:manifest` gates `npm run pack` and CI, and a pre-commit hook
  (`forbid-debug-manifest` in `devenv.nix`) blocks committing it enabled.
- **Build output ignored:** `*.sdPlugin/bin` is gitignored, plugin source is tracked
- **Logging:** "info" by default; set `EISCP_DEBUG` to get "trace" (see
  `plugin.ts`). TRACE dumps every WebSocket frame, i.e. full settings objects,
  LAN IPs and the learned-name map, into the plugin's log files.
- **No default device IP:** `resolveDeviceIp` returns `undefined` when neither
  the action settings nor the global settings carry an IP; actions then show
  "No IP" / alert and send nothing. There is deliberately no baked-in fallback.
- **Adapter layer must not import `@elgato/streamdeck`:** importing the SDK
  rotates its log files as a module side effect, which races between parallel
  test processes. `src/adapter/**` logs via `src/adapter/logging.ts`
  (`scopedLogger`); the plugin entry point injects the SDK logger. The same
  rule applies to test files: keep them free of transitive SDK imports (the
  SDK-free extractions `pi-device-list.ts`, `sweep.ts`, `device-tracker.ts`
  exist for exactly this).
- **Typecheck surface:** `npm run typecheck` uses `tsconfig.typecheck.json`
  (src + tests + scripts); the build's `tsconfig.json` covers src only.

## Testing without hardware

`tests/helpers/mock-receiver.ts` is a fixture-driven TCP double of the
VSX-S520D (answers from `tests/fixtures/command-responses.json`, captured from
the real unit via `npm run capture:responses`; ignores SPA/SPB/DIR like the
real device; echoes sets with UP/DOWN/TG semantics). Transport, client, and
ConnectionManager behaviour tests run against it — prefer it over ad-hoc
`net.createServer` mocks.

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
  in `pi-device-list.ts`), which runs eISCP discovery and replies
  `{ event: "getDevices", items: [...] }` (items are grouped
  `{label, children:[{label,value}]}` or flat `{label,value}`). It always
  includes the globally configured IP (if any) + a "Custom IP…" entry, and a
  blocked discovery (e.g. the macOS local-network firewall) is labelled
  "Discovery failed — check Local Network permission" instead of pretending
  the LAN is empty.
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
  first. Never hold two connections in tests.
- Selecting the TUNER input (`SLI 26`) makes it report the active band
  (FM = `24` / AM = `25`), never `26` itself.
