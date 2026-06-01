# ISCP_AVR_134 — Integra/Onkyo eISCP protocol spec

`ISCP_AVR_134.xlsx` is the vendor spreadsheet documenting the ISCP (Integra
Serial Control Protocol, "AVR 1.34") commands used by this plugin — the same
protocol the `docs/eiscp-reference.md` and `docs/eiscp-commands.yaml` are built
from. It is **not** required to build or run the plugin.

## How to obtain the spreadsheet

The plaintext `docs/ISCP_AVR_134.xlsx` is intentionally **not** committed (it is
gitignored) because its licensing status is a vendor document. You can get an
equivalent copy from these public sources:

- **Onkyo protocol documents** (the spreadsheet itself, with the lists of
  supported commands): <http://michael.elsdoerfer.name/onkyo/ISCP_AVR_134.xlsx>
- **`miracle2k/onkyo-eiscp`** — a community Python library whose
  `eiscp-commands.yaml` is derived from the same protocol tables:
  <https://github.com/miracle2k/onkyo-eiscp>

## Encrypted copy in this repo

A PGP-encrypted copy is committed as **`docs/ISCP_AVR_134.xlsx.gpg`**, encrypted
to these recipients:

- `FCX19GT9XR@schwetschke.de` (key `4019D2B96C630FDD`)
- `stefan@schwetschke.de` (key `F586F998607C3F0B`)

If you hold one of those private keys, decrypt it with:

```bash
gpg --output docs/ISCP_AVR_134.xlsx --decrypt docs/ISCP_AVR_134.xlsx.gpg
```

The decrypted `docs/ISCP_AVR_134.xlsx` is gitignored and a gitleaks rule guards
against committing it by accident — always commit the `.gpg`, never the `.xlsx`.
