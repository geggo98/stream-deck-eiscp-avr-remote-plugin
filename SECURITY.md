# Security

## Reporting a vulnerability

Please report security issues privately to **stefan@schwetschke.de** rather than
opening a public issue. You will get an acknowledgement as soon as possible.

## Threat model

The plugin is a network client for unauthenticated LAN traffic: eISCP frames over
TCP from an AV receiver, and UDP discovery responses from anything that answers.

| Actor | Access |
|---|---|
| Any host on the LAN | UDP to the discovery socket; mDNS advertisements |
| A compromised receiver, or a MITM on the plugin↔receiver path | Full control of the TCP byte stream |
| Whoever controls the Property Inspector's script source | Arbitrary script in the PI webview |
| Any local process on the machine | The plugin's Node inspector port, when debug mode is on |

No actor reaches credentials — eISCP is unauthenticated by design and the plugin
holds no secrets. What is worth protecting is the availability of the plugin
process (it dies, every button on the deck stops working), the integrity of the
persisted settings, control over where the plugin opens connections, and the
contents of the log files (LAN topology and usage patterns in plaintext, in files
that get attached to bug reports).

The consequences for code: bound everything that comes off the wire, treat
device-supplied text as untrusted right through to rendering, never let a peer
decide how much memory or CPU to spend, and fail loudly rather than quietly.

## Review history

- **2026-07-25 — first application-level review.**
  [`docs/security-review-2026-07.md`](docs/security-review-2026-07.md): threat
  model, scope (what ships and what does not), 16 findings with their fixes, and
  the two defects that fuzzing found after the manual pass had cleared the same
  code.

## Fuzzing

Parser and socket-level fuzzing for the network-facing code, with no added
dependency: a seeded PRNG plus structure-aware generators
(`tests/helpers/fuzz.ts`).

```bash
npm test                                          # short fixed-seed pass, part of CI
npm run test:fuzz                                 # the fuzz files on their own
FUZZ_ITERATIONS=200000 npm run test:fuzz          # a long local run
FUZZ_SEED=1234 npm run test:fuzz                  # replay a reported failure
```

`npm test` uses a fixed seed and a small budget, so pull requests cannot go flaky.
`.github/workflows/fuzz.yml` runs nightly (and on demand) with a fresh random seed
and a large budget, and uploads the seed plus corpus when it fails. Every failure
prints the command that reproduces it.

When a fuzzer finds something, add the input to
`tests/fixtures/fuzz-corpus.json` with a note on what it broke.
`tests/fuzz-corpus.test.ts` replays the corpus deterministically as part of the
normal suite, so the finding no longer depends on the fuzzer generating it again.

## Dependency scanning

Dependencies are scanned with [osv-scanner](https://google.github.io/osv-scanner/)
(pinned in `devenv.nix`, so the same scan runs locally and in CI):

```bash
npm run scan        # vulnerabilities + license report
npm run scan:vulns  # vulnerabilities only (used as the CI gate)
```

The scan covers `package-lock.json` (the npm tree). It does **not** cover
`streamdeck_manifest.deno.lock`: osv-scanner has no Deno-lockfile extractor. That
file only locks dev-time manifest-generation tooling (`ajv`, `@std/*`) and is not
shipped in the packed plugin.

## Vendored Property Inspector dependency

The Property Inspectors used to load `sdpi-components.js` from
`https://sdpi-components.dev` at PI-open time, with no Subresource Integrity and
no Content Security Policy. A PI webview has full access to
`SDPIComponents.streamDeckClient`, so anyone able to alter that response — the
domain, a hijacked DNS answer, or any TLS-terminating position — could execute
arbitrary script in the PI, write any action setting (including the device IP and
custom command parameters), and read back all global settings. The bundle is
therefore vendored:

| | |
|---|---|
| File | `de.schwetschke.sd.eiscp-avr-remote.sdPlugin/ui/vendor/sdpi-components.js` |
| Source | `https://sdpi-components.dev/releases/v4/sdpi-components.js` |
| Version | v4.0.1 |
| Size | 55823 bytes |
| SHA-256 | `f6c0dfd2ed68e18084b9952842b86e3850cf837d674704700c2a0718e0a24f6b` |

Verify the vendored copy with:

```bash
shasum -a 256 de.schwetschke.sd.eiscp-avr-remote.sdPlugin/ui/vendor/sdpi-components.js
```

**Updating it** (we no longer receive upstream fixes automatically — that is the
deliberate trade-off):

1. Download the new release and diff it against the vendored copy.
2. Confirm it stays self-contained: no `fetch`/`XMLHttpRequest`/`Worker`, no
   `eval`/`new Function`, and no external hosts. The 4.0.1 bundle satisfies all
   of these.
3. Replace the file, update the version/size/SHA-256 above.
4. Open one PI of every kind and confirm the **Device IP dropdown and the
   dynamic parameter selects still populate** — that is the regression that the
   `sdpi-select` upgrade-order behaviour documented in CLAUDE.md causes.

Each PI also carries a Content Security Policy:

```
default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src ws://127.0.0.1:* ws://localhost:*
```

`script-src 'self'` is what blocks a remote bundle from being loaded at all.
Verified against a `file://` origin (PIs are loaded as `file://` documents):
local scripts run, inline scripts are refused. Because inline script is refused,
each PI's init block lives in `ui/init/<pi-name>.js` rather than inline — keep it
that way. `style-src` needs `'unsafe-inline'` because Lit falls back to injecting
a `<style>` element when constructable stylesheets are unavailable, and
`connect-src` must permit the loopback WebSocket the PI uses to talk to Stream
Deck.

## License posture

All bundled and dev dependencies use permissive licenses
(MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, 0BSD). No
copyleft (GPL/LGPL/AGPL) licenses are present. The plugin itself is MIT (see
`LICENSE`).

## Advisory history

### 2026-05-31 — initial hardening (19 advisories cleared)

A baseline `osv-scanner` run reported 19 advisories (12 high, 7 medium), all in
build/dev tooling except `ws` (a transitive runtime dependency of
`@elgato/streamdeck`). All were resolved by updating — no version pins were
required:

- 17 were fixed within existing version ranges via `npm audit fix`
  (`ajv`, `brace-expansion`, `fast-uri`, `lodash`, `minimatch`, `picomatch`,
  `rollup`, `tar`, `ws`, `yaml`).
- The remaining 2 (`serialize-javascript`,
  [GHSA-5c6j-r48x-rmvq](https://github.com/advisories/GHSA-5c6j-r48x-rmvq),
  [GHSA-qj8w-gfj5-8c6v](https://github.com/advisories/GHSA-qj8w-gfj5-8c6v)) came
  in transitively through `@rollup/plugin-terser@0.4.4`, which pinned a
  vulnerable `serialize-javascript`. Fixed by upgrading the dev dependency
  `@rollup/plugin-terser` `^0.4.4 → ^1.0.0`.

Post-remediation: `npm run scan:vulns` reports no issues.

## Pinned dependency overrides

### `brace-expansion` → `^5.0.8`

Pulled in transitively by `minimatch` (dev-only), which requires `^2.0.1`.

- [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) (7.7)
  — fixed in 2.1.2, reachable in range.
- [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) (7.5)
  — fixed only in 5.0.8, i.e. past `minimatch`'s range, so an override is the only
  way to clear it without waiting for `minimatch` to move.

`brace-expansion` is a small, stable glob-brace utility and the consumer is
dev-only tooling. Verified after the override: `npm run typecheck`, `npm test`,
`npm run build`, `npm run validate` and `npm run pack` all pass, and
`npm run scan:vulns` reports no issues. Drop the override once `minimatch` widens
its range.

Add further entries the same way: the advisory ID, why the parent's range does not
cover it, and what was verified.
