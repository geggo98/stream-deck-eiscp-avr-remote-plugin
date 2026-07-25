# Security

## Reporting a vulnerability

Please report security issues privately to **stefan@schwetschke.de** rather than
opening a public issue. You will get an acknowledgement as soon as possible.

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

None currently. If a transitive dependency ever needs to be force-upgraded ahead
of its parent, add a `package.json` `overrides` entry and record the advisory ID
and rationale here.
