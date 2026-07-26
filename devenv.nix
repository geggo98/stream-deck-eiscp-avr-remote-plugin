{ pkgs, lib, config, inputs, ... }:

{
  # https://devenv.sh/basics/
  env.GREET = "devenv";

  # https://devenv.sh/packages/
  packages = [
    pkgs.git
    pkgs.tsx
    pkgs.osv-scanner # dependency vulnerability + license scanning (npm run scan)
    pkgs.pinact # pin GitHub Actions to full commit SHAs
  ];

  # https://devenv.sh/languages/
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    corepack.enable = true;
    npm = {
      enable = true;
      install.enable = true;
    };
    lsp = {
      enable = true;
      package = pkgs.nodePackages.typescript-language-server;
    };
  };

  languages.typescript.enable = true;

  # https://devenv.sh/processes/
  # processes.dev.exec = "${lib.getExe pkgs.watchexec} -n -- ls -la";

  # https://devenv.sh/services/
  # services.postgres.enable = true;

  # https://devenv.sh/scripts/
  scripts.hello.exec = ''
    echo hello from $GREET
  '';

  # https://devenv.sh/basics/
  enterShell = ''
    hello         # Run scripts directly
    git --version # Use packages
    echo "Node.js $(node --version) development environment loaded."
  '';

  # https://devenv.sh/tasks/
  # tasks = {
  #   "myproj:setup".exec = "mytool build";
  #   "devenv:enterShell".after = [ "myproj:setup" ];
  # };

  # https://devenv.sh/tests/
  enterTest = ''
    echo "Running tests"
    git --version | grep --color=auto "${pkgs.git.version}"
  '';

  # https://devenv.sh/git-hooks/
  git-hooks.hooks = {
    # Enforce Conventional Commits on the commit message (see CONTRIBUTING.md).
    commitizen.enable = true;
    # Refuse to commit the unencrypted ISCP spec (defence in depth on top of
    # .gitignore; catches `git add -f`). gitleaks can't scan binary content, so
    # this is a path check, not a gitleaks rule. Commit the .gpg instead.
    forbid-plaintext-spec = {
      enable = true;
      name = "forbid committing the unencrypted ISCP spec";
      entry = "${pkgs.writeShellScript "forbid-plaintext-spec" ''
        if git diff --cached --name-only --diff-filter=AM | grep -qiE '(^|/)ISCP_AVR_134[^/]*\.xlsx$'; then
          echo "ERROR: refusing to commit the unencrypted ISCP_AVR_134 spreadsheet (it is gitignored)." >&2
          echo "Commit docs/ISCP_AVR_134.xlsx.gpg instead." >&2
          exit 1
        fi
      ''}";
      language = "system";
      pass_filenames = false;
      always_run = true;
    };
    # Refuse to commit a manifest that carries Nodejs.Debug at all. `npm run
    # watch` adds it for the dev loop; committing that would either ship an open
    # inspector port ("enabled") or a plugin Stream Deck refuses to launch
    # ("disabled"). `npm run build` removes the key.
    forbid-debug-manifest = {
      enable = true;
      name = "forbid committing a manifest with Nodejs.Debug";
      entry = "${pkgs.writeShellScript "forbid-debug-manifest" ''
        manifest=de.schwetschke.sd.eiscp-avr-remote.sdPlugin/manifest.json
        if ! git diff --cached --name-only --diff-filter=AM | grep -qxF "$manifest"; then
          exit 0
        fi
        if git show ":$manifest" | ${pkgs.jq}/bin/jq -e 'has("Nodejs") and (.Nodejs | has("Debug"))' >/dev/null; then
          echo "ERROR: refusing to commit $manifest with a Nodejs.Debug key." >&2
          echo "\"enabled\" opens an inspector port in production; \"disabled\" makes" >&2
          echo "Stream Deck refuse to launch the plugin. Run 'npm run build' to remove it." >&2
          exit 1
        fi
      ''}";
      language = "system";
      pass_filenames = false;
      always_run = true;
    };
    # A raw control byte in a .ts source silently turns it into a "binary" file for
    # git: no diff, no review, no blame. It has happened three times in this repo
    # (a NUL in a test fixture string, a NUL used as a separator, a SUB in a
    # terminator literal) and each time the only symptom was "Bin 0 -> N bytes" in
    # the commit stat, which is easy to miss. A unicode escape is always
    # available, so there is never a reason to embed the raw byte.
    forbid-control-bytes = {
      enable = true;
      name = "forbid raw control bytes in sources";
      # Python, not grep: `grep -qP '[\x00-\x08…]'` silently fails to match a NUL
      # (the pattern reaches PCRE as a C string), so the first version of this hook
      # passed the very file it was written to catch. Verified by probe in both
      # directions — a file with a NUL is rejected, a clean one is not.
      entry = "${pkgs.writeShellScript "forbid-control-bytes" ''
        exec ${pkgs.python3}/bin/python3 - "$@" <<'PY'
        import subprocess, sys
        LEGAL = {0x09, 0x0a, 0x0d}  # tab, LF, CR
        EXT = (".ts", ".js", ".json", ".md", ".html", ".css", ".nix", ".yaml", ".yml")
        names = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=AM"],
                               capture_output=True, text=True, check=True).stdout.split()
        status = 0
        for name in (n for n in names if n.endswith(EXT)):
            blob = subprocess.run(["git", "show", f":{name}"], capture_output=True, check=True).stdout
            offenders = sorted({b for b in blob if b < 0x20 and b not in LEGAL} | ({0x7f} if 0x7f in blob else set()))
            if offenders:
                where = blob.find(bytes([offenders[0]]))
                line = blob[:where].count(b"\n") + 1
                print(f"ERROR: {name}:{line} contains raw control byte(s) "
                      f"{', '.join(hex(b) for b in offenders)}; git will treat the file as binary.",
                      file=sys.stderr)
                print("       Write them as unicode escapes instead.", file=sys.stderr)
                status = 1
        sys.exit(status)
        PY
      ''}";
      language = "system";
      pass_filenames = false;
      always_run = true;
    };
    # Block secrets from being committed (pre-commit).
    gitleaks = {
      enable = true;
      name = "gitleaks (secret scan)";
      entry = "${pkgs.gitleaks}/bin/gitleaks git --staged --no-banner --redact";
      language = "system";
      pass_filenames = false;
    };
    # Scan dependencies for known vulnerabilities before pushing (pre-push).
    osv-scanner = {
      enable = true;
      name = "osv-scanner (dependency vulnerabilities)";
      entry = "${pkgs.osv-scanner}/bin/osv-scanner scan source --lockfile=package-lock.json";
      language = "system";
      pass_filenames = false;
      stages = [ "pre-push" ];
    };
  };

  # See full reference at https://devenv.sh/reference/options/
}
