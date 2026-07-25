# Security review — 2026-07-25

First application-level security review of the plugin. Prior security work in
this repo covered the **supply chain** only (osv-scanner, gitleaks, pinact,
Dependabot — see `SECURITY.md`). This review covers the **application**: parser
robustness, resource limits, and the trust boundaries between the receiver, the
Property Inspector and the plugin.

All findings below were verified against the code, and every one is fixed on this
branch. Each fix is a separate commit; the "Fixed in" column names the commit
subject.

---

## Scope

Every claim about reachability rests on what actually ships. `src/plugin.ts` is
the only Rollup entry point, so anything it does not reach transitively is
tree-shaken out of `bin/plugin.js`.

**In the shipped plugin:**

- `src/actions/**`
- `src/adapter/eiscp/{protocol,transport,client,connection-manager,discover,command-registry,enums,receive-buffer}.ts`
- `src/adapter/logging.ts`
- the nine Property Inspectors in `*.sdPlugin/ui/`

**Not shipped** — reachable only through `scripts/`, but still public API of this
repo, and still fed by the network:

- `src/adapter/dnssd/**`
- `src/adapter/discovery/**`
- `src/adapter/eiscp/network-scanner.ts`

---

## Threat model

| # | Actor | Access |
|---|---|---|
| T1 | Any host on the user's LAN | UDP to the discovery socket; mDNS advertisements |
| T2 | A compromised receiver, or a MITM on the plugin↔receiver path | Full control of the TCP byte stream |
| T3 | Whoever controls `sdpi-components.dev`, its DNS, or the TLS path | Arbitrary script in the PI webview |
| T4 | Any local process on the user's machine | The plugin's Node inspector port |

No actor reaches credentials: eISCP is unauthenticated by protocol design and the
plugin holds no secrets. The assets worth protecting are therefore:

1. **Availability of the plugin process.** It dies, every configured button and
   dial on the deck stops working.
2. **Integrity of persisted settings.** Learned names and device IPs are written
   to Stream Deck's global settings and rendered as button titles.
3. **Control over where the plugin connects.** The plugin opens TCP connections
   on the user's LAN; who picks the target matters.
4. **Confidentiality of the log files.** Not secrets, but LAN topology and usage
   patterns, in plaintext, in files that get attached to bug reports.

An explicit non-goal: defending against the user's own misconfiguration. A user
who types a wrong IP gets a non-working button, and that is fine.

---

## Findings

### High

| # | Finding | Actor | Fixed in |
|---|---|---|---|
| H1 | `"Debug": "enabled"` in the committed manifest made Stream Deck launch the plugin with `--inspect=127.0.0.1:<port>` — an open inspector port is code execution inside the plugin process for any local process that reaches it — and the SDK derives its log level from debug mode, so the plugin logged at TRACE: every WebSocket frame, meaning complete settings objects, LAN IPs and the entire learned-name map, in plaintext. **Scope is narrower than it first appears — see the correction below.** | T4 | `never ship the Node inspector or TRACE logging` |

> **Correction on H1's scope.** An initial reading of this finding was that every
> production install was exposed. That is wrong, and the distinction matters.
> `streamdeck pack` **strips `Nodejs.Debug` from the manifest regardless of its
> value** — verified by packing a copy with `Debug` explicitly set to `"enabled"`
> and finding no `Debug` key in the resulting artifact. So:
>
> - **Marketplace / packed installs were never exposed.** No inspector port, and
>   because `logger.setLevel` is clamped to the SDK's `minimumLevel` outside debug
>   mode, the effective level was already INFO rather than TRACE.
> - **Installs that run from the source directory were exposed** — which is the
>   documented development workflow, and how this repo installs itself (the
>   Stream Deck plugin directory is a symlink to the working tree). Confirmed
>   empirically: the running plugin had `--inspect=127.0.0.1:58163` with the Node
>   inspector answering on it, while a stock Elgato plugin alongside it had no
>   such flag.
>
> So H1 is a **developer-machine exposure, not a shipped-plugin one**. It is still
> worth fixing — a dev machine is a valuable target, TRACE logs accumulate real
> data, and relying on a packaging step to strip a dangerous flag is fragile — but
> it should not be read as having affected users. The parts of the logging problem
> that *did* affect every install are tracked separately as M11.

> **The first attempt at this fix broke the plugin.** It set
> `Nodejs.Debug: "disabled"`, which is not a value Stream Deck accepts: it then
> refuses to launch the plugin at all. The process exits with code 1 *before any
> JavaScript runs*, so the plugin's own log stays empty and there is no crash to
> find — the plugin simply never appears. Stream Deck's own log
> (`~/Library/Logs/ElgatoStreamDeck/StreamDeck.log`) shows
> `Process stopped (unexpected): code=0x00000001` in a 10-second restart loop,
> ending in `Plugin is unstable an was disabled`; after that, `npx streamdeck
> restart` no longer helps and the app must be restarted.
>
> The correct release state is the key being **absent**, which is also what
> `streamdeck pack` produces. `sync-manifest-version.ts` now deletes it for
> release builds and adds `"enabled"` only for `npm run watch`;
> `verify-release-manifest.ts` and the pre-commit hook reject the key in *any*
> form. Both directions are verified against the real app.
>
> Two lessons worth keeping: a green `npm test` / `npm run build` /
> `streamdeck validate` says nothing about whether Stream Deck will *launch* the
> plugin, and a security hardening step that changes packaging metadata has to be
> verified by actually running the product.
| H2 | All nine Property Inspectors loaded `sdpi-components.js` from `https://sdpi-components.dev` with no Subresource Integrity and no CSP. A PI webview has full access to `SDPIComponents.streamDeckClient`, so altering that one response yields: write any action setting (device IP, custom command parameters → H4/M7), read back all global settings, and drive the receiver sweep (M8). | T3 | `vendor sdpi-components and add a CSP to every PI` |
| H3 | Unbounded receive path. `dataSize` is an unchecked `uint32`, and the framing loop only asked "is the buffer long enough yet" — which a peer keeps false forever by declaring `0xFFFFFFFF`, or simply by opening an ISCP line with `!` and never terminating it. Meanwhile `receiveBuffer = Buffer.concat([receiveBuffer, chunk])` ran per `data` event (O(n²) in bytes received) and consuming via `subarray` retained the whole parent allocation. | T2 | `bound the eISCP receive path` |
| H4 | The discovery socket is bound but never connected, and neither the source address nor the source port was checked, so any host that could reach the ephemeral port had its datagrams parsed and trusted. The dedupe key (`identifier-host`) is built from attacker-supplied bytes and nothing capped the device list, so one host could flood the PI device dropdown — and in the unified controller each entry also triggers an outbound TCP connect. | T1 | `validate and bound eISCP discovery input` |
| H5 | No process-level `unhandledRejection`/`uncaughtException` handler. The SDK's only net is `process.once("uncaughtException", …)` — `once`, so it absorbs the first escaped error and the **second** kills the plugin. The SDK also invokes action handlers without awaiting or catching them, and several handlers bare-awaited SDK calls. | T1, T2 | `keep the plugin alive when a promise escapes` |

### Medium

| # | Finding | Fixed in |
|---|---|---|
| M6 | Receiver display text (`FLD`) was persisted into global settings and rendered as button titles with no sanitisation and no bound, growing along three axes: one entry per distinct code reported, unbounded name length, one key per host. The whole blob is re-serialised and pushed to Stream Deck every 1.5 s. | `bound and sanitise device-supplied data` |
| M7 | `encodePacket` interpolated `command` and `parameter` into `!<unit><command><parameter><terminator>` with no validation, and several of those values come from free-text PI fields. A parameter containing CR produces **two** ISCP messages inside one correctly framed packet. Combined with `resolveDeviceIp`, which validated nothing (non-strings from the untyped PI JSON reached `socket.connect`, and any hostname was accepted and resolved), this was "arbitrary bytes to an arbitrary host on port 60128". | `validate outbound commands and the configured device IP` |
| M8 | `{action:"discover"}` started a fresh receiver sweep every time, with no lock. A sweep sends up to 60 steps, each waiting up to 3 s plus a settle delay, so one message can manipulate the receiver for minutes — and the PI's confirm dialog is no protection, since the message can be sent directly. Overlapping sweeps also fight over the shared `sliSweeping` flag: the first `finally` clears it for all of them, and each then "restores" its own captured start value. | `guard against amplifying PI messages into unbounded work` |
| M9 | `{event:"getDevices", isRefresh:true}` bypasses the TTL cache by design, but each message started its own broadcast sweep concurrently (one UDP socket per interface × four probe packets, 2.5 s), with the last to finish winning the cache. | same |
| M10 | `MVL` had no `NaN`/range guard where `SLI` and `LMD` do. `"N/A"` yielded `NaN` and `"FFFFFFFFFF"` ~1.1e12, both reaching `setFeedback({ indicator: { value } })` as a JSON number. | `bound and sanitise device-supplied data` |
| M11 | Parse errors embedded the peer's bytes verbatim (`` `ISCP message too short: ${trimmed}` ``), so a peer controlled both the content and the volume of the log files, control characters included. Separately, `ConnectionManager` logged a LAN IP plus every command and value at **INFO**, which the SDK writes in every configuration. | same |
| M12 | `unit` and the 3-character `command` are entirely unvalidated, and the command name is a `Map` key in `ConnectionManager.stateCache`, so a device emitting varying names added a key per name. | same |

### Low, and dev-tooling only

| # | Finding | Fixed in |
|---|---|---|
| L13 | The framing loop required 16 buffered bytes before parsing anything, so a trailing headerless ISCP line — as short as 8 bytes, e.g. `!1MVL0E\r` — was stranded until unrelated data arrived. A functional bug, not a security one, but in the same code path. | `bound the eISCP receive path` |
| L14 | ECN `iscpPort` accepted `0`, `-5`, `65536` and `99999999`; `modelName` (rendered in the PI dropdown) had no length or charset bound. | `validate and bound eISCP discovery input` |
| L15 | `network-scanner`: the correct RFC 1918 check `isPrivateIp` was dead outside tests while the live gate compared only the first octet, admitting public space including TEST-NET-1. The /24 derivation used the network base rather than the host's own /24 for prefixes shorter than /24. Caller-supplied subnet prefixes were interpolated raw into connect targets. | `harden the dev-only scanner and DNS-SD tooling` |
| L16 | `dns-sd`: unbounded subprocess fan-out (2 per advertised instance, no limiter), argument injection via a leading `-` in instance names or parsed hostnames, no `maxBuffer` on output, and parsed addresses never validated as IPs before becoming connect targets. | same |

### Assessed and deliberately left alone

- **The eISCP `version` field is captured but not enforced.** No device is known
  to vary it, and rejecting on it risks refusing legitimate hardware. Recorded in
  the fuzz corpus (`version-not-01`) so that changing this later is a deliberate
  decision rather than an accident.
- **Query/response correlation is by command name only** (`client.ts`), so an
  unsolicited message with a matching command can settle a pending query. The
  protocol has no request id, so this is not fixable without inventing one; the
  practical impact is bounded because a peer that can inject messages can already
  send whatever it likes. Documented here rather than papered over.
- **`style-src 'unsafe-inline'` in the PI CSP.** Lit falls back to injecting a
  `<style>` element when constructable stylesheets are unavailable. The value of
  the CSP here is `script-src 'self'`, which is what blocks a remote bundle.

---

## What fuzzing found that the manual review missed

Two real defects, both in code the manual pass had read and judged sound. This is
the argument for keeping the fuzzers in CI.

1. **ReDoS in `stripTerminators`** (fixed in `add seeded fuzzing for the protocol
   and discovery parsers`). The manual review recorded this function as "anchored,
   single character class, no backtracking risk". That was wrong:
   `/[\x0D\x0A\x1A\x19]+$/` retries the whole terminator run from every start
   position when the run is followed by any other character. A 64 KiB frame of CR
   plus one trailing byte — inside the frame cap, and pipelineable — cost ~1.4 s
   of CPU, on a function called for **every** inbound message. Replaced with a
   backward scan: 1399 ms → 1.2 ms.

2. **Non-round-tripping encode** (fixed in `replay a fuzz corpus and add a nightly
   fuzz workflow`). `encodePacket` accepted a parameter with a trailing space, but
   `parseIscpMessage` trims, so the value on the wire could not be read back — what
   got sent differed from what was configured. `encodePacket` now emits the
   canonical form, making encode/decode an identity for everything it accepts.

Found by the socket-level fuzzing, and worth noting as a robustness rather than
security improvement: resync skipped to the first `!`, which finds the marker
inside the **body** of a following enveloped frame, silently discarding its
16-byte header. Resync now prefers the eISCP magic when it appears earlier.

---

## Test coverage added

The suite went from 297 to 387 tests. Beyond per-finding regression tests:

| File | Covers |
|---|---|
| `tests/helpers/fuzz.ts` | Seeded mulberry32 PRNG, structure-aware eISCP/ECN generators, mutation, invariant helpers. Zero dependencies. |
| `tests/fuzz-protocol.test.ts` | `decodePacket`, `parseIscpMessage`, `decodeMultiplePackets`, `stripTerminators`, `encodePacket` round-trip, ReDoS budgets |
| `tests/fuzz-discovery.test.ts` | `parseEcnResponse`, `parseDiscoveryResponse`, dedupe-key bounds |
| `tests/fuzz-transport.test.ts` | The real transport against a hostile TCP peer: random streams at random chunk sizes, garbage interleaving, buffer-ceiling pressure, oversized declared sizes across write boundaries, byte-at-a-time delivery, mid-frame RST |
| `tests/fuzz-corpus.test.ts` | Deterministic replay of `tests/fixtures/fuzz-corpus.json` |
| `tests/receive-buffer.test.ts` | The bounded accumulator: ceiling, growth, no aliasing of the backing store |
| `tests/discovery-guards.test.ts` | The sweep concurrency lock |

**Invariants, not outputs.** A parser fed hostile bytes must either produce a
well-formed result or reject with a deliberate `Error`; a `TypeError`/`RangeError`
means an unchecked access reachable from the network. Nothing may hang or allocate
without bound.

**Running them.** `npm test` includes a short fixed-seed pass, so pull requests
cannot go flaky from randomness. `npm run test:fuzz` takes `FUZZ_SEED` and
`FUZZ_ITERATIONS`; `.github/workflows/fuzz.yml` runs nightly with a fresh random
seed and a 20000-iteration budget, uploading the seed and corpus on failure. Every
failure prints its reproduction command.

**When a fuzzer finds something**, add the input to
`tests/fixtures/fuzz-corpus.json` with a note on what it broke. The corpus is
replayed by the normal suite, so the finding stops depending on the fuzzer
generating it again.

---

## Verification performed

- `npm run typecheck`, `npm test` (387 passing), `npm run build`,
  `npm run validate` after every step.
- Three independent 20000-iteration fuzz runs with random seeds, clean.
- **H1 confirmed empirically before and after.** The running plugin had
  `--inspect=127.0.0.1:58163` with the Node inspector answering on it, while a
  stock Elgato plugin alongside it had no such flag. After the fix and a restart,
  the flag and the port are gone. Also confirmed that CDP on port 23654 belongs to
  the Stream Deck **app**, not the plugin, so PI debugging is unaffected — an
  incorrect claim to the contrary was corrected in CLAUDE.md. Packing was then
  tested in both directions, which is what established that `streamdeck pack`
  strips the flag and therefore that H1 never reached packed installs.
- **The packed artifact was inspected**, not just the source tree: no `Debug` key,
  the vendored `ui/vendor/sdpi-components.js` present, and no HTML file referencing
  the CDN (the only remaining occurrence of that hostname is inside the vendored
  bundle's own license header).
- **Dependency scan cleared.** `npm run scan:vulns` reported five advisories in dev
  dependencies at the start of this work, all pre-existing on `main` (identical
  versions). Four were fixable in range via `npm audit fix`; `brace-expansion`
  needed a major bump past its parent's range, so it is now a `package.json`
  `overrides` entry, recorded in SECURITY.md as that file asks. The scan reports no
  issues, and typecheck, tests, build, validate and pack all still pass on the
  updated lockfile.
- **H2 verified against a real `file://` origin** (how Stream Deck loads PIs):
  local scripts run under `script-src 'self'`, inline script is refused. The
  rendered DOM contains the `deviceIp` select that only the externalised init
  script injects, so the CSP, the vendored bundle and the init scripts all work.
- **H4 measured against the real receiver before enforcing.** The VSX-S520D at
  `10.2.0.32` answers ECN from source port 60128, so requiring that port is safe;
  live discovery still finds it. The same capture is why sanitisation strips
  padding rather than rejecting: its ECN datagram is 255 bytes of which ~219 are
  NUL.
- **Live hardware unaffected**: `npm run eiscp -- state`,
  `npm run discover-eiscp-broadcast` and `npm run discover-airplay` (4 LAN
  devices, IPv4 and zone-scoped IPv6) all still work.

## Confirmed in the running app

The `datasource` round-trip was subsequently verified in the real Stream Deck app
after the manifest correction above: the Device IP dropdown populates with
`VSX-S520D (10.2.0.32)`, the dials show live receiver values, and the plugin log
reports `Connected to 10.2.0.32:60128`. Property Inspectors for the other action
types are worth a look after any change to `ui/`, since a PI webview only exists
while its action is selected and cannot be opened from a script.

## Follow-up hardening in the Property Inspector

Fixing the manifest exposed that the PI had no defence against the plugin being
unavailable, which is what made the failure so opaque:

- The Device IP dropdown waited forever on its `loading` text ("Scanning the
  network…") with no explanation. It now has a watchdog, like the Auto-Discover
  button already had.
- The manual-IP field could only be revealed by selecting the dropdown's
  "Custom IP…" entry — which arrives *in the plugin's reply*. The one escape hatch
  from "the plugin is not answering" required the plugin to answer. There is now
  an "Enter IP manually" button that does not depend on it.
- `handleDeviceListMessage` now always sends a reply, even if resolution fails
  unexpectedly, so the plugin can never be the reason the dropdown hangs.
- Auto-Discover is disabled unless an IP would actually resolve (including the
  plugin-wide global setting, not just the action's own selection); a sweep
  without an address can only be rejected.
- PI hint text had `opacity: 0.6` on text that inherits **black** on a dark panel,
  making it unreadable. Hints now use shared `.pi-hint` / `.pi-warn` classes in
  `ui/eiscp-pi.css`, and the one hint that carried no actionable information was
  removed rather than restyled.
