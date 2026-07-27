/**
 * Unit tests for the pure action logic in src/actions/eiscp-base.ts (SDK-free:
 * no @elgato/streamdeck in the import chain). parseTone's core cases live in
 * dial-catalog.test.ts; here only the gaps (case-insensitivity) are covered.
 */
import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import {
	actionIdFromManifestId,
	deviceIpToAdopt,
	DIM_OPACITY,
	explicitDeviceIp,
	feedbackStatusStyle,
	forgetActionSettings,
	formatCommandValue,
	generateColoredBg,
	getRememberedActionSettings,
	isDimmedFor,
	keyImageFor,
	markGlobalSettingsLoaded,
	MAX_REMEMBERED_MODEL_LENGTH,
	MAX_TRACKED_ACTION_SETTINGS,
	nextToggleValue,
	OFFLINE_TITLE,
	parseTone,
	presetLabel,
	pressIsSwallowed,
	readLastDevice,
	rememberActionSettings,
	resolveDeviceIp,
	resolveParam,
	setCachedGlobalSettings,
	dialIconFor,
	statusTitle,
	toneFeedback,
	wakeOnPressEnabled,
	whenGlobalSettingsLoaded,
} from "../src/actions/eiscp-base.ts";

describe("resolveDeviceIp", () => {
	afterEach(() => setCachedGlobalSettings(undefined));

	it("prefers the per-action deviceIp over customIp and global settings", () => {
		setCachedGlobalSettings({ deviceIp: "3.3.3.3" });
		assert.equal(resolveDeviceIp({ deviceIp: "1.1.1.1", customIp: "2.2.2.2" }), "1.1.1.1");
	});

	it("uses customIp when deviceIp is 'custom'", () => {
		assert.equal(resolveDeviceIp({ deviceIp: "custom", customIp: "2.2.2.2" }), "2.2.2.2");
	});

	it("uses customIp when no deviceIp is set", () => {
		assert.equal(resolveDeviceIp({ customIp: "2.2.2.2" }), "2.2.2.2");
	});

	it("falls back to the plugin-wide global deviceIp", () => {
		setCachedGlobalSettings({ deviceIp: "3.3.3.3" });
		assert.equal(resolveDeviceIp({}), "3.3.3.3");
		assert.equal(resolveDeviceIp({ deviceIp: "custom" }), "3.3.3.3");
	});

	it("returns undefined when nothing is configured anywhere", () => {
		assert.equal(resolveDeviceIp({}), undefined);
		setCachedGlobalSettings({ deviceIp: "" });
		assert.equal(resolveDeviceIp({}), undefined);
	});

	it("rejects hostnames, so a setting cannot make the plugin resolve arbitrary names", () => {
		assert.equal(resolveDeviceIp({ deviceIp: "receiver.local" }), undefined);
		assert.equal(resolveDeviceIp({ customIp: "attacker.example.com" }), undefined);
		setCachedGlobalSettings({ deviceIp: "evil.example" });
		assert.equal(resolveDeviceIp({}), undefined);
	});

	it("rejects non-string values from the untyped PI JSON", () => {
		// `deviceIp?: string` is a compile-time fiction: the index signature is
		// JsonValue and these arrive as untyped JSON at runtime.
		for (const value of [42, true, { host: "1.1.1.1" }, ["1.1.1.1"], null]) {
			assert.equal(
				resolveDeviceIp({ deviceIp: value as never }),
				undefined,
				`${JSON.stringify(value)} must not resolve`,
			);
		}
	});

	it("rejects malformed and whitespace-only addresses", () => {
		for (const value of ["   ", "1.2.3", "1.2.3.4.5", "999.1.1.1", "1.1.1.1 ; rm -rf /", "::gg"]) {
			assert.equal(resolveDeviceIp({ deviceIp: value }), undefined, `${value} must not resolve`);
		}
	});

	it("accepts IPv4 and IPv6 literals, trimming surrounding whitespace", () => {
		assert.equal(resolveDeviceIp({ deviceIp: " 10.2.0.32 " }), "10.2.0.32");
		assert.equal(resolveDeviceIp({ deviceIp: "fe80::1" }), "fe80::1");
		assert.equal(resolveDeviceIp({ deviceIp: "::1" }), "::1");
	});

	it("does not fall back to the global IP when an explicit device is invalid", () => {
		// Silently retargeting to a different receiver than the action names would
		// be worse than degrading to "No IP".
		setCachedGlobalSettings({ deviceIp: "3.3.3.3" });
		assert.equal(resolveDeviceIp({ deviceIp: "not-an-ip" }), undefined);
		assert.equal(resolveDeviceIp({ deviceIp: "custom", customIp: "also-not-an-ip" }), undefined);
	});
});

describe("explicitDeviceIp", () => {
	afterEach(() => setCachedGlobalSettings(undefined));

	it("returns the address the action selected itself", () => {
		assert.equal(explicitDeviceIp({ deviceIp: "1.1.1.1" }), "1.1.1.1");
		assert.equal(explicitDeviceIp({ deviceIp: "custom", customIp: "2.2.2.2" }), "2.2.2.2");
		assert.equal(explicitDeviceIp({ customIp: "2.2.2.2" }), "2.2.2.2");
	});

	it("never falls back to the plugin-wide setting — that is not the user's pick", () => {
		setCachedGlobalSettings({ deviceIp: "3.3.3.3" });
		assert.equal(explicitDeviceIp({}), undefined);
		assert.equal(explicitDeviceIp({ deviceIp: "custom" }), undefined);
		assert.equal(explicitDeviceIp({ deviceIp: "" }), undefined);
	});

	it("applies the same validation as resolveDeviceIp", () => {
		assert.equal(explicitDeviceIp({ deviceIp: "receiver.local" }), undefined);
		assert.equal(explicitDeviceIp({ deviceIp: 42 as never }), undefined);
		assert.equal(explicitDeviceIp({ deviceIp: " 10.2.0.32 " }), "10.2.0.32");
	});
});

describe("readLastDevice", () => {
	it("reads a remembered receiver back", () => {
		assert.deepEqual(readLastDevice({ lastDevice: { host: "10.2.0.32", model: "VSX-S520D" } }), {
			host: "10.2.0.32",
			model: "VSX-S520D",
		});
	});

	it("tolerates a missing model", () => {
		assert.deepEqual(readLastDevice({ lastDevice: { host: "10.2.0.32" } }), { host: "10.2.0.32", model: "" });
	});

	it("returns undefined when nothing is remembered", () => {
		assert.equal(readLastDevice({}), undefined);
		assert.equal(readLastDevice({ lastDevice: {} }), undefined);
	});

	it("rejects a host that is not an IP literal — persisted values are re-validated", () => {
		// The global settings blob round-trips through disk and is editable; a
		// hostname here would make the plugin resolve whatever it names.
		assert.equal(readLastDevice({ lastDevice: { host: "receiver.local" } }), undefined);
		assert.equal(readLastDevice({ lastDevice: { host: "" } }), undefined);
		for (const value of [42, true, ["10.2.0.32"], { host: "10.2.0.32" }, null]) {
			assert.equal(
				readLastDevice({ lastDevice: { host: value as never } }),
				undefined,
				`${JSON.stringify(value)} must not be accepted as a host`,
			);
		}
	});

	it("rejects a lastDevice that is not an object", () => {
		for (const value of ["10.2.0.32", 42, [{ host: "10.2.0.32" }], null]) {
			assert.equal(readLastDevice({ lastDevice: value as never }), undefined);
		}
	});

	it("strips control characters from the model and clamps its length", () => {
		// The model name originally came off the wire (ECN response) and is rendered
		// in the PI dropdown; NUL padding and escape sequences genuinely arrive.
		const dirty = readLastDevice({ lastDevice: { host: "10.2.0.32", model: "VSX\u0000-S520\u001b[31mD" } });
		assert.equal(dirty?.model, "VSX-S520[31mD");
		const long = readLastDevice({ lastDevice: { host: "10.2.0.32", model: "M".repeat(500) } });
		assert.equal(long?.model.length, MAX_REMEMBERED_MODEL_LENGTH);
	});

	it("ignores a non-string model instead of rejecting the device", () => {
		assert.deepEqual(readLastDevice({ lastDevice: { host: "10.2.0.32", model: 42 as never } }), {
			host: "10.2.0.32",
			model: "",
		});
	});
});

describe("global-settings write gate", () => {
	it("stays closed until the initial load is reported", async () => {
		// Writers merge over the cached snapshot, and that cache is empty until the
		// initial load lands — which happens after connect(), i.e. after the first
		// actions have bound. Writing in that window persisted a settings object
		// with every other key missing and destroyed a real learned-name map.
		// A timer, not Promise.resolve(): an already-settled promise always wins the
		// race and would report "closed" even for an open gate.
		const soon = (): Promise<string> =>
			new Promise((resolve) => {
				setTimeout(() => resolve("closed"), 20).unref?.();
			});
		assert.equal(
			await Promise.race([whenGlobalSettingsLoaded().then(() => "open"), soon()]),
			"closed",
			"the gate must not be open before markGlobalSettingsLoaded()",
		);
		markGlobalSettingsLoaded();
		assert.equal(await Promise.race([whenGlobalSettingsLoaded().then(() => "open"), soon()]), "open");
	});
});

describe("remembered action settings", () => {
	// The Device IP dropdown pins the asking action's own selection from this map
	// instead of calling action.getSettings(): that round trip is delivered to the
	// action's own onDidReceiveSettings as well, so opening a PI would re-bind it.
	it("hands back what an action last recorded, and forgets it on disappear", () => {
		rememberActionSettings("key-1", { deviceIp: "10.2.0.32" });
		assert.deepEqual(getRememberedActionSettings("key-1"), { deviceIp: "10.2.0.32" });
		forgetActionSettings("key-1");
		assert.equal(getRememberedActionSettings("key-1"), undefined);
	});

	it("stays bounded, dropping the oldest entry first", () => {
		for (let i = 0; i < MAX_TRACKED_ACTION_SETTINGS + 5; i++) {
			rememberActionSettings(`bounded-${i}`, { deviceIp: "10.2.0.32" });
		}
		assert.equal(getRememberedActionSettings("bounded-0"), undefined, "the oldest entry must be evicted");
		assert.deepEqual(getRememberedActionSettings(`bounded-${MAX_TRACKED_ACTION_SETTINGS + 4}`), {
			deviceIp: "10.2.0.32",
		});
	});
});

describe("deviceIpToAdopt", () => {
	const last = { host: "10.2.0.32", model: "VSX-S520D" };

	it("adopts the remembered device for a never-configured action", () => {
		assert.equal(deviceIpToAdopt({}, last), "10.2.0.32");
	});

	it("leaves a deliberately emptied selection alone", () => {
		// "" is what the dropdown's "(none found)" entry persists; re-pointing that
		// action at a receiver would undo an explicit choice.
		assert.equal(deviceIpToAdopt({ deviceIp: "" }, last), undefined);
		assert.equal(deviceIpToAdopt({ customIp: "" }, last), undefined);
	});

	it("never overrides an existing selection", () => {
		assert.equal(deviceIpToAdopt({ deviceIp: "1.1.1.1" }, last), undefined);
		assert.equal(deviceIpToAdopt({ deviceIp: "custom", customIp: "2.2.2.2" }, last), undefined);
	});

	it("adopts nothing when no device is remembered yet", () => {
		assert.equal(deviceIpToAdopt({}, undefined), undefined);
	});
});

describe("resolveParam", () => {
	it("returns the value when one is set", () => {
		assert.equal(resolveParam("X", "Y", "F"), "X");
	});

	it("returns the custom value for 'custom'", () => {
		assert.equal(resolveParam("custom", "Y", "F"), "Y");
	});

	it("falls back when the custom value is empty or missing", () => {
		assert.equal(resolveParam("custom", "", "F"), "F");
		assert.equal(resolveParam("custom", undefined, "F"), "F");
	});

	it("falls back when no value is set", () => {
		assert.equal(resolveParam(undefined, "Y", "F"), "F");
		assert.equal(resolveParam("", undefined, "F"), "F");
	});

	it("returns undefined when neither value nor fallback exist", () => {
		assert.equal(resolveParam(undefined, undefined, undefined), undefined);
	});
});

describe("formatCommandValue", () => {
	it("uses the registry name when the value is known", () => {
		assert.equal(formatCommandValue("PWR", "01"), "on");
		assert.equal(formatCommandValue("AMT", "TG"), "toggle");
	});

	it("converts stepper hex values to decimal", () => {
		assert.equal(formatCommandValue("MVL", "0E"), "14");
		assert.equal(formatCommandValue("MVL", "1E"), "30");
	});

	it("passes unknown values through unchanged", () => {
		assert.equal(formatCommandValue("ZZZ", "whatever"), "whatever");
		assert.equal(formatCommandValue("MVL", "QSTN"), "QSTN"); // stepper, but not hex
		assert.equal(formatCommandValue("PWR", "77"), "77"); // toggle without a matching value
	});
});

describe("parseTone (gaps beyond dial-catalog.test.ts)", () => {
	it("matches case-insensitively, including a lowercase hex nibble", () => {
		assert.deepEqual(parseTone("b+3t-2"), { bass: 3, treble: -2 });
		assert.deepEqual(parseTone("B+aT-a"), { bass: 10, treble: -10 });
	});

	it("mixes the zero token with signed tokens", () => {
		assert.deepEqual(parseTone("B00T+5"), { bass: 0, treble: 5 });
		assert.deepEqual(parseTone("B-7T00"), { bass: -7, treble: 0 });
	});
});

describe("toneFeedback", () => {
	it("maps −10..+10 onto a 0..100 percent bar", () => {
		assert.deepEqual(toneFeedback("B+AT-A", "bass"), { percent: 100, display: "+10" });
		assert.deepEqual(toneFeedback("B+AT-A", "treble"), { percent: 0, display: "-10" });
		assert.deepEqual(toneFeedback("B00T00", "bass"), { percent: 50, display: "0" });
		assert.deepEqual(toneFeedback("B+2T-1", "treble"), { percent: 45, display: "-1" });
		assert.deepEqual(toneFeedback("B+2T-1", "bass"), { percent: 60, display: "+2" });
	});

	it("renders an em dash at the neutral bar position for non-tone input", () => {
		assert.deepEqual(toneFeedback("garbage", "bass"), { percent: 0, display: "—" });
		assert.deepEqual(toneFeedback("", "treble"), { percent: 0, display: "—" });
	});
});

describe("presetLabel", () => {
	it("shows the hex preset number as P<decimal>", () => {
		assert.equal(presetLabel("01"), "P1");
		assert.equal(presetLabel("0E"), "P14");
		assert.equal(presetLabel("28"), "P40");
	});

	it("keeps unparseable raw values as-is", () => {
		assert.equal(presetLabel("XY"), "XY");
		assert.equal(presetLabel(""), "");
	});
});

describe("nextToggleValue", () => {
	const cfg = { onValue: "01", offValue: "00" };

	it("turns off when the current value reads on (power key switches off while on)", () => {
		assert.equal(nextToggleValue("01", cfg), "00");
	});

	it("turns on when the current value reads off", () => {
		assert.equal(nextToggleValue("00", cfg), "01");
	});

	it("turns on for any other (unknown/transitional) value", () => {
		assert.equal(nextToggleValue("77", cfg), "01");
		assert.equal(nextToggleValue("", cfg), "01");
	});
});

// --- receiver power state on the deck ---------------------------------------

describe("isDimmedFor", () => {
	it("leaves a reachable, powered receiver alone", () => {
		assert.equal(isDimmedFor("on", "MVL"), false);
		assert.equal(isDimmedFor("on", "PWR"), false);
	});

	it("dims a sleeping receiver's keys", () => {
		assert.equal(isDimmedFor("standby", "MVL"), true);
		assert.equal(isDimmedFor("standby", "SLI"), true);
	});

	it("never dims the power key in standby — it is the one key that works there", () => {
		assert.equal(isDimmedFor("standby", "PWR"), false);
	});

	it("dims everything, power included, when the receiver is unreachable", () => {
		assert.equal(isDimmedFor("offline", "PWR"), true);
		assert.equal(isDimmedFor("offline", "MVL"), true);
		assert.equal(isDimmedFor("offline", undefined), true);
	});

	it("leaves an unknown state undecorated rather than guessing", () => {
		assert.equal(isDimmedFor("unknown", "MVL"), false);
	});
});

describe("statusTitle", () => {
	it("says so when the receiver cannot be reached", () => {
		assert.equal(statusTitle("14", "offline"), OFFLINE_TITLE);
		assert.equal(statusTitle(undefined, "offline"), OFFLINE_TITLE);
	});

	it("passes every other state through untouched, undefined included", () => {
		// undefined means "restore the user's own title", and that has to survive.
		for (const status of ["on", "standby", "unknown"] as const) {
			assert.equal(statusTitle("14", status), "14");
			assert.equal(statusTitle(undefined, status), undefined);
		}
	});

	it("restores the real title when the receiver comes back", () => {
		// The regression this guards: "Offline" is a function of the status, not a
		// separate write, so it cannot outlive the outage.
		assert.equal(statusTitle("Play", "offline"), OFFLINE_TITLE);
		assert.equal(statusTitle("Play", "on"), "Play");
	});
});

describe("actionIdFromManifestId", () => {
	it("takes the catalog id — which is also the image folder — off the UUID", () => {
		assert.equal(actionIdFromManifestId("de.schwetschke.sd.eiscp-avr-remote.power"), "power");
		assert.equal(actionIdFromManifestId("de.schwetschke.sd.eiscp-avr-remote.eiscp-dial-indicator"), "eiscp-dial-indicator");
	});

	it("returns undefined for anything unusable", () => {
		assert.equal(actionIdFromManifestId(undefined), undefined);
		assert.equal(actionIdFromManifestId(""), undefined);
		assert.equal(actionIdFromManifestId("trailing."), undefined);
	});
});

describe("keyImageFor", () => {
	const uuid = "de.schwetschke.sd.eiscp-avr-remote.mute";

	it("names the dim variant while the receiver sleeps", () => {
		assert.equal(keyImageFor(uuid, "standby", "AMT", 0), "imgs/actions/mute/key-dim.svg");
		assert.equal(keyImageFor(uuid, "standby", "AMT", 1), "imgs/actions/mute/key-on-dim.svg");
	});

	it("falls back to the manifest image when everything is normal", () => {
		// undefined is what setImage() wants for "use the declared image".
		assert.equal(keyImageFor(uuid, "on", "AMT", 0), undefined);
		assert.equal(keyImageFor(uuid, "unknown", "AMT", 1), undefined);
	});

	it("dims the power key only when the receiver is gone", () => {
		const power = "de.schwetschke.sd.eiscp-avr-remote.power";
		assert.equal(keyImageFor(power, "standby", "PWR", 0), undefined);
		assert.equal(keyImageFor(power, "offline", "PWR", 0), "imgs/actions/power/key-dim.svg");
	});

	it("decorates nothing when the action id is unknown", () => {
		assert.equal(keyImageFor(undefined, "offline", "MVL", 0), undefined);
	});
});

describe("feedbackStatusStyle", () => {
	it("is fully opaque and untitled when all is well", () => {
		assert.deepEqual(feedbackStatusStyle("on", "MVL"), { opacity: 1 });
	});

	it("dims a sleeping receiver's touch strip without renaming it", () => {
		assert.deepEqual(feedbackStatusStyle("standby", "MVL"), { opacity: DIM_OPACITY });
	});

	it("dims and labels an unreachable one", () => {
		assert.deepEqual(feedbackStatusStyle("offline", "MVL"), { opacity: DIM_OPACITY, title: OFFLINE_TITLE });
	});

	it("always states an opacity, so returning to normal is never implicit", () => {
		// The layout keeps its last value; omitting it would leave a strip dimmed.
		for (const status of ["on", "standby", "offline", "unknown"] as const) {
			assert.equal(typeof feedbackStatusStyle(status, "MVL").opacity, "number");
		}
	});
});

describe("generateColoredBg", () => {
	const fillOf = (dataUri: string): string => {
		const svg = Buffer.from(dataUri.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf-8");
		return /fill="([^"]+)"/.exec(svg)?.[1] ?? "";
	};

	it("uses the colour as given when the receiver is on", () => {
		assert.equal(fillOf(generateColoredBg("#4CAF50", "on", "AMT")), "#4CAF50");
		// Default argument: unchanged behaviour for callers that do not care.
		assert.equal(fillOf(generateColoredBg("#4CAF50")), "#4CAF50");
	});

	it("darkens it while the receiver is not listening", () => {
		assert.equal(fillOf(generateColoredBg("#4CAF50", "standby", "AMT")), "#1E4620");
		assert.equal(fillOf(generateColoredBg("#F44336", "offline", "AMT")), "#621B16");
	});

	it("passes an unparseable colour through instead of throwing", () => {
		assert.equal(fillOf(generateColoredBg("red", "offline", "AMT")), "red");
	});
});

describe("pressIsSwallowed", () => {
	it("knows which commands a sleeping receiver acts on", () => {
		// Measured on the reference unit: PWR works, SLI even wakes it.
		assert.equal(pressIsSwallowed("standby", "PWR"), false);
		assert.equal(pressIsSwallowed("standby", "SLI"), false);
		assert.equal(pressIsSwallowed("standby", "MVL"), true);
		assert.equal(pressIsSwallowed("standby", "AMT"), true);
		assert.equal(pressIsSwallowed("standby", "LMD"), true);
	});

	it("is only about standby — an offline receiver fails loudly on its own", () => {
		assert.equal(pressIsSwallowed("offline", "MVL"), false);
		assert.equal(pressIsSwallowed("on", "MVL"), false);
		assert.equal(pressIsSwallowed("unknown", "MVL"), false);
	});
});

describe("wakeOnPressEnabled", () => {
	afterEach(() => setCachedGlobalSettings(undefined));

	it("defaults to on: a key that does nothing is the problem being solved", () => {
		assert.equal(wakeOnPressEnabled({}), true);
		assert.equal(wakeOnPressEnabled({ wakeOnPress: true }), true);
	});

	it("is off only when explicitly switched off", () => {
		assert.equal(wakeOnPressEnabled({ wakeOnPress: false }), false);
	});

	it("reads the shared cache when asked without an argument", () => {
		setCachedGlobalSettings({ wakeOnPress: false });
		assert.equal(wakeOnPressEnabled(), false);
	});
});

describe("a dial's icon slot", () => {
	it("always resolves to a concrete path, because the slot cannot be unset", () => {
		// The defect this prevents: the track-change preview wrote a cover into a dial's
		// icon slot and then, on expiry, sent only `{ opacity }`. A layout item keeps
		// whatever it was last given, so the cover stayed on the touch strip for good.
		// The way back is to write the action's own icon again — so this must return
		// something for every real action.
		const path = dialIconFor("de.schwetschke.sd.eiscp-avr-remote.volume-dial", "on", "MVL");
		assert.equal(path, "imgs/actions/volume-dial/icon.svg");
	});

	it("uses the transparent list glyph, not the key image", () => {
		// key.svg carries a dark rounded background that would show as a tile on the
		// strip; icon.svg is the bare glyph, which is what the strip shows by default.
		const path = dialIconFor("de.schwetschke.sd.eiscp-avr-remote.input-dial", "on", "SLI")!;
		assert.ok(path.endsWith("/icon.svg"), path);
		assert.ok(!path.includes("key"), path);
	});

	it("dims with the receiver, like the keys do", () => {
		const dim = dialIconFor("de.schwetschke.sd.eiscp-avr-remote.volume-dial", "standby", "MVL");
		assert.equal(dim, "imgs/actions/volume-dial/key-dim.svg");
		const offline = dialIconFor("de.schwetschke.sd.eiscp-avr-remote.volume-dial", "offline", "MVL");
		assert.equal(offline, "imgs/actions/volume-dial/key-dim.svg");
	});

	it("returns nothing for an unresolvable action, so the caller leaves the slot alone", () => {
		// Writing "" would clear the layout's own icon with no way to restore it, so
		// "no idea" has to be distinguishable from "blank".
		assert.equal(dialIconFor(undefined, "on"), undefined);
	});
});
