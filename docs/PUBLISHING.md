# Publishing & Releasing

How this plugin is versioned, released, and distributed across three channels:
**GitHub Releases** (sideload), the **Elgato Marketplace**, and **OpenDeck**.

The single build artifact is `de.schwetschke.sd.eiscp-avr-remote.streamDeckPlugin`,
produced by `streamdeck pack` (`npm run pack`). The Stream Deck CLI **never applies
DRM** — DRM is added only server-side when Elgato processes a Marketplace upload. So
the GitHub artifact is DRM-free and works for sideloading and for OpenDeck; only the
Marketplace download is wrapped (functionally identical for official-app users).

---

## 1. Cutting a release (automated, PR-gated)

Releases are driven by [release-please](https://github.com/googleapis/release-please)
from the [Conventional Commits](../CONTRIBUTING.md) on `main`. You never edit version
numbers or the changelog by hand.

**Flow**

1. Merge feature/fix PRs to `main` as usual (`feat:`, `fix:`, `perf:`, …).
2. The **Release** workflow (`.github/workflows/release.yml`) opens/updates a
   **`chore(main): release X.Y.Z`** PR. It computes the next SemVer from the commits
   and stages the changes to `CHANGELOG.md`, `package.json`, and `package-lock.json`.
   (The manifest's 4-part `Version` is **derived** from `package.json` at build time —
   see [Config files](#config-files) below — not bumped in the PR.)
3. Review that PR. Merge it when you want to ship.
4. On merge, release-please creates the **`vX.Y.Z` git tag** and a **GitHub Release**
   with generated notes; the workflow's `publish` job then builds, validates, packs,
   and **attaches `*.streamDeckPlugin`** to that release.

**Version bumps** (pre-1.0, `0.y.z`): `fix:`/`perf:` → patch (`0.1.0`→`0.1.1`),
`feat:` → minor (`0.1.0`→`0.2.0`), `feat!:`/`BREAKING CHANGE:` → minor while < 1.0.

### One-time repo setup

- **Settings → Actions → General → Workflow permissions**: enable
  *“Allow GitHub Actions to create and approve pull requests.”* Without it,
  release-please cannot open its release PR. (Read/write token is already granted via
  the workflow `permissions:` block.)
- The current version is seeded in `.release-please-manifest.json` (`0.1.0`). With no
  prior release tag, the **first** release PR summarizes the whole commit history into
  `CHANGELOG.md` — trim it in the PR before merging if you want a tidier first entry.

### Config files

- `release-please-config.json` — `release-type: node` (bumps `package.json` +
  `package-lock.json`); `changelog-sections` maps the project's commit types.
- `.release-please-manifest.json` — current released version per package.
- The Stream Deck CLI requires a **4-part** manifest version
  (`{major}.{minor}.{patch}.{build}`), which 3-part SemVer can't satisfy. So
  `scripts/sync-manifest-version.ts` mirrors `package.json` into the manifest as
  `X.Y.Z.0` as the first step of the `build` script (also `npm run sync:version`).
  release-please therefore does **not** touch the manifest; the committed manifest may lag one
  release until the next build re-syncs it (the packed artifact is always correct,
  because the publish job builds before packing).

### Preview a release without shipping

```bash
npx release-please release-pr --dry-run \
  --repo-url=geggo98/stream-deck-eiscp-avr-remote-plugin \
  --config-file=release-please-config.json \
  --manifest-file=.release-please-manifest.json \
  --token="$(gh auth token)"
```

release-please reads the config and manifest **from the remote target branch**, so
run this once the config files are on `main` (or push your branch and add
`--target-branch=<branch>`). Until then it reports
`Missing required manifest versions` — that means it found the config and looked for
`.release-please-manifest.json` on the remote, where it doesn't exist yet.

---

## 2. Elgato Marketplace submission checklist

The upload itself happens in the **Maker Console** (https://makerconsole.elgato.com)
and is **manual** — there is no public submission API. Everything below the Console
step is what this repo prepares.

### Technical readiness (in-repo) — status

- [x] `manifest.json` `Version` is 4-part `{major}.{minor}.{patch}.{build}` (the CLI
      rejects 3-part), derived from `package.json` SemVer at build time.
- [x] `UUID` is reverse-DNS (`de.schwetschke.sd.eiscp-avr-remote`).
- [x] `SDKVersion` = 3, `Software.MinimumVersion` = 7.1 (required by the Node 24
      runtime), `OS` mac 12 / win 10.
- [x] `URL` set to the project page.
- [ ] Repo is **public** so the manifest `URL` resolves — `validate` warns
      *“URL should return success (received 404)”* while the repo is private, and
      Marketplace requires a reachable URL. Validation otherwise passes.
- [x] `npm run validate` passes (also gated in CI).
- [x] Name avoids third-party trademarks; `NOTICE` carries the Pioneer/Onkyo/Integra
      disclaimer (Marketplace brand-usage guideline).
- [ ] Plugin icon meets Elgato's size/format spec (verify `imgs/plugin/marketplace`
      pixel dimensions; re-render via `npm run generate:icons` if needed).

### Listing assets (uploaded in Maker Console, kept under `docs/marketplace/`)

- [ ] **Plugin icon** — high-resolution square.
- [ ] **≥ 2 gallery screenshots** — Property Inspector + keys/dials in use.
- [ ] **Marketing/banner image** (optional but recommended).
- [ ] **Short + long description** (base: manifest `Description`).
- [ ] **Listing category** chosen in the Console (e.g. *Audio*). Note: this is
      separate from the manifest `Category` field, which only groups the plugin's own
      actions in the action list.
- [ ] **Support URL** (the GitHub repo / issues).

> Capturing screenshots: install the packed plugin locally, then drive the live
> Property Inspector via Chrome DevTools Protocol on `127.0.0.1:23654` (see
> `CLAUDE.md`); screenshot the deck canvas from the Stream Deck app window directly.

### In Maker Console

1. Create/sign in to an Elgato **Maker** account.
2. New product → upload the `.streamDeckPlugin`.
3. Fill in metadata + gallery assets (above).
4. Submit for review (automated checks + manual QA by Elgato).
5. Publish after approval.

---

## 3. OpenDeck

[OpenDeck](https://github.com/nekename/OpenDeck) (Linux / Windows / macOS) supports
plugins made for the original Stream Deck SDK. Users install the same DRM-free
`.streamDeckPlugin` from GitHub Releases via OpenDeck's **Plugins** tab; a community
registry exists at `marketplace.rivul.us`.

**What this repo already guarantees**

- DRM-free artifact (CLI-packed, never Marketplace-wrapped).
- Case-exact manifest paths — every `Icon`, `CategoryIcon`, state `Image`,
  `PropertyInspectorPath`, and `CodePath` matches on-disk casing, so it loads on
  case-sensitive Linux filesystems (audited; see `.sdignore` and the case audit).
- Lean bundle via `.sdignore` (no source maps, caches, logs).

**Verified on Linux ✅** (OpenDeck 2.12.1 arm64, Ubuntu 25.10 in OrbStack, headless
via xvfb; 2026-06-04):

- [x] **Plugin registers** — `Registered plugin de.schwetschke.sd.eiscp-avr-remote.sdPlugin`;
      no manifest/case errors. Its **"eISCP AV Receiver"** category and actions show up in
      OpenDeck's action list.
- [x] **Node plugin runs** — OpenDeck spawns `node bin/plugin.js -port … -registerEvent
      registerPlugin -info {…}` (the standard Stream Deck SDK handshake), the WebSocket
      server listens, and the plugin connects cleanly (its SDK log shows
      `INFO Discovery: passive name discovery registered`, no errors).

**The one real caveat — OpenDeck does not bundle a Node runtime.** Unlike the Elgato app
(which ships the Node version from `Nodejs.Version`), OpenDeck runs the plugin with the
**system `node`** on `PATH`. So OpenDeck users must have Node installed (Node 24 to match
`Nodejs.Version: 24`); without it the plugin can't launch. Worth stating in the OpenDeck
install notes.

Minor: OpenDeck reports `platform: "windows"` to the plugin (it maps to our manifest `OS`,
which lists mac/windows). Harmless here — the plugin is platform-agnostic JS. Do **not** add
`linux` to the manifest `OS` to "fix" this: OpenDeck runs the plugin fine without it, and a
`linux` platform would not pass Elgato's Marketplace validation.

---

## 4. Sideloading (no Marketplace)

See the [README → Installation](../README.md#installation) section. Short form:
download the `.streamDeckPlugin` from GitHub Releases and double-click it, or unzip
the `…​.sdPlugin` folder into the platform plugins directory and restart the app.
