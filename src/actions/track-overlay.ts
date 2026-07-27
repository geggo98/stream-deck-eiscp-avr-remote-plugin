/**
 * The short "here is what just started playing" display that any element can show.
 *
 * Every action can opt in (off by default): on a **track change** it replaces its
 * normal face for a few seconds and then falls back. Deliberately not on progress —
 * `NTM` ticks once a second, and a display that re-triggered on it would never go
 * away again.
 *
 * This module is the pure half: what the replacement face looks like, and the two
 * settings that govern it. The timer and the render interception live in
 * `EiscpActionBase`, where the existing paint funnels are.
 *
 * ## Why it is a snapshot
 *
 * The face is built once when the change arrives and then left alone until it
 * expires. That is what "only on a track change, not on progress" means in practice,
 * and it is also what makes the feature affordable: eight configured keys repainting
 * a ~173 KB composed cover once per track is fine, once per second is not. The
 * caller composes the image **once per track change** and hands the same string to
 * every element.
 */

import type { DeviceStatus } from "../adapter/eiscp/device-status.ts";
import type { NowPlaying } from "../adapter/eiscp/now-playing.ts";
import { composeCoverImage, composePlaceholder, type CoverSlice } from "./cover-image.ts";

/** Seconds the replacement face stays up. */
export const DEFAULT_TRACK_CHANGE_SECONDS = 5;
export const MIN_TRACK_CHANGE_SECONDS = 1;
export const MAX_TRACK_CHANGE_SECONDS = 60;

/** Per-action settings, present in every Property Inspector. */
export interface TrackOverlaySettings {
	/** Off by default: this changes what every other key looks like. */
	showOnTrackChange?: boolean;
	trackChangeSeconds?: number;
}

export function trackOverlayEnabled(settings: TrackOverlaySettings | undefined): boolean {
	return settings?.showOnTrackChange === true;
}

/**
 * The configured duration, clamped.
 *
 * Settings are user text and survive plugin upgrades, so a nonsense value has to
 * resolve to something rather than produce a `setTimeout(NaN)` — which fires
 * immediately and would make the display flicker instead of showing.
 */
export function trackOverlaySeconds(settings: TrackOverlaySettings | undefined): number {
	const raw = Number(settings?.trackChangeSeconds);
	if (!Number.isFinite(raw)) return DEFAULT_TRACK_CHANGE_SECONDS;
	return Math.min(MAX_TRACK_CHANGE_SECONDS, Math.max(MIN_TRACK_CHANGE_SECONDS, Math.round(raw)));
}

/**
 * Whether the short display should be drawn right now.
 *
 * Extracted from `EiscpActionBase` so the two rules that govern it are testable:
 * that file imports the Stream Deck SDK, and tests here must stay free of it (the
 * SDK rotates its log files as an import side effect, which races between parallel
 * test processes).
 *
 * **Status beats metadata.** An unreachable receiver has to keep saying `Offline`,
 * and nothing plays in standby, so the overlay only applies while the receiver is
 * actually on — evaluated on every render rather than once at trigger time, so a
 * receiver that disappears mid-overlay stops showing it at once.
 */
export function overlayIsActive(until: number | undefined, now: number, status: DeviceStatus): boolean {
	if (until === undefined) return false;
	if (now >= until) return false;
	return status === "on";
}

export interface OverlayFace {
	/** Composed image; absent only when the art was over budget and there is no glyph. */
	image?: string;
	/** The track, or the best stand-in we have. */
	primary: string;
	/** Artist, falling back to the album. */
	secondary: string;
	/** Two lines, for a key title. */
	keyTitle: string;
	/** Elapsed/total as `1:08/3:41`, when the receiver says the time means anything. */
	time?: string;
	/** 0…1 for a progress bar, on the same condition. */
	progress?: number;
}

export interface OverlayFaceOptions {
	width?: number;
	height?: number;
	slice?: CoverSlice;
	scrimOpacity?: number;
	/** Glyph drawn over the art; omit for none. */
	glyph?: string;
}

/** `68` -> `1:08`, `3800` -> `1:03:20`. */
export function formatTime(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const hh = Math.floor(s / 3600);
	const mm = Math.floor((s % 3600) / 60);
	const ss = s % 60;
	const pad = (n: number): string => String(n).padStart(2, "0");
	return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

/**
 * How far through the track we are, or `undefined`.
 *
 * Gated on the receiver's own statement (`NMS` field `t`) rather than on the numbers
 * being present: with the time display disabled the values are meaningless, and a
 * bar drawn from them would be confidently wrong. `--:--` already arrives as absent
 * (see `parseTimeInfo`), so this only has to reject the "not meaningful" case and
 * division by zero.
 */
export function overlayProgress(state: NowPlaying): number | undefined {
	if (state.timeDisplay !== "elapsed-total") return undefined;
	const { elapsed, total } = state;
	if (elapsed === undefined || total === undefined || total <= 0) return undefined;
	return Math.min(1, Math.max(0, elapsed / total));
}

/**
 * Composed images, shared across every element showing the same cover.
 *
 * One track change notifies every configured element at once, and each was composing
 * its own copy: for a 97 KB cover that is two base64 passes over ~100 and ~260 KB, per
 * element, at the exact moment the receiver is streaming ~1 800 frames a second at us.
 * With eight keys that is eight times the work and eight times the garbage for eight
 * byte-identical strings.
 *
 * Keyed on the art's `Buffer` identity because the tracker hands the *same* `ArtImage`
 * object to every listener, and held weakly so a superseded cover is collected with
 * the transfer it came from. The inner key is the composition options, since a key
 * (144x144, with glyph) and a strip (200x100) legitimately differ.
 */
const composedByArt = new WeakMap<Buffer, Map<string, string | undefined>>();

function composeShared(art: NonNullable<NowPlaying["art"]>, options: OverlayFaceOptions): string | undefined {
	let byOptions = composedByArt.get(art.bytes);
	if (!byOptions) {
		byOptions = new Map();
		composedByArt.set(art.bytes, byOptions);
	}
	const key = `${options.width ?? ""}x${options.height ?? ""}|${options.glyph ?? ""}|${options.scrimOpacity ?? ""}|${options.slice?.index ?? ""}/${options.slice?.count ?? ""}`;
	if (byOptions.has(key)) return byOptions.get(key);

	const composed = composeCoverImage({
		art,
		glyph: options.glyph,
		scrimOpacity: options.scrimOpacity,
		slice: options.slice,
		width: options.width,
		height: options.height,
	});
	byOptions.set(key, composed);
	return composed;
}

/**
 * Build the replacement face, or `undefined` when there would be nothing to show.
 *
 * Returning `undefined` matters: an element that hid its own useful content behind
 * an empty box would be strictly worse than one that did nothing. So a track change
 * with no text and no art produces no overlay at all.
 */
export function buildOverlayFace(state: NowPlaying, options: OverlayFaceOptions = {}): OverlayFace | undefined {
	const primary = state.track ?? state.artist ?? state.album;
	const hasText = primary !== undefined;
	if (!hasText && !state.art) return undefined;

	const secondary = state.track ? (state.artist ?? state.album ?? "") : (state.album ?? "");
	const progress = overlayProgress(state);
	const time =
		progress !== undefined && state.elapsed !== undefined && state.total !== undefined
			? `${formatTime(state.elapsed)}/${formatTime(state.total)}`
			: undefined;

	// Over budget the composer returns undefined; fall back to the placeholder so the
	// element still says "something is playing" rather than going blank.
	const composed = state.art ? composeShared(state.art, options) : undefined;
	const image =
		composed ?? composePlaceholder({ glyph: options.glyph ?? "music", width: options.width, height: options.height });

	return {
		image,
		primary: primary ?? "",
		secondary,
		keyTitle: [primary ?? "", secondary].filter(Boolean).join("\n"),
		time,
		progress,
	};
}
