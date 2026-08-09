/**
 * The cover's block brightness — the plugin's first pixel decoder.
 *
 * Two things are being pinned here, and they pull in opposite directions:
 *
 *  1. **It reads real JPEGs correctly.** Tested against bytes this suite encodes
 *     itself (`tests/helpers/tiny-jpeg.ts`), so a block's expected mean is known
 *     exactly instead of eyeballed off a fixture.
 *  2. **It cannot be made to misbehave.** The input is unauthenticated LAN traffic, so
 *     "answers `undefined`" is a success and "throws, hangs or grows" is the failure.
 *     `undefined` means the caller draws in white, which is always an acceptable
 *     colour — that is what makes strictness affordable here.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ArtImage } from "../src/adapter/eiscp/jacket-art.ts";
import { LUMA_BLOCK, lumaGrid } from "../src/actions/image-luma.ts";
import { expectFastCompletion, expectOnlyDeliberateErrors, fuzzConfig, fuzzEach, mutate } from "./helpers/fuzz.ts";
import { tinyJpeg, type TinyJpegSpec } from "./helpers/tiny-jpeg.ts";

const config = fuzzConfig();

/**
 * Time budget, matching the rest of the suite.
 *
 * Deliberately generous, for the reason `expectFastCompletion` states: it is there to
 * catch an algorithmic blowup, not to measure a loaded machine. A tighter number turns
 * a busy CI runner into a red build, which is how a real signal gets ignored.
 */
const FAST_BUDGET_MS = 250;

let hashCounter = 0;
/** A fresh ArtImage each time, so the per-buffer cache never masks a change. */
function artOf(bytes: Buffer, type: "jpeg" | "bmp" = "jpeg"): ArtImage {
	return { type, bytes, frames: 1, hash: `probe${hashCounter++}` };
}

function jpeg(spec: TinyJpegSpec): ArtImage {
	return artOf(tinyJpeg(spec));
}

/** A 24-bit BMP of a solid colour, in the usual bottom-up row order. */
function bmp(width: number, height: number, rgb: [number, number, number], topDown = false): ArtImage {
	const stride = Math.floor((width * 3 + 3) / 4) * 4;
	const offset = 54;
	const bytes = Buffer.alloc(offset + stride * height);
	bytes.write("BM", 0, "ascii");
	bytes.writeUInt32LE(bytes.length, 2);
	bytes.writeUInt32LE(offset, 10);
	bytes.writeUInt32LE(40, 14);
	bytes.writeInt32LE(width, 18);
	bytes.writeInt32LE(topDown ? -height : height, 22);
	bytes.writeUInt16LE(1, 26);
	bytes.writeUInt16LE(24, 28);
	bytes.writeUInt32LE(0, 30);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const p = offset + y * stride + x * 3;
			bytes[p] = rgb[2];
			bytes[p + 1] = rgb[1];
			bytes[p + 2] = rgb[0];
		}
	}
	return artOf(bytes, "bmp");
}

describe("reading a cover's block brightness", () => {
	it("recovers the mean of every block of a greyscale JPEG", () => {
		// The DC coefficient dequantised is eight times the block mean, plus the level
		// shift. If either half of that were wrong, every colour decision would be.
		const grid = lumaGrid(jpeg({ width: 32, height: 16, luma: (col, row) => 16 + col * 32 + row * 8 }));
		assert.ok(grid, "a well-formed JPEG must decode");
		assert.deepEqual({ width: grid.width, height: grid.height }, { width: 4, height: 2 });
		for (let row = 0; row < grid.height; row++) {
			for (let col = 0; col < grid.width; col++) {
				assert.equal(grid.data[row * grid.width + col], 16 + col * 32 + row * 8, `at ${col},${row}`);
			}
		}
	});

	it("reads the luminance plane of a 4:2:0 image, chroma and all", () => {
		// The interleaving is the part a DC-only decoder can get subtly wrong: four Y
		// blocks then one of each chroma, per MCU, each with its own DC predictor.
		const grid = lumaGrid(jpeg({ width: 32, height: 32, layout: "420", luma: (col, row) => 40 + col * 10 + row * 20 }));
		assert.ok(grid);
		assert.deepEqual({ width: grid.width, height: grid.height }, { width: 4, height: 4 });
		assert.equal(grid.data[0], 40);
		assert.equal(grid.data[grid.width + 1], 40 + 10 + 20, "the second Y block of the second row");
	});

	it("keeps the padding blocks past the image edge out of the grid", () => {
		// A 20x20 4:2:0 image is coded as 2x2 MCUs, i.e. 4x4 luminance blocks, but only
		// 3x3 of them are inside the picture. The others still have to be decoded — the
		// stream demands it — and must not colour anything.
		const grid = lumaGrid(
			jpeg({ width: 20, height: 20, layout: "420", luma: (col, row) => (col > 2 || row > 2 ? 255 : 20) }),
		);
		assert.ok(grid);
		assert.deepEqual({ width: grid.width, height: grid.height }, { width: 3, height: 3 });
		assert.ok(
			[...grid.data].every((v) => v === 20),
			`padding leaked into the grid: ${[...grid.data].join(",")}`,
		);
	});

	it("follows restart markers and the predictor reset that goes with them", () => {
		const spec: TinyJpegSpec = { width: 64, height: 8, luma: (col) => 30 + col * 20 };
		const plain = lumaGrid(jpeg(spec));
		const restarted = lumaGrid(jpeg({ ...spec, restartInterval: 2 }));
		assert.ok(plain && restarted);
		assert.deepEqual([...restarted.data], [...plain.data], "restarts must not change what the picture is");
	});

	it("undoes the byte stuffing the format requires", () => {
		// A 0xFF inside the entropy stream is written as 0xFF 0x00, so it cannot be read
		// as a marker. A decoder that does not step over that padding byte takes eight
		// bits nobody coded and everything after it is wrong — silently, since the image
		// still "decodes". The alternating pattern is here because it is what actually
		// produces a stuffed byte; asserted, so this cannot quietly stop testing the path.
		const bytes = tinyJpeg({ width: 128, height: 128, luma: (col, row) => ((col + row) % 2 ? 255 : 0) });
		assert.ok(bytes.includes(Buffer.from([0xff, 0x00])), "the fixture must stuff a byte");
		const grid = lumaGrid(artOf(bytes));
		assert.ok(grid);
		for (let row = 0; row < grid.height; row++) {
			for (let col = 0; col < grid.width; col++) {
				assert.equal(grid.data[row * grid.width + col], (col + row) % 2 ? 255 : 0, `at ${col},${row}`);
			}
		}
	});

	it("walks over the segments it has no use for", () => {
		const grid = lumaGrid(jpeg({ width: 8, height: 8, luma: () => 100, extraSegments: 4 }));
		assert.equal(grid?.data[0], 100);
	});

	it("reads a BMP either way up", () => {
		// 0.299*200 + 0.587*100 + 0.114*50 = 124.
		for (const topDown of [false, true]) {
			const grid = lumaGrid(bmp(16, 16, [200, 100, 50], topDown));
			assert.ok(grid, `topDown=${topDown}`);
			assert.deepEqual({ width: grid.width, height: grid.height }, { width: 2, height: 2 });
			assert.ok(
				[...grid.data].every((v) => Math.abs(v - 124) <= 1),
				`${[...grid.data].join(",")}`,
			);
		}
	});

	it("sees which way up a BMP is, rather than assuming", () => {
		const width = 8;
		const height = 16;
		const stride = width * 3 + ((4 - ((width * 3) % 4)) % 4);
		const make = (topDown: boolean): ArtImage => {
			const bytes = Buffer.alloc(54 + stride * height);
			bytes.write("BM", 0, "ascii");
			bytes.writeUInt32LE(54, 10);
			bytes.writeUInt32LE(40, 14);
			bytes.writeInt32LE(width, 18);
			bytes.writeInt32LE(topDown ? -height : height, 22);
			bytes.writeUInt16LE(24, 28);
			// First stored row white, second black — which end of the picture that is
			// depends entirely on the sign of the height.
			for (let y = 0; y < height; y++) {
				const value = y < 8 ? 255 : 0;
				for (let x = 0; x < width; x++) bytes.fill(value, 54 + y * stride + x * 3, 54 + y * stride + x * 3 + 3);
			}
			return artOf(bytes, "bmp");
		};
		const bottomUp = lumaGrid(make(false));
		const topDown = lumaGrid(make(true));
		assert.ok(bottomUp && topDown);
		assert.equal(bottomUp.data[0], 0, "bottom-up: the last stored row is at the top");
		assert.equal(topDown.data[0], 255, "top-down: the first stored row is at the top");
	});

	it("computes a cover only once, however often it is asked", () => {
		// The progress ticks once a second; decoding per repaint would be absurd.
		const art = jpeg({ width: 64, height: 64, luma: () => 90 });
		const first = lumaGrid(art);
		assert.ok(first);
		assert.equal(lumaGrid(art), first, "the same buffer must give back the same grid object");
	});
});

describe("refusing to read a cover it cannot trust", () => {
	const cases: [string, () => ArtImage][] = [
		["a progressive JPEG", () => jpeg({ width: 16, height: 16, luma: () => 100, progressive: true })],
		["an empty buffer", () => artOf(Buffer.alloc(0))],
		["something that is not a JPEG at all", () => artOf(Buffer.alloc(512, 0x41))],
		[
			"a truncated entropy stream",
			() => artOf(tinyJpeg({ width: 64, height: 64, luma: () => 100 }).subarray(0, 120)),
		],
		[
			"a frame larger than anything real",
			() => {
				const bytes = tinyJpeg({ width: 16, height: 16, luma: () => 100 });
				// Rewrite the SOF's dimensions to something absurd.
				const sof = bytes.indexOf(Buffer.from([0xff, 0xc0]) as unknown as Uint8Array);
				bytes.writeUInt16BE(60000, sof + 5);
				bytes.writeUInt16BE(60000, sof + 7);
				return artOf(bytes);
			},
		],
		["a BMP header with nothing behind it", () => artOf(Buffer.from("BM" + "\0".repeat(60)), "bmp")],
	];

	for (const [what, build] of cases) {
		it(`answers "unknown" for ${what}`, () => {
			assert.equal(lumaGrid(build()), undefined);
		});
	}

	it("never throws and never hangs, whatever a mutated cover looks like", () => {
		// A cover arrives from an unauthenticated peer on the LAN. The invariant is not
		// that the decoder is right — it is that it always returns, quickly, without an
		// unchecked access. Mutating a valid image reaches states a random generator
		// never would: a plausible header with one field that lies.
		const seed = tinyJpeg({ width: 64, height: 64, layout: "420", luma: (c, r) => (c * 8 + r * 4) % 256 });
		fuzzEach(
			config,
			(rng) => mutate(rng, seed),
			(bytes) => {
				expectFastCompletion(
					() => {
						const grid = expectOnlyDeliberateErrors(() => lumaGrid(artOf(bytes)), "lumaGrid");
						if (grid) {
							assert.ok(grid.width > 0 && grid.height > 0);
							assert.equal(grid.data.length, grid.width * grid.height);
							assert.ok(
								[...grid.data].every((v) => v >= 0 && v <= 255),
								"a sample outside 0…255 would poison every colour decision",
							);
						}
					},
					FAST_BUDGET_MS,
					"lumaGrid on a mutated cover",
				);
			},
		);
	});

	it("stays bounded when the picture claims to be enormous", () => {
		// The cap is on blocks, not on bytes: a few hundred bytes of header can claim an
		// image with millions of them, and the MCU loop would happily try.
		const bytes = tinyJpeg({ width: 16, height: 16, luma: () => 100 });
		const sof = bytes.indexOf(Buffer.from([0xff, 0xc0]) as unknown as Uint8Array);
		bytes.writeUInt16BE(4096, sof + 5);
		bytes.writeUInt16BE(4096, sof + 7);
		expectFastCompletion(() => assert.equal(lumaGrid(artOf(bytes)), undefined), 50, "an oversized frame");
	});

	it("gives one grid cell per 8x8 block, which is what the caller assumes", () => {
		const grid = lumaGrid(jpeg({ width: 40, height: 24, luma: () => 77 }));
		assert.equal(grid?.width, Math.ceil(40 / LUMA_BLOCK));
		assert.equal(grid?.height, Math.ceil(24 / LUMA_BLOCK));
	});
});
