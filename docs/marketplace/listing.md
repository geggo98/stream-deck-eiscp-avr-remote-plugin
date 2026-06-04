# Marketplace listing — copy & assets

Draft of everything that goes into the Elgato **Maker Console** product page. The
manifest stays the technical source of truth; this file is the human-facing listing.
Assets live alongside this file under `docs/marketplace/` (they are **not** shipped
inside the plugin bundle).

## Text

**Name:** eISCP AV Receiver Remote Control

**Tagline (one line):** Control Pioneer, Onkyo & Integra network receivers from your
Stream Deck — over the network, no IR blaster.

**Short description (≈ 1–2 sentences):**
> Remote-control AV receivers that speak the Integra Serial Control Protocol over
> Ethernet (eISCP). Power, volume, mute, input, listening modes, tone and tuner
> presets on keys and dials, with live state shown on the buttons.

**Long description:**
> Turn your Stream Deck into a remote for network AV receivers that support **eISCP**
> (the Integra Serial Control Protocol over Ethernet) — covering many **Pioneer,
> Onkyo and Integra** models.
>
> **Keys and dials, pre-wired:**
> - Power, Mute, Volume Up/Down, and a Volume **dial** (press to mute)
> - Next/Previous Input, Next/Previous Listening Mode
> - Tuner preset controls, Bass and Treble
> - Generic **Button**, **Toggle**, **Dial Value** and **Dial Indicator** actions to
>   send any eISCP command you like
>
> **Live feedback:** most actions subscribe to the receiver and reflect its current
> state (on/off, level, selected input) right on the key.
>
> **Setup is simple:** the plugin discovers receivers on your network; pick yours from
> a dropdown (or enter the IP). Works on Stream Deck and Stream Deck + (dials).
>
> _Independent, community project. Not affiliated with, sponsored by, or endorsed by
> Pioneer, Onkyo or Integra; those names describe compatible hardware only._

**Category (Maker Console):** Audio _(confirm in the Console; this is separate from the
manifest `Category` field, which only groups the plugin's own actions)._

**Keywords / tags:** AV receiver, eISCP, ISCP, Onkyo, Pioneer, Integra, home theater,
volume, amplifier, audio

**Support URL:** https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin
**Author:** Stefan Schwetschke · **License:** MIT
**Supported OS:** macOS 12+, Windows 10+ · **Requires:** Stream Deck app 7.1+

## Assets

| Asset | Spec | Status |
|---|---|---|
| Plugin/listing icon | 512×512 PNG (square) | ✅ `plugin-icon-512.png` (reused from manifest icon) |
| Gallery screenshot — Property Inspector (dial) | PNG, the action config UI | ✅ `screenshot-pi-dial.png` (378×185 @2x, captured live via CDP) |
| Gallery screenshot — Property Inspector (keypad) | PNG of eISCP Button config | ✅ `screenshot-pi-button.png` (378×185 @2x, captured live via CDP) |
| Gallery screenshot — keys/dials in use | PNG of the deck layout | ⬜ capture (manual OS screenshot; see below) |
| Marketing banner (optional) | wide image (e.g. 1920×1080) | ⬜ design |

> Confirm exact required sizes/counts against the current Maker Console upload form —
> Elgato adjusts these over time.

### How to capture the screenshots

The plugin is already installed (dev-linked) and the Stream Deck app is running.

1. **Property Inspector:** in the Stream Deck app, drag an eISCP action (e.g. *Volume*
   or *eISCP Button*) onto a key and select it. That opens the "eISCP Settings"
   Property Inspector webview, exposed over Chrome DevTools Protocol at
   `127.0.0.1:23654` (see `CLAUDE.md`). Screenshot it via the `web-browser` skill
   (`connect 23654`) — no OS screen-recording permission needed.
2. **Deck layout:** arrange a representative profile (Power, Volume dial, Mute, Input,
   Listening Mode…) and screenshot the Stream Deck app window (macOS `⇧⌘4` then space,
   or `screencapture -w`). The native app canvas is not a CDP target, so this one is a
   manual OS screenshot.

Save captures here as `screenshot-pi.png` and `screenshot-deck.png`.
