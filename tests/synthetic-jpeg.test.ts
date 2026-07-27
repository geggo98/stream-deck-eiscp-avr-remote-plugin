/**
 * The generated stand-in cover.
 *
 * It exists so a recording of real album art can be committed: everything a replay
 * test cares about — frame count, chunk sizes, packet flags, the remainder in the end
 * frame — follows from the image's byte length, so a picture of our own at exactly
 * that length preserves all of it and carries none of the original.
 *
 * Two things therefore have to hold, and both are asserted from the bytes rather than
 * assumed: the length is *exact*, and the result is a real JPEG. The structure is
 * walked segment by segment here; during development the output was additionally fed
 * to an actual decoder, which read it back as a 512x512 grayscale image at each of the
 * measured cover sizes.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { minimumJpegBytes, syntheticJpeg } from "../scripts/lib/synthetic-jpeg.ts";

/** Walk the marker segments, the way a decoder would. */
function segments(jpeg: Buffer): { marker: number; length: number }[] {
	assert.equal(jpeg.readUInt16BE(0), 0xffd8, "must start with SOI");
	const found: { marker: number; length: number }[] = [];
	let i = 2;
	while (i < jpeg.length - 1) {
		assert.equal(jpeg[i], 0xff, `expected a marker at ${i}, found ${jpeg[i]?.toString(16)}`);
		const marker = jpeg[i + 1]!;
		if (marker === 0xd9) {
			found.push({ marker, length: 0 });
			break;
		}
		const length = jpeg.readUInt16BE(i + 2);
		found.push({ marker, length });
		i += 2 + length;
		// The scan runs to the end; everything after it is entropy-coded data plus EOI.
		if (marker === 0xda) {
			assert.equal(jpeg.readUInt16BE(jpeg.length - 2), 0xffd9, "must end with EOI");
			found.push({ marker: 0xd9, length: 0 });
			break;
		}
	}
	return found;
}

describe("synthetic JPEG", () => {
	it("is exactly the requested length, at every size a real cover reached", () => {
		// The measured covers: 20 752 B (the old fixture), 45 217 B and 97 357 B.
		// "Close enough" would change the frame count of every replay, so exactness is
		// the whole contract.
		for (const target of [minimumJpegBytes(), 1_000, 20_752, 45_217, 97_357, 300_000]) {
			assert.equal(syntheticJpeg(target).length, target, `target ${target}`);
		}
	});

	it("is a structurally valid baseline JPEG", () => {
		const jpeg = syntheticJpeg(45_217, { size: 512 });
		const markers = segments(jpeg).map((s) => s.marker);
		assert.ok(markers.includes(0xdb), "quantisation table");
		assert.ok(markers.includes(0xc0), "baseline frame header");
		assert.ok(markers.includes(0xc4), "Huffman table");
		assert.ok(markers.includes(0xda), "start of scan");
		assert.equal(markers[markers.length - 1], 0xd9, "end of image");
	});

	it("carries the declared dimensions", () => {
		const jpeg = syntheticJpeg(5_000, { size: 512 });
		const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
		assert.ok(sof > 0, "SOF0 present");
		assert.equal(jpeg.readUInt16BE(sof + 5), 512, "height");
		assert.equal(jpeg.readUInt16BE(sof + 7), 512, "width");
	});

	it("pads with comment segments, which decoders skip", () => {
		// The padding has to be inert. A comment is the one segment a decoder is
		// required to ignore, so the picture stays a flat square however large the file.
		const small = syntheticJpeg(minimumJpegBytes());
		const large = syntheticJpeg(97_357);
		assert.ok(!segments(small).some((s) => s.marker === 0xfe), "no padding needed at the minimum");
		const comments = segments(large).filter((s) => s.marker === 0xfe);
		assert.ok(comments.length >= 2, `97 KB needs several comments, found ${comments.length}`);
		// Each stays inside the 16-bit length field.
		for (const c of comments) assert.ok(c.length <= 65_535, `comment length ${c.length}`);
	});

	it("contains none of the original image, by construction", () => {
		// Built from scratch rather than by editing a real file, so not even the encoder
		// tables come from one: the Huffman tables define a single symbol each instead of
		// the standard 160-odd bytes of Annex K constants.
		const jpeg = syntheticJpeg(50_000);
		const huffman = segments(jpeg).filter((s) => s.marker === 0xc4);
		assert.equal(huffman.length, 2, "one DC and one AC table");
		for (const table of huffman) {
			assert.equal(table.length, 2 + 1 + 16 + 1, "a one-symbol table is 20 bytes including its length");
		}
	});

	it("refuses a target it cannot hit exactly", () => {
		// Silently approximating would change the recording it is meant to preserve.
		assert.throws(() => syntheticJpeg(minimumJpegBytes() - 1), /below the .* minimum/);
		assert.throws(() => syntheticJpeg(minimumJpegBytes() + 1), /cannot pad by 1 byte/);
		assert.throws(() => syntheticJpeg(0), /positive integer/);
		assert.throws(() => syntheticJpeg(1.5), /positive integer/);
	});

	it("is deterministic, so regenerating a fixture produces no diff", () => {
		assert.deepEqual(syntheticJpeg(12_345), syntheticJpeg(12_345));
	});
});
