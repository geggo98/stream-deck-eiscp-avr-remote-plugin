/**
 * Compose what a key or a touch strip shows when the receiver's cover art is
 * involved: the art as a background, an optional darkening scrim, and an optional
 * glyph on top — all as one image.
 *
 * Pure and SDK-free, so the composition is testable without a Stream Deck.
 *
 * ## What the hardware actually accepts
 *
 * Every rule below was established by probing a throwaway action on a real Stream
 * Deck +, because none of it is documented and one part of the documentation is
 * wrong. Four variants of the same picture, one axis changed at a time:
 *
 * | wrapping        | image reference   | renders |
 * |-----------------|-------------------|---------|
 * | data URI        | xlink:href + href | yes     |
 * | data URI        | href only         | **yes** |
 * | raw SVG string  | xlink:href + href | no      |
 * | raw SVG string  | href only         | no      |
 *
 * So:
 *
 *   - **The SVG must be wrapped in a base64 data URI.** `setImage`'s documentation
 *     says a plain SVG string is accepted; for a composed image it is not, and the
 *     failure is silent — the key falls back to its manifest icon, which looks like
 *     "the plugin forgot to paint" rather than "the payload was rejected".
 *   - **`xlink:href` is unnecessary**, and leaving it out matters: it appears once
 *     per image reference, so a duplicate reference doubles the whole payload.
 *     Measured for the same 97 KB cover: 346 KB with both attributes, 173 KB with
 *     `href` alone.
 *   - A nested `<image href="data:image/jpeg;base64,…">` does render, which is what
 *     makes layering possible at all — native image libraries are out of reach
 *     (Rollup bundles the plugin into a single file), so an SVG wrapper is the only
 *     way to get two layers into one key image.
 *
 * ## The one security rule
 *
 * The cover is device-controlled and enters **only** as base64 inside an attribute
 * value — never as markup, and never as text. Nothing here interpolates a string
 * that came off the wire: titles and artists go to `setTitle` or to layout text
 * items, which escape them, not into an `<svg>` this module builds. The glyph markup
 * *is* interpolated, and that is safe because it comes from the build-time generated
 * `glyphs.ts`, not from the receiver.
 */

import type { ArtImage } from "../adapter/eiscp/jacket-art.ts";
import { GLYPHS } from "./generated/glyphs.ts";

/** Stream Deck key images are square; the repo draws at @2x. */
export const KEY_SIZE = 144;
/**
 * One touch-strip segment, in layout units.
 *
 * The strip is physically continuous — verified on a Stream Deck + by looking at a
 * background image that spans all four segments: it runs across the boundaries with
 * no visible offset. So slices for adjacent dials sit on exact multiples of this,
 * with no bezel correction. That is a device property rather than a documented
 * guarantee, which is why it is one named constant and not a number spread around.
 */
export const STRIP_SEGMENT_WIDTH = 200;
export const STRIP_HEIGHT = 100;

/**
 * The text geometry of one cooperating panel (`layouts/np-panel.json`).
 *
 * Here rather than next to the planner because it describes the strip, like the two
 * constants above, and because both the planner (how many panels a title needs) and the
 * renderer (how large to set the type) have to agree on it — a disagreement would show
 * up as text that spills onto a second panel and then still gets clipped.
 */
export const PANEL_TEXT_WIDTH = STRIP_SEGMENT_WIDTH - 12;
/** `line1` + `line2`; a third line at a readable size does not fit under them. */
export const PANEL_TEXT_LINES = 2;
/**
 * The size below which another panel beats smaller type.
 *
 * Not the bottom of `FONT_SIZE_LADDER`: that ladder was picked for the cramped built-in
 * layouts, where shrinking was the only option. With panels to hand the order is spread
 * first, shrink second, clip last — so this is the point at which spreading wins, not
 * the point at which text becomes unreadable.
 */
export const PANEL_PREFERRED_FONT_SIZE = 20;

/**
 * Largest composed image we will hand to Stream Deck.
 *
 * Measured cost for a real 97 KB cover is 173 KB, so this is ~3x headroom. It exists
 * because the size is ultimately the receiver's choice: `MAX_ART_BYTES` allows a
 * 512 KB image, which composes to roughly 900 KB, and a track change can repaint
 * every configured key at once. Over budget we draw the placeholder instead —
 * visibly "no cover" rather than silently nothing.
 */
export const MAX_RENDER_BYTES = 512 * 1024;

/** Scrim range offered to users. 0 keeps the art untouched; 0.8 is nearly black. */
export const MIN_SCRIM = 0;
export const MAX_SCRIM = 0.8;
export const DEFAULT_SCRIM = 0.45;

const GLYPH_STROKE = "#FFFFFF";
/** Backdrop when there is no art to show. Matches the generated key images. */
const PLACEHOLDER_BG = "#1A1A1A";

export interface CoverSlice {
	/** Which segment this instance draws, left to right. */
	index: number;
	/** How many adjacent segments share the picture. */
	count: number;
}

/**
 * How the art fills its box when the two shapes disagree.
 *
 * `cover` crops to fill, `contain` fits the whole picture and leaves the rest of the
 * box showing. A square key never sees the difference; a 200x100 strip segment with a
 * square cover very much does — `cover` there would show only the middle band of the
 * artwork, which is where the title usually is not.
 */
export type CoverFit = "cover" | "contain";

export interface ComposeOptions {
	/** The assembled cover; absent means "draw the placeholder". */
	art?: ArtImage;
	/** Lucide glyph name to draw on top. Omit for art only. */
	glyph?: string;
	/** 0…0.8; clamped. Ignored when there is no art (the placeholder needs no scrim). */
	scrimOpacity?: number;
	/** Spread one picture across adjacent touch strips. */
	slice?: CoverSlice;
	width?: number;
	height?: number;
	/** Defaults to `cover`, which is what a square key wants. */
	fit?: CoverFit;
}

/**
 * Intrinsic size of the art, from its own header.
 *
 * Needed because **`preserveAspectRatio` cannot be relied on**: Stream Deck renders
 * with Qt, whose SVG support is partial, and a nested `<image>` came out stretched to
 * the box on a real Stream Deck + — a square cover drawn 200x100 wide. Computing the
 * geometry here removes the dependency on an attribute the renderer may ignore.
 *
 * Returns `undefined` when the header cannot be read; the caller then falls back to
 * filling the box, which is the old behaviour and no worse than it was.
 *
 * This parses device-controlled bytes, so the marker walk is bounded and every read is
 * range-checked.
 */
export function imageSize(art: ArtImage): { width: number; height: number } | undefined {
	const b = art.bytes;
	if (art.type === "bmp") {
		// BITMAPINFOHEADER: signed 32-bit width/height at 18 and 22; a negative height
		// means the rows are stored top-down, which says nothing about the size.
		if (b.length < 26) return undefined;
		const width = b.readInt32LE(18);
		const height = Math.abs(b.readInt32LE(22));
		return width > 0 && height > 0 ? { width, height } : undefined;
	}
	// JPEG: walk the segment markers to the frame header, which carries the size.
	let pos = 2;
	for (let steps = 0; steps < MAX_JPEG_MARKERS && pos + 3 < b.length; steps++) {
		if (b[pos] !== 0xff) return undefined;
		const marker = b[pos + 1]!;
		// Fill bytes and the standalone markers carry no length field.
		if (marker === 0xff) {
			pos++;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
			pos += 2;
			continue;
		}
		const length = b.readUInt16BE(pos + 2);
		if (length < 2) return undefined;
		// SOF0..SOF15, except the four that are not frame headers (DHT, JPG, DAC, and
		// the restart-interval marker do not carry a size).
		const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
		if (isFrame) {
			if (pos + 9 > b.length) return undefined;
			const height = b.readUInt16BE(pos + 5);
			const width = b.readUInt16BE(pos + 7);
			return width > 0 && height > 0 ? { width, height } : undefined;
		}
		pos += 2 + length;
	}
	return undefined;
}

/** Segments walked before giving up; a real header reaches the frame in a handful. */
const MAX_JPEG_MARKERS = 64;

function clampScrim(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return DEFAULT_SCRIM;
	return Math.min(MAX_SCRIM, Math.max(MIN_SCRIM, value));
}

/** MIME type for the container we verified, not the one the device claimed. */
function mimeFor(art: ArtImage): string {
	return art.type === "bmp" ? "image/bmp" : "image/jpeg";
}

/**
 * A `<g>` drawing a Lucide glyph, scaled from its 24-unit space into `size`.
 *
 * Returns "" for an unknown name rather than throwing: the glyph comes from a
 * catalog id, and a missing one should cost a decoration, not a key.
 */
export function glyphMarkup(name: string, x: number, y: number, size: number, stroke = GLYPH_STROKE): string {
	const inner = GLYPHS[name];
	if (!inner) return "";
	const scale = (size / 24).toFixed(4);
	return (
		`<g transform="translate(${x},${y}) scale(${scale})" fill="none" stroke="${stroke}" ` +
		`stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g>`
	);
}

function svgToDataUri(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * The `<image>` element for the art.
 *
 * Without a slice the art fills the box and is cropped to fit (`slice`), keeping its
 * aspect ratio — album art is square and a key is square, so nothing is lost.
 *
 * With a slice the picture is laid out at `count` segments wide and shifted left by
 * `index` segments, so each instance shows its own part of one continuous image.
 * `preserveAspectRatio="none"` is deliberate there: the combined canvas is 200·n by
 * 100, far wider than the square source, and letterboxing four strips would waste
 * most of them. The stretch is the point.
 */
function artElement(art: ArtImage, width: number, height: number, slice?: CoverSlice, fit: CoverFit = "cover"): string {
	const href = `data:${mimeFor(art)};base64,${art.bytes.toString("base64")}`;
	if (slice && slice.count > 1) {
		const total = width * slice.count;
		const offset = -width * Math.min(Math.max(slice.index, 0), slice.count - 1);
		return `<image x="${offset}" y="0" width="${total}" height="${height}" preserveAspectRatio="none" href="${href}"/>`;
	}
	const size = imageSize(art);
	if (!size) {
		// Unreadable header: fill the box and ask the renderer to do the right thing.
		// No worse than before, and it keeps a cover on screen rather than none.
		return `<image x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" href="${href}"/>`;
	}
	// The geometry, done here rather than declared: see `imageSize`. Everything outside
	// the viewBox is clipped by the outer <svg>, so `cover` needs no clip path.
	const scale =
		fit === "contain"
			? Math.min(width / size.width, height / size.height)
			: Math.max(width / size.width, height / size.height);
	const drawn = { w: size.width * scale, h: size.height * scale };
	const x = (width - drawn.w) / 2;
	const y = (height - drawn.h) / 2;
	const round = (n: number): string => n.toFixed(2);
	return `<image x="${round(x)}" y="${round(y)}" width="${round(drawn.w)}" height="${round(drawn.h)}" preserveAspectRatio="none" href="${href}"/>`;
}

/**
 * Compose one image.
 *
 * Returns `undefined` when the result would exceed `MAX_RENDER_BYTES`, so the caller
 * can fall back deliberately instead of sending a payload of unknown size.
 */
export function composeCoverImage(options: ComposeOptions): string | undefined {
	const width = options.width ?? KEY_SIZE;
	const height = options.height ?? KEY_SIZE;
	const glyphSize = Math.round(Math.min(width, height) / 2);
	const glyph = options.glyph
		? glyphMarkup(options.glyph, Math.round((width - glyphSize) / 2), Math.round((height - glyphSize) / 2), glyphSize)
		: "";

	const layers = options.art
		? // The backdrop shows wherever `contain` leaves the box unfilled; without it a
			// letterboxed cover would sit on whatever the strip drew last.
			`<rect width="${width}" height="${height}" fill="${PLACEHOLDER_BG}"/>` +
			artElement(options.art, width, height, options.slice, options.fit) +
			`<rect width="${width}" height="${height}" fill="#000000" opacity="${clampScrim(options.scrimOpacity)}"/>`
		: `<rect width="${width}" height="${height}" fill="${PLACEHOLDER_BG}"/>`;

	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
		layers +
		glyph +
		`</svg>`;

	const uri = svgToDataUri(svg);
	return uri.length > MAX_RENDER_BYTES ? undefined : uri;
}

/**
 * The "playing, but no cover" face: the placeholder backdrop plus a music glyph.
 *
 * Separate from `composeCoverImage({})` only so callers read as what they mean.
 */
export function composePlaceholder(options: { glyph?: string; width?: number; height?: number } = {}): string {
	// Cannot exceed the budget: no art, so the payload is a few hundred bytes.
	return composeCoverImage({ glyph: options.glyph ?? "music", width: options.width, height: options.height })!;
}
