# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stream Deck plugin for remote controlling Pioneer and Onkyo network receivers using the ISCP (Integra Serial Control Protocol) over Ethernet (eISCP protocol). Currently in early development (v0.1.0.0) with a template counter action that demonstrates the plugin architecture.

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
3. **Manifest** (`de.schwetschke.sd.pioneer-onkyo-remote.sdPlugin/manifest.json`) - Plugin metadata, action definitions, requirements
4. **Property Inspectors** (`de.schwetschke.sd.pioneer-onkyo-remote.sdPlugin/ui/`) - HTML settings panels using SDPI Components v4

### Action Pattern

Actions use TypeScript decorators and extend SDK base classes:

```typescript
@action({ UUID: "de.schwetschke.sd.pioneer-onkyo-remote.action-name" })
class MyAction extends SingletonAction<Settings> {
  onWillAppear(ev, context): void { ... }
  onKeyDown(ev, context): void { ... }
}
```

**Critical:** Action UUIDs must match between TypeScript decorators and `manifest.json`.

### Build System

- **Tool:** Rollup with TypeScript compilation
- **Entry:** `src/plugin.ts`
- **Output:** `de.schwetschke.sd.pioneer-onkyo-remote.sdPlugin/bin/plugin.js`
- **Watch mode:** Generates source maps, disables minification, auto-restarts plugin

## Important Notes

- **Plugin ID:** `de.schwetschke.sd.pioneer-onkyo-remote`
- **Node.js requirement:** Plugin requires Node.js 20 (dev env uses 24)
- **Debug mode:** Enabled in manifest
- **Build output ignored:** `*.sdPlugin/bin` is gitignored, plugin source is tracked
- **Logging:** Currently set to "trace" level in `plugin.ts`
