/**
 * What a Now Playing dial's settings mean, separated from the action that uses them.
 *
 * Every value here arrives as untyped JSON from a Property Inspector and survives
 * plugin upgrades, so "resolve it to something sensible" is the whole job. It sits in
 * its own file for one reason: `now-playing-dial.ts` imports `@elgato/streamdeck`, and
 * a test may not — the SDK rotates its log files as a module side effect, which races
 * between parallel test processes. The same split as `pi-device-list.ts` and `sweep.ts`.
 *
 * The one type imported from the SDK side is `DialConfig`, and only as a type, so
 * nothing is loaded at runtime.
 */

import type { DialConfig } from "./eiscp-action-base.ts";
import { type EiscpActionSettings, resolveParam } from "./eiscp-base.ts";
import { DEFAULT_SCRIM, MAX_SCRIM, MIN_SCRIM } from "./cover-image.ts";

/**
 * What an unconfigured dial does.
 *
 * Volume and mute, because that is what an encoder next to a receiver is for and it
 * gives the action readout the one value people actually watch. Every other dial in
 * this plugin refuses to bind without a command; this one must not, because its job is
 * the display and a display waiting for a command to be picked shows nothing.
 */
export const DEFAULT_ROTATE_COMMAND = "MVL";
export const DEFAULT_PRESS_COMMAND = "AMT";
export const DEFAULT_PRESS_PARAM = "TG";

/** Seconds the action readout stays up before the track comes back. */
export const DEFAULT_ACTION_SECONDS = 2;
export const MIN_ACTION_SECONDS = 1;
export const MAX_ACTION_SECONDS = 10;

export interface NowPlayingDialSettings extends EiscpActionSettings {
	upParam?: string;
	customUpParam?: string;
	downParam?: string;
	customDownParam?: string;
	pressCommand?: string;
	pressParam?: string;
	customPressParam?: string;
	/** 0…0.8; how far the cover is darkened so the text over it stays readable. */
	scrimOpacity?: number;
	/** Show what a turn or a press did, briefly. On by default. */
	showActionFeedback?: boolean;
	seconds?: number;
	/** Keep the cover behind that readout. On by default. */
	actionOverCover?: boolean;
}

/**
 * Resolve the settings into the rotate/press contract the dial base works from.
 *
 * Never `undefined`, unlike every other dial's version: see the note on the defaults.
 */
export function npDialConfig(settings: NowPlayingDialSettings): DialConfig {
	return {
		command: settings.command || DEFAULT_ROTATE_COMMAND,
		upParam: resolveParam(settings.upParam, settings.customUpParam, "UP"),
		downParam: resolveParam(settings.downParam, settings.customDownParam, "DOWN"),
		pressCommand: settings.pressCommand || DEFAULT_PRESS_COMMAND,
		// `TG` whatever the press command is, matching what the Property Inspector shows.
		// It first defaulted only while the *command* was untouched, and the two then
		// disagreed: choosing a press command left the parameter unset, the panel still
		// read "Toggle (TG)", and the press silently did nothing while the dial still
		// flashed its readout as though it had worked. A toggle the chosen command does
		// not have is refused by the receiver and shows as an alert; a promise the panel
		// never kept shows as nothing at all.
		pressParam: resolveParam(settings.pressParam, settings.customPressParam, DEFAULT_PRESS_PARAM),
	};
}

/** Clamped: a nonsense value must resolve rather than produce a `setTimeout(NaN)`. */
export function readoutSeconds(settings: NowPlayingDialSettings | undefined): number {
	const raw = Number(settings?.seconds);
	if (!Number.isFinite(raw)) return DEFAULT_ACTION_SECONDS;
	return Math.min(MAX_ACTION_SECONDS, Math.max(MIN_ACTION_SECONDS, Math.round(raw)));
}

/** Clamped to the range the Property Inspector offers. */
export function scrimFor(settings: NowPlayingDialSettings | undefined): number {
	const raw = Number(settings?.scrimOpacity);
	if (!Number.isFinite(raw)) return DEFAULT_SCRIM;
	return Math.min(MAX_SCRIM, Math.max(MIN_SCRIM, raw));
}

/** Whether the brief readout after a turn or a press is wanted. On unless switched off. */
export function readoutEnabled(settings: NowPlayingDialSettings | undefined): boolean {
	return settings?.showActionFeedback !== false;
}

/** Whether the cover stays behind that readout. On unless switched off. */
export function readoutKeepsCover(settings: NowPlayingDialSettings | undefined): boolean {
	return settings?.actionOverCover !== false;
}
