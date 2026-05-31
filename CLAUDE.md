# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stream Deck plugin ("eISCP AV Receiver Remote Control") for remote controlling AV receivers that speak the ISCP (Integra Serial Control Protocol) over Ethernet (eISCP). Compatible with many Pioneer, Onkyo and Integra network receivers; this is an independent project, not affiliated with or endorsed by those manufacturers. Currently in early development (v0.1.0.0).

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

Actions use TypeScript decorators and extend SDK base classes:

```typescript
@action({ UUID: "de.schwetschke.sd.eiscp-avr-remote.action-name" })
class MyAction extends SingletonAction<Settings> {
  onWillAppear(ev, context): void { ... }
  onKeyDown(ev, context): void { ... }
}
```

**Critical:** Action UUIDs must match between TypeScript decorators and `manifest.json`.

### Build System

- **Tool:** Rollup with TypeScript compilation
- **Entry:** `src/plugin.ts`
- **Output:** `de.schwetschke.sd.eiscp-avr-remote.sdPlugin/bin/plugin.js`
- **Watch mode:** Generates source maps, disables minification, auto-restarts plugin

## Important Notes

- **Plugin ID:** `de.schwetschke.sd.eiscp-avr-remote`
- **Node.js requirement:** Plugin requires Node.js 20 (dev env uses 24)
- **Debug mode:** Enabled in manifest
- **Build output ignored:** `*.sdPlugin/bin` is gitignored, plugin source is tracked
- **Logging:** Currently set to "trace" level in `plugin.ts`

## Property Inspector (PI) notes

PIs are static HTML in `*.sdPlugin/ui/` using SDPI Components v4
(`sdpi-components.dev`); shared helpers live in `ui/eiscp-pi.js`.

- **`sdpi-select` renders only the `<option>`s present at first paint.** Options
  injected via `innerHTML`, or `appendChild`-ed after the element renders, sit in
  the DOM but never appear (the dropdown looks empty — this caused a real bug).
  Inline `<option>`s in *static* HTML markup are fine. For anything dynamic, use
  the sdpi-components **`datasource`** round-trip instead of hand-built options.
- The **Device IP** dropdown is a datasource:
  `<sdpi-select setting="deviceIp" datasource="getDevices" hot-reload>`. The plugin
  answers via `handleDeviceListMessage` (`src/actions/pi-devices.ts`), which runs
  eISCP discovery and replies `{ event: "getDevices", items: [...] }` (items are
  grouped `{label, children:[{label,value}]}` or flat `{label,value}`). It always
  includes the default IP + a "Custom IP…" entry, so the dropdown is never empty
  even when discovery is blocked (e.g. the macOS local-network firewall).
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

Stream Deck in debug mode exposes Chrome DevTools Protocol at
`http://127.0.0.1:23654`; `…/json/list` lists the open PI webview (title
"eISCP Settings"). Attach a CDP browser (e.g. the `web-browser` skill,
`connect 23654`) to inspect and drive the live PI. Caveats:

- The PI webview exists **only while its action is selected**; a plugin restart
  closes it.
- PI HTML/JS edits (`*.sdPlugin/ui/`) take effect on a PI reload — no build needed.
  Plugin (`src/`) changes need `npm run build` then
  `npx streamdeck restart de.schwetschke.sd.eiscp-avr-remote`.

## Live test receiver

A real Pioneer **VSX-S520D** is on the LAN at `10.2.0.32` (the default in
`resolveDeviceIp`). Verify wire behaviour with the maintained CLI
(`npm run eiscp -- state` / `mute toggle` / `mode STEREO`), not ad-hoc
`createClient` scripts that `send()` then `query()` — those race and give false
negatives. Snapshot/restore values when testing. Note: this unit **ignores the
`DIR` (Direct) command** (`DIR QSTN` times out); use `LMD` listening modes instead.
