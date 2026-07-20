# Changelog

## [0.3.0](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/compare/v0.2.0...v0.3.0) (2026-07-20)


### ⚠ BREAKING CHANGES

* **actions:** actions without a configured device IP no longer target 10.2.0.32; users must pick a receiver in the Property Inspector once.

### Features

* **actions:** treat a missing device IP as unconfigured ([bdb0b50](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/bdb0b50f7dca26c47738f7beb36f404fa0854bb8))
* **eiscp:** evict long-disconnected clients from the pool ([e1ed7fc](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/e1ed7fc036f220db06f8470e16c5a27436f74ee3))


### Bug Fixes

* **actions:** clear stuck degraded titles; make the connect timeout real ([3e0b685](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/3e0b685f8e429abcda057850b829030993ead2c9))
* **actions:** close the remaining adversarial-review findings ([0c319f3](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/0c319f3cec576ec358860e26981e025fe5213884))
* **actions:** guard re-binds against stale continuations and typing floods ([a6cf9d3](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/a6cf9d3248bbb40ce554b5e339d55069672b36e4))
* **actions:** name-store persist retry, sweep restore, PI watchdog ([ad39b3e](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/ad39b3e6abd98c7fe72d0d9eff41d0a232686990))
* **actions:** stop dropping SDK promise rejections ([bca4e7f](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/bca4e7f38ef490c3ef9436acfe8f5cb580cc7c02))
* **actions:** surface a failed restore after a successful sweep ([e865b18](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/e865b189defb98f75bf6dbe0735e12c55086b5fe))
* **adapter:** stop importing the SDK for logging in the adapter layer ([c5af66c](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/c5af66c3c0ab8c928648025250cc337c4377172a))
* **discovery:** stop silencing dnssd and per-IP connect errors ([205e89b](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/205e89bacf2e0d98aab8dd5cad9c55101e6245eb))
* **discovery:** surface broadcast-discovery socket errors ([b77a2b1](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/b77a2b1f28d0a080676870346143b31a1b0e6611))
* **eiscp:** close two eviction races found by the adversarial review ([e2a869b](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/e2a869b428efb624e1f1f801cf55d7afe81ee68c))
* **eiscp:** guard error re-emit and subscriber dispatch ([5b5e82f](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/5b5e82f815f5841de63fdf730fc0054c10c6141e))
* **eiscp:** harden the transport socket lifecycle ([19fb540](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/19fb540548ff4471d7aca5bb0df6874dd7d09f2e))
* **eiscp:** honest delivery feedback for sent commands ([54b7ddb](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/54b7ddbebc10196aeb87efedfa90dbebb72fd2a7))
* **eiscp:** query timeout context, fail fast on close, log garbage ([dd1d749](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/dd1d749a93d5d87f3c6b5081fac85b37b81a2146))
* **eiscp:** share one in-flight connect across concurrent callers ([0482712](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/04827129d30af8948a153bae9d691f7de4cd8c7d))
* **pi:** make the Auto-Discover text readable and trim the scrollbar ([868316c](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/868316c0b6ed31d12d2b3fd4d17640386ddf3bc0))


### Refactoring

* **actions:** close the any-hole in the settings index signature ([ad75e1c](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/ad75e1c36953cccfe8dd9fb241332603c8eb11d0))
* **actions:** discriminate DedicatedSpec and derive literal ids ([304d27f](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/304d27fbf3bf197e1301c86a88eec9560fdee837))
* **actions:** pull stepper ranges from the command registry ([bf05117](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/bf05117ea3c65e8a1160946e6b2acc0ac1ce7321))
* **discovery:** extract DeviceTracker, replace the test theater ([423d7da](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/423d7da9f42484bb5f8d521f4c3b88b5fe5d8659))
* **discovery:** snapshot immutability, DeviceId, rename collisions ([085d21e](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/085d21e591aab44c7792d62cc815d8d6b2adc94b))
* **eiscp:** bind typed event maps to the emitters ([1253478](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/12534782be2688a7842ef6020033e09b2a271688))
* **eiscp:** connection-manager and client API hygiene ([addcc16](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/addcc165ea4b49a1f04de9599c3245605b9e0a95))
* **eiscp:** discriminate CommandDef and inbound frames ([2e74738](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/2e747385510f796a6015ab742fef9da6fef530a6))
* **eiscp:** make the command registry the single label source ([1ec7405](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/1ec74059d7c128ced6629a04ab5e2c55f8b98e92))


### Documentation

* add the 2026-06 review implementation plan ([45787e4](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/45787e4fd275599ecf60834fcb3e3db039f4d78f))
* correct factually wrong comments, remove narration noise ([396609f](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/396609f60e62ad8c48c74a82e870d91a0fa326d3))
* **marketing:** refresh plugin icon and add deck rendering 🤖 ([4ed6d18](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/4ed6d189147f7ac398102299bfdacbb68e1f4d52))
* update CLAUDE.md to match the current code and verified behaviour ([70bdc40](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/70bdc400170aa10252de436323eb0dc972ae81f5))


### Build System

* bump tar to 7.5.20 to clear the osv-scanner pre-push gate ([b7935f7](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/b7935f77277016df070a3de858ccfab3e56274c0))
* bump the npm-dependencies group across 1 directory with 3 updates ([f000228](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/f000228c1b7a385f44796b9bc90f87c7a854c80a))
* **deps:** normalize package-lock.json peer metadata [skip ci] ([60c25ff](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/60c25ffaec96188b6f35681929a8a24166feaaf9))
* enable noUncheckedIndexedAccess ([3c34439](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/3c34439c7e830a48905d2796e7bb4c6b46be2289))
* typecheck tests and scripts, fix the errors this reveals ([aa0a128](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/aa0a1286d729a119263509c847a70d29251be620))


### Continuous Integration

* bump actions/checkout in the github-actions group across 1 directory ([7744c1a](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/7744c1ac1b83e150ef8492aedda2110487fa36e1))
* don't fail the build on flaky deps.dev license scan 🤖 ([f750475](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/f750475c9e1b10c891a3ae1c160b22f20075b4de))
* run the test suite on macOS too ([824ac43](https://github.com/geggo98/stream-deck-eiscp-avr-remote-plugin/commit/824ac4394f3b421ccb2fac0cbce1a3d424062509))

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
