# AirPlay Device Discovery via dns-sd

This document explains how to use macOS's built-in `dns-sd` command to discover AirPlay devices on your local network.

## Overview

`dns-sd` is the command-line interface to the mDNS (Multicast DNS) and DNS-SD (DNS-Based Service Discovery) APIs on macOS. AirPlay devices advertise themselves using mDNS, making them discoverable without any prior configuration.

## The Three-Step Discovery Process

### Step 1: Browse for AirPlay Devices

Browse for devices advertising the `_airplay._tcp` service:

```bash
dns-sd -B _airplay._tcp
```

**Output format:**
```
Timestamp     A/R    Flags  Domain  Service Type  Instance Name
<timestamp>   Add     0      local.  _airplay._tcp Living Room TV
<timestamp>   Add     0      local.  _airplay._tcp Bedroom Speaker
```

**Key fields:**
- **A/R** (Add/Remove): `Add` means a new device appeared, `Rmv` means it disappeared
- **Instance Name**: Human-readable device name (e.g., "Living Room TV")

**To stop browsing:** Press `Ctrl+C`. The command runs continuously.

---

### Step 2: Resolve Device Metadata and Hostname

Once you have an instance name from Step 1, resolve it to get metadata and hostname:

```bash
dns-sd -L "Living Room TV" _airplay._tcp local.
```

**Output format:**
```
Living Room TV._airplay._tcp.local. can be reached at Apple-TV.local.:7000
(deviceid=AA:BB:CC:DD:EE:FF, features=0x12345678, model=AppleTV6,2, pk=...)
```

**Key information returned:**
- **Hostname**: The `.local` hostname (e.g., `Apple-TV.local`)
- **Port**: The AirPlay service port (typically `7000`)
- **TXT Records** (metadata):
  - `deviceid`: MAC address of the device
  - `model`: Device model identifier
  - `features`: Hex bitfield of supported features
  - `pk`: Public key for encrypted connections
  - `vv`: AirPlay protocol version

---

### Step 3: Get IP Addresses

Use the hostname from Step 2 to get IPv4 and IPv6 addresses:

```bash
dns-sd -G v4v6 Apple-TV.local
```

**Output format:**
```
DNS-SD (v4v6) Apple-TV.local.
> IPv4 address: 192.168.1.100
> IPv6 address: fe80::1234:5678:90ab:cdef
```

---

## Alternative: RAOP (Audio-Only Devices)

Some devices (like older AirPort Express or standalone speakers) may only expose the `_raop._tcp` service (Remote Audio Output Protocol):

```bash
# Browse for RAOP devices
dns-sd -B _raop._tcp

# Resolve RAOP device
dns-sd -L "001122334455@Speaker Name" _raop._tcp local.

# Get IP (same as above)
dns-sd -G v4v6 hostname.local
```

---

## Zone File Format (All-at-Once)

For debugging, you can get all information in zone file format:

```bash
dns-sd -Z _airplay._tcp
```

This outputs everything in DNS zone file format but is less structured for programmatic parsing.

---

## Timeout Considerations

The `dns-sd` command runs indefinitely by default. For programmatic use:
- Use `-t` flag to set timeout in seconds (not all commands support it)
- Or spawn a child process and kill it after a timeout
- Or use `-B` with a timeout: `dns-sd -B _airplay._tcp local. 3` (browse for 3 seconds)

---

## Common Issues

| Issue | Solution |
|-------|----------|
| No devices found | Check that devices are on the same network and Wi-Fi is enabled |
| Hostname resolution fails | Wait a moment after discovery; mDNS propagation can take a few seconds |
| "Can't connect" errors | Ensure firewall allows mDNS (UDP port 5353) |

---

## Integration in This Project

See the `src/adapter/dnssd/` module for a TypeScript implementation of this discovery process:

- **caller.ts**: Executes dns-sd commands with timeout
- **parser.ts**: Parses dns-sd output into structured data
- **controller.ts**: Coordinates the discovery workflow

Run the discovery script:
```bash
node scripts/discover-airplay.mjs
```
