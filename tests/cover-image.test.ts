/**
 * Composing cover art into a key or strip image.
 *
 * Two kinds of assertion here, and the second is the important one:
 *
 *  1. Structural — the layer order, the clamps, the slice geometry. Pure function,
 *     cheap to pin.
 *  2. **The encoding the hardware actually accepts.** Established by probing a real
 *     Stream Deck +, and it contradicts the SDK documentation on one point: a plain
 *     SVG string is rejected, only a base64 data URI renders. That failure is silent
 *     (the key falls back to its manifest icon), so nothing but a test keeps the
 *     knowledge from being "simplified" away later.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ArtImage } from "../src/adapter/eiscp/jacket-art.ts";
import {
	composeCoverImage,
	composePlaceholder,
	DEFAULT_SCRIM,
	glyphMarkup,
	imageSize,
	KEY_SIZE,
	MAX_RENDER_BYTES,
	MAX_SCRIM,
	PROGRESS_STEPS,
	quantiseProgress,
	ringGeometry,
	STRIP_HEIGHT,
	STRIP_SEGMENT_WIDTH,
} from "../src/actions/cover-image.ts";

function art(bytes = 64, type: "jpeg" | "bmp" = "jpeg"): ArtImage {
	const data = Buffer.alloc(bytes, 0x41);
	return { type, bytes: data, frames: 2, hash: `h${bytes}` };
}

/** Recover the SVG from the data URI the composer returns. */
function svgOf(uri: string | undefined): string {
	assert.ok(uri, "expected an image");
	const prefix = "data:image/svg+xml;base64,";
	assert.ok(uri.startsWith(prefix), `expected a base64 SVG data URI, got ${uri.slice(0, 40)}…`);
	return Buffer.from(uri.slice(prefix.length), "base64").toString("utf8");
}

describe("cover image: the encoding the hardware accepts", () => {
	it("wraps the SVG in a base64 data URI, because a raw SVG string is rejected", () => {
		// Measured on a Stream Deck +: handing setImage the SVG markup directly leaves
		// the key showing its manifest icon — no error, no log line. The SDK docs claim
		// a plain SVG string works; for a composed image it does not.
		const uri = composeCoverImage({ art: art(), glyph: "music" });
		assert.ok(uri, "a small cover must compose");
		assert.ok(uri.startsWith("data:image/svg+xml;base64,"));
		assert.ok(!uri.includes("<svg"), "the markup must not be sent unwrapped");
	});

	it("references the art with href only, since xlink:href doubles the payload", () => {
		// Measured for the same 97 KB cover: 346 KB with both attributes, 173 KB with
		// href alone — the data URI appears once per attribute, so a duplicate
		// reference doubles the whole image.
		const svg = svgOf(composeCoverImage({ art: art(4096) }));
		assert.match(svg, / href="data:image\/jpeg;base64,/);
		assert.ok(!svg.includes("xlink"), "xlink:href is unnecessary and doubles the size");
		assert.equal(svg.match(/base64,/g)?.length, 1, "the art must be embedded exactly once");
	});

	it("declares the container it verified, not the one the device claimed", () => {
		assert.match(svgOf(composeCoverImage({ art: art(64, "bmp") })), /data:image\/bmp;base64,/);
		assert.match(svgOf(composeCoverImage({ art: art(64, "jpeg") })), /data:image\/jpeg;base64,/);
	});

	it("keeps device bytes out of the markup entirely", () => {
		// The art enters only as base64 inside an attribute value. If it could reach the
		// markup, a cover would be able to inject elements into an image the plugin
		// builds — the one injection surface this module has.
		const bytes = Buffer.from('</svg><script>alert(1)</script><svg>', "utf8");
		const svg = svgOf(composeCoverImage({ art: { type: "jpeg", bytes, frames: 1, hash: "probe" } }));
		assert.ok(!svg.includes("<script"), "raw art bytes must never appear as markup");
		assert.ok(svg.includes(bytes.toString("base64")));
	});
});

describe("cover image: layers", () => {
	it("puts the scrim between the art and the glyph", () => {
		// Order is the whole point: a glyph under the scrim is dimmed with the art, and
		// a scrim under the art does nothing at all.
		const svg = svgOf(composeCoverImage({ art: art(), glyph: "music", scrimOpacity: 0.5 }));
		const image = svg.indexOf("<image");
		const scrim = svg.indexOf('fill="#000000"');
		const glyph = svg.indexOf("<g transform");
		assert.ok(image >= 0 && scrim >= 0 && glyph >= 0, "all three layers must be present");
		assert.ok(image < scrim && scrim < glyph, `expected art < scrim < glyph, got ${image}/${scrim}/${glyph}`);
	});

	it("clamps the scrim and falls back to the default for nonsense", () => {
		assert.match(svgOf(composeCoverImage({ art: art(), scrimOpacity: 5 })), new RegExp(`opacity="${MAX_SCRIM}"`));
		assert.match(svgOf(composeCoverImage({ art: art(), scrimOpacity: -1 })), /opacity="0"/);
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
			assert.match(
				svgOf(composeCoverImage({ art: art(), scrimOpacity: bad })),
				new RegExp(`opacity="${DEFAULT_SCRIM}"`),
				`${bad} should fall back to the default`,
			);
		}
	});

	it("draws no scrim and no image when there is no art", () => {
		const svg = svgOf(composeCoverImage({ glyph: "music" }));
		assert.ok(!svg.includes("<image"), "nothing to darken");
		assert.match(svg, /fill="#1A1A1A"/, "the placeholder backdrop instead");
		assert.match(svg, /<g transform/, "but the glyph still shows");
	});

	it("omits the glyph layer when none is asked for, or the name is unknown", () => {
		assert.ok(!svgOf(composeCoverImage({ art: art() })).includes("<g transform"));
		// A glyph comes from a catalog id; a miss should cost a decoration, not a key.
		assert.ok(!svgOf(composeCoverImage({ art: art(), glyph: "no-such-glyph" })).includes("<g transform"));
	});

	it("draws the glyph from the generated markup, centred", () => {
		const svg = svgOf(composeCoverImage({ art: art(), glyph: "music" }));
		// 144 key, glyph half that -> 72, centred at 36,36.
		assert.match(svg, /translate\(36,36\) scale\(3\.0000\)/);
		assert.match(svg, /stroke="#FFFFFF"/);
	});

	it("has a standalone glyph helper that is safe for unknown names", () => {
		assert.equal(glyphMarkup("definitely-not-a-glyph", 0, 0, 24), "");
		assert.match(glyphMarkup("music", 10, 20, 48), /translate\(10,20\) scale\(2\.0000\)/);
	});
});

describe("cover image: spreading one picture across adjacent strips", () => {
	it("covers the whole width exactly once, with no gap and no overlap", () => {
		// The property that matters when four dials show one cover: each segment must
		// draw its own part of the same picture. Since the strip is physically
		// continuous (verified on the device against a background image that runs
		// across all four segments), the offsets are exact multiples of the segment
		// width — no bezel correction.
		const count = 4;
		const offsets: number[] = [];
		for (let index = 0; index < count; index++) {
			const svg = svgOf(
				composeCoverImage({
					art: art(256),
					slice: { index, count },
					width: STRIP_SEGMENT_WIDTH,
					height: STRIP_HEIGHT,
				}),
			);
			const m = /<image x="(-?\d+)" y="0" width="(\d+)"/.exec(svg);
			assert.ok(m, "expected a positioned image");
			assert.equal(Number(m[2]), STRIP_SEGMENT_WIDTH * count, "each slice lays out the full width");
			offsets.push(Number(m[1]));
		}
		assert.deepEqual(offsets, [0, -200, -400, -600]);
		// Consecutive offsets differ by exactly one segment: contiguous, non-overlapping.
		for (let i = 1; i < offsets.length; i++) {
			assert.equal(offsets[i - 1]! - offsets[i]!, STRIP_SEGMENT_WIDTH);
		}
	});

	it("stretches rather than letterboxes when spread, and crops when not", () => {
		// A square cover across 800x100 would be almost entirely empty bars if it kept
		// its aspect ratio, so the stretch is deliberate. A single segment or a key
		// crops instead, which loses nothing (square art, square key).
		assert.match(
			svgOf(composeCoverImage({ art: art(), slice: { index: 0, count: 3 }, width: STRIP_SEGMENT_WIDTH, height: STRIP_HEIGHT })),
			/preserveAspectRatio="none"/,
		);
		assert.match(svgOf(composeCoverImage({ art: art() })), /preserveAspectRatio="xMidYMid slice"/);
	});

	it("treats a one-segment group as no slicing at all", () => {
		assert.match(svgOf(composeCoverImage({ art: art(), slice: { index: 0, count: 1 } })), /x="0" y="0" width="144"/);
	});

	it("clamps an out-of-range slice index instead of drawing off-canvas", () => {
		// The index comes from a device/profile layout, so it is not fully under our
		// control; an index past the group would otherwise shift the picture out of view.
		const high = svgOf(composeCoverImage({ art: art(), slice: { index: 9, count: 3 }, width: 200, height: 100 }));
		assert.match(high, /<image x="-400"/, "clamped to the last segment");
		const low = svgOf(composeCoverImage({ art: art(), slice: { index: -5, count: 3 }, width: 200, height: 100 }));
		assert.match(low, /<image x="0"/, "clamped to the first");
	});
});

describe("cover image: budget", () => {
	it("refuses an image over the budget instead of sending an unknown payload", () => {
		// The size is ultimately the receiver's choice, and a track change can repaint
		// every configured key at once — so there has to be a point where the composer
		// says no rather than "probably fine".
		const huge = composeCoverImage({ art: art(MAX_RENDER_BYTES) });
		assert.equal(huge, undefined);
	});

	it("accepts a realistically sized cover with room to spare", () => {
		// Measured: a real 97 KB cover composes to ~173 KB.
		const uri = composeCoverImage({ art: art(97_357), glyph: "music" });
		assert.ok(uri, "a real cover must render");
		assert.ok(uri.length < MAX_RENDER_BYTES, `${uri.length} should be inside the budget`);
		assert.ok(uri.length > 97_357, "and it is necessarily larger than the source");
	});

	it("always produces a placeholder, whatever the budget", () => {
		const uri = composePlaceholder();
		assert.ok(uri.startsWith("data:image/svg+xml;base64,"));
		assert.ok(uri.length < 2_000, "the placeholder is tiny by construction");
		assert.match(svgOf(uri), /<g transform/);
	});

	it("uses the key size by default and honours an explicit one", () => {
		assert.match(svgOf(composeCoverImage({ art: art() })), new RegExp(`width="${KEY_SIZE}" height="${KEY_SIZE}"`));
		assert.match(
			svgOf(composeCoverImage({ art: art(), width: STRIP_SEGMENT_WIDTH, height: STRIP_HEIGHT })),
			new RegExp(`width="${STRIP_SEGMENT_WIDTH}" height="${STRIP_HEIGHT}"`),
		);
	});
});

/** A JPEG carrying nothing but a frame header of the given size. */
function jpegOf(width: number, height: number, extraSegments = 0): ArtImage {
	const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
	for (let i = 0; i < extraSegments; i++) {
		// APP0-ish filler, to prove the marker walk steps over what it does not need.
		const payload = Buffer.alloc(16, 0x20);
		parts.push(Buffer.from([0xff, 0xe0, 0x00, payload.length + 2]), payload);
	}
	const sof = Buffer.alloc(15);
	sof.writeUInt16BE(0xffc0, 0);
	sof.writeUInt16BE(13, 2); // segment length
	sof.writeUInt8(8, 4); // precision
	sof.writeUInt16BE(height, 5);
	sof.writeUInt16BE(width, 7);
	parts.push(sof, Buffer.from([0xff, 0xd9]));
	const bytes = Buffer.concat(parts);
	return { type: "jpeg", bytes, frames: 1, hash: "sized" };
}

function bmpOf(width: number, height: number): ArtImage {
	const bytes = Buffer.alloc(64);
	bytes.write("BM", 0, "ascii");
	bytes.writeInt32LE(width, 18);
	bytes.writeInt32LE(height, 22);
	return { type: "bmp", bytes, frames: 1, hash: "bmp" };
}

describe("reading the art's own size", () => {
	// Needed because `preserveAspectRatio` cannot be relied on: Stream Deck renders with
	// Qt, and on a real Stream Deck + a nested <image> came out stretched to the box —
	// a square cover drawn 200 wide and 100 tall. The geometry is computed here instead,
	// which means the intrinsic size has to be read from the file.

	it("reads a JPEG frame header, past whatever segments precede it", () => {
		assert.deepEqual(imageSize(jpegOf(512, 512)), { width: 512, height: 512 });
		assert.deepEqual(imageSize(jpegOf(640, 480, 3)), { width: 640, height: 480 });
	});

	it("reads a BMP header, including the top-down form", () => {
		assert.deepEqual(imageSize(bmpOf(300, 200)), { width: 300, height: 200 });
		// A negative height means the rows are stored top-down; it is not a size.
		assert.deepEqual(imageSize(bmpOf(300, -200)), { width: 300, height: 200 });
	});

	it("gives up rather than guessing on anything it cannot parse", () => {
		// These bytes come off the wire, so "cannot parse" is a normal outcome, not a bug.
		assert.equal(imageSize(art(64)), undefined, "not a real header");
		assert.equal(imageSize({ ...art(2), bytes: Buffer.from([0xff, 0xd8]) }), undefined, "truncated");
		assert.equal(imageSize(bmpOf(0, 0)), undefined, "a zero dimension is not a size");
	});

	it("terminates on bytes designed to keep it walking", () => {
		// A marker walk over attacker-shaped input has to be bounded. A file of nothing
		// but 0xFF fill bytes would otherwise step one byte at a time forever.
		const evil: ArtImage = { type: "jpeg", bytes: Buffer.alloc(8192, 0xff), frames: 1, hash: "evil" };
		const started = Date.now();
		assert.equal(imageSize(evil), undefined);
		assert.ok(Date.now() - started < 200, "bounded");
	});
});

describe("fitting the art into a box that is not its shape", () => {
	/** The x/y/width/height the composer gave the <image>. */
	function geometry(uri: string | undefined): { x: number; y: number; w: number; h: number } {
		const m = /<image x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svgOf(uri));
		assert.ok(m, "expected an <image> with explicit geometry");
		return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
	}

	it("keeps a square cover square on a 200x100 strip segment", () => {
		// The bug the user saw: the cover was drawn stretched to the full segment.
		const g = geometry(
			composeCoverImage({
				art: jpegOf(512, 512),
				width: STRIP_SEGMENT_WIDTH,
				height: STRIP_HEIGHT,
				fit: "contain",
			}),
		);
		assert.equal(g.w, g.h, `expected a square, got ${g.w}x${g.h}`);
		assert.equal(g.h, STRIP_HEIGHT, "and as tall as the segment allows");
		assert.equal(g.x, (STRIP_SEGMENT_WIDTH - g.w) / 2, "centred");
		assert.equal(g.y, 0);
	});

	it("fills a square key with a square cover, edge to edge", () => {
		const g = geometry(composeCoverImage({ art: jpegOf(512, 512) }));
		assert.deepEqual(g, { x: 0, y: 0, w: KEY_SIZE, h: KEY_SIZE });
	});

	it("crops rather than letterboxes where the box is square", () => {
		// `cover` is the key's default: a wide cover on a square key fills it and loses
		// the sides, which beats black bars on a 144x144 button.
		const g = geometry(composeCoverImage({ art: jpegOf(1000, 500) }));
		assert.equal(g.h, KEY_SIZE);
		assert.ok(g.w > KEY_SIZE, "wider than the box, so the sides are cropped");
		assert.ok(g.x < 0 && g.y === 0, "and centred by overhanging both sides");
	});

	it("never leaves the backdrop showing through where nothing was drawn", () => {
		// `contain` deliberately does not fill the box; without a backdrop the gap would
		// show whatever the strip drew last.
		const svg = svgOf(
			composeCoverImage({ art: jpegOf(512, 512), width: STRIP_SEGMENT_WIDTH, height: STRIP_HEIGHT, fit: "contain" }),
		);
		assert.ok(svg.indexOf("<rect") < svg.indexOf("<image"), "the backdrop is drawn first");
	});

	it("still composes when the header cannot be read", () => {
		// Falling back to the old behaviour keeps a cover on screen; refusing would not.
		const svg = svgOf(composeCoverImage({ art: art(64), width: STRIP_SEGMENT_WIDTH, height: STRIP_HEIGHT }));
		assert.match(svg, /preserveAspectRatio="xMidYMid slice"/);
	});

	describe("moving the crop off a face", () => {
		const strip = { art: jpegOf(512, 512), width: STRIP_SEGMENT_WIDTH, height: STRIP_HEIGHT };

		it("composes exactly what it always did when nothing asks it to move", () => {
			// The regression bar for every element that already exists: a cover with no
			// opinion attached has to land byte for byte where it landed before.
			assert.equal(composeCoverImage({ ...strip, focusY: 0 }), composeCoverImage(strip));
		});

		it("puts the top of the picture at the top of the box, and the bottom at the bottom", () => {
			const top = geometry(composeCoverImage({ ...strip, focusY: -1 }));
			const bottom = geometry(composeCoverImage({ ...strip, focusY: 1 }));
			const centre = geometry(composeCoverImage(strip));
			assert.equal(top.y, 0, "at -1 the picture's top edge meets the box's");
			assert.equal(bottom.y + bottom.h, STRIP_HEIGHT, "at +1 its bottom edge does");
			assert.equal(centre.y, (STRIP_HEIGHT - centre.h) / 2, "and the middle is still the middle");
			assert.deepEqual(
				[top.w, top.h, bottom.w, bottom.h],
				[centre.w, centre.h, centre.w, centre.h],
				"moving the crop must not resize the picture",
			);
		});

		it("never uncovers the box, whatever it is asked for", () => {
			// A shift beyond the overhang would let the backdrop show through at one edge,
			// which is a black band across half the touch strip.
			for (const focusY of [-3, -1, -0.5, 0, 0.5, 1, 3, Number.NaN, Number.POSITIVE_INFINITY]) {
				const g = geometry(composeCoverImage({ ...strip, focusY }));
				assert.ok(g.y <= 0, `top gap at focusY=${focusY}: y=${g.y}`);
				assert.ok(g.y + g.h >= STRIP_HEIGHT, `bottom gap at focusY=${focusY}: y+h=${g.y + g.h}`);
			}
		});

		it("cannot move a picture that is not cropped in the first place", () => {
			// A square cover on a square key has no overhang, so there is nowhere to go —
			// and `contain` fits the whole picture by definition.
			const key = { art: jpegOf(512, 512) };
			assert.equal(composeCoverImage({ ...key, focusY: -1 }), composeCoverImage(key));
			const contained = { ...strip, fit: "contain" as const };
			assert.equal(composeCoverImage({ ...contained, focusY: -1 }), composeCoverImage(contained));
		});
	});
});

describe("drawing how far through the track we are", () => {
	/** Every `<rect>` in the composed SVG, as attribute maps. */
	function rects(uri: string | undefined): Record<string, string>[] {
		return [...svgOf(uri).matchAll(/<rect\b([^>]*)\/>/g)].map((m) => {
			const attrs: Record<string, string> = {};
			for (const a of m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1]!] = a[2]!;
			return attrs;
		});
	}

	/** The two rects the ring is made of: the track, then the elapsed part. */
	function ringRects(uri: string | undefined): Record<string, string>[] {
		return rects(uri).filter((r) => r["fill"] === "none");
	}

	it("computes the ring's length instead of declaring pathLength", () => {
		// pathLength is not in SVG Tiny 1.2, which is roughly what Qt implements — and
		// this repo has already been bitten by assuming an attribute would be honoured.
		// So the closed form is the contract, and it is checked here rather than trusted.
		const g = ringGeometry(KEY_SIZE, KEY_SIZE);
		const expected = 2 * (g.width - 2 * g.radius) + 2 * (g.height - 2 * g.radius) + 2 * Math.PI * g.radius;
		assert.ok(Math.abs(g.perimeter - expected) < 1e-9, `${g.perimeter} vs ${expected}`);
		assert.doesNotMatch(svgOf(composeCoverImage({ art: art(), progress: 0.5 })), /pathLength/);
	});

	it("gives the elapsed part exactly its share of the perimeter", () => {
		const g = ringGeometry(KEY_SIZE, KEY_SIZE);
		for (const fraction of [0.25, 0.5, 0.75]) {
			const dash = ringRects(composeCoverImage({ art: art(), progress: fraction })).at(-1)?.["stroke-dasharray"];
			assert.ok(dash, `expected a dash pattern at ${fraction}`);
			const [len, gap] = dash.split(" ").map(Number) as [number, number];
			assert.ok(Math.abs(len - g.perimeter * fraction) < 0.02, `${len} is not ${fraction} of ${g.perimeter}`);
			assert.ok(Math.abs(len + gap - g.perimeter) < 0.02, "the gap must close the ring exactly");
		}
	});

	it("starts the ring at twelve o'clock, not where the rect's path happens to begin", () => {
		const g = ringGeometry(KEY_SIZE, KEY_SIZE);
		const offset = Number(ringRects(composeCoverImage({ art: art(), progress: 0.5 })).at(-1)?.["stroke-dashoffset"]);
		assert.ok(Math.abs(offset - (g.perimeter - g.topCentre)) < 0.02, `${offset}`);
		// Positive, because a partial renderer may well not handle a negative one.
		assert.ok(offset > 0);
	});

	it("draws a full ring plain, since a zero-length gap is not defined", () => {
		// And "full" is not an edge case: it happens at the end of every single track.
		const full = ringRects(composeCoverImage({ art: art(), progress: 1 }));
		assert.equal(full.length, 2, "track plus elapsed");
		assert.equal(full[1]!["stroke-dasharray"], undefined, "no dash pattern at all");
	});

	it("leaves only the track at zero, rather than a zero-length dash", () => {
		const none = ringRects(composeCoverImage({ art: art(), progress: 0 }));
		assert.equal(none.length, 1);
		assert.equal(none[0]!["opacity"], "0.3", "and that one is the unfilled track");
	});

	it("draws nothing at all when there is no elapsed fraction", () => {
		// The receiver saying "the time means nothing" must produce no ring, not an empty
		// one — an empty ring reads as a frame someone chose to draw.
		const svg = svgOf(composeCoverImage({ art: art() }));
		assert.doesNotMatch(svg, /stroke-dasharray/);
		assert.equal(rects(composeCoverImage({ art: art() })).filter((r) => r["fill"] === "none").length, 0);
	});

	it("keeps the ring inside the canvas, stroke included", () => {
		const g = ringGeometry(KEY_SIZE, KEY_SIZE);
		const half = g.strokeWidth / 2;
		assert.ok(g.x - half >= 0, "the stroke must not bleed off the left edge");
		assert.ok(g.y - half >= 0);
		assert.ok(g.x + g.width + half <= KEY_SIZE);
		assert.ok(g.y + g.height + half <= KEY_SIZE);
		assert.ok(g.radius * 2 <= Math.min(g.width, g.height), "the corners must not meet");
	});

	it("draws the bar along the bottom, filled to its share of the width", () => {
		const bars = rects(composeCoverImage({ art: art(), progress: 0.25, progressStyle: "bar" })).filter(
			(r) => r["rx"] !== undefined,
		);
		assert.equal(bars.length, 2, "track plus elapsed");
		const [track, fill] = bars as [Record<string, string>, Record<string, string>];
		assert.equal(track["x"], fill["x"], "both start at the same place");
		assert.equal(track["y"], fill["y"]);
		assert.ok(Math.abs(Number(fill["width"]) - Number(track["width"]) * 0.25) < 0.02);
		assert.ok(Number(track["y"]) + Number(track["height"]) <= KEY_SIZE, "inside the canvas");
		// The bar is the fallback for a renderer that ignores dash patterns, so it may
		// not depend on one.
		assert.doesNotMatch(svgOf(composeCoverImage({ art: art(), progress: 0.25, progressStyle: "bar" })), /dasharray/);
	});

	it("paints the progress over the scrim and the glyph, never under them", () => {
		const svg = svgOf(composeCoverImage({ art: art(), glyph: "play", scrimOpacity: 0.4, progress: 0.5 }));
		assert.ok(svg.indexOf("<g transform") < svg.lastIndexOf("stroke-dasharray"), "glyph first, ring last");
		assert.ok(svg.indexOf('fill="#000000"') < svg.lastIndexOf("stroke-dasharray"), "scrim first, ring last");
	});

	it("uses the colour it was given for both halves, and white when it was given none", () => {
		const dark = ringRects(composeCoverImage({ art: art(), progress: 0.5, progressColour: "#000000" }));
		assert.deepEqual(
			dark.map((r) => r["stroke"]),
			["#000000", "#000000"],
		);
		const plain = ringRects(composeCoverImage({ art: art(), progress: 0.5 }));
		assert.deepEqual(
			plain.map((r) => r["stroke"]),
			["#FFFFFF", "#FFFFFF"],
		);
	});

	it("still shows the progress when there is no cover to draw it on", () => {
		// A source with a clock but no artwork is normal; the placeholder must carry it.
		assert.match(svgOf(composePlaceholder({ progress: 0.5 })), /stroke-dasharray/);
	});

	it("rounds the fraction to a step the eye can tell apart", () => {
		// This is what lets writeKeyImage keep dropping repaints: two ticks that land in
		// one step compose to the same string, so nothing is written.
		assert.equal(quantiseProgress(0.5), 0.5);
		assert.equal(quantiseProgress(0.50001), 0.5);
		assert.equal(quantiseProgress(0.504), 0.5);
		assert.equal(quantiseProgress(0.506), 0.51);
		assert.equal(quantiseProgress(1 / PROGRESS_STEPS / 3), 0);
		assert.equal(
			composeCoverImage({ art: art(), progress: quantiseProgress(0.5001) }),
			composeCoverImage({ art: art(), progress: quantiseProgress(0.5004) }),
			"two ticks inside one step must produce the identical payload",
		);
	});

	it("never lets a nonsense fraction reach the geometry", () => {
		// Settings and device data both arrive untyped; NaN in an SVG length has been a
		// real finding in this repo.
		assert.equal(quantiseProgress(Number.NaN), 0);
		assert.equal(quantiseProgress(-1), 0);
		assert.equal(quantiseProgress(7), 1);
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -3, 9]) {
			assert.doesNotMatch(svgOf(composeCoverImage({ art: art(), progress: bad })), /NaN|Infinity|-\d/);
		}
	});
});
