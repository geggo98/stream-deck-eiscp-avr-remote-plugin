/**
 * Shared helpers for eISCP actions
 */

import { isIP } from "node:net";

import { COMMAND_REGISTRY, getValueName } from "../adapter/eiscp/command-registry.ts";

/** JSON-compatible value (mirrors the SDK's JsonValue; undefined is allowed). */
type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };

export interface EiscpActionSettings {
	deviceIp?: string;
	customIp?: string;
	command?: string;
	/** Configurable dial press action key (see resolveDialPress / ui/dial-*.html). */
	pressAction?: string;
	// JsonValue (not any) keeps SDK compatibility while forcing every access
	// to an undeclared key through a real type check — the get*Config hooks
	// are the parse/validate boundary for the untyped PI JSON.
	[key: string]: JsonValue;
}

/** Learned option names, persisted in global settings: host -> command -> code -> name. */
export type SerializedNames = { [host: string]: { [command: string]: { [code: string]: string } } };

/** Plugin-wide persisted settings (Stream Deck global settings). */
export interface GlobalSettings {
	deviceIp?: string;
	names?: SerializedNames;
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

export function generateColoredBg(color: string): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144"><rect width="144" height="144" fill="${color}"/></svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
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
