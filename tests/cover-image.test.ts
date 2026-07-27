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
	KEY_SIZE,
	MAX_RENDER_BYTES,
	MAX_SCRIM,
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
