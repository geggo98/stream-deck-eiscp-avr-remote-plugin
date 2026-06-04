# eISCP AV Receiver Remote Control

A [Stream Deck](https://www.elgato.com/stream-deck) plugin that remote-controls
AV receivers over **eISCP** — the Integra Serial Control Protocol carried over
Ethernet (TCP/IP). Map keys and Stream Deck&nbsp;+ dials to power, volume, mute,
input selection, listening modes, tone controls, tuner presets, and any raw
eISCP command, with live state shown on the keys.

> **Not affiliated with Pioneer or Onkyo.** "Pioneer", "Onkyo" and "Integra" are
> trademarks of their respective owners. This is an independent, community
> project — not produced, authorised, sponsored, or endorsed by any of these
> companies. Their names appear only to describe which receivers the plugin can
> talk to.

## Project status

This is a **hobby project**, built and maintained in spare time. Every bug
report, idea, and pull request is genuinely welcome — but there's no promise of
*when*, or *whether*, it gets a response. Please don't depend on a timely reply.

Need a fix or feature urgently? The fastest path is to **fork** it and carry it
yourself. A published Stream Deck plugin must use globally unique identifiers, so
a fork **must rename every plugin-specific ID** (the plugin ID, the action
UUIDs, and the `*.sdPlugin` folder) before release — see
[CONTRIBUTING.md](CONTRIBUTING.md#forking-and-renaming-ids).

## Compatibility

Works with network receivers that speak ISCP over Ethernet (eISCP) on the
standard TCP port. That covers **many Pioneer, Onkyo and Integra** network
receivers, though the protocol and the available commands vary by model and
firmware — not every command is supported on every unit.

- **Verified:** Pioneer VSX-S520D.
- **Likely compatible:** Onkyo / Integra / Pioneer network receivers from the
  eISCP era. Community reports of working (and non-working) models are welcome.

If your receiver is discovered on the network and responds to a power or volume
command, the rest of the plugin will most likely work.

## Actions

- **Generic eISCP actions** — *Button* (send any command), *Toggle* (on/off
  commands like power or mute), *Dial Value* and *Dial Indicator* (encoders for
  text or numeric values).
- **Dedicated actions** — Power, Mute, Volume Up/Down, a Volume dial (press to
  mute), Next/Previous Input, Next/Previous Listening Mode, tuner Preset
  controls, and Bass/Treble — pre-wired so they work without configuration.

Most actions subscribe to the receiver and reflect its current state on the key.

## Requirements

- Stream Deck app 7.1 or newer (Windows 10+ / macOS 12+). The plugin runs on the
  Node.js 24 runtime, which the Stream Deck app ships from version 7.1 onward.
- A receiver reachable on the local network with eISCP enabled.

## Installation

The plugin is distributed as a `.streamDeckPlugin` file. There is no DRM on it —
the GitHub release artifact is built with the Stream Deck CLI, which never applies
DRM (that only happens to Marketplace copies, server-side at Elgato). Pick whichever
matches your setup:

1. **Elgato Stream Deck app (recommended).** Download the latest
   `de.schwetschke.sd.eiscp-avr-remote.streamDeckPlugin` from the
   [GitHub Releases](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/releases)
   page and double-click it — the Stream Deck app installs it. (Once it is on the
   Elgato Marketplace you can also install it from there with **Get**.)

2. **Manual / folder install.** A `.streamDeckPlugin` is a ZIP archive. Rename it to
   `.zip`, extract the `de.schwetschke.sd.eiscp-avr-remote.sdPlugin` folder, and drop
   it into the plugins directory, then restart the Stream Deck app:
   - macOS: `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`
   - Windows: `%APPDATA%\Elgato\StreamDeck\Plugins\`

3. **[OpenDeck](https://github.com/nekename/OpenDeck) (Linux / Windows / macOS).**
   OpenDeck is an open-source host for Stream Deck hardware that supports the
   original Stream Deck plugin format. Install the same DRM-free
   `.streamDeckPlugin` from GitHub Releases through OpenDeck's **Plugins** tab.
   OpenDeck runs the plugin with your **system Node.js** (it does not bundle one,
   unlike the Elgato app), so install **Node.js 24** first. Verified working on
   OpenDeck 2.12.1 (Linux); see
   [docs/PUBLISHING.md](docs/PUBLISHING.md#3-opendeck) for details.

## Development

The dev environment is defined with [devenv](https://devenv.sh) (Nix), pinning
Node.js 24 and the tooling (`osv-scanner`, `pinact`). With
[direnv](https://direnv.net) it loads automatically on `cd`; otherwise run
`devenv shell`.

```bash
npm install        # install dependencies
npm run watch      # build + hot-reload the plugin into Stream Deck
npm run build      # production build (minified) → <plugin>.sdPlugin/bin/plugin.js
npm test           # run the unit test suite
npm run scan       # osv-scanner: dependency vulnerabilities + licenses
```

Actions, icons and the manifest's action list are generated from a single
catalog (`src/actions/dedicated/catalog.ts`) via `npm run generate`. See
[CLAUDE.md](CLAUDE.md) for the full architecture and contribution notes, and
[CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions.

The vendor protocol spreadsheet under `docs/` is committed only in PGP-encrypted
form (`docs/ISCP_AVR_134.xlsx.gpg`) — see [docs/ISCP_AVR_134.md](docs/ISCP_AVR_134.md)
for how to obtain or decrypt it. It is not required to build or run the plugin.

## License

[MIT](LICENSE). See [NOTICE](NOTICE) for trademark and third-party attributions.
