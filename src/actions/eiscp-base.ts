/**
 * Shared helpers for eISCP actions
 */

import { isIP } from "node:net";

import { COMMAND_REGISTRY, getValueName } from "../adapter/eiscp/command-registry.ts";
import type { DeviceStatus } from "../adapter/eiscp/device-status.ts";
import { keyImagePath, listIconPath } from "./dedicated/catalog.ts";

/** JSON-compatible value (mirrors the SDK's JsonValue; undefined is allowed). */
type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };

export interface EiscpActionSettings {
	deviceIp?: string;
	customIp?: string;
	command?: string;
	/** Configurable dial press action key (see resolveDialPress / ui/dial-*.html). */
	pressAction?: string;
	/**
	 * Briefly replace this element's face with the now-playing metadata when the
	 * track changes. Declared here rather than per action because every Property
	 * Inspector offers it — see `track-overlay.ts` for the semantics. Off by default:
	 * it changes what an unrelated key looks like.
	 */
	showOnTrackChange?: boolean;
	/** How long that replacement stays up; clamped by `trackOverlaySeconds`. */
	trackChangeSeconds?: number;
	// JsonValue (not any) keeps SDK compatibility while forcing every access
	// to an undeclared key through a real type check — the get*Config hooks
	// are the parse/validate boundary for the untyped PI JSON.
	[key: string]: JsonValue;
}

/** Learned option names, persisted in global settings: host -> command -> code -> name. */
export type SerializedNames = { [host: string]: { [command: string]: { [code: string]: string } } };

/** A receiver remembered across sessions, so a new action can adopt it. */
export interface LastDevice {
	host: string;
	model: string;
}

/** Plugin-wide persisted settings (Stream Deck global settings). */
export interface GlobalSettings {
	deviceIp?: string;
	/** The receiver most recently picked in any PI; pre-fills freshly added actions. */
	lastDevice?: { host?: string; model?: string };
	names?: SerializedNames;
	/** Power the receiver on before sending a command it would sleep through. */
	wakeOnPress?: boolean;
	/**
	 * Fetch the cover from the receiver's own web server rather than only accepting
	 * the copy it streams over the control connection. Default on.
	 */
	coverOverHttp?: boolean;
	[key: string]: JsonValue;
}

// getGlobalSettings() is async, so reads must come from a cache kept fresh by
// plugin.ts (initial load + onDidReceiveGlobalSettings).
let cachedGlobalSettings: GlobalSettings = {};
export function setCachedGlobalSettings(settings: GlobalSettings | undefined): void {
	cachedGlobalSettings = settings ?? {};
}
export function getCachedGlobalSettings(): GlobalSettings {
	return cachedGlobalSettings;
}

/**
 * Gate for code that *writes* the global settings.
 *
 * Writers merge over the cached snapshot (`{...getCachedGlobalSettings(), …}`),
 * and that snapshot is empty until the initial load lands — which happens after
 * `connect()`, i.e. after the first actions have already appeared and bound.
 * Writing in that window persists a settings object with everything else
 * missing; it cost a real user their whole learned-name map once.
 *
 * Resolved by plugin.ts once, and deliberately only on a *successful* load: if
 * we could not read the settings we do not know what is in them, so overwriting
 * them is worse than not remembering anything this session.
 */
let markLoaded: () => void;
let settingsLoaded = false;
const globalSettingsLoaded = new Promise<void>((resolve) => {
	markLoaded = resolve;
});
export function markGlobalSettingsLoaded(): void {
	settingsLoaded = true;
	markLoaded();
}
export function whenGlobalSettingsLoaded(): Promise<void> {
	return globalSettingsLoaded;
}
/** Synchronous form of the gate, for writers that waited with a timeout. */
export function areGlobalSettingsLoaded(): boolean {
	return settingsLoaded;
}

/** How long a bind may wait for the settings load before carrying on without it. */
export const GLOBAL_SETTINGS_WAIT_MS = 2000;

/**
 * Bounded wait for the same load, for *readers* that would otherwise decide on an
 * empty cache. Actions appear immediately after `connect()`, before the settings
 * arrive, so an action that should adopt the remembered receiver would show
 * "No IP" until something happened to re-bind it — on every plugin restart.
 *
 * Capped rather than open-ended: a load that never completes must cost the
 * remembered device, not the bind.
 */
export function waitForGlobalSettings(timeoutMs: number = GLOBAL_SETTINGS_WAIT_MS): Promise<void> {
	return Promise.race([
		globalSettingsLoaded,
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
		}),
	]);
}

/**
 * Persist the global settings. Injected by plugin.ts so this module stays
 * SDK-free (importing @elgato/streamdeck rotates its log files as a side effect).
 */
export type GlobalSettingsWriter = (settings: GlobalSettings) => Promise<void>;

let globalSettingsWriter: GlobalSettingsWriter | undefined;
export function setGlobalSettingsWriter(write: GlobalSettingsWriter | undefined): void {
	globalSettingsWriter = write;
}

let globalWriteQueue: Promise<void> = Promise.resolve();

/**
 * The **only** way to write the global settings.
 *
 * Stream Deck stores them as one object shared by unrelated subsystems (the
 * learned-name map, the remembered device). Every writer therefore has to merge
 * over the others' values, and two independent writers merging over their own
 * stale idea of that object is how data disappears here:
 *
 * - Writing before the initial load persists a snapshot with everything else
 *   missing. That wiped a real user's learned names once, hence the gate.
 * - Writing over `getCachedGlobalSettings()` without putting the result *back*
 *   into the cache leaves the next writer merging over a superseded snapshot,
 *   silently reverting whatever happened in between. Stream Deck does not echo
 *   a plugin's own `setGlobalSettings` back as `didReceiveGlobalSettings`, so
 *   nothing else refreshes that cache during a session.
 *
 * So: patches are applied to the live cache, serialised against each other, and
 * the cache is updated before the round-trip — a queued patch then merges over
 * the new values even while the write is still in flight. `patch` returns
 * `undefined` to skip the write entirely.
 *
 * A failed write deliberately leaves the cache holding the new values: the next
 * successful write carries them along, so a transient failure self-heals instead
 * of resurrecting old data. The rejection is passed to the caller (name-store
 * retries with backoff).
 */
export function updateGlobalSettings(
	patch: (current: GlobalSettings) => GlobalSettings | undefined,
	waitMs: number = GLOBAL_SETTINGS_WAIT_MS,
): Promise<void> {
	const run = globalWriteQueue.then(async () => {
		await waitForGlobalSettings(waitMs);
		if (!areGlobalSettingsLoaded()) {
			// We do not know what is in there, so we must not replace it.
			throw new Error("global settings were never loaded — refusing to overwrite them");
		}
		if (!globalSettingsWriter) throw new Error("no global-settings writer injected");
		const next = patch(getCachedGlobalSettings());
		if (next === undefined) return;
		setCachedGlobalSettings(next);
		await globalSettingsWriter(next);
	});
	// Keep the chain alive after a rejection; the caller still sees it.
	globalWriteQueue = run.then(
		() => {},
		() => {},
	);
	return run;
}

/**
 * The settings each action was last seen with, by action id.
 *
 * The Device IP dropdown has to pin the asking action's own selection, and
 * `action.getSettings()` is not a cheap read for that: it is a WebSocket
 * round-trip whose `didReceiveSettings` reply is also delivered to the action's
 * own handler, so merely *opening* a PI would re-enter onDidReceiveSettings and
 * re-bind the action. Actions record what they already have instead.
 */
const actionSettings = new Map<string, EiscpActionSettings>();
/** Bound like every other in-memory map here; ids come from outside. */
export const MAX_TRACKED_ACTION_SETTINGS = 512;

export function rememberActionSettings(actionId: string, settings: EiscpActionSettings): void {
	if (!actionSettings.has(actionId) && actionSettings.size >= MAX_TRACKED_ACTION_SETTINGS) {
		// Map preserves insertion order: drop the oldest entry.
		const oldest = actionSettings.keys().next().value;
		if (oldest !== undefined) actionSettings.delete(oldest);
	}
	actionSettings.set(actionId, settings);
}

export function getRememberedActionSettings(actionId: string): EiscpActionSettings | undefined {
	return actionSettings.get(actionId);
}

export function forgetActionSettings(actionId: string): void {
	actionSettings.delete(actionId);
}

export function resolveParam(value: string | undefined, customValue: string | undefined, fallback: string): string;
export function resolveParam(value?: string, customValue?: string, fallback?: string): string | undefined;
export function resolveParam(value?: string, customValue?: string, fallback?: string): string | undefined {
	if (!value) return fallback;
	if (value === "custom") return customValue || fallback;
	return value;
}

/** Title/feedback shown while no receiver IP is configured. */
export const UNCONFIGURED_TITLE = "No IP";

/**
 * Validate an address coming out of the untyped Property Inspector JSON.
 *
 * The declared `deviceIp?: string` is a compile-time fiction — the index
 * signature is `JsonValue` and the values arrive as untyped JSON, so numbers,
 * objects and arrays reach here at runtime and used to be handed straight to
 * `socket.connect({ host })`. Only literal IP addresses are accepted:
 * hostnames would make the plugin issue DNS lookups for whatever a settings
 * writer chose, and nothing in this plugin needs to address a receiver by name.
 *
 * @returns The trimmed address, or undefined when it is not a usable IP.
 */
function validDeviceIp(value: JsonValue): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return isIP(trimmed) === 0 ? undefined : trimmed;
}

/**
 * Resolve the receiver IP for an action: per-action setting, then the
 * plugin-wide global setting. Returns undefined when nothing is configured or
 * the configured value is not a valid IP address — deliberately no hardcoded
 * fallback, so an unconfigured action never sends commands to somebody else's
 * LAN. Callers must degrade visibly instead.
 *
 * The precedence between the three sources is unchanged; each candidate is now
 * validated, and a candidate that fails validation resolves to undefined rather
 * than being passed to `socket.connect`.
 */
export function resolveDeviceIp(settings: EiscpActionSettings): string | undefined {
	if (settings.deviceIp && settings.deviceIp !== "custom") {
		return validDeviceIp(settings.deviceIp);
	}
	if (settings.customIp) {
		return validDeviceIp(settings.customIp);
	}
	return validDeviceIp(getCachedGlobalSettings().deviceIp);
}

/**
 * The IP this action selects *on its own*, ignoring the plugin-wide fallback.
 *
 * Deliberately a second function rather than a refactor of resolveDeviceIp: that
 * one falls back to the global setting when `deviceIp` is "custom" and no
 * `customIp` is set (asserted by tests/actions-logic.test.ts), and folding the
 * two together would change that precedence. This is the value worth
 * remembering as "the device the user picked".
 */
export function explicitDeviceIp(settings: EiscpActionSettings): string | undefined {
	if (settings.deviceIp && settings.deviceIp !== "custom") {
		return validDeviceIp(settings.deviceIp);
	}
	if (settings.customIp) {
		return validDeviceIp(settings.customIp);
	}
	return undefined;
}

/** Longest model name kept in the remembered device (mirrors discovery's cap). */
export const MAX_REMEMBERED_MODEL_LENGTH = 48;

/**
 * Read the remembered receiver out of the global settings.
 *
 * Everything persisted is re-validated on load: the value round-tripped through
 * a JSON blob that other tooling can edit, and the host ends up in
 * `socket.connect()` while the model is rendered in the PI dropdown. Same stance
 * as name-store.load().
 */
export function readLastDevice(gs: GlobalSettings): LastDevice | undefined {
	const raw = gs.lastDevice;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const host = validDeviceIp(raw.host);
	if (!host) return undefined;
	return { host, model: sanitiseModel(raw.model) };
}

/** Keep printable ASCII only and clamp; the model name is untrusted wire data. */
function sanitiseModel(value: JsonValue): string {
	if (typeof value !== "string") return "";
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		if (code >= 0x20 && code !== 0x7f) out += ch;
		if (out.length >= MAX_REMEMBERED_MODEL_LENGTH) break;
	}
	return out.trim();
}

/**
 * The IP a freshly added action should adopt from the remembered device, if any.
 *
 * Only actions that were *never* configured qualify: both keys are `undefined`
 * on an action the user just dropped onto the deck. A deliberately cleared
 * selection persists as `""` (the dropdown's "(none found)" entry) and must stay
 * empty — adopting there would silently re-point an action the user emptied on
 * purpose.
 */
export function deviceIpToAdopt(
	settings: EiscpActionSettings,
	last: LastDevice | undefined,
): string | undefined {
	if (!last) return undefined;
	if (settings.deviceIp !== undefined || settings.customIp !== undefined) return undefined;
	return last.host;
}

/**
 * Catch-and-log for fire-and-forget SDK calls (setTitle, setFeedback, ...)
 * made from synchronous code. Node 24 runs with unhandled rejections fatal,
 * so every dropped promise must be caught somewhere.
 */
export function fireAndLog(
	promise: Promise<unknown>,
	logger: { error(message: string): void },
	what: string,
): void {
	promise.catch((err) => logger.error(`${what} failed: ${err}`));
}

// --- receiver power state on the deck ---------------------------------------
//
// A receiver in standby answers queries but silently drops sets, and an
// unreachable one does not even do that (measured; see
// tests/fixtures/standby-behaviour-capture.json). Both used to look exactly like
// a working key. The rendering rule, in one place so no render path can differ:
//
//   on       – untouched
//   standby  – the key is drawn asleep (dim image / dim touch strip)
//   offline  – asleep *and* labelled, because it is the more serious case
//
// The decoration is deliberately a pure function of the status rather than a
// separate "show offline" write: every render recomputes it, so nothing can stick
// once the receiver comes back — a failure mode this plugin has already had twice.

/** Title shown while the receiver cannot be reached at all. */
export const OFFLINE_TITLE = "Offline";

/**
 * Opacity values a layout item accepts: the schema allows one decimal only
 * (`@elgato/schemas` `Opacity`), which is worth stating here because this module
 * must not import the SDK to say so.
 */
export type FeedbackOpacity = 0 | 0.1 | 0.2 | 0.3 | 0.4 | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 | 1;

/** Touch-strip opacity for a receiver that is not listening (matches the icons' dim). */
export const DIM_OPACITY: FeedbackOpacity = 0.4;

/**
 * Whether a key steering `command` should look asleep.
 *
 * `PWR` is exempt in standby: it is the one command a sleeping receiver *does*
 * honour, so dimming the Power key would claim the opposite of the truth. When
 * the receiver is unreachable nothing works, power included.
 */
export function isDimmedFor(status: DeviceStatus, command?: string): boolean {
	if (status === "offline") return true;
	if (status === "standby") return command !== "PWR";
	return false;
}

/** The title to show: the real one, or "Offline" when there is nothing to talk to. */
export function statusTitle(base: string | undefined, status: DeviceStatus): string | undefined {
	return status === "offline" ? OFFLINE_TITLE : base;
}

/**
 * The catalog id of an action — which is also its image folder — from the UUID
 * the SDK reports as `manifestId`.
 */
export function actionIdFromManifestId(manifestId: string | undefined): string | undefined {
	if (!manifestId) return undefined;
	const id = manifestId.split(".").pop();
	return id || undefined;
}

/**
 * Key image for a status, or `undefined` to fall back to the manifest image.
 *
 * `undefined` is the lit state on purpose: `setImage(undefined)` restores what the
 * manifest declares, so the normal look needs no asset of its own and a user's own
 * icon keeps working.
 */
export function keyImageFor(
	manifestId: string | undefined,
	status: DeviceStatus,
	command?: string,
	state: 0 | 1 = 0,
): string | undefined {
	const id = actionIdFromManifestId(manifestId);
	if (!id || !isDimmedFor(status, command)) return undefined;
	return keyImagePath(id, state === 1, true);
}

/**
 * The picture a dial's icon slot should hold when nothing special is being shown.
 *
 * A layout item keeps whatever it was last given, so once the plugin has written a
 * cover into the icon slot there is no way to *unset* it — the only way back is to
 * write the original again. That is not hypothetical: the track-change preview left
 * the cover on the touch strip permanently until this existed.
 *
 * Returns `undefined` when the action id cannot be resolved, and callers must then
 * leave the slot untouched rather than blanking it: writing `""` would remove the
 * layout's own icon with no way to restore it.
 */
export function dialIconFor(manifestId: string | undefined, status: DeviceStatus, command?: string): string | undefined {
	const id = actionIdFromManifestId(manifestId);
	if (!id) return undefined;
	// Dimmed in standby/offline for the same reason keys are — the strip should not
	// look livelier than the receiver is.
	return isDimmedFor(status, command) ? keyImagePath(id, false, true) : listIconPath(id);
}

/**
 * Commands a sleeping receiver still acts on — measured, not assumed
 * (`tests/fixtures/standby-behaviour-capture.json`): `PWR` obviously, and `SLI`,
 * because selecting an input powers the unit on by itself.
 *
 * Everything else is swallowed in standby, which is why a press needs either a
 * wake-up first or honest feedback afterwards.
 */
export const STANDBY_HONOURED_COMMANDS: readonly string[] = ["PWR", "SLI"];

/** Whether pressing this key now would visibly do nothing. */
export function pressIsSwallowed(status: DeviceStatus, command: string): boolean {
	return status === "standby" && !STANDBY_HONOURED_COMMANDS.includes(command);
}

/**
 * Whether a press should power the receiver on first. Default on: a key that does
 * nothing is the complaint this whole feature exists for, so opting *out* is the
 * deliberate choice.
 */
export function wakeOnPressEnabled(gs: GlobalSettings = getCachedGlobalSettings()): boolean {
	return gs.wakeOnPress !== false;
}

/** Persist the wake-on-press choice (through the shared funnel; see updateGlobalSettings). */
export function setWakeOnPress(enabled: boolean): Promise<void> {
	return updateGlobalSettings((current) =>
		wakeOnPressEnabled(current) === enabled ? undefined : { ...current, wakeOnPress: enabled },
	);
}

/**
 * Whether the cover may be fetched over HTTP. Default on.
 *
 * Measured worth: in the receiver's data mode one track change is 368-792 frames down
 * the single control connection it allows; over HTTP it is one request on a separate
 * socket, and a cover is available immediately at startup instead of only after the
 * next track change.
 */
export function coverOverHttpEnabled(gs: GlobalSettings = getCachedGlobalSettings()): boolean {
	return gs.coverOverHttp !== false;
}

/** Persist that choice (through the shared funnel; see updateGlobalSettings). */
export function setCoverOverHttp(enabled: boolean): Promise<void> {
	return updateGlobalSettings((current) =>
		coverOverHttpEnabled(current) === enabled ? undefined : { ...current, coverOverHttp: enabled },
	);
}

/**
 * How a dial's touch strip is decorated. Always returns a concrete opacity: the
 * layout keeps whatever it was last given, so "back to normal" has to be stated,
 * not omitted.
 */
export function feedbackStatusStyle(
	status: DeviceStatus,
	command?: string,
): { opacity: FeedbackOpacity; title?: string } {
	const opacity = isDimmedFor(status, command) ? DIM_OPACITY : 1;
	return status === "offline" ? { opacity, title: OFFLINE_TITLE } : { opacity };
}

/**
 * Flat background for the generic toggle's key. A dimmed receiver gets the same
 * colour drawn dark, matching the generated `key-dim.svg` variants.
 */
export function generateColoredBg(color: string, status: DeviceStatus = "on", command?: string): string {
	const fill = isDimmedFor(status, command) ? darkenColor(color, DIM_BG_FACTOR) : color;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="${fill}"/></svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Kept in step with DIM_FACTOR in scripts/generate-icons.ts. */
const DIM_BG_FACTOR = 0.4;

/** Scale a #rrggbb colour toward black; anything unparseable is passed through. */
function darkenColor(hex: string, factor: number): string {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) return hex;
	const channel = (part: string): string =>
		Math.round(Number.parseInt(part, 16) * factor)
			.toString(16)
			.padStart(2, "0")
			.toUpperCase();
	return `#${channel(m[1]!)}${channel(m[2]!)}${channel(m[3]!)}`;
}

export function getToggleColor(command: string, isOn: boolean): string {
	if (!isOn) return "#555555";
	// Mute ON = warning (red), everything else ON = active (green)
	return command === "AMT" ? "#F44336" : "#4CAF50";
}

/**
 * Longest display text decoded from an FLD parameter.
 *
 * A receiver's display is a couple of dozen characters; the cap exists because
 * the parameter itself is unbounded network data, and the decoded text is fed to
 * the name store's regex-based cleanup. Bounding it here keeps that cleanup
 * cheap no matter what arrives — the trailing-run regexes in `stripVolume` are
 * anchored and would otherwise backtrack quadratically on a long crafted string.
 */
export const MAX_DISPLAY_TEXT_LENGTH = 128;

/**
 * Decode the receiver's display-field (FLD) parameter — hex-encoded ASCII — into
 * readable text, e.g. "20445453204E657572616C3A5820" -> "DTS Neural:X".
 * Matches the client's FLD decoding.
 */
export function decodeDisplayText(hex: string): string {
	try {
		// Two hex characters per byte; slice before decoding so an oversized
		// parameter never allocates a large buffer or string.
		const bounded = hex.length > MAX_DISPLAY_TEXT_LENGTH * 2 ? hex.slice(0, MAX_DISPLAY_TEXT_LENGTH * 2) : hex;
		return Buffer.from(bounded, "hex").toString("ascii").trim();
	} catch {
		// Defensive only: Buffer.from(..., "hex") never throws
		// (invalid input yields a truncated/empty buffer).
		return "";
	}
}

export function formatCommandValue(command: string, rawValue: string): string {
	// Try to find a human-readable name from the registry
	const name = getValueName(command, rawValue);
	if (name) return name;

	// For volume-like hex values, convert to decimal
	const cmd = COMMAND_REGISTRY[command];
	if (cmd?.actionType === "stepper") {
		const num = parseInt(rawValue, 16);
		if (!isNaN(num)) return String(num);
	}

	return rawValue;
}

/**
 * Parse a tone readout (TFR/TFW/... "B{xx}T{yy}") into signed bass/treble in the
 * receiver's −10..+10 range. Each token is the receiver's signed text encoding:
 * "00" is zero, otherwise a sign ("+"/"-") followed by one hex nibble 0..A
 * (e.g. "+2" -> +2, "-A" -> −10). Returns undefined if the string isn't a tone
 * readout. The generated registry omits these B{xx}/T{yy} value templates, so
 * the dial actions parse the raw value here rather than via formatCommandValue.
 */
export function parseTone(raw: string): { bass: number; treble: number } | undefined {
	const m = /B([+-][0-9A]|00)T([+-][0-9A]|00)/i.exec(raw);
	if (!m) return undefined;
	// t[1] exists: per the regex, t is either "00" (handled first) or a sign plus one hex digit.
	const dec = (t: string): number => (t === "00" ? 0 : (t[0] === "-" ? -1 : 1) * parseInt(t[1]!, 16));
	// Both capture groups are non-optional, so m[1]/m[2] exist when the regex matched.
	return { bass: dec(m[1]!), treble: dec(m[2]!) };
}

/**
 * Touch-strip feedback for one component of a tone readout: the −10..+10 value
 * mapped to a 0..100 % bar plus its display text ("+n"/"-n"/"0", "—" when the
 * raw value isn't a tone readout). Used by the bass/treble dials.
 */
export function toneFeedback(raw: string, component: "bass" | "treble"): { percent: number; display: string } {
	const tone = parseTone(raw);
	const signed = tone ? tone[component] : undefined;
	const percent = signed === undefined ? 0 : Math.max(0, Math.min(Math.round(((signed + 10) / 20) * 100), 100));
	const display = signed === undefined ? "—" : signed > 0 ? `+${signed}` : String(signed);
	return { percent, display };
}

/** Tuner-preset display label: hex preset number -> "P<n>", unparseable raw stays as-is. */
export function presetLabel(raw: string): string {
	const num = parseInt(raw, 16);
	return Number.isNaN(num) ? raw : `P${num}`;
}

/**
 * Soft-flip inversion for a two-state command without a hardware TG toggle:
 * if the current value reads "on", send the off value; anything else (off,
 * unknown, transitional) turns it on. The "query on cold cache" step stays in
 * the action — this only decides which value to send.
 */
export function nextToggleValue(current: string, cfg: { onValue: string; offValue: string }): string {
	return current === cfg.onValue ? cfg.offValue : cfg.onValue;
}

/**
 * Press-button actions a configurable dial can run on push (chosen in the PI).
 * The receiver may not implement every one — e.g. DIR (Direct) is a no-op on some
 * Pioneer units — so "mute" is the safe default. Mirrored by ui/dial-*.html.
 */
export interface DialPressAction {
	/** eISCP command sent on press. */
	command: string;
	/** Parameter sent on press (TG toggles; an absolute value sets it). */
	param: string;
	/** Raw value of `command` that means "on" — drives the touch-strip overlay. */
	on: string;
	/** Title shown on the touch strip while the press reads on. */
	label: string;
}

export const DIAL_PRESS_ACTIONS: Record<string, DialPressAction> = {
	mute: { command: "AMT", param: "TG", on: "01", label: "MUTED" },
	direct: { command: "DIR", param: "TG", on: "01", label: "DIRECT" },
	stereo: { command: "LMD", param: "00", on: "00", label: "STEREO" },
};

/** Resolve a dial's `pressAction` setting to its press behavior, defaulting to mute. */
export function resolveDialPress(action: string | undefined): DialPressAction {
	// "mute" is a key of the DIAL_PRESS_ACTIONS literal above, so the fallback always exists.
	return DIAL_PRESS_ACTIONS[action ?? "mute"] ?? DIAL_PRESS_ACTIONS.mute!;
}
