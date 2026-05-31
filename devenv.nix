{ pkgs, lib, config, inputs, ... }:

{
  # https://devenv.sh/basics/
  env.GREET = "devenv";

  # https://devenv.sh/packages/
  packages = [
    pkgs.git
    pkgs.tsx
    pkgs.git-crypt # decrypt docs/*.enc.* (git-crypt-tracked vendor docs)
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
