/**
 * What one cooperating touch-strip panel draws.
 *
 * `strip-group.ts` decides *which* part of the display a dial is responsible for;
 * this turns that decision plus the receiver's state into concrete content — which
 * layout items are on, what stands in them, at what size.
 *
 * Two things it deliberately is not:
 *
 *   - **It does not send anything.** It returns a plain object and
 *     `DialActionBase.sendFeedback` maps it onto `layouts/np-panel.json`. Same split as
 *     `track-overlay.ts`, and for the same reason: this file has to stay free of
 *     `@elgato/streamdeck` so its tests can be too (importing the SDK rotates its log
 *     files as a module side effect, which races between parallel test processes).
 *   - **It does not build markup.** The cover arrives as an already-composed data URI
 *     from `composeCoverImage`; titles and artists go into layout text items, which
 *     Stream Deck renders and escapes itself. No string off the wire is ever
 *     interpolated into an `<svg>` here — see the note in `cover-image.ts`.
 *
 * ## Why a panel can decline
 *
 * `passive` says "this dial keeps its own face". It is not a failure path: a group can
 * be wider than the receiver has text (a one-word title with no artist and no album),
 * and the alternatives are both worse — cutting a word in half, or leaving a blank
 * panel in the middle of a row, which reads as a crash rather than as a layout.
 *
 * ## Two faces, and why only one of them has a progress bar
 *
 * `buildPanelFace` is the **cooperating** display: a few seconds after a track change,
 * shared across adjacent dials. `buildNowPlayingFace` is the **permanent** one a single
 * Now Playing dial wears. They produce the same `PanelFace` and land on the same layout,
 * but they disagree about the clock, and deliberately so.
 *
 * The short display had both, and both were wrong on the hardware. It freezes the state
 * at the moment of the change, and at that moment the receiver's elapsed time is still
 * the **previous** track's. `NTM` ticks once a second, so waiting does not help; asking
 * for it did not either, which was measured rather than assumed — the unit has nothing
 * useful to give that early. A bar showing where the last song had got to is worse than
 * no bar at all, and it is barely worth having anyway: a track that has just started is
 * at zero.
 *
 * A permanent display is the opposite case — it is the one thing there that changes —
 * so it is the one that fills `time` and `progress`. `panelItems` switches them off for
 * everyone who leaves them unset, exactly like everything else it is not using.
 */

import type { NowPlaying } from "../adapter/eiscp/now-playing.ts";
import type { CropFocus } from "./face-crop.ts";
import {
	DEFAULT_SCRIM,
	PANEL_TEXT_LINES,
	PANEL_TEXT_WIDTH,
	STRIP_HEIGHT,
	STRIP_SEGMENT_WIDTH,
} from "./cover-image.ts";
import type { StripAssignment, StripRole } from "./strip-group.ts";
import { fitLines, PANEL_FONT_SIZE_LADDER, splitTextAcross } from "./text-fit.ts";
import { buildOverlayFace, overlayTexts, type OverlayFaceOptions } from "./track-overlay.ts";

/** Path of the layout that carries both faces, relative to the plugin folder. */
export const PANEL_LAYOUT = "layouts/np-panel.json";

/** A layout bar's full-scale value; `np-panel.json` declares no `range`, so it is the default. */
const BAR_FULL = 100;

/**
 * Darkest the cover is allowed to be behind the brief action readout.
 *
 * The permanent face puts a 24 px bold title over the art, which the user's own scrim
 * setting is chosen for. The readout puts an 18 px value and a thin bar there instead,
 * and those need more help — so the setting is a floor to raise, not a value to obey.
 * Estimated, not measured: it is the one number here that a bright cover can disprove.
 */
export const ACTION_SCRIM_FLOOR = 0.6;

/**
 * The layout's items and what kind each one is.
 *
 * The kind is not decoration: a `bar` takes a number and a `text` takes a string, and
 * the two are indistinguishable once they are in a `FeedbackPayload`. Keeping it here
 * lets `panelItems` be checked against the layout rather than trusted.
 */
const PANEL_ITEM_KINDS = { cover: "pixmap", line1: "text", line2: "text", time: "text", progress: "bar" } as const;

/**
 * Items the dial's own face uses; hidden while the panel is up.
 *
 * Both lists are written out in full on every send, in both directions. That is not
 * belt and braces: a layout item keeps whatever it was last given, so there is no way
 * to *unset* one — leaving an item out is how a cover once stuck to a touch strip for
 * good. The way back has to be said as plainly as the way there.
 *
 * The dial's label is keyed **`label`, not `title`**, and that is load-bearing. A text
 * item keyed `title` is special: Stream Deck binds it to the action's own title
 * property, styles it from the user's Property Inspector settings and keeps it
 * rendered — `enabled: false` in a feedback payload does not take it away. Measured on
 * a real Stream Deck +: the dial's own label stayed on screen underneath the panel
 * text and the two were unreadable on top of each other.
 */
const NORMAL_ITEM_KINDS = { icon: "pixmap", label: "text", value: "text", indicator: "bar" } as const;

/**
 * Where a `buildFeedback` payload's `title` goes on the panel layout.
 *
 * The implementations all speak the built-in layouts' vocabulary, so the rename is
 * absorbed at the boundary rather than pushed into every dial.
 */
export const PANEL_TITLE_KEY = "label";

/** Items only the panel display uses; hidden the rest of the time. */
export const PANEL_ITEM_KEYS = Object.keys(PANEL_ITEM_KINDS) as (keyof typeof PANEL_ITEM_KINDS)[];
export const NORMAL_ITEM_KEYS = Object.keys(NORMAL_ITEM_KINDS) as (keyof typeof NORMAL_ITEM_KINDS)[];

/** One rendered line of a panel, with the size the fitter settled on. */
export interface PanelLine {
	text: string;
	fontSize: number;
}

export interface PanelFace {
	/** Full-bleed cover as a data URI; absent on a text panel. */
	cover?: string;
	/** Wide text lines, top to bottom. At most `PANEL_TEXT_LINES`. */
	lines: PanelLine[];
	/**
	 * True when this dial takes no part in the group display this time round and
	 * should keep its own face.
	 */
	passive: boolean;
	/** Elapsed/total as `1:08/3:41`. Only a permanent display sets it; see the header. */
	time?: string;
	/** How far through the track, 0…1. Same condition as `time`. */
	progress?: number;
	/**
	 * Where the crop was placed, when the cover had to be cropped at all.
	 *
	 * Carried so the dial can log the decision. Only the permanent face sets it: the
	 * cooperating panels fit the whole picture rather than cropping it.
	 */
	focus?: CropFocus;
	/**
	 * Draw the dial's own icon, label, value and bar **on top of** this face.
	 *
	 * The one case where the two faces are not exclusive: a Now Playing dial that has
	 * just been turned shows what the turn did, with the cover left standing behind it.
	 * Everything else is all-or-nothing, and `sendFeedback` reads this to decide which.
	 */
	withOwnFace?: boolean;
}

export interface PanelFaceOptions {
	/** Usable text width inside the panel; defaults to the layout's own. */
	width?: number;
	/** Lines the layout offers; defaults to the layout's own. */
	maxLines?: number;
	/** Passed through to the cover composition. */
	scrimOpacity?: number;
}

const PASSIVE: PanelFace = { lines: [], passive: true };

/** Roles that carry the picture. Exactly one per group, plus the lone-dial case. */
function showsCover(role: StripRole): boolean {
	return role === "cover" || role === "all";
}

/** The string a text role is responsible for, before any splitting. */
function textForRole(state: NowPlaying, role: StripRole): string | undefined {
	const { primary } = overlayTexts(state);
	if (role === "title") return primary;
	if (role === "artist") return state.artist;
	if (role === "album") return state.album;
	return undefined;
}

/**
 * What one layout item is to be set to. Mapped onto a `FeedbackPayload` by the caller.
 *
 * Discriminated so a bar's numeric value and a text's string can never be swapped —
 * they are the same field name in the payload, and Stream Deck simply ignores the one
 * it cannot use.
 */
export type PanelItem =
	| { kind: "text"; enabled: boolean; value?: string; font?: { size: number } }
	| { kind: "pixmap"; enabled: boolean; value?: string }
	| { kind: "bar"; enabled: boolean; value?: number };

/**
 * Turn a face into the layout items that express it.
 *
 * Every key of both lists appears in the result every time, so the two faces cannot
 * bleed into each other: switching to the panel display says "the icon is off" as
 * explicitly as it says "the cover is on".
 */
export function panelItems(face: PanelFace): Record<string, PanelItem> {
	const items: Record<string, PanelItem> = {};
	for (const [key, kind] of Object.entries(PANEL_ITEM_KINDS)) items[key] = { kind, enabled: false };
	for (const [key, kind] of Object.entries(NORMAL_ITEM_KINDS)) {
		// Hidden text is also blanked, not merely switched off. `enabled` is one
		// mechanism and the caller adds `opacity: 0` as a second, but neither is worth
		// betting a legible display on: an empty string cannot overlap anything even if
		// both are ignored. Not the pixmap — `""` there would clear the layout's own
		// icon with no way back (see `sendFeedback`).
		items[key] =
			kind === "text" && !face.passive ? { kind, enabled: false, value: "" } : { kind, enabled: face.passive };
	}
	if (face.passive) return items;

	if (face.cover) items["cover"] = { kind: "pixmap", enabled: true, value: face.cover };
	const [first, second] = face.lines;
	if (first) items["line1"] = { kind: "text", enabled: true, value: first.text, font: { size: first.fontSize } };
	if (second) items["line2"] = { kind: "text", enabled: true, value: second.text, font: { size: second.fontSize } };
	if (face.time !== undefined) items["time"] = { kind: "text", enabled: true, value: face.time };
	// A layout bar reads 0…100 unless it declares a `range`, and `np-panel.json` does
	// not. The face speaks in fractions because that is what `overlayProgress` means;
	// the conversion belongs here, where the layout's units are known.
	if (face.progress !== undefined) {
		items["progress"] = { kind: "bar", enabled: true, value: Math.round(face.progress * BAR_FULL) };
	}
	return items;
}

/**
 * Drop the cover's picture when the strip already has that exact one.
 *
 * Returns what the caller should remember for next time. Only the `value` goes;
 * `enabled` and `opacity` are still said on every send, because those are what switch
 * the face and dim it. A layout item keeping whatever it was last given is usually the
 * hazard around here and for once is the mechanism: re-enabled without a value, the item
 * comes back with the picture it already had.
 *
 * Worth its own function rather than four lines at the call site, because both ways of
 * getting it wrong are expensive: send the picture every time and a permanent display
 * puts ~173 KB per second through the socket; suppress one that was actually needed and
 * the strip goes blank with nothing in any log.
 */
export function dedupeCover(items: Record<string, unknown>, previous: string | undefined): string | undefined {
	const item = items["cover"];
	if (typeof item !== "object" || item === null) return previous;
	const rest = { ...item } as Record<string, unknown>;
	const value = rest["value"];
	// No picture in this payload says nothing about what is on screen — the item may
	// simply be switched off — so the memory stands.
	if (typeof value !== "string") return previous;
	if (value !== previous) return value;
	delete rest["value"];
	items["cover"] = rest;
	return previous;
}

/**
 * Two strings that belong on their own lines (title above artist).
 *
 * Fitted separately but drawn at one size — the smaller of the two — because two
 * lines of the same block at different sizes reads as a rendering fault rather than
 * as emphasis.
 */
function fitSeparateLines(strings: readonly string[], width: number, maxLines: number): PanelLine[] {
	const fits = strings.slice(0, maxLines).map((text) => fitLines(text, width, 1));
	const fontSize = Math.min(...fits.map((f) => f.fontSize));
	return fits.map((f) => ({ text: f.lines[0] ?? "", fontSize }));
}

/** One string wrapped over the lines the panel has. */
function fitOneString(text: string, width: number, maxLines: number): PanelLine[] {
	const fitted = fitLines(text, width, maxLines);
	return fitted.lines.map((line) => ({ text: line, fontSize: fitted.fontSize }));
}

/**
 * Build the face for one panel.
 *
 * `undefined` is never returned: a dial that is a member of a group always gets an
 * answer, and "nothing to show" is expressed as `passive` so the caller has one code
 * path rather than two.
 */
export function buildPanelFace(
	state: NowPlaying,
	assignment: StripAssignment,
	options: PanelFaceOptions = {},
): PanelFace {
	const width = options.width ?? PANEL_TEXT_WIDTH;
	const maxLines = options.maxLines ?? PANEL_TEXT_LINES;
	const { role } = assignment;
	if (role === "none") return PASSIVE;

	const faceOptions: OverlayFaceOptions = {
		width: STRIP_SEGMENT_WIDTH,
		height: STRIP_HEIGHT,
		// A 200x100 segment against square album art: cropping to fill would show only
		// the middle band of the cover, so the whole picture is fitted instead and the
		// backdrop shows either side of it.
		fit: "contain",
		...(options.scrimOpacity !== undefined ? { scrimOpacity: options.scrimOpacity } : {}),
	};
	// Only the cover roles pay for the composition; `buildOverlayFace` shares and
	// caches it per transfer, so the one panel that needs it composes once for the
	// whole group. Its time and progress are ignored here — see the note on `PanelFace`.
	const composed = showsCover(role) ? buildOverlayFace(state, faceOptions) : undefined;
	if (showsCover(role) && !composed) return PASSIVE;

	const lines: string[] = [];
	if (role === "text" || role === "all") {
		const { primary, secondary } = overlayTexts(state);
		if (primary) lines.push(primary);
		if (secondary) lines.push(secondary);
	} else if (role !== "cover") {
		const whole = textForRole(state, role);
		// A part index only ever comes with a count above one (see `assignRoles`), so
		// this is the "several panels share this string" case.
		const part = assignment.textPart ? splitTextAcross(whole ?? "", assignment.textPart.count)[assignment.textPart.index] : whole;
		if (part) lines.push(part);
	}

	// A text panel with nothing in it would be a blank segment in the middle of the
	// row. Defensive: `planPanels` only hands out roles it has text for, but the
	// plan and the state are read at different moments.
	if (!showsCover(role) && lines.length === 0) return PASSIVE;

	const rendered = lines.length > 1 ? fitSeparateLines(lines, width, maxLines) : fitOneString(lines[0] ?? "", width, maxLines);

	return {
		...(composed?.image !== undefined ? { cover: composed.image } : {}),
		lines: rendered,
		passive: false,
	};
}

export interface NowPlayingFaceOptions {
	/** Usable text width inside the segment; defaults to the layout's own. */
	width?: number;
	/** 0…0.8, how far the cover is darkened so the text over it stays readable. */
	scrimOpacity?: number;
	/**
	 * Build the face for the brief readout after a turn or a press instead: the cover
	 * stays as a backdrop and the dial's own face goes on top of it.
	 */
	actionReadout?: boolean;
	/** Move the crop so it does not run through a face. */
	keepFacesWhole?: boolean;
}

/**
 * Title above artist, with the title the louder of the two.
 *
 * Unlike `fitSeparateLines` — which brings both to one size because two lines of the
 * *same* block at different sizes reads as a fault — this is a heading and a subheading,
 * so the artist starts one rung down the ladder and can never overtake the title.
 */
function fitStacked(primary: string, secondary: string, width: number): PanelLine[] {
	const lines: PanelLine[] = [];
	let titleSize = PANEL_FONT_SIZE_LADDER[0]!;
	if (primary) {
		const fitted = fitLines(primary, width, 1);
		titleSize = fitted.fontSize;
		lines.push({ text: fitted.lines[0] ?? "", fontSize: fitted.fontSize });
	}
	if (secondary) {
		const fitted = fitLines(secondary, width, 1, { sizes: PANEL_FONT_SIZE_LADDER.slice(1) });
		// Never larger than the title. A long title shrinks down the ladder while a short
		// artist stays where it started, and the two would end up the wrong way round —
		// which reads as the artist being the important one. Shrinking a line that already
		// fits can only make it fit again.
		lines.push({ text: fitted.lines[0] ?? "", fontSize: Math.min(fitted.fontSize, titleSize) });
	}
	return lines.filter((line) => line.text !== "");
}

/**
 * Build the face a Now Playing dial wears, or `undefined` when there is nothing to wear.
 *
 * `undefined` is the load-bearing case, not an error path: a receiver on the radio, or
 * one sitting on a menu, has no track and no art, and a dial that went black for it
 * would look broken. The caller falls back to the dial's ordinary face, which still
 * shows the volume or the input it is set to.
 *
 * The cover fills the segment (`fit: "cover"`) rather than fitting inside it. That is
 * the opposite of `buildPanelFace` and for the opposite reason: there the picture *is*
 * the content and must not be cropped, here it is the backdrop behind four lines of
 * text, and letterboxing a backdrop leaves black bars down both sides.
 */
export function buildNowPlayingFace(state: NowPlaying, options: NowPlayingFaceOptions = {}): PanelFace | undefined {
	const width = options.width ?? PANEL_TEXT_WIDTH;
	const wanted = options.scrimOpacity ?? DEFAULT_SCRIM;
	const composed = buildOverlayFace(state, {
		width: STRIP_SEGMENT_WIDTH,
		height: STRIP_HEIGHT,
		fit: "cover",
		scrimOpacity: options.actionReadout ? Math.max(wanted, ACTION_SCRIM_FLOOR) : wanted,
		// This is the one face in the plugin where a square cover is cropped to a strip, so
		// it is the only one with a crop to place.
		...(options.keepFacesWhole ? { keepFacesWhole: true } : {}),
	});
	if (!composed) return undefined;
	// Only a real cover becomes the backdrop. `buildOverlayFace` substitutes a music
	// glyph when there is none, which is right for a key that would otherwise be blank
	// and wrong here — a glyph behind the title is clutter, and black is not.
	const cover = state.art ? composed.image : undefined;

	if (options.actionReadout) {
		// Nothing but the picture: `sendFeedback` writes the dial's own items over it.
		// With no cover there is nothing to keep, so the dial shows its ordinary face and
		// this returns nothing rather than an empty one.
		return cover !== undefined ? { cover, lines: [], passive: false, withOwnFace: true } : undefined;
	}

	const { primary, secondary } = overlayTexts(state);
	const lines = fitStacked(primary ?? "", secondary, width);
	if (lines.length === 0 && cover === undefined) return undefined;

	return {
		...(cover !== undefined ? { cover } : {}),
		lines,
		passive: false,
		...(composed.time !== undefined ? { time: composed.time } : {}),
		...(composed.progress !== undefined ? { progress: composed.progress } : {}),
		...(composed.focus !== undefined ? { focus: composed.focus } : {}),
	};
}
