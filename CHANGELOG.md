# Changelog

## [0.2.0](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/compare/v0.1.0...v0.2.0) (2026-06-04)


### ⚠ BREAKING CHANGES

* **plugin:** the plugin's user-facing name changes.

### Features

* **actions:** add command registry, connection manager, and universal actions ([88d6b26](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/88d6b26ce877fa792dd776a901bd8072b438a759))
* **actions:** add status feedback, logging, pre-built components, icons, and dynamic PI ([91365e0](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/91365e0b58299e6c6dee0981bba868ecc0429892))
* **actions:** learn receiver option names and add Stream Deck+ dials ([cfc1042](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/cfc1042e3589dbf3f8966f1fd6355c259f8de4a5))
* add eISCP and AirPlay device adapters with discovery ([85e71a4](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/85e71a4c5e6cb635d263a6e524637ca6a87c91ff))
* **discovery:** add unified device discovery (TCP scan, incremental updates) ([de575ea](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/de575eafab4a71768f4c0d1fe3db74ab1a426393))
* **manifest:** target the Node 24 runtime (Stream Deck 7.1+) ([d534e8e](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/d534e8e204438973f2f3dc1a85e1a59eed0ac514))


### Bug Fixes

* **pi:** populate Device IP dropdown via datasource; resize marketplace icon ([1205725](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/12057253adfa488d6a433a52c0e9e7c5f1496c93))


### Refactoring

* **plugin:** rename to "eISCP AV Receiver Remote Control" ([3027d65](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/3027d6581625c1eb96d9bee75c6c6b3c952adaba))


### Documentation

* **contributing:** document commit conventions and scopes ([742aad6](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/742aad62e7c2a19a14efc27d4a0364438b930c9d))
* **contributing:** document the AI-assistance commit convention ([e7081b1](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/e7081b102dfa3dfb8c37e6c18e564aee7f99cbc6))
* **eiscp:** add the eISCP command reference ([28b1ba7](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/28b1ba791583c8cdfb14b2c8fdfde07cc47058d9))
* **project:** document publishing, installation, and Marketplace listing ([a84f159](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/a84f1597bca3a28d0b7656d7d1dda86c82fd0096))
* **project:** note hobby-project status and fork/rename guidance ([edbe4e0](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/edbe4e014fefac5d7217cf42469fa0dd20a0aca0))
* **project:** record verified OpenDeck Linux compatibility ([a2fad99](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/a2fad99b83da78c05e1820b5c3179c79cc4e5718))


### Build System

* **deps:** bump dependencies via Dependabot ([87e7c32](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/87e7c32b3260bb15e94e524c39d8f8c8ef01cf9d))
* **deps:** bump grouped npm dependencies via Dependabot ([056b970](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/056b9703885efec5f8e1e802c4faba6977e1f6d8))
* derive the 4-part manifest version from package.json ([f428f7a](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/f428f7ad944c80b933deeea247f98cd45ea5ef13))
* exclude dev artefacts from the packed bundle via .sdignore ([5f8e077](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/5f8e0773cf3c527a9cbce00c6eb6fa5a4708a810))
* load @types/node so node globals typecheck ([6efd7db](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/6efd7db863d5c404cc11916c8fd10e323e94924e))
* **release:** add package metadata, license, README, and packaging scripts ([670bda7](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/670bda702072df5af0039fe26a12b1d086e6c671))


### Continuous Integration

* add SHA-pinned devenv workflows and OSV scanning ([8296dce](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/8296dcee041b444e1ce384f183f8f954a8e64d5d))
* align release workflows with Node 24 and fix the schema check ([bf31095](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/bf31095c74c0f2086ed92b4d603034b51b4ed228))
* automate releases with release-please ([f5758dc](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/f5758dc745bd964697043a66a47a14ed0e04b097))
* gate the build on a standalone typecheck ([8e1623e](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/8e1623eaefe4320565d3fcb4dcbfbb43dbb87cf0))
* harden Dependabot updates (cooldown, lockfile normalization) ([a30815d](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/a30815d863813e8fef17bfc937c2bf605041d4a7))
* keep release-please in the 0.x range ([8ebe9c7](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/8ebe9c77c26867abe56dbe2923ae1846a8296cd3))
