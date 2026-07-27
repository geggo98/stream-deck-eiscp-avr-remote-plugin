/**
 * A valid JPEG of an exact byte length, containing nothing but a flat grey square.
 *
 * Exists so a recording of real cover art can go into a public repository: the frame
 * count, the per-frame chunk sizes, the packet-flag sequence and the remainder in the
 * end frame all follow from the image's **byte length** alone, so replacing the bytes
 * with a picture of our own — at exactly the same length — keeps every property a
 * replay test cares about while carrying none of the original.
 *
 * The file is built from scratch rather than by editing a real one, so nothing of the
 * original survives, not even its encoder tables:
 *
 *   - **Custom Huffman tables with a single symbol each.** JPEG lets a file define its
 *     own; the standard Annex K tables are 160-odd bytes of well-known constants and
 *     none of them is needed here. One 1-bit DC code and one 1-bit AC code cover a
 *     picture whose only coefficient is "no change from the previous block".
 *   - **One 8x8 block**, DC difference zero. After the level shift that is mid grey,
 *     and the entropy-coded scan is a single byte.
 *   - **COM segments for the padding.** A comment may hold 65 533 bytes and decoders
 *     skip it, so any target length above the ~90-byte base is reachable exactly.
 *
 * Verified by decoding the result with an actual JPEG decoder — see
 * `tests/synthetic-jpeg.test.ts`, which refuses to accept a file it cannot read back.
 */

/** Largest payload one COM segment can carry (the 2-byte length field includes itself). */
const MAX_COM_PAYLOAD = 65_533;
/** Smallest COM segment: marker plus an empty length field. */
const MIN_COM_BYTES = 4;

function marker(code: number): Buffer {
	return Buffer.from([0xff, code]);
}

/** A segment: marker, then a big-endian length that counts itself. */
function segment(code: number, body: Buffer): Buffer {
	const length = Buffer.alloc(2);
	length.writeUInt16BE(body.length + 2, 0);
	return Buffer.concat([marker(code), length, body]);
}

/**
 * Quantisation table, all ones.
 *
 * Values do not matter for a flat image — every AC coefficient is zero either way —
 * and 1 keeps the table trivially valid (0 would be a division by zero for a decoder).
 */
function quantisationTable(): Buffer {
	return segment(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 0x01)]));
}

/** Baseline frame header: 8-bit, one component, no subsampling. */
function frameHeader(size: number): Buffer {
	const body = Buffer.alloc(9);
	body.writeUInt8(8, 0); // sample precision
	body.writeUInt16BE(size, 1); // height
	body.writeUInt16BE(size, 3); // width
	body.writeUInt8(1, 5); // one component
	body.writeUInt8(1, 6); // component id
	body.writeUInt8(0x11, 7); // sampling factors 1x1
	body.writeUInt8(0, 8); // quantisation table 0
	return segment(0xc0, body);
}

/**
 * A Huffman table with exactly one symbol, coded as the single bit `0`.
 *
 * `class` is 0 for DC, 1 for AC. BITS says "one code of length 1"; HUFFVAL says that
 * code means symbol 0 — which is "category 0" for DC (no change) and "end of block"
 * for AC.
 */
function huffmanTable(tableClass: 0 | 1): Buffer {
	const bits = Buffer.alloc(16);
	bits.writeUInt8(1, 0);
	return segment(0xc4, Buffer.concat([Buffer.from([tableClass << 4]), bits, Buffer.from([0x00])]));
}

/** Scan header: one component, using DC table 0 and AC table 0. */
function scanHeader(): Buffer {
	return segment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
}

/**
 * The entropy-coded data: one block, DC category 0 then end-of-block.
 *
 * Both symbols are the single bit `0` with the tables above, so the whole scan is the
 * two bits `00`, padded to a byte with ones as the standard requires: `0b00111111`.
 */
function scanData(): Buffer {
	return Buffer.from([0x3f]);
}

function comSegment(payload: number): Buffer {
	return segment(0xfe, Buffer.alloc(payload, 0x20));
}

export interface SyntheticJpegOptions {
	/** Square edge length written into the header. Purely cosmetic here. */
	size?: number;
}

/** The smallest file this can produce; a target below it cannot be met exactly. */
export function minimumJpegBytes(options: SyntheticJpegOptions = {}): number {
	return baseParts(options.size ?? 8).reduce((n, p) => n + p.length, 0);
}

function baseParts(size: number): Buffer[] {
	return [
		marker(0xd8), // SOI
		quantisationTable(),
		frameHeader(size),
		huffmanTable(0),
		huffmanTable(1),
		scanHeader(),
		scanData(),
		marker(0xd9), // EOI
	];
}

/**
 * Build a valid JPEG of exactly `targetBytes`.
 *
 * Throws rather than approximating: the whole point is that the replacement occupies
 * the same space as the original, so "close enough" would silently change the frame
 * count of every replay.
 */
export function syntheticJpeg(targetBytes: number, options: SyntheticJpegOptions = {}): Buffer {
	if (!Number.isInteger(targetBytes) || targetBytes <= 0) {
		throw new Error(`syntheticJpeg: target must be a positive integer, got ${targetBytes}`);
	}
	const size = options.size ?? 8;
	const parts = baseParts(size);
	const base = parts.reduce((n, p) => n + p.length, 0);
	let padding = targetBytes - base;
	if (padding < 0) {
		throw new Error(`syntheticJpeg: ${targetBytes} bytes is below the ${base}-byte minimum`);
	}
	if (padding > 0 && padding < MIN_COM_BYTES) {
		throw new Error(
			`syntheticJpeg: cannot pad by ${padding} bytes — a comment segment costs at least ${MIN_COM_BYTES}`,
		);
	}

	const comments: Buffer[] = [];
	while (padding > 0) {
		const payload = Math.min(MAX_COM_PAYLOAD, padding - MIN_COM_BYTES);
		comments.push(comSegment(payload));
		padding -= payload + MIN_COM_BYTES;
	}

	// Comments go after SOI and before the tables; decoders skip them wherever they
	// sit, but keeping them at the front leaves the image structure easy to read.
	const [soi, ...rest] = parts;
	const out = Buffer.concat([soi!, ...comments, ...rest]);
	if (out.length !== targetBytes) {
		throw new Error(`syntheticJpeg: produced ${out.length} bytes, wanted ${targetBytes}`);
	}
	return out;
}
