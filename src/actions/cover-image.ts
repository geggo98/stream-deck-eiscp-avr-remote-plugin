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
}

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
function artElement(art: ArtImage, width: number, height: number, slice?: CoverSlice): string {
	const href = `data:${mimeFor(art)};base64,${art.bytes.toString("base64")}`;
	if (!slice || slice.count <= 1) {
		return `<image x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" href="${href}"/>`;
	}
	const total = width * slice.count;
	const offset = -width * Math.min(Math.max(slice.index, 0), slice.count - 1);
	return `<image x="${offset}" y="0" width="${total}" height="${height}" preserveAspectRatio="none" href="${href}"/>`;
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
		? artElement(options.art, width, height, options.slice) +
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
