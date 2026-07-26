# Bundler analysis, July 2026 — what happens when TypeScript 7 arrives

**Outcome: nothing changes for now.** The bundle step stays on Rollup with
`@rollup/plugin-typescript`, `typescript` stays pinned to 6.x, and Dependabot is told
to skip its majors (`.github/dependabot.yml`, which carries the removal conditions).
This document records *why* that is a considered position rather than inertia, and
what the escape routes actually cost — measured by building each one, not by reading
release notes.

Everything below was established on 2026-07-26 against this repo.

---

## 1. The trigger

`typescript@7.0.2` cannot build this project:

```
$ npm i -D typescript@7 && npm run build
[!] TypeError: Cannot read properties of undefined (reading 'ES2015')
    at node_modules/@rollup/plugin-typescript/dist/es/index.js:528:16
```

Meanwhile `npm run typecheck` passes cleanly and all tests pass, because Node 24
strips the types itself and never touches the bundler. **That split is the trap:** a
green type check says nothing about a compiler bump. Verify with `npm run build`.

### Why it is not a plugin bug waiting for a patch

`typescript@7`'s `exports["."]` maps to `lib/version.cjs`, whose entire content
exports `version` and `versionMajorMinor`. The compiler API is not exported from the
package root at all — it lives behind `./unstable/*` subpaths. `@rollup/plugin-typescript`
destructures `ModuleKind`, `ModuleResolutionKind` and `DiagnosticCategory` from a bare
`import … from "typescript"` at module scope, in four files. All three destructures
yield `undefined`.

That also kills the documented escape hatch: passing your own compiler via
`typescript({ typescript: … })` cannot help, because the bare import is evaluated
regardless (reported upstream as rollup/plugins#2012, closed without comment four
hours later).

### No timeline exists

- rollup/plugins#2016 ("Support for TypeScript 7", opened 2026-07-10) had **no
  maintainer response**, no PR and no branch. Its only comment reports the identical
  error.
- `@rollup/plugin-typescript` 12.3.0 (published 2025-10-23) is the newest release; the
  package has never shipped a prerelease, and `packages/typescript` has had no
  functional change since.
- TypeScript's own 7.0 announcement states that 7 ships **without** an API and only
  *expects* one in 7.1. Calendar dates circulating in third-party posts have no primary
  source.

Consequence worth stating plainly: pinning to 6.x pins to a **closed line** — 6.0.3 is
the last 6.x, with servicing limited to security and high-severity fixes.

---

## 2. What actually matters when replacing the transpiler

Not speed, and not bundle size: **decorator emit**. The 25 dedicated actions are
registered by a class decorator, `@action({ UUID: … })`, and `tsconfig.json` sets no
`experimentalDecorators`, so this repo uses **TC39 standard decorators** with
`useDefineForClassFields: true` (implied by `target: es2024`).

- Standard emit calls the decorator with **two** arguments — `(value, context)` — where
  the context carries `kind`/`name`/`metadata`/`addInitializer`.
- Legacy emit passes the target **alone**, with no context.

`@elgato/streamdeck`'s `action` currently ignores its second parameter, so legacy emit
would *appear* to work — and then diverge the moment the SDK uses the context, or the
moment class-field semantics matter. Nothing in the test suite looked at the bundle, so
this class of regression was invisible. That is what `tests/bundle-artifact.test.ts`
now closes (see §5).

---

## 3. The routes, measured

Each was built in an isolated worktree and run. Decorator and class-field semantics
were verified with a runtime probe compiled through both the candidate and `tsc`, not
by reading the emit.

| | Rollup + `rollup-plugin-esbuild` | `esbuild` alone | `bun build` | Vite 8 |
|---|---|---|---|---|
| builds under typescript 7 | ✅ byte-identical to the 6.x build | ✅ | ✅ byte-identical (sha256) | ✅ only via an esbuild plugin |
| decorators | **standard** | **standard** | **standard** | **legacy or unparseable** |
| class fields | define | define | define | define |
| bundle vs 184,801 B | 181,564 (−1.8 %) | 167,416 (−9.4 %) | 375,614 (**+103 %**) | 187,076 (+1.2 %) |
| build time (from 1.7–2.25 s) | 0.86 s | ~30× faster | 0.02 s (~100×) | — |
| `npm run watch` | unchanged | 193-line script | 65-line script | **breaks** |
| diff | **10 lines / 2 files** | +224/−73 + new script | −49/+65 + `devenv.nix` | 83 config lines vs 49 |
| Nix CI | ✅ | ✅ (linux binary untested) | ✅ `pkgs.bun` cached, verified | ✅ |

### Vite is out, and it is worth knowing why

Vite 8 transpiles with **oxc**, which has no TC39 standard-decorator transform — its
whole option surface is `{legacy, emitDecoratorMetadata}`. The default build emits raw
`@action({…}) class …` into the output: `node --check` rejects it, while `vite build`
exits **0 with no warning**. Its one in-family fix, `oxc.decorator.legacy: true`,
produces one-argument calls with `ctx === undefined` — the silent 25-class regression.
Making Vite work means bypassing its own transpiler with an esbuild plugin, at which
point it contributes a wrapper: more config, a bigger bundle, and `addWatchFile` on
`manifest.json` becomes a measured no-op under `vite build --watch`.

The same disqualification applies to every **swc** variant: `@rollup/plugin-swc`
hard-codes `legacyDecorator: true`, and `unplugin-swc` needs
`decoratorVersion: "2022-03"` set by hand.

### Leaving Rollup costs tree-shaking

Rollup drops `zod`'s locale barrel (`export * as locales`, **114 KB**, 31 % of the bun
bundle) and `to-json-schema`; esbuild-style dead-code elimination cannot drop a
namespace re-export. That is the whole of bun's +103 %. It is reducible to +41 % only by
stubbing a dependency's internals from a build plugin. Plain `esbuild` needs the same
kind of intervention — a `sideEffects: false` override keyed to `@elgato/utils`'
internal file paths — or the bundle is 404 KB, 2.19× the baseline. Such an override is
a claim about someone else's file layout, and it rots silently.

`esbuild` alone additionally needs a `createRequire` banner, without which the bundle
dies on its first import with `Error: Dynamic require of "events" is not supported` —
i.e. the "plugin is dead and its log is empty" failure CLAUDE.md warns about.

### Two footguns found along the way

- **`bun build --outfile=X --sourcemap=linked` ignores the directory of `X`** and writes
  `plugin.js`/`plugin.js.map` next to the *entry point* — into `src/`. Silently.
  `--sourcemap=external` errors instead. Use `--outdir`.
- **Dropping `target: "es2024"` from any esbuild-based config** falls back to esbuild's
  es2020 default: 81 `__publicField` call sites, i.e. class fields lowered to
  assignment. The one line is load-bearing.

---

## 4. The recommendation, if it ever becomes urgent

1. **Rollup + `rollup-plugin-esbuild`** — 10 changed lines across two files, bundle
   *smaller*, `npm run watch` untouched (the watch sourcemap resolves to the same file,
   line and column), and two devDependencies dropped (`@rollup/plugin-typescript` and
   `tslib`, which was only there as its peer). Smallest possible escape.
2. **`bun build`** if build speed ever matters more than bundle size — genuinely ~100×
   faster and one line in `devenv.nix` (`pkgs.bun` is cached in nixpkgs for all four
   systems, verified inside `devenv shell`), at the price of a second native toolchain
   and a bundle twice the size.
3. **`esbuild` alone** only with the two compensations above written down and tested.
4. **Never Vite/oxc/swc** without proving standard-decorator emit first.

Any of them must be verified against the real Stream Deck app and the receiver before
merging: the bundle applies `@action` through a different helper afterwards, and no test
covers the running plugin.

---

## 5. What was fixed regardless of the route

`tests/bundle-artifact.test.ts` — the suite had **no test that looked at the built
bundle at all**. It now checks that the artifact parses, that it carries the standard
decorator context (`addInitializer`, `kind:"class"` — property literals that survive
minification and that legacy emit cannot produce), and that running it gets far enough
to register all 25 actions.

That last check needs care, and the test documents it: `registerAction` throws for a
UUID missing from the manifest, but the plugin's own `uncaughtException` net swallows it
and **still exits 0**. The exit code is therefore useless as a signal; the log line
`passive name discovery registered`, which `plugin.ts` reaches only *after* every
registration, is the real one. A fourth test runs the same probe with the manifest
withheld and asserts that the failure is visible — so the check cannot quietly become a
test that always passes.

Verified by mutation: replacing `addInitializer`/`kind:"class"` in the bundle fails the
decorator test and nothing else.

### Left for later

A fake Stream Deck host (WebSocket handshake, `willAppear` + `keyDown`/`dialRotate` for
every manifest UUID) was written during this analysis and worked: 24 of 25 contexts
responded, the two silent ones being the generic dials, which need a `command` in their
settings. It would exercise the action instances rather than just their registration.
Not adopted here to keep the artifact test small.
