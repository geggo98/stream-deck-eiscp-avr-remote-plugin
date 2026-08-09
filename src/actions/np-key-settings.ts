/**
 * What a Now Playing key's settings mean, separated from the action that uses them.
 *
 * Every value here arrives as untyped JSON from a Property Inspector and survives
 * plugin upgrades, so "resolve it to something sensible" is the whole job. It sits in
 * its own file for one reason: `now-playing-key.ts` imports `@elgato/streamdeck`, and a
 * test may not — the SDK rotates its log files as a module side effect, which races
 * between parallel test processes. The same split as `np-dial-settings.ts`.
 *
 * ## What changed, and why the defaults moved
 *
 * The key used to draw the play glyph over the cover and set the track and artist as
 * its title, always and unconditionally. On the deck that leaves very little of the
 * picture: the glyph is half the width of the key and sits in the middle, and the title
 * is drawn over it in the user's own font. The point of the key is the cover, so the
 * decorations now step out of its way — the glyph only when there is nothing else to
 * show, the text only when it has just changed.
 */

import { DEFAULT_SCRIM, MAX_SCRIM, MIN_SCRIM, type ProgressShape } from "./cover-image.ts";
import type { EiscpActionSettings } from "./eiscp-base.ts";
import type { NowPlaying } from "../adapter/eiscp/now-playing.ts";

/** When the play glyph is drawn over the picture. */
export type GlyphMode = "auto" | "always" | "never";
/** When the track and artist are set as the key's title. */
export type TextMode = "onChange" | "always" | "never";
/** How the elapsed fraction is drawn, or that it is not. */
export type ProgressMode = ProgressShape | "off";
/** What a press does. */
export type PressAction = "playPause" | "toggleText";

/** Seconds the track text stays up after a change, in `onChange`. */
export const DEFAULT_TEXT_SECONDS = 5;
export const MIN_TEXT_SECONDS = 1;
export const MAX_TEXT_SECONDS = 60;

export interface NowPlayingKeySettings extends EiscpActionSettings {
	glyphMode?: GlyphMode;
	textMode?: TextMode;
	textSeconds?: number;
	progressStyle?: ProgressMode;
	pressAction?: PressAction;
	/** 0…0.8; how far the cover is darkened. */
	scrimOpacity?: number;
	/**
	 * The old on/off switch for the glyph.
	 *
	 * Read, never written. See `glyphModeFor` for why only `false` survives.
	 */
	showGlyph?: boolean;
}

/**
 * Which glyph mode applies, honouring what an older version stored.
 *
 * `showGlyph: false` was a deliberate choice — "I do not want the glyph" — and is kept
 * as `never`. `showGlyph: true` is **not** read as `always`, because it was also the
 * default: nothing distinguishes a user who wanted the glyph from one who never opened
 * the panel, and treating both as "always" would leave every existing key looking
 * exactly as covered up as it does today, which is the complaint.
 */
export function glyphModeFor(settings: NowPlayingKeySettings | undefined): GlyphMode {
	const mode = settings?.glyphMode;
	if (mode === "always" || mode === "never" || mode === "auto") return mode;
	return settings?.showGlyph === false ? "never" : "auto";
}

/**
 * The glyph to draw over the picture, or `undefined` for none.
 *
 * In `auto` it appears when there is no cover — otherwise the key would be a bare dark
 * square — and when the receiver says playback is **paused or stopped**, which is the
 * one thing a cover on its own cannot express. An unknown play status draws nothing:
 * guessing would put the glyph back over every cover, which is what this is here to
 * stop.
 */
export function glyphFor(settings: NowPlayingKeySettings | undefined, state: NowPlaying | undefined): string | undefined {
	switch (glyphModeFor(settings)) {
		case "never":
			return undefined;
		case "always":
			return "play";
		default:
			if (!state?.art) return "play";
			return state.playStatus === "pause" || state.playStatus === "stop" ? "play" : undefined;
	}
}

export function textModeFor(settings: NowPlayingKeySettings | undefined): TextMode {
	const mode = settings?.textMode;
	return mode === "always" || mode === "never" ? mode : "onChange";
}

/** Clamped: a nonsense value must resolve rather than become a `setTimeout(NaN)`. */
export function textSecondsFor(settings: NowPlayingKeySettings | undefined): number {
	const raw = Number(settings?.textSeconds);
	if (!Number.isFinite(raw)) return DEFAULT_TEXT_SECONDS;
	return Math.min(MAX_TEXT_SECONDS, Math.max(MIN_TEXT_SECONDS, Math.round(raw)));
}

/** Clamped to the range the Property Inspector offers. */
export function scrimFor(settings: NowPlayingKeySettings | undefined): number {
	const raw = Number(settings?.scrimOpacity);
	if (!Number.isFinite(raw)) return DEFAULT_SCRIM;
	return Math.min(MAX_SCRIM, Math.max(MIN_SCRIM, raw));
}

/** The ring unless told otherwise; `undefined` means draw no progress at all. */
export function progressStyleFor(settings: NowPlayingKeySettings | undefined): ProgressShape | undefined {
	const style = settings?.progressStyle;
	if (style === "off") return undefined;
	return style === "bar" ? "bar" : "ring";
}

/** Play/pause unless the key was told to be a text switch instead. */
export function pressActionFor(settings: NowPlayingKeySettings | undefined): PressAction {
	return settings?.pressAction === "toggleText" ? "toggleText" : "playPause";
}

/** What a key currently knows about its own text window. */
export interface TextWindow {
	/** Epoch ms the `onChange` window closes at. */
	until?: number;
	/** Set by a press; overrides everything until the next track change. */
	pinned?: boolean;
}

/**
 * Whether the track text should be on screen right now.
 *
 * The whole rule, in one pure function, because the three inputs interact: a press
 * overrides the mode, the mode overrides the clock, and the clock is only consulted in
 * `onChange`. Keeping it here means the action holds nothing but timers.
 */
export function textIsVisible(mode: TextMode, window: TextWindow, now: number): boolean {
	if (window.pinned !== undefined) return window.pinned;
	if (mode === "always") return true;
	if (mode === "never") return false;
	return window.until !== undefined && now < window.until;
}

/**
 * Everything about a key's drawing situation that is worth a log line — and nothing
 * that is not.
 *
 * The key repaints once a second, so what it records has to be keyed on something that
 * *changes* rarely. This is that key, and the load-bearing part is what it leaves out:
 * **the elapsed time.** Put that in and every tick becomes a log line, which is the one
 * outcome that would make the logs useless for the thing they are there for.
 *
 * Here rather than in the action so it can be tested at all: the action imports the
 * Stream Deck SDK and a test may not.
 */
export function faceLogKey(
	state: Pick<NowPlaying, "art" | "timeDisplay">,
	shape: ProgressShape | undefined,
	scrim: number,
): string {
	return `${state.art?.hash ?? "-"}|${state.timeDisplay}|${shape ?? "off"}|${scrim}`;
}
