# Contributing

Thanks for your interest in improving **eISCP AV Receiver Remote Control**.

## Development environment

The toolchain is defined with [devenv](https://devenv.sh) (Nix), pinning Node.js
24 plus `git-crypt`, `osv-scanner` and `pinact`. With
[direnv](https://direnv.net) it loads on `cd`; otherwise run `devenv shell`.

```bash
npm install        # dependencies
npm run build      # production build
npm run watch      # build + hot-reload into Stream Deck during development
npm test           # unit tests
npm run validate   # validate the plugin manifest/bundle
npm run scan       # dependency vulnerabilities + licenses
```

Actions, icons and the manifest's action list are generated from a single
catalog — after editing `src/actions/dedicated/catalog.ts`, run `npm run
generate`. See [CLAUDE.md](CLAUDE.md) for the architecture in depth.

### Git hooks

Entering the devenv shell installs git hooks (via `git-hooks.nix`):

- **commit-msg** — `commitizen` checks the Conventional Commit format.
- **pre-commit** — `gitleaks` scans staged changes for secrets.
- **pre-push** — `osv-scanner` scans `package-lock.json` for known
  vulnerabilities (needs network).

Some `docs/*.enc.*` files are encrypted with `git-crypt` and need the repository
key to read; they are not required to build or run the plugin.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>)<!>: <summary>

[body]

[footer(s)]
```

- **summary**: imperative mood, lower-case start, no trailing period.
- `!` and/or a `BREAKING CHANGE:` footer marks a breaking change.
- The format is checked on commit by a `commitizen` git hook (installed via
  devenv's git-hooks). Run it manually with `cz check --rev-range <range>`.

### Types

| Type       | Use for |
|------------|---------|
| `feat`     | a new user-facing capability |
| `fix`      | a bug fix |
| `refactor` | code change that neither fixes a bug nor adds a feature |
| `perf`     | a performance improvement |
| `docs`     | documentation only |
| `test`     | adding or correcting tests |
| `build`    | build system, dependencies, packaging (rollup, npm, generators) |
| `ci`       | CI configuration and workflows |
| `chore`    | tooling/maintenance with no src or test change (e.g. devenv, security) |
| `style`    | formatting only, no behaviour change |
| `revert`   | reverts a previous commit |

### Scopes

Scopes follow the repository structure. Use one of:

| Scope       | Area |
|-------------|------|
| `eiscp`     | eISCP protocol adapter — `src/adapter/eiscp/` |
| `discovery` | device-discovery controller — `src/adapter/discovery/` |
| `dnssd`     | DNS-SD / AirPlay discovery — `src/adapter/dnssd/` |
| `actions`   | action classes — `src/actions/` (incl. `dedicated/`) |
| `dial`      | Stream Deck&nbsp;+ encoder/dial actions |
| `pi`        | Property Inspector — `*.sdPlugin/ui/` |
| `manifest`  | plugin manifest |
| `logging`   | logging infrastructure |
| `docs`      | documentation |
| `deps`      | dependency bumps |
| `build`     | build system, generators, packaging scripts |
| `ci`        | GitHub Actions / workflows |
| `devenv`    | the Nix dev environment |
| `project`   | repo-wide meta (gitignore, licensing, structure) |

Pick the most specific scope; the scope may be omitted for repo-wide changes.
Two naming rules, to keep history greppable: use **`actions`** (not `action`)
and **`dial`** (not `dials`). Add a new scope here in the same PR that
introduces the area it names.

### Examples

```
feat(eiscp): add tuner-preset cycling command
fix(pi): populate the Device IP dropdown via datasource
refactor(actions): extract shared encoder base class
docs(project): document the release process
chore(security): bump @rollup/plugin-terser to clear GHSA-5c6j-r48x-rmvq
```

## Before opening a pull request

Run the checks CI will run:

```bash
npm run build && npm test && npm run validate && npm run scan:vulns
```

GitHub Actions also verifies that every action is pinned to a commit SHA
(`pinact run --check`). If you add or bump an action, pin it with `pinact run`.
