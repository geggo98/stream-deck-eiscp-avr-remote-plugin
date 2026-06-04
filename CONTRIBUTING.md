# Contributing

Thanks for your interest in improving **eISCP AV Receiver Remote Control**.

## How this project is maintained

This is a hobby project, worked on in spare time. Contributions, bug reports,
and ideas are all very welcome — but there's no guarantee of when, or whether,
they can be reviewed. If something is urgent for you, please **fork** the project
(see [Forking and renaming IDs](#forking-and-renaming-ids)) rather than wait.

## Development environment

The toolchain is defined with [devenv](https://devenv.sh) (Nix), pinning Node.js
24 plus `osv-scanner` and `pinact`. With
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
- **pre-commit** — `gitleaks` scans staged changes for secrets, and a guard
  refuses to commit the unencrypted ISCP spec.
- **pre-push** — `osv-scanner` scans `package-lock.json` for known
  vulnerabilities (needs network).

The vendor ISCP spec under `docs/` is committed only as a PGP-encrypted file
(`docs/ISCP_AVR_134.xlsx.gpg`); see [docs/ISCP_AVR_134.md](docs/ISCP_AVR_134.md)
to obtain or decrypt it. It is not required to build or run the plugin.

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

### AI assistance

Commits created with the help of an AI agent end with a one-line marker as the
**last line** of the message:

```
AI-assisted 🤖
```

Do **not** name the tool, model, or agent, and do **not** add `Co-Authored-By`
trailers for AI tools. The marker records only that an AI agent assisted; the
author remains the human who made and reviewed the change. Commits with no AI
involvement — and automated dependency bumps — omit the marker.

## Releases

Releases are automated from these commits with
[release-please](https://github.com/googleapis/release-please): merging to `main`
maintains a release PR that bumps the version and `CHANGELOG.md` from the commit
types above, and merging that PR tags the release and publishes the
`.streamDeckPlugin`. This is why the commit `type` matters — `feat` drives a minor
bump, `fix`/`perf` a patch. See [docs/PUBLISHING.md](docs/PUBLISHING.md) for the
full release, Marketplace, and OpenDeck flow.

## Before opening a pull request

Run the checks CI will run:

```bash
npm run build && npm test && npm run validate && npm run scan:vulns
```

GitHub Actions also verifies that every action is pinned to a commit SHA
(`pinact run --check`). If you add or bump an action, pin it with `pinact run`.

## Forking and renaming IDs

A Stream Deck plugin is identified by a globally unique reverse-DNS **plugin ID**
(`de.schwetschke.sd.eiscp-avr-remote`), and every action's UUID derives from it.
Publishing a fork without changing these makes it collide with this plugin in
users' Stream Deck installs. **Before releasing a fork, rename every identifier
to your own namespace.**

The plugin ID lives in one place — `PLUGIN_ID` in
`src/actions/dedicated/catalog.ts` — and the dedicated actions derive their UUIDs
from it. To re-brand a fork:

1. Set your own `PLUGIN_ID` in `src/actions/dedicated/catalog.ts`
   (e.g. `com.yourname.sd.your-plugin`).
2. Run `npm run generate` to rewrite the manifest's action list and the icons.
3. Rename the `de.schwetschke.sd.eiscp-avr-remote.sdPlugin/` folder to match the
   new ID — Stream Deck requires the folder name to equal the plugin ID.
4. Update the references to that folder name in `rollup.config.mjs`,
   `scripts/generate-icons.ts`, `scripts/generate-command-registry.ts`, and the
   `watch`/`validate`/`pack` scripts in `package.json`.
5. Update the generic action UUIDs, which are hand-written rather than generated:
   `src/actions/eiscp-button.ts`, `eiscp-toggle.ts`, `eiscp-dial.ts`, and
   `eiscp-dial-indicator.ts`.
6. Replace the author and repository metadata pointing at the original:
   `manifest.json` (`Author`), `package.json` (`author` and the
   repository/homepage/bugs URLs), and the contact details in `SECURITY.md` and
   `docs/`.

It's your fork to maintain — no permission needed, and no obligation to upstream
anything (though PRs are welcome if you'd like to).
