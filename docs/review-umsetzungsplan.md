# Umsetzungsplan: Repo-Review vom 2026-06-11

Quelle: Voll-Repo-Review mit fünf spezialisierten Agents (Code-Review,
Silent-Failure-Analyse, Testabdeckung, Kommentar-Genauigkeit, Typ-Design).
Stand der Codebasis: `main` (sauber), Testsuite grün (215 Tests, ~36 s).
Alle Datei-/Zeilenangaben und Behauptungen wurden am 2026-06-12 per
Verifikations-Workflow (6 Agents, 151 Einzelclaims) gegen den Code geprüft
und korrigiert.

**Arbeitsweise:** Ein Schritt = ein in sich abgeschlossener Commit (oder PR).
Nach jedem Schritt: `npm test` und `npm run build` müssen grün sein.
Bei Schritten mit Receiver-Bezug optional live gegen die VSX-S520D verifizieren
(`npm run eiscp -- state`; Werte vorher sichern und nachher wiederherstellen).
Erledigte Punkte hier abhaken.

---

## Phase 1 — Stabilität: Crashes und Races (kritisch)

### Schritt 1: Connect-Race im ConnectionManager beheben

- [x] umgesetzt

**Problem:** `ensureConnected` (`src/adapter/eiscp/connection-manager.ts:37-79`)
dedupliziert laufende Verbindungsaufbauten nicht; `EiscpTransport.connect()`
wirft bei parallelem Aufruf „Connection already in progress"
(`src/adapter/eiscp/transport.ts:98-100`). `DialActionBase.bind`
(`src/actions/eiscp-action-base.ts:317-333`) feuert erst die Press-Query
(fire-and-forget) und awaited dann die Haupt-Query — auf kalter Verbindung
schlägt die Haupt-Query damit **deterministisch** fehl: jedes dedizierte Dial
(Volume, Input, Mode, Tone, Preset) zeigt beim ersten Erscheinen keinen Wert.
Gleiches Muster trifft Profilseiten, auf denen mehrere Actions gleichzeitig
`onWillAppear` für denselben Host feuern.

**Umsetzung:**
- [x] In-Flight-Connect-Promise pro Host im `ConnectionManager` memoizen
      (z. B. `private connecting = new Map<string, Promise<void>>()`); alle
      parallelen `ensureConnected`-Aufrufer awaiten dasselbe Promise.
- [x] Alternativ/zusätzlich: `EiscpTransport.connect()` gibt bei Zustand
      `CONNECTING` das laufende Promise zurück, statt zu werfen.
- [x] Test in `tests/connection-manager.test.ts`: zwei parallele
      `ensureConnected`-Aufrufe gegen einen Mock-TCP-Server → beide resolven,
      es entsteht genau eine Verbindung.

**Verifikation:** `npm test`; manuell: Stream-Deck-Seite mit Volume-Dial kalt
öffnen → Wert erscheint sofort (ohne erst zu drehen).

### Schritt 2: Socket-Lifecycle im Transport härten

- [x] umgesetzt

**Problem:** Nach Connect-Timeout/-Fehler (`src/adapter/eiscp/transport.ts:133-152`)
wird der Socket nicht destroyed, aber alle Listener werden entfernt. Trifft
später ein Socket-Error ein (z. B. spätes `EHOSTUNREACH` durch die
macOS-Local-Network-Firewall), gibt es keinen `error`-Listener mehr →
`ERR_UNHANDLED_ERROR` → der Plugin-Prozess stirbt. Gelingt der Connect
verspätet doch noch, leakt eine offene TCP-Verbindung, während der Zustand
`DISCONNECTED` meldet. Zusätzlich ersetzt `connect()` (`transport.ts:111`)
einen evtl. vorhandenen alten Socket, ohne ihn zu destroyen.

**Umsetzung:**
- [x] In beiden Fehlerpfaden (`onError`, `onTimeout`) vor dem `reject`:
      `this.socket.destroy(); this.socket = null;`.
- [x] Am Anfang von `connect()` einen evtl. vorhandenen alten Socket destroyen.
- [x] Dauerhaften (oder geguardeten) `error`-Listener sicherstellen, damit
      späte Socket-Fehler nie ungehört bleiben.
- [x] Test: Mock-Szenario „Connect-Timeout, danach später Socket-Fehler" →
      kein Prozess-Crash, Zustand bleibt konsistent.

### Schritt 3: Fehler-Robustheit im Event-Pfad (Listener-Guards + Dispatch)

- [x] umgesetzt

**Problem (drei Stellen):**
1. `src/adapter/eiscp/client.ts:366` re-emittiert Transport-Errors ungeschützt
   (`this.emit("error", err)`); ein `EiscpClient` ohne `error`-Listener crasht
   den Prozess. `refreshState` (`client.ts:352-355`) hat den
   `listenerCount`-Guard bereits — die Inkonsistenz ist die Falle.
2. `src/adapter/discovery/unified-controller.ts:559-575`: `checkEiscpAtIp`
   entfernt seinen einzigen `error`-Listener **vor** `await client.refreshState()`.
   Ein Transport-Fehler während der State-Queries (plausibel bei
   Port-60128-Geräten, die keine Receiver sind) crasht am `try/catch` vorbei.
3. `src/adapter/eiscp/connection-manager.ts:130-134`: Subscription-Callbacks
   werden ungeschützt aufgerufen — ein werfender Render-Callback stoppt alle
   nachfolgenden Subscriber und propagiert in `client.handlePacket`.
   (Die Message-Observer direkt darunter, Zeilen 137-143, sind korrekt
   geschützt — gleiches Muster übernehmen.)

**Umsetzung:**
- [x] `setupTransportHandlers` im Client: `listenerCount`-Guard wie in
      `refreshState` (dort gibt es nur den Guard — ohne Listener wird der
      Fehler still verworfen). Zusätzlich einen Logger-Fallback neu
      einführen: `client.ts` hat keinen Logger-Import und läuft auch
      außerhalb der Stream-Deck-Runtime (z. B. Scripts), also `console`
      oder injizierter Logger statt `streamDeck.logger`.
- [x] `checkEiscpAtIp`: Error-Listener für die gesamte Client-Lebensdauer
      registrieren; Abräumen im `finally` nach `disconnect()`.
- [x] `unified-controller.ts:444-449`: `.catch` mit Log an die
      `checkPromise.then(...)`-Kette hängen (Schutz gegen künftige Rejections).
- [x] Subscription-Loop: jeden `sub.callback(parameter)` in `try/catch`
      wrappen; im Log Host+Command nennen (mehr trägt `Subscription`,
      `connection-manager.ts:15-19`, nicht — für echten Action-Kontext
      müsste `onCommandUpdate` um eine actionId erweitert werden).
- [x] Test: werfender Subscriber → nachfolgende Subscriber erhalten die
      Nachricht trotzdem (siehe auch Schritt 16).

---

## Phase 2 — Fehler sichtbar machen (Silent Failures)

### Schritt 4: Discovery-Fehler beobachtbar machen

- [x] umgesetzt

**Problem:** Die Broadcast-Discovery (`src/adapter/eiscp/discover.ts:352-402`)
verschluckt nach dem Bind sämtliche Socket-Fehler: der `error`-Handler kann
nach Resolve des Bind-Promise nur noch ins Leere rejecten, und `socket.send()`
(Zeile 400) hat keinen Error-Callback. Eine Firewall-Blockade
(`EPERM`/`EHOSTUNREACH`) sieht exakt aus wie „keine Geräte im LAN" — das
bekannte macOS-Firewall-Diagnoseproblem. Auch der dnssd-Pfad silenced doppelt:
`caller.ts:213-225` wandelt einen Spawn-Fehler in ein „erfolgreiches" leeres
Ergebnis; `discoverAirplayDevicesStreaming` prüft `stderr`/`exitCode` nie;
`unified-controller.ts:631` fängt mit `.catch(() => {})` **alle** Fehler, nicht
nur „kein macOS"; `unified-controller.ts:595-604` verschluckt die echten
Verbindungsfehler (`catch` → `return null`), und der Aufrufer
`checkDeviceViaEiscp` baut daraus die generische Meldung „All N IPs failed
eISCP connection" (`unified-controller.ts:501`, Reporting 504-519).

**Umsetzung:**
- [x] `discover.ts`: nach dem Bind Socket-Fehler an Logger/`onError`-Callback
      routen; `socket.send(...)` einen Error-Callback geben; Fehler in einem
      `DiscoveryResult.errors`-Array sammeln.
- [x] `src/actions/pi-devices.ts:69-77`: wenn der Catch-/Fallback-Pfad feuert,
      Gruppen-Label ehrlich benennen (z. B. „Discovery fehlgeschlagen —
      Local-Network-Berechtigung prüfen") statt „Pre-configured".
- [x] `dnssd/caller.ts`: `child.on("error")` nicht als Erfolg resolven
      (Fehler kennzeichnen); Streaming-Variante in `controller.ts` soll
      `stderr`/`exitCode`/`timedOut` prüfen — die Felder trägt `DnsSdResult`
      bereits (`caller.ts:15-21`). Hinweis: die nicht-streamende Variante
      prüft heute auch nur `stderr && !stdout` (`controller.ts:105-107`),
      also beide Varianten härten.
- [x] `unified-controller.ts:631`: vorher `isDnsSdAvailable()` prüfen;
      unerwartete Fehler loggen statt pauschal schlucken.
- [x] `unified-controller.ts:595-604` und `checkDeviceViaEiscp`
      (`unified-controller.ts:501-519`): pro IP den echten Fehler
      (message + `code`) erfassen und statt der generischen Meldung in
      `EiscpConnectError` durchreichen.

**Verifikation:** `npm run dummy:discovery` + PI-Dropdown; Negativtest mit
blockierter Firewall → Dropdown zeigt den Fehlerhinweis statt nur Default-IP.

### Schritt 5: Send-Ehrlichkeit — kein `showOk` für nie zugestellte Befehle

- [x] umgesetzt

**Problem:** `send()` resolved, sobald `socket.write()` gequeued ist
(`src/adapter/eiscp/client.ts:612-614`, `src/adapter/eiscp/transport.ts:271-277`,
Write-Callback ignoriert). Bei halboffener Verbindung (Receiver-Standby) sieht
der Nutzer einen grünen Haken (`eiscp-action-base.ts:169, 229`) für einen
Befehl, der nie ankam. Zusätzlich flippt `ToggleActionBase.onKeyDown`
(`eiscp-action-base.ts:154-174`) bei leerem Cache blind auf `onValue` und
meldet Erfolg. Dial-Fehler (`onDialRotate`/`onDialDown`,
`eiscp-action-base.ts:356-358, 374-376`) geben gar kein Feedback;
Press-State-Query-Fehler werden nur auf `debug` geloggt
(`eiscp-action-base.ts:326-328`).

**Umsetzung:**
- [x] `transport.send`: Write-Callback auswerten; Fehler mit Host+Befehl
      loggen/emittieren; ConnectionManager markiert den Client als tot und
      reconnectet proaktiv.
- [x] Toggle bei leerem Cache: erst Query versuchen, sonst `showAlert()` statt
      Soft-Flip mit `showOk()`.
- [x] `onWillAppear`-Query-Fehler: sichtbar degradierter Zustand auf dem Key
      (z. B. Titel „?" / ausgegraut), nicht nur Log.
- [x] Dial-Fehler sichtbar machen: `ev.action.showAlert()` funktioniert auch
      auf Dials — im SDK liegt `showAlert` auf der Basisklasse `Action`,
      nur `showOk` ist Keypad-only (der gegenteilige Code-Kommentar in
      `dedicated/discovery.ts:145` ist falsch, siehe Schritt 21).
      Ergänzend optional: transientes `setFeedback({ title: "Error", ... })`
      auf dem Touch-Strip (wird beim nächsten Update überschrieben).
- [x] Press-State-Query-Fehler von `debug` auf `warn` heben, Host+Befehl in
      die Meldung.
- [x] Klären (siehe „Offene Punkte"): Doppel-Send in `client.ts:644-647`
      (Frame + nochmal nackter ISCP-String) — Workaround oder Bug? →
      **Geklärt am echten VSX-S520D (2026-07-19, Fixture
      `tests/fixtures/vsx-s520d-framed-vs-naked-query.jsonl`):** das geframte
      Paket allein wird beantwortet, der nackte ISCP-String allein wird
      ignoriert, beides zusammen ergibt genau eine Antwort. Der zweite Write
      war wirkungslos und wurde entfernt.

### Schritt 6: Floating Promises absichern

- [x] umgesetzt

**Problem:** SDK-Aufrufe (`setTitle`/`setState`/`setImage`/`setFeedback`/
`showOk`/`showAlert`/`sendToPropertyInspector`) geben Promises zurück und
werden per `void` oder gar nicht awaited — unter Node 24
(`--unhandled-rejections=throw`) ist eine Rejection prozess-fatal.
Betroffen u. a.: `eiscp-action-base.ts` (118-123, 157, 169, …),
`dedicated/index.ts` (121, 256, 297, 351, 417, 474), `eiscp-dial.ts:52`,
`eiscp-dial-indicator.ts:68-79`, `pi-devices.ts:61-62`,
`dedicated/discovery.ts:137`.

**Umsetzung:**
- [x] Kleinen Helper `fireAndLog(promise, logger, what)` einführen.
- [x] Alle `void`-/un-awaited SDK-Aufrufe systematisch darauf umstellen
      (grep nach `void ev.action`, `void streamDeck`, nackten `setTitle(` etc.).

### Schritt 7: Kleinere Robustheitsfixes

- [x] umgesetzt

- [x] **name-store Persist-Retry** (`src/actions/dedicated/name-store.ts:183-192`):
      schlägt `persist()` fehl, wird nur `dirty = true` gesetzt, aber kein
      neuer Timer geplant — gelernte Namen gehen beim nächsten Neustart
      verloren. Debounce-Timer mit Backoff neu aufziehen.
- [x] **`runSweep`-Restore darf Originalfehler nicht maskieren**
      (`src/actions/dedicated/discovery.ts:110-115`): Restore im `finally` in
      eigenes `try/catch` wrappen, „failed to restore <start>" loggen und den
      **ursprünglichen** Fehler weiterwerfen.
- [x] **PI-Watchdog für Auto-Discover**
      (`de.schwetschke.sd.eiscp-avr-remote.sdPlugin/ui/eiscp-pi.js:123-134`):
      antwortet das Plugin nicht (z. B. Neustart), hängt der Status ewig auf
      „Starting discovery…". Nach ~10 s ohne `discover`-Event: Meldung
      „No response from plugin", Button wiederherstellen.
- [x] **Query-Timeout-Kontext + Fail-fast** (`src/adapter/eiscp/client.ts:627-637`):
      `host:port` in die Timeout-Meldung; bei Transport-`close` alle
      `pendingQueries` sofort mit „connection lost" rejecten statt den vollen
      Timeout abzuwarten.
- [x] **Verschluckte Garbage-Bytes loggen** (`transport.ts:201-207`):
      beim Verwerfen des Empfangspuffers Breadcrumb mit Hex-Preview loggen.

---

## Phase 3 — Typsicherheit

### Schritt 8: Das `any`-Loch in den Action-Settings schließen

- [x] umgesetzt

**Problem:** `EiscpActionSettings` hat `[key: string]: any`
(`src/actions/eiscp-base.ts:13`). Die vier deklarierten Felder
(`deviceIp`/`customIp`/`command`/`pressAction`) sind zwar typisiert, aber
jeder Zugriff auf nicht deklarierte Keys — die Mehrheit in den abgeleiteten
Settings aller 25+ Action-Klassen — ist `any`; Tippfehler wie
`settings.upParm` kompilieren stillschweigend.

**Umsetzung:**
- [x] Index-Signatur auf `[key: string]: JsonValue` ändern (`JsonValue`
      existiert bereits in derselben Datei) — hält die SDK-Kompatibilität.
- [x] Die dadurch aufgedeckten Compile-Fehler beheben; die bestehenden
      `getToggleConfig`/`getKeyConfig`/`getDialConfig`-Hooks als
      Parse-/Validierungsgrenze für das ungeprüfte PI-JSON behandeln
      („parse, don't validate"). (Keine Fehler aufgedeckt — alle abgeleiteten
      Settings deklarieren ihre Felder bereits explizit.)

### Schritt 9: Event-Maps an die Emitter binden

- [x] umgesetzt

**Problem:** `EiscpClientEvents` (`client.ts:214-221`) und
`EiscpTransportEvents` (`transport.ts:44-50`) sind deklariert, aber nie an die
Emitter gebunden — alle `.on`/`.emit` sind stringly-typed, die manuellen
Callback-Annotationen (z. B. `connection-manager.ts:56`) ungeprüft.

**Umsetzung:**
- [x] Node ≥ 19 / 24 unterstützt generische Emitter (reines
      @types/node-Typfeature, keine Runtime-Beteiligung):
      `class EiscpClient extends EventEmitter<{ message: [DecodedMessage]; ... }>`,
      analog für `EiscpTransport`. Die bestehenden Callback-förmigen
      Event-Interfaces dafür in Tupel-Maps umformen. Mit @types/node 24 +
      TS 6 empirisch verifiziert: falsche Event-Namen/Payloads werden
      abgelehnt. Null Laufzeitkosten.

### Schritt 10: Kind-abhängige Strukturen als diskriminierte Unions

- [x] umgesetzt

**Problem:** Drei Typen erlauben (bzw. konstruieren) illegale Zustände:
1. `DedicatedSpec` (`src/actions/dedicated/catalog.ts:27-51`) ist ein
   Bag-of-Optionals; Konsumenten kaschieren das mit Fallbacks, die nie
   legitim feuern dürften (`s.onValue ?? "01"`, `s.upParam ?? "UP"` in
   `dedicated/index.ts:32, 281, 330, 397, 459`).
2. `CommandDef` (`src/adapter/eiscp/command-registry.ts:12-24`, generiert):
   `actionType: "toggle"` erzwingt `onValue`/`offValue` nicht.
3. Der Transport fabriziert ein „RAW"-`EiscpPacket`
   (`transport.ts:224-231`), das jede dokumentierte Invariante des Typs
   verletzt (`header: "RAW"`, `headerSize: 0`).

**Umsetzung:**
- [x] `type DedicatedSpec = ToggleSpec | KeySpec | DialSpec` (diskriminiert
      über `kind`, kind-spezifische Felder required); Fallbacks entfernen.
- [x] Literal-Id-Union ableiten:
      `const DEDICATED_SPECS = [...] as const satisfies readonly DedicatedSpec[]`,
      `type DedicatedId = ...["id"]`; `SPEC_BY_ID: Record<DedicatedId, ...>` —
      Tippfehler in `protected id = "..."` werden Compile-Fehler.
- [x] `CommandDef` im Generator (`scripts/generate-command-registry.ts`) über
      `actionType` diskriminieren — propagiert automatisch.
- [x] Inbound-Frame-Union im Transport:
      `{ kind: "eiscp"; ... } | { kind: "raw-iscp"; message: string }` statt
      fabriziertem `EiscpPacket`.

### Schritt 11: Eine Quelle der Wahrheit für Wire-Values

- [x] umgesetzt

**Problem:** `enums.ts:34-102` (`InputSource`, `ListeningMode`) und das
generierte `command-registry.ts:75-220` modellieren dieselben SLI/LMD-Werte
doppelt und widersprüchlich (Registry-`"10"` = „dvd" vs. Enum „BLURAY/DVD";
HDMI1 = „16" fehlt in der Registry). Client und Actions labeln denselben
Rohwert unterschiedlich. Dazu: `NetworkService` (`enums.ts:155-168`) hat
doppelte Keys (`"0"`, `"1"`) — `getNetworkServiceByKey` macht
`MUSIC_SERVER`/`PLAY_QUEUE` unerreichbar; NLS ist falsch modelliert
(`client.ts:167, 551`: `"C" | "U"` heißt Cursor/Unicode, nicht
Category/Service, `A` fehlt, unsound `as`-Assertion); mehrere
`IscpCommand`-Konstanten sind falsch gelabelt (`enums.ts:124-145`: `TFR` ist
Tone(Front), nicht Tuner; `SPL` = Speaker Layout; `MOT` = Music Optimizer;
`AEQ` = AccuEQ; `NDS` = Status-Report) — ungenutzt, also billig zu fixen.

**Umsetzung:**
- [x] `InputSource`/`ListeningMode` in die generierte Registry konsolidieren
      (oder Enums aus der Registry generieren) — eine Quelle. → Alle
      Label-Pfade (Client-Decode, State, query*) nutzen `getValueName`
      (Registry); die Enums bleiben reine Sende-API (Key→hex) und sind
      entsprechend dokumentiert. Live gegen die VSX-S520D verifiziert.
- [x] `NetworkService`-Doppel-Keys auflösen (NLS-Zeilennummern sind keine
      Service-IDs; Service-Auswahl ist `NSV`) oder den Typ entfernen, solange
      ungenutzt. → Entfernt (war ungenutzt).
- [x] NLS-Typ korrigieren (`"A" | "C" | "U"` mit echter Bedeutung), die
      `as "C" | "U"`-Assertion durch echte Prüfung ersetzen.
- [x] Falsch gelabelte `IscpCommand`-Konstanten umbenennen oder löschen.

### Schritt 12: API-Hygiene (ConnectionManager, Snapshots, Volume-Grenzen)

- [ ] umgesetzt

- [ ] **`port`-Parameter ehrlich machen** (`connection-manager.ts:37, 83, 90`):
      wird bei existierendem Client ignoriert — entweder Pool nach
      `host:port` keyen oder Parameter entfernen.
- [ ] **`addMessageObserver` ohne Gegenstück** (`connection-manager.ts:115`):
      `removeMessageObserver` ergänzen (oder Permanenz dokumentieren und
      bewusst machen).
- [ ] **Snapshot-Aliasing im unified-controller**
      (`unified-controller.ts:344, 380, 429, 585`): emittierte
      `currentState`-Snapshots teilen das live `ips`-Array/`metadata`-Objekt —
      spätere Mutation ändert bereits emittierte Events. Deep-copy oder
      `readonly`-Felder + Neuaufbau bei Änderung.
- [ ] **Geräte-Identität vereinheitlichen** (`unified-controller.ts:56/70/140/589`):
      drei Vokabulare (`id: string`, `deviceId: number`, stringifizierte Zahl)
      → ein konsistenter `DeviceId`-Typ; die sechsfach wiederholte
      „primary source"-Ableitung (`Array.from(tracked.sources)[0] ?? ...`,
      `unified-controller.ts:464, 470, 508, 516, 583, 590`) auf den Typ
      ziehen.
- [ ] **`VolumeConfig` durchsetzen** (`client.ts:60-64, 307-311, 668-673`):
      `cap ≤ max` validieren; `volumeToHex` auch nach unten clampen
      (`setVolume(-1)` schickt heute `"-1"` aufs Kabel).
- [ ] **`getState()`-Aliasing** (`client.ts:293-295`): liefert das live
      interne Objekt als shallow `Readonly` — Kopie zurückgeben.
- [ ] **Namenskollisionen** (`eiscp/discover.ts:110/120` vs.
      `dnssd/controller.ts:35/376`): `DiscoveryResult`/`StreamingDiscoveryOptions`
      existieren doppelt mit verschiedenen Shapes; ein Paar umbenennen.

---

## Phase 4 — Tests

### Schritt 13: Sofort-Fixes in der Testsuite (Einzeiler)

- [ ] umgesetzt

- [x] `tests/dnssd-integration.test.ts:119-133`: `getDevice` wird nie
      importiert — der `assert.rejects`-Callback wirft `ReferenceError`, der
      Test ist vakuos. Import ergänzen (`src/adapter/dnssd/controller.ts:328`).
      (Erledigt im Zuge der Typecheck-Erweiterung auf tests/ + scripts/.)
- [ ] `tests/eiscp-integration.test.ts:242`: `require()` in ESM-Datei →
      bricht beim nächsten Lauf mit `EISCP_TEST_HOST`. Auf das bereits
      importierte ESM-Modul umstellen. Zeile 32: tote zweite
      `ENABLE_TESTS`-Klausel entfernen.
- [ ] `tests/network-scanner.test.ts:227`: Probe gegen `10.255.255.1`
      (routbar im 10/8-LAN!) ersetzen. Achtung: ein ungebundener
      localhost-Port testet den Connection-Refused-Pfad (den Zeile 233
      schon abdeckt) — für den Timeout-Zweig einen absichtlich nicht
      antwortenden lokalen Listener verwenden.

### Schritt 14: Transport-Reassembly-Tests (neu: `tests/eiscp-transport.test.ts`)

- [ ] umgesetzt

`processReceiveBuffer` (`transport.ts:196-263`) hat keine gezielten Tests —
nur indirekte Happy-Path-Abdeckung über die Fixture-Replays
(`tests/eiscp-listen.test.ts:97-124`,
`tests/eiscp-captured-data.test.ts:193-222`); die Edge-Cases sind ungedeckt,
und eine Regression dort droppt State-Updates dauerhaft.
Mock-Server-Pattern aus `tests/eiscp-listen.test.ts` wiederverwenden:
- [ ] Paket mid-header und mid-body gesplittet; byte-by-byte.
- [ ] Garbage-Bytes vor gültigem Paket (Resync via `!`-Scan).
- [ ] Headerless-RAW-Fallback (`!1PWR01\r` ohne eISCP-Header).
- [ ] Mehrere Pakete in einem `data`-Event.
- [ ] Assertion auf die exakte Sequenz der emittierten Events.

### Schritt 15: Client-Query-/Timeout-Tests

- [ ] umgesetzt

`sendCommand`/Query-Korrelation (`client.ts:598-656`) wird heute nur gegen
echte Hardware **asserted** (via `autoQuery` läuft sie zwar auch in den
Mock-Server-Tests mit, aber `refreshState`/`Promise.allSettled` verschluckt
Fehler — eine Regression macht die Suite nur langsamer, nicht rot).
Mit Mock-Server und kurzem `commandTimeoutMs` (~50 ms):
- [ ] Query resolved mit geantwortetem Parameter.
- [ ] Zwei parallele `query("MVL")` resolven beide.
- [ ] Server schweigt → Reject nach Timeout, `pendingQueries` danach leer.
- [ ] Unsolicited Message ohne pending Query wirft nicht.
- [ ] (Nach Schritt 7) `close` rejected alle pending Queries sofort.

### Schritt 16: ConnectionManager-Verhaltenstests

- [ ] umgesetzt

Der bestehende Test ist nahezu vakuos (Singleton-Identität + „unsubscribe
wirft nicht"). Mit Mock-Server:
- [ ] Eingehende Message aktualisiert `getCachedValue`.
- [ ] Callbacks feuern nur für passenden Host+Command.
- [ ] Unsubscribe stoppt die Zustellung wirklich.
- [ ] Werfender Subscriber unterbricht den Dispatch nicht (Fix aus Schritt 3).
- [ ] `ensureConnected` reconnectet einen getrennten Client.

### Schritt 17: Volume-Cap-Tests (sicherheitsrelevant)

- [ ] umgesetzt

Der Cap existiert, damit eine fehlkonfigurierte Taste keine Lautsprecher
sprengt — heute nur mit echter Hardware getestet. Bytes-on-the-wire gegen
Mock-Server asserten:
- [ ] `setVolume(200)` mit `cap: 50` sendet `MVL32`, niemals `MVLC8`.
- [ ] `setVolume(-1)` clampt auf `00` (Fix aus Schritt 12).
- [ ] `volumeUp` am Cap bleibt am Cap.
- [ ] Hardcodierte Ranges entschärfen: `VolumeDialAction.updateFeedback`
      (`dedicated/index.ts:288-303`, `/80`) und `eiscp-dial-indicator.ts:33-35`
      (MVL→80, sonst 24) → Range in `CommandDef` ziehen.

### Schritt 18: `unified-discovery.test.ts` ersetzen (Test-Theater)

- [ ] umgesetzt

**Problem:** 774 Zeilen, die `discoverAllDevicesStreaming` importieren, aber
nie aufrufen — alle 15 Tests prüfen ihre eigene lokale Simulation; die
`MockDiscoveryProvider`-Klasse (Zeilen 27-64) wird nie benutzt. Alle Tests
blieben grün, wenn man die Logik aus `unified-controller.ts` löschte.

**Umsetzung:**
- [ ] Tracker-/Merge-Logik (um `getOrCreateTrackedDevice`,
      `unified-controller.ts:265+`) in eine testbare Klasse extrahieren.
- [ ] Echte Tests dagegen schreiben (Merge airplay+eiscp, IP-Dedupe,
      Snapshot-Immutability aus Schritt 12).
- [ ] Die Simulations-Tests und den toten Mock löschen.

### Schritt 19: PI-Geräteliste testen (`src/actions/pi-devices.ts`)

- [ ] umgesetzt

Hier gab es laut CLAUDE.md schon einen echten Bug (leeres Dropdown). Die
dokumentierten Invarianten testen:
- [ ] `buildItems` exportieren; Discover-Funktion injizierbar machen
      (oder `mock.module`).
- [ ] Default-IP immer enthalten; „Custom IP…" immer letzter Eintrag.
- [ ] Dedupe nach Host; Gruppenlabels „Discovered"/„Pre-configured"
      (+ Fehlerlabel aus Schritt 4).
- [ ] Cache-TTL respektiert; `isRefresh` umgeht den Cache.
- [ ] Discovery-Fehler → Fallback auf gecachte Geräte, nie leere Liste.

### Schritt 20 (optional): Weitere Unit-Tests für pure Logik

- [ ] umgesetzt

- [ ] `ToggleActionBase.onKeyDown`-Soft-Flip (Inversion = „Power-Taste
      schaltet ein, wenn schon an").
- [ ] `resolveDeviceIp`/`resolveParam`-Präzedenz (`eiscp-base.ts:39-58`).
- [ ] `formatCommandValue` (Registry-Treffer, Stepper-Hex→Dezimal, Passthrough).
- [ ] Tone-Feedback-Mapping (`dedicated/index.ts:406-425`,
      −10..+10 → 0..100 %) und Preset-Feedback
      (`dedicated/index.ts:466-475`, `P<num>`).
- [ ] `runSweep`-Zustandsmaschine (Wrap-around, „UP advanced nicht"-Bail,
      60-Schritte-Cap, Restore im `finally`) — erfordert, den Manager
      injizierbar zu machen (`{send, query, getCached}`).

---

## Phase 5 — Doku und Kommentare

### Schritt 21: Faktisch falsche Kommentare korrigieren

- [ ] umgesetzt

Verifiziert falsch (gegen Code, Node-Runtime, `dns-sd`-Usage bzw.
`docs/eiscp-commands.yaml` geprüft):
- [ ] `transport.ts:302`: `createTransport` behauptet „auto-reconnect" —
      existiert nicht. → „no auto-reconnect; callers must reconnect on close".
- [ ] `unified-controller.ts:15`: Modul-`@example` importiert
      `discoverEiscpDevicesStreaming`, das dieses Modul nicht exportiert →
      auf `discoverAllDevicesStreaming` umstellen (die Options-/Callback-
      Shape des Beispiels ist bereits gültig, nur der Funktionsname ist
      falsch).
- [ ] `discover.ts:291`: „'broadcast' exists at runtime" ist falsch (Node
      liefert kein `broadcast`-Property); toten `(info as ...).broadcast`-Zweig
      entfernen, `calculateBroadcastAddress` läuft immer.
- [ ] `protocol.ts:27, 143`: `rawMessage` enthält den Terminator (Stripping
      passiert erst in `parseIscpMessage`) — Doku korrigieren.
- [ ] `dedicated/discovery.ts:122` vs. `:145`: Widerspruch zu
      `showOk`/`showAlert` auflösen — korrekt ist: `showAlert` gibt es auf
      Keys und Dials, `showOk` ist Keypad-only.
- [ ] `dnssd/caller.ts:62-64`: `dns-sd -B` hat keinen Timeout-Parameter;
      der echte Timeout ist `setTimeout` + `SIGTERM` in `executeDnsSd`.
- [ ] `dnssd/parser.ts:79-83`: JSDoc-Beispielformat parst mit dem Regex nicht
      (Flags-Spalte, `HH:MM:SS.mmm`); echtes `dns-sd`-Ausgabebeispiel einsetzen.
      `:125-126`: „ms since epoch / string as identifier" → tatsächlich ms
      seit Mitternacht. `:348, 354`: IPv4/IPv6-Flag-Heuristik als Heuristik
      kennzeichnen.
- [ ] `client.ts:47`: `volume` ist immer roh (0–max), nie skaliert —
      „0-100 (scaled) or" streichen. `:229`: `debugLog` loggt nicht, sondern
      gated `rawPacket`-Events. `:63, 757-770`: `steps` ist ungenutzt,
      `volumeUp/Down` gehen ±1 Rohwert — re-dokumentieren oder implementieren.
      `:537` + `eiscp-base.ts:78-80`: `Buffer.from(str, "hex")` wirft nie —
      toten Fehlerpfad/Kommentar bereinigen.
- [ ] `network-scanner.ts:4-10`: Header verspricht „nur private Ranges", Code
      klassifiziert nach erstem Oktett (ganz 172/8 bzw. 192/8) — entweder
      `isPrivateIp()` (existiert in der Datei!) wirklich nutzen oder den
      Header abschwächen. `:262`: „network.0.1"-Formulierung begradigen.
- [ ] `discover.ts:57` (`port` = UDP-Quellport, nicht eISCP-Port), `:83`
      (nur erstes Discovery-Paket wird aufgezeichnet), `:130-132`
      (Format-Zeile vs. Beispiele: 3 oder 4 Segmente, Code kann beides),
      `:361` (Key ist `identifier-host`, Mehrfach-Interfaces absichtlich).
- [ ] `scripts/discover-eiscp-broadcast.ts:9` und
      `scripts/discover-eiscp-ip-scan.ts:9`: Usage-Zeilen nennen alte
      Dateinamen. `scripts/generate-manifest.ts:5`: „~16 dedicated actions"
      → Zahl entfernen (es sind 21).

### Schritt 22: CLAUDE.md aktualisieren

- [ ] umgesetzt

- [ ] **sdpi-select-Regel präzisieren** — die pauschale Aussage („nachträglich
      injizierte Options erscheinen nie") widerspricht dem eigenen Code:
      `buildParamSelect` baut Options per `valuechange` + 250-ms-`setTimeout`
      neu (`eiscp-button.html:45-47`) und funktioniert. Erst empirisch klären
      (CDP gegen live PI), welches Pattern wirklich kaputt war
      (vermutlich: Injektion *vor* Component-Upgrade ok, danach nur via
      Datasource?), dann die Regel mit der echten Nuance formulieren.
- [ ] Versionsangabe „v0.1.0.0" entfernen (rottet immer) oder auf
      `package.json` als Quelle verweisen.
- [ ] Action-Pattern-Beispiel: Handler nehmen **ein** Event-Argument
      (`onKeyDown(ev)`), nicht `(ev, context)`; alles erbt von
      `SingletonAction`.
- [ ] CDP-Hinweis: „eISCP Settings" gilt nur für `dedicated.html` und
      `discover.html`. Tatsächliche Titel je PI-HTML: „eISCP Button
      Settings" (`eiscp-button.html`), „eISCP Dial Settings"
      (`eiscp-dial.html`, `dial-press.html`, `dial-discover.html`),
      „eISCP Dial Indicator Settings", „eISCP Toggle Settings",
      „Transport Settings" (`transport.html`). In CLAUDE.md entsprechend
      auflisten.

### Schritt 23: Kommentar-Rauschen entfernen

- [ ] umgesetzt

- [ ] `protocol.ts:122, 220-221` („Parse header", „Strip terminators …" über
      der gleichnamigen Funktion).
- [ ] `client.ts:259, 265, 273` („Initialize …"-Konstruktor-Narration).
- [ ] `dnssd/parser.ts:231`: ungenutzte `nextChar`-Variable + redundante
      Escape-Narration (Strategie ist in 222-226 schon erklärt).

---

## Offene Punkte / vorab klären

- [ ] **Doppel-Send bei Queries** (`client.ts:644-647`): mit `sendRaw: true`
      wird das geframte Paket **und** danach der nackte ISCP-String gesendet.
      Absichtlicher VSX-S520D-Workaround oder Versehen? Gegen den echten
      Receiver testen (`npm run eiscp -- state`), dann entweder Kommentar mit
      Begründung oder zweiten Write entfernen.
- [x] **Hardcodierte Default-IP `10.2.0.32`** (`eiscp-base.ts:48-58`): jeder
      Nutzer ohne Settings sendet an die Entwickler-LAN-IP. Für die
      Veröffentlichung: „nicht konfiguriert" als eigener Zustand? →
      **Umgesetzt:** `resolveDeviceIp` liefert `undefined` ohne Konfiguration;
      Actions zeigen „No IP"/Alert und senden nichts. Das PI-Dropdown bietet
      die global konfigurierte IP (falls vorhanden) statt der Entwickler-IP.
      Die Dev-CLI (`scripts/eiscp-cli.ts`) behält ihren eigenen Default.
- [ ] **Client-Pool räumt nie auf** (`connection-manager.ts:25, 65-67`):
      getrennte Clients + Stale-Cache bleiben für immer im Pool. Bewusst so
      lassen (bounded durch Host-Anzahl) oder Eviction einbauen?
- [ ] **dnssd auf CI unsichtbar**: `dnssd-integration.test.ts` ist
      macOS-gegated (Zeilen 20/36), CI läuft nur ubuntu
      (`.github/workflows/ci.yml:19`) → von `caller.ts` läuft auf CI nur
      der triviale `isDnsSdAvailable`-Plattform-Check; die
      Spawn-/Streaming-Logik in `caller.ts`/`controller.ts` ist komplett
      ungedeckt. Akzeptieren oder macOS-Runner/Injektion erwägen.
- [ ] **`noUncheckedIndexedAccess`** aktivieren? Code ist teils schon so
      geschrieben (`parts[0]!`); würde alle `Record`-Lookups härten
      (u. a. `COMMAND_REGISTRY[command]`, `SPEC_BY_ID`).

---

## Stärken (nicht anfassen, als Vorbild nutzen)

- Katalog als Single Source of Truth (`dedicated/catalog.ts` → Klassen,
  Manifest- und Icon-Generator); UUID-Drift dadurch weitgehend
  ausgeschlossen (Restlücke: `uuidFor` nimmt beliebige Strings —
  Dekorator-Tippfehler kompilieren; schließt Schritt 10 mit der
  Literal-Id-Union). `dial-catalog.test.ts` validiert
  Katalog↔Registry↔Icons↔PI-Routing quer (bewusst ohne
  Action-Klassen/UUIDs).
- Fixture-first-Tests gegen echte VSX-S520D-Captures; `name-store.test.ts`
  und `command-registry.test.ts` (gepinnte echte Regressionen) als Vorbild
  für neue Tests.
- Saubere Schichtung protocol → transport → client → connection-manager;
  PI-Datasource-Roundtrip korrekt; Subscriptions werden in
  `onWillDisappear` abgeräumt.
- „Warum"-Kommentare mit hardware-verifizierten Timings (name-store,
  Sweep-Logik, Lifecycle-Notizen) — Stil beibehalten.
- Hardware-Tests korrekt hinter `EISCP_TEST_HOST` gegated; dns-sd
  platform-gegated.
