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
