/**
 * Shared helpers for eISCP actions
 */

import { COMMAND_REGISTRY, getValueName } from "../adapter/eiscp/command-registry.ts";

export interface EiscpActionSettings {
	deviceIp?: string;
	customIp?: string;
	command?: string;
	/** Configurable dial press action key (see resolveDialPress / ui/dial-*.html). */
	pressAction?: string;
	[key: string]: any;
}

/** JSON-compatible value (mirrors the SDK's JsonValue; undefined is allowed). */
type JsonValue = string | number | boolean | null | undefined | JsonValue[] | { [key: string]: JsonValue };

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
 * Resolve the receiver IP for an action: per-action setting, then the
 * plugin-wide global setting. Returns undefined when nothing is configured —
 * deliberately no hardcoded fallback, so an unconfigured action never sends
 * commands to somebody else's LAN. Callers must degrade visibly instead.
 */
export function resolveDeviceIp(settings: EiscpActionSettings): string | undefined {
	if (settings.deviceIp && settings.deviceIp !== "custom") {
		return settings.deviceIp;
	}
	if (settings.customIp) {
		return settings.customIp;
	}
	return getCachedGlobalSettings().deviceIp || undefined;
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
 * Decode the receiver's display-field (FLD) parameter — hex-encoded ASCII — into
 * readable text, e.g. "20445453204E657572616C3A5820" -> "DTS Neural:X".
 * Matches the client's FLD decoding.
 */
export function decodeDisplayText(hex: string): string {
	try {
		return Buffer.from(hex, "hex").toString("ascii").trim();
	} catch {
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
	const dec = (t: string): number => (t === "00" ? 0 : (t[0] === "-" ? -1 : 1) * parseInt(t[1], 16));
	return { bass: dec(m[1]), treble: dec(m[2]) };
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
	return DIAL_PRESS_ACTIONS[action ?? "mute"] ?? DIAL_PRESS_ACTIONS.mute;
}
