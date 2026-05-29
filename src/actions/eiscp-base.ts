/**
 * Shared helpers for eISCP actions
 */

import { streamDeck } from "@elgato/streamdeck";
import { COMMAND_REGISTRY, getValueName } from "../adapter/eiscp/command-registry.ts";

export interface EiscpActionSettings {
	deviceIp?: string;
	customIp?: string;
	command?: string;
	[key: string]: any;
}

interface GlobalSettings {
	deviceIp?: string;
}

export function resolveParam(value: string | undefined, customValue: string | undefined, fallback: string): string;
export function resolveParam(value?: string, customValue?: string, fallback?: string): string | undefined;
export function resolveParam(value?: string, customValue?: string, fallback?: string): string | undefined {
	if (!value) return fallback;
	if (value === "custom") return customValue || fallback;
	return value;
}

export function resolveDeviceIp(settings: EiscpActionSettings): string {
	if (settings.deviceIp && settings.deviceIp !== "custom") {
		return settings.deviceIp;
	}
	if (settings.customIp) {
		return settings.customIp;
	}
	const global = streamDeck.settings.getGlobalSettings() as GlobalSettings;
	return global.deviceIp || "10.2.0.32";
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
