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
export const PLACEHOLDER_BG = "#1A1A1A";

/**
 * How the elapsed fraction is drawn on a key.
 *
 * A key has no layout, so unlike a dial there is no native bar to feed — the progress
 * has to become part of the composed image. `ring` traces the key's border, `bar` sits
 * along the bottom. The bar is also the fallback: it needs nothing but two rectangles,
 * whereas the ring depends on `stroke-dasharray`, which Qt may or may not honour.
 */
export type ProgressShape = "ring" | "bar";

/**
 * Steps the elapsed fraction is rounded to before it is drawn.
 *
 * Not cosmetic — it is what keeps a once-a-second repaint affordable. A key is 72 px
 * on the physical device, so 1 % is about 1.5 px along the bar and less around the
 * ring: a finer step would change the composed string without changing the picture,
 * and `writeKeyImage`'s de-duplication would stop dropping anything. At 100 steps a
 * typical 3:41 track moves on roughly every other tick.
 */
export const PROGRESS_STEPS = 100;

/** Used when the cover's brightness could not be established. */
export const PROGRESS_DEFAULT_COLOUR = "#FFFFFF";
/** The unfilled part, in the same colour so one decision covers both. */
const PROGRESS_TRACK_OPACITY = 0.3;

/** Ring and bar geometry, in key units; scaled for boxes of another size. */
const RING_INSET = 6;
const RING_STROKE = 8;
const RING_RADIUS = 16;
const BAR_INSET = 8;
const BAR_HEIGHT = 6;

/** Clamp to 0…1 and round to `PROGRESS_STEPS`; nonsense becomes 0, never `NaN`. */
export function quantiseProgress(value: number): number {
	if (!Number.isFinite(value)) return 0;
	const clamped = Math.min(1, Math.max(0, value));
	return Math.round(clamped * PROGRESS_STEPS) / PROGRESS_STEPS;
}

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
	/** Elapsed fraction, 0…1. Absent draws no progress at all — see `overlayProgress`. */
	progress?: number;
	/** Defaults to `ring`. */
	progressStyle?: ProgressShape;
	/** Chosen from the cover by `progressColour`; defaults to white. */
	progressColour?: string;
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

/**
 * The darkening that will actually be applied.
 *
 * Exported because the progress colour has to be chosen against the *darkened* cover,
 * and a second copy of this clamp would be a way for the two to disagree — which shows
 * up as a black ring on a background the composer then left grey.
 */
export function effectiveScrim(value: number | undefined): number {
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
/**
 * The art as a data URI, computed once per buffer.
 *
 * Worth caching only since the progress arrived: before that the *finished* image was
 * cached per cover and this ran once anyway. Now a moving ring means a fresh
 * composition every second or two, and base64-ing ~97 KB of cover each time would be
 * the expensive part of it. Held weakly, so a superseded cover goes with the transfer
 * it came from.
 *
 * **This is the line that hands device-controlled bytes to Stream Deck**, where Qt
 * decodes them — the only native image decoder anywhere in this feature, and one we do
 * not control. If a decoder CVE ever lands there, this plugin is the delivery path: a
 * receiver on the LAN only has to announce a cover. `SECURITY.md` records the staged
 * way out (metadata is already stripped on receipt; the next step is decoding in WASM,
 * downscaling to the key size and re-encoding as PNG, so Stream Deck only ever sees
 * bytes we produced).
 */
const hrefByArt = new WeakMap<Buffer, string>();

function artHref(art: ArtImage): string {
	const cached = hrefByArt.get(art.bytes);
	if (cached !== undefined) return cached;
	const href = `data:${mimeFor(art)};base64,${art.bytes.toString("base64")}`;
	hrefByArt.set(art.bytes, href);
	return href;
}

function artElement(art: ArtImage, width: number, height: number, slice?: CoverSlice, fit: CoverFit = "cover"): string {
	const href = artHref(art);
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

const round2 = (n: number): string => Number(n.toFixed(2)).toString();

export interface RingGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
	radius: number;
	strokeWidth: number;
	/** Length once around, from the closed form for a rounded rectangle. */
	perimeter: number;
	/** Distance from the path's start to twelve o'clock, clockwise. */
	topCentre: number;
}

/**
 * Where the ring sits, and how long it is.
 *
 * The perimeter is computed rather than declared because **`pathLength` is not usable
 * here**: it is not part of SVG Tiny 1.2, which is roughly what Qt implements, and this
 * repo has already been caught once by assuming an attribute would be honoured
 * (`preserveAspectRatio`, see `imageSize`). Absolute lengths need nothing but
 * `stroke-dasharray`.
 *
 * A `<rect>`'s path starts at `(x + r, y)` and runs clockwise, so twelve o'clock is
 * half the top edge along it.
 */
export function ringGeometry(width: number, height: number): RingGeometry {
	const scale = Math.min(width, height) / KEY_SIZE;
	const inset = RING_INSET * scale;
	const radius = RING_RADIUS * scale;
	const w = width - 2 * inset;
	const h = height - 2 * inset;
	const straight = 2 * (w - 2 * radius) + 2 * (h - 2 * radius);
	return {
		x: inset,
		y: inset,
		width: w,
		height: h,
		radius,
		strokeWidth: RING_STROKE * scale,
		perimeter: straight + 2 * Math.PI * radius,
		topCentre: (w - 2 * radius) / 2,
	};
}

function progressRingMarkup(width: number, height: number, fraction: number, colour: string): string {
	const g = ringGeometry(width, height);
	const shape =
		`x="${round2(g.x)}" y="${round2(g.y)}" width="${round2(g.width)}" height="${round2(g.height)}" ` +
		`rx="${round2(g.radius)}" ry="${round2(g.radius)}" fill="none" stroke="${colour}" ` +
		`stroke-width="${round2(g.strokeWidth)}"`;
	const track = `<rect ${shape} opacity="${PROGRESS_TRACK_OPACITY}"/>`;
	// A full ring is drawn plain: a dash pattern whose gap is zero is not defined in a
	// partial renderer, and "full" happens at the end of every single track.
	if (fraction >= 1) return `${track}<rect ${shape}/>`;
	if (fraction <= 0) return track;
	const len = g.perimeter * fraction;
	return (
		track +
		`<rect ${shape} stroke-linecap="butt" ` +
		`stroke-dasharray="${round2(len)} ${round2(g.perimeter - len)}" ` +
		`stroke-dashoffset="${round2(g.perimeter - g.topCentre)}"/>`
	);
}

function progressBarMarkup(width: number, height: number, fraction: number, colour: string): string {
	const scale = Math.min(width, height) / KEY_SIZE;
	const inset = BAR_INSET * scale;
	const barHeight = BAR_HEIGHT * scale;
	const y = height - inset - barHeight;
	const full = width - 2 * inset;
	const radius = barHeight / 2;
	const track =
		`<rect x="${round2(inset)}" y="${round2(y)}" width="${round2(full)}" height="${round2(barHeight)}" ` +
		`rx="${round2(radius)}" fill="${colour}" opacity="${PROGRESS_TRACK_OPACITY}"/>`;
	const filled = full * fraction;
	if (filled <= 0) return track;
	// A stub shorter than its own end caps would round into a lens; clamp instead.
	const capped = Math.min(radius, filled / 2);
	return (
		track +
		`<rect x="${round2(inset)}" y="${round2(y)}" width="${round2(filled)}" height="${round2(barHeight)}" ` +
		`rx="${round2(capped)}" fill="${colour}"/>`
	);
}

/** The progress layer, or "" when there is no usable elapsed fraction to show. */
function progressMarkup(options: ComposeOptions, width: number, height: number): string {
	if (options.progress === undefined || !Number.isFinite(options.progress)) return "";
	const fraction = Math.min(1, Math.max(0, options.progress));
	const colour = options.progressColour ?? PROGRESS_DEFAULT_COLOUR;
	return options.progressStyle === "bar"
		? progressBarMarkup(width, height, fraction, colour)
		: progressRingMarkup(width, height, fraction, colour);
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
			`<rect width="${width}" height="${height}" fill="#000000" opacity="${effectiveScrim(options.scrimOpacity)}"/>`
		: `<rect width="${width}" height="${height}" fill="${PLACEHOLDER_BG}"/>`;

	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
		layers +
		glyph +
		// Last, so neither the scrim nor the glyph can sit on top of it: the progress is
		// the one part of the picture that has to stay readable at a glance.
		progressMarkup(options, width, height) +
		`</svg>`;

	const uri = svgToDataUri(svg);
	return uri.length > MAX_RENDER_BYTES ? undefined : uri;
}

/**
 * The "playing, but no cover" face: the placeholder backdrop plus a music glyph.
 *
 * Separate from `composeCoverImage({})` only so callers read as what they mean.
 */
export function composePlaceholder(
	options: {
		glyph?: string;
		width?: number;
		height?: number;
		progress?: number;
		progressStyle?: ProgressShape;
		progressColour?: string;
	} = {},
): string {
	// Cannot exceed the budget: no art, so the payload is a few hundred bytes.
	return composeCoverImage({
		glyph: options.glyph ?? "music",
		width: options.width,
		height: options.height,
		progress: options.progress,
		progressStyle: options.progressStyle,
		progressColour: options.progressColour,
	})!;
}
