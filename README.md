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

- Stream Deck app 6.9 or newer (Windows 10+ / macOS 12+).
- A receiver reachable on the local network with eISCP enabled.

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
