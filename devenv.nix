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
