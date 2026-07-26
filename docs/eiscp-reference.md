# eISCP Protocol Reference Manual

## Overview

**eISCP (Ethernet Integra Serial Control Protocol)** is the network-based version of Onkyo/Integra/Pioneer's serial protocol (ISCP), used to control AV receivers over TCP/IP.

### Connection Details

| Property | Value |
|----------|-------|
| **Protocol** | TCP |
| **Default Port** | `60128` |
| **Direction** | Bidirectional (Commands + Unsolicited status updates) |
| **Unit Type** | `1` (Receiver) |

---

## Packet Structure

An eISCP packet consists of a 16-byte header followed by the ISCP message:

```
+--------+--------+------------+------------+----------------+------+
| Header |  Size  | Data Size  |  Version   |  ISCP Message  | EOF  |
| 4 bytes| 4 bytes|  4 bytes   |  4 bytes   |  variable      |1 byte|
+--------+--------+------------+------------+----------------+------+
|  ISCP  |00 00 00| message len |01 00 00 00 | !1CCCPP...     | 0D  |
|        |   10   | (big-endian)|            |                |      |
+--------+--------+------------+------------+----------------+------+
```

### Header Breakdown

| Offset | Length | Description |
|--------|--------|-------------|
| 0-3 | 4 bytes | ASCII characters `ISCP` |
| 4-7 | 4 bytes | Header size (always `0x00000010` = 16) |
| 8-11 | 4 bytes | ISCP message length (big-endian) |
| 12-15 | 4 bytes | Version/reserved (typically `0x01000000`) |

### ISCP Message Format

```
! 1 CCC PP...
| | |   |
| | |   +-- Parameter (variable length)
| | +------ 3-character Command (e.g., PWR, MVL)
| +-------- Unit Type: 1 = Receiver
+---------- Start Character
```

### Terminators

- `0x0D` (CR) - Most common
- `0x0A` (LF) - Some commands
- `0x1A` (EOF) - Alternative

---

## Commands Reference

### Power Control (`PWR`)

| Command | Value | Description |
|---------|-------|-------------|
| `!1PWRQSTN` | - | Query power state |
| `!1PWR01` | ON | Power on |
| `!1PWR00` | OFF | Power off/standby |

**Response format:** `!1PWR00` or `!1PWR01`

**In standby (`PWR00`) the unit stays on the network** and answers queries
normally, but SET commands are dropped **silently** — no echo and no state
change, so only a follow-up query reveals it. Measured exception on the
VSX-S520D: `SLI` (input selection) powers the unit on and is then applied. See
`tests/fixtures/standby-behaviour-capture.json`.

---

### Master Volume (`MVL`)

Volume is represented in hexadecimal (0x00-0xFF or higher, model-dependent).

| Command | Value | Description |
|---------|-------|-------------|
| `!1MVLQSTN` | - | Query volume level |
| `!1MVLXX` | XX hex | Set volume (hex) |

**Volume mapping examples:**
- `!1MVL00` = 0dB (minimum/muted)
- `!1MVL28` = 40dB (0x28 = 40 decimal)
- `!1MVL32` = 50dB (0x32 = 50 decimal)

**Maximum volume varies by model:**
- Some models: 0-80 (0x00-0x50)
- Some models: 0-100 (0x00-0x64)
- Some models: 0-120 (0x00-0x78) with 0.5dB steps

**Response format:** `!1MVLXX` where XX is current volume in hex

---

### Mute Control (`AMT`)

Audio Mute command.

| Command | Value | Description |
|---------|-------|-------------|
| `!1AMTQSTN` | - | Query mute state |
| `!1AMT01` | ON | Mute audio |
| `!1AMT00` | OFF | Unmute audio |
| `!1AMTTG` | TG | Toggle mute |

**Response format:** `!1AMT00` or `!1AMT01`

---

### Input Source Selection (`SLI`)

Select input source by decimal value converted to hex.

| Decimal | Hex | Source Name | Decimal | Hex | Source Name |
|---------|-----|-------------|---------|-----|-------------|
| 0 | 00 | DVR/VCR | 35 | 23 | CD |
| 1 | 01 | SATELLITE/CABLE | 36 | 24 | FM |
| 2 | 02 | GAME | 37 | 25 | AM |
| 3 | 03 | AUX | 38 | 26 | TUNER |
| 5 | 05 | PC | 39 | 27 | MUSIC SERVER |
| 16 | 10 | BLURAY/DVD | 40 | 28 | INTERNET RADIO |
| 32 | 20 | TAPE 1 | 41 | 29 | USB (Front) |
| 33 | 21 | TAPE 2 | 43 | 2B | NETWORK |
| 34 | 22 | PHONO | 45 | 2D | AIRPLAY |

**Common commands:**
- `!1SLIQSTN` - Query current input
- `!1SLI10` - Select BLURAY/DVD (0x10 = 16)
- `!1SLI2B` - Select NETWORK (0x2B = 43)
- `!1SLI2D` - Select AIRPLAY (0x2D = 45)

**Response format:** `!1SLIXX` where XX is the input source in hex

---

### Listening Mode (`LMD`)

Also known as Sound Mode.

| Decimal | Hex | Mode Name | Decimal | Hex | Mode Name |
|---------|-----|-----------|---------|-----|-----------|
| 0 | 00 | Stereo | 12 | 0C | All Channel Stereo |
| 1 | 01 | Direct | 5 | 05 | Auto / Surround |
| 2 | 02 | Pure Direct | 66 | 42 | THX Cinema |
| 8 | 08 | Theater | 64 | 40 | Whole House Mode |
| 11 | 0B | Music | 80 | 50 | DTS Neural:X |

**Common commands:**
- `!1LMDQSTN` - Query current listening mode
- `!1LMD00` - Set to Stereo
- `!1LMD01` - Set to Direct

**Response format:** `!1LMDXX` where XX is the listening mode in hex

---

## Response Handling

### Unsolicited Notifications

The receiver sends status updates automatically when settings change (e.g., volume knob turned, input switched on receiver front panel). Always handle incoming data asynchronously.

### Query Responses

Query commands (ending in `QSTN`) return the current state:
```
Sent:    !1PWRQSTN
Received: !1PWR01
```

---

## Album Art Information

Some receivers support album art metadata via network commands. Commands vary by model and may include:
- `N/A` - Not all models support this feature
- Check your receiver's documentation for specific album art commands

---

## Best Practices

1. **Always connect with keepalive** - Send periodic queries or use TCP keepalive
2. **Handle unsolicited messages** - The receiver sends updates without requests
3. **Volume capping** - Implement software limits to protect equipment/speakers
4. **Hex conversion** - Most numeric values are hexadecimal in ISCP
5. **Terminators** - Always append proper terminator (CR is most common)

---

## Integration in This Project

See the `src/adapter/eiscp/` module for a TypeScript implementation:

- **protocol.ts** - eISCP protocol encoding/decoding (packet structure, commands)
- **transport.ts** - TCP network layer (connection, send/receive)
- **client.ts** - High-level client API (state management, control methods)
- **enums.ts** - Enum definitions for inputs, listening modes, etc.

Run the CLI script:
```bash
node scripts/eiscp-cli.mjs
```

---

## References

- [OpenHAB Onkyo Binding](https://www.openhab.org/addons/bindings/onkyo/)
- [Onkyo ISCP/eISCP Documentation](https://www.integra.com/remote_protocol_docs/)
- Various open-source eISCP implementations (python-onkyo-eiscp, onkyo-eiscp-node)
