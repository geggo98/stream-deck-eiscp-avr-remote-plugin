/**
 * How bright the cover is, in blocks — just enough to choose a colour to draw on it.
 *
 * The progress ring and bar sit on top of artwork the plugin does not choose, so the
 * colour has to come from the picture. That needs pixels, and until now nothing here
 * read further than the image header (`imageSize`).
 *
 * ## Why this is our own code and not a dependency
 *
 * The obvious candidate, `jpeg-js`, last shipped in June 2022 and carries two DoS
 * advisories — CVE-2022-25851 (an input that makes it loop forever, CVSS 7.5) and
 * CVE-2020-8175 (unbounded resource use). An unmaintained parser pointed at
 * unauthenticated LAN traffic is a bad trade, and running it safely (a worker thread
 * with `resourceLimits` and a `terminate()` deadline) costs more than the decoding it
 * would do. Note what both advisories are, though: **denial of service, not remote code
 * execution.** The classic multimedia RCE lives in *native* decoders with memory bugs;
 * JavaScript cannot corrupt memory, so the worst case here is a wrong grid or a thrown
 * exception — both of which end as "unknown", which means white.
 *
 * ## What it reads
 *
 * Only the DC coefficient of each 8x8 block, which is that block's average — an
 * eight-times smaller picture, and all a colour decision needs. The 63 AC coefficients
 * are decoded and thrown away, because a Huffman stream cannot be skipped through.
 * Everything else about the image (the IDCT, the chroma planes, upsampling) is never
 * touched.
 *
 * ## Bounded by construction, because the bytes are hostile
 *
 * Dimensions and block counts are capped; the per-block loop can only run 64 times
 * because `k` strictly increases; the bit reader throws at the end of the buffer rather
 * than wrapping; there is no recursion and no allocation beyond the fixed grid. The one
 * public entry point catches everything and answers `undefined`, so a malformed cover
 * costs a colour, never a plugin.
 */

import { MAX_ART_BYTES, type ArtImage } from "../adapter/eiscp/jacket-art.ts";

/** One cell per 8x8 source block, row-major, 0…255. */
export interface LumaGrid {
	width: number;
	height: number;
	data: Uint8Array;
}

/** Source pixels per grid cell, in both directions. */
export const LUMA_BLOCK = 8;

/** Caps. Generous for real album art, finite for anything else. */
const MAX_DIMENSION = 4096;
const MAX_BLOCKS = 200_000;
const MAX_COMPONENTS = 4;

/**
 * Computed once per cover and remembered weakly.
 *
 * `null` records "we tried and it did not work", so a cover that cannot be read is not
 * decoded again on every repaint — which, with the progress ticking, would be once a
 * second.
 */
const gridByArt = new WeakMap<Buffer, LumaGrid | null>();

/**
 * The block-average brightness of a cover, or `undefined` when it cannot be read.
 *
 * `undefined` is a normal answer, not a failure to report: progressive JPEGs, unusual
 * BMP variants and anything malformed all land here, and the caller's fallback (white)
 * is a perfectly good colour.
 */
export function lumaGrid(art: ArtImage): LumaGrid | undefined {
	const cached = gridByArt.get(art.bytes);
	if (cached !== undefined) return cached ?? undefined;
	let grid: LumaGrid | undefined;
	try {
		grid = art.bytes.length > MAX_ART_BYTES ? undefined : decode(art);
	} catch {
		// Every parse error, cap breach and short read arrives here. There is nothing to
		// log: this runs per cover, the input is device-controlled, and the consequence
		// is a white ring.
		grid = undefined;
	}
	gridByArt.set(art.bytes, grid ?? null);
	return grid;
}

function decode(art: ArtImage): LumaGrid | undefined {
	return art.type === "bmp" ? decodeBmp(art.bytes) : decodeJpegDc(art.bytes);
}

// ---------------------------------------------------------------------------
// BMP — the easy half: the pixels are simply there
// ---------------------------------------------------------------------------

function decodeBmp(b: Buffer): LumaGrid | undefined {
	if (b.length < 54) return undefined;
	const dataOffset = b.readUInt32LE(10);
	const width = b.readInt32LE(18);
	const rawHeight = b.readInt32LE(22);
	const bpp = b.readUInt16LE(28);
	const compression = b.readUInt32LE(30);
	const height = Math.abs(rawHeight);
	// A negative height means top-down rows; it says nothing about the size.
	const topDown = rawHeight < 0;
	if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) return undefined;
	// 24- and 32-bit uncompressed only. RLE and palettes are not worth the code for a
	// container this firmware sends as an alternative to JPEG at best.
	if ((bpp !== 24 && bpp !== 32) || (compression !== 0 && compression !== 3)) return undefined;

	const bytesPerPixel = bpp / 8;
	const stride = Math.floor((width * bytesPerPixel + 3) / 4) * 4;
	if (dataOffset + stride * height > b.length) return undefined;

	const grid = emptyGrid(width, height);
	const sums = new Float64Array(grid.width * grid.height);
	const counts = new Uint32Array(grid.width * grid.height);
	for (let y = 0; y < height; y++) {
		const sourceRow = topDown ? y : height - 1 - y;
		const rowStart = dataOffset + sourceRow * stride;
		const cellRow = Math.floor(y / LUMA_BLOCK);
		for (let x = 0; x < width; x++) {
			const p = rowStart + x * bytesPerPixel;
			// BMP stores BGR.
			const luma = 0.114 * b[p]! + 0.587 * b[p + 1]! + 0.299 * b[p + 2]!;
			const cell = cellRow * grid.width + Math.floor(x / LUMA_BLOCK);
			sums[cell]! += luma;
			counts[cell]!++;
		}
	}
	for (let i = 0; i < grid.data.length; i++) {
		grid.data[i] = counts[i] ? Math.round(sums[i]! / counts[i]!) : 0;
	}
	return grid;
}

function emptyGrid(width: number, height: number): LumaGrid {
	const w = Math.ceil(width / LUMA_BLOCK);
	const h = Math.ceil(height / LUMA_BLOCK);
	return { width: w, height: h, data: new Uint8Array(w * h) };
}

// ---------------------------------------------------------------------------
// Baseline JPEG — DC coefficients only
// ---------------------------------------------------------------------------

interface HuffmanTable {
	/** `(length << 16) | code` -> symbol. Built once per table, read per symbol. */
	lookup: Map<number, number>;
	maxLength: number;
}

interface FrameComponent {
	id: number;
	h: number;
	v: number;
	quantTable: number;
}

function buildHuffmanTable(counts: Uint8Array, symbols: Uint8Array): HuffmanTable {
	const lookup = new Map<number, number>();
	let code = 0;
	let k = 0;
	let maxLength = 0;
	for (let length = 1; length <= 16; length++) {
		for (let i = 0; i < counts[length - 1]!; i++) {
			lookup.set((length << 16) | code, symbols[k]!);
			code++;
			k++;
			maxLength = length;
		}
		code <<= 1;
	}
	return { lookup, maxLength };
}

/**
 * Reads bits out of the entropy-coded segment.
 *
 * Two JPEG facts it has to honour: a `0xFF` in the data is written as `0xFF 0x00`, and
 * a `0xFF` followed by anything else is a marker, i.e. the scan has ended. Running past
 * the buffer throws rather than returning zeroes, so a truncated image fails loudly
 * inside the `try` instead of producing a plausible-looking grid.
 */
class BitReader {
	private bitBuffer = 0;
	private bitCount = 0;
	private readonly b: Buffer;
	pos: number;

	// Written out rather than as constructor parameter properties: the test runner
	// strips types without transforming them, and a parameter property is a transform.
	constructor(b: Buffer, pos: number) {
		this.b = b;
		this.pos = pos;
	}

	readBit(): number {
		if (this.bitCount === 0) {
			if (this.pos >= this.b.length) throw new Error("out of data");
			let byte = this.b[this.pos++]!;
			if (byte === 0xff) {
				const next = this.b[this.pos];
				if (next === 0x00) this.pos++;
				else throw new Error("marker inside the scan");
			}
			this.bitBuffer = byte;
			this.bitCount = 8;
		}
		this.bitCount--;
		return (this.bitBuffer >> this.bitCount) & 1;
	}

	receive(n: number): number {
		let value = 0;
		for (let i = 0; i < n; i++) value = (value << 1) | this.readBit();
		return value;
	}

	decode(table: HuffmanTable): number {
		let code = 0;
		for (let length = 1; length <= table.maxLength; length++) {
			code = (code << 1) | this.readBit();
			const symbol = table.lookup.get((length << 16) | code);
			if (symbol !== undefined) return symbol;
		}
		throw new Error("no such Huffman code");
	}

	/** Drop the partial byte and step over a restart marker, as the spec requires. */
	restart(): void {
		this.bitCount = 0;
		while (this.pos + 1 < this.b.length) {
			if (this.b[this.pos] === 0xff) {
				const marker = this.b[this.pos + 1]!;
				if (marker >= 0xd0 && marker <= 0xd7) {
					this.pos += 2;
					return;
				}
			}
			this.pos++;
		}
		throw new Error("no restart marker where one was due");
	}
}

/** `value` is stored without its sign bit; this puts it back. */
function extend(value: number, length: number): number {
	return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
}

function decodeJpegDc(b: Buffer): LumaGrid | undefined {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return undefined;

	const quantTables: (Uint16Array | undefined)[] = [];
	const dcTables: (HuffmanTable | undefined)[] = [];
	const acTables: (HuffmanTable | undefined)[] = [];
	let components: FrameComponent[] | undefined;
	let frameWidth = 0;
	let frameHeight = 0;
	let restartInterval = 0;

	let pos = 2;
	while (pos + 3 < b.length) {
		if (b[pos] !== 0xff) return undefined;
		const marker = b[pos + 1]!;
		if (marker === 0xff) {
			pos++; // fill byte
			continue;
		}
		if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
			pos += 2;
			continue;
		}
		if (marker === 0xd9) return undefined; // end of image before any scan
		const length = b.readUInt16BE(pos + 2);
		if (length < 2 || pos + 2 + length > b.length) return undefined;
		const start = pos + 4;
		const end = pos + 2 + length;

		switch (marker) {
			case 0xdb: {
				// DQT. Only element 0 is used, but all 64 must be walked to find the next.
				let p = start;
				while (p < end) {
					const precision = b[p]! >> 4;
					const id = b[p]! & 15;
					p++;
					if (id > 3) return undefined;
					const table = new Uint16Array(64);
					for (let i = 0; i < 64; i++) {
						if (precision === 0) {
							if (p >= end) return undefined;
							table[i] = b[p++]!;
						} else {
							if (p + 1 >= end) return undefined;
							table[i] = b.readUInt16BE(p);
							p += 2;
						}
					}
					quantTables[id] = table;
				}
				break;
			}
			case 0xc4: {
				let p = start;
				while (p < end) {
					const tableClass = b[p]! >> 4;
					const id = b[p]! & 15;
					p++;
					if (id > 3 || tableClass > 1 || p + 16 > end) return undefined;
					const counts = new Uint8Array(b.subarray(p, p + 16));
					p += 16;
					let total = 0;
					for (const c of counts) total += c;
					if (total > 256 || p + total > end) return undefined;
					const symbols = new Uint8Array(b.subarray(p, p + total));
					p += total;
					const table = buildHuffmanTable(counts, symbols);
					if (tableClass === 0) dcTables[id] = table;
					else acTables[id] = table;
				}
				break;
			}
			case 0xc0:
			case 0xc1: {
				// SOF0/SOF1 — baseline and extended sequential, both Huffman-coded.
				if (start + 5 > end) return undefined;
				frameHeight = b.readUInt16BE(start + 1);
				frameWidth = b.readUInt16BE(start + 3);
				const count = b[start + 5]!;
				if (count < 1 || count > MAX_COMPONENTS) return undefined;
				if (frameWidth <= 0 || frameHeight <= 0) return undefined;
				if (frameWidth > MAX_DIMENSION || frameHeight > MAX_DIMENSION) return undefined;
				if (start + 6 + count * 3 > end) return undefined;
				components = [];
				for (let i = 0; i < count; i++) {
					const p = start + 6 + i * 3;
					const h = b[p + 1]! >> 4;
					const v = b[p + 1]! & 15;
					if (h < 1 || h > 4 || v < 1 || v > 4) return undefined;
					components.push({ id: b[p]!, h, v, quantTable: b[p + 2]! });
				}
				break;
			}
			case 0xdd:
				if (start + 1 >= end) return undefined;
				restartInterval = b.readUInt16BE(start);
				break;
			case 0xda:
				return scan(b, end, start, components, frameWidth, frameHeight, restartInterval, {
					quantTables,
					dcTables,
					acTables,
				});
			default:
				// Everything with a length we do not need: APPn, COM, and — deliberately —
				// SOF2 (progressive), SOF3/9/10/11 (lossless, arithmetic). Those cannot be
				// read by a DC-only decoder, and guessing is worse than saying "unknown".
				if (marker === 0xc2 || (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc)) {
					return undefined;
				}
				break;
		}
		pos = end;
	}
	return undefined;
}

interface Tables {
	quantTables: (Uint16Array | undefined)[];
	dcTables: (HuffmanTable | undefined)[];
	acTables: (HuffmanTable | undefined)[];
}

function scan(
	b: Buffer,
	headerEnd: number,
	headerStart: number,
	components: FrameComponent[] | undefined,
	frameWidth: number,
	frameHeight: number,
	restartInterval: number,
	tables: Tables,
): LumaGrid | undefined {
	if (!components || components.length === 0) return undefined;
	const scanCount = b[headerStart]!;
	if (scanCount < 1 || scanCount > components.length) return undefined;
	if (headerStart + 1 + scanCount * 2 > headerEnd) return undefined;

	// Which Huffman tables this scan assigned to each frame component.
	const dcOf = new Map<number, number>();
	const acOf = new Map<number, number>();
	for (let i = 0; i < scanCount; i++) {
		const p = headerStart + 1 + i * 2;
		dcOf.set(b[p]!, b[p + 1]! >> 4);
		acOf.set(b[p]!, b[p + 1]! & 15);
	}
	// A scan that does not carry every component is an interleaving we do not support.
	if (dcOf.size !== components.length) return undefined;

	const maxH = Math.max(...components.map((c) => c.h));
	const maxV = Math.max(...components.map((c) => c.v));
	const mcusX = Math.ceil(frameWidth / (LUMA_BLOCK * maxH));
	const mcusY = Math.ceil(frameHeight / (LUMA_BLOCK * maxV));
	let blocksPerMcu = 0;
	for (const c of components) blocksPerMcu += c.h * c.v;
	if (mcusX * mcusY * blocksPerMcu > MAX_BLOCKS) return undefined;

	// Component 0 is the luminance plane in every layout this can meet: three-component
	// YCbCr, or a single-component greyscale image where it is the image itself.
	const luma = components[0]!;
	const quant = tables.quantTables[luma.quantTable];
	if (!quant || quant[0] === 0) return undefined;
	const grid = emptyGrid(frameWidth, frameHeight);

	const reader = new BitReader(b, headerEnd);
	const predictors = new Int32Array(components.length);
	let sinceRestart = 0;

	for (let my = 0; my < mcusY; my++) {
		for (let mx = 0; mx < mcusX; mx++) {
			if (restartInterval > 0 && sinceRestart === restartInterval) {
				reader.restart();
				predictors.fill(0);
				sinceRestart = 0;
			}
			for (const [ci, component] of components.entries()) {
				const dcTable = tables.dcTables[dcOf.get(component.id) ?? -1];
				const acTable = tables.acTables[acOf.get(component.id) ?? -1];
				if (!dcTable || !acTable) return undefined;
				for (let by = 0; by < component.v; by++) {
					for (let bx = 0; bx < component.h; bx++) {
						const length = reader.decode(dcTable);
						if (length > 16) return undefined;
						const diff = length === 0 ? 0 : extend(reader.receive(length), length);
						predictors[ci] = predictors[ci]! + diff;
						// The 63 AC coefficients are read only to reach the next block. `k`
						// strictly increases, so this cannot run more than 64 times.
						for (let k = 1; k < 64; ) {
							const rs = reader.decode(acTable);
							const size = rs & 15;
							const run = rs >> 4;
							if (size === 0) {
								if (run !== 15) break; // end of block
								k += 16;
								continue;
							}
							k += run + 1;
							if (k > 64) return undefined;
							reader.receive(size);
						}
						if (component !== luma) continue;
						// The DC coefficient dequantised is eight times the block's mean, and
						// samples are stored level-shifted by 128.
						const mean = (predictors[ci]! * quant[0]!) / 8 + 128;
						const row = my * component.v + by;
						const col = mx * component.h + bx;
						// MCUs are padded out past the image edge; those blocks are decoded
						// (the stream demands it) but must not reach the grid.
						if (row < grid.height && col < grid.width) {
							grid.data[row * grid.width + col] = Math.max(0, Math.min(255, Math.round(mean)));
						}
					}
				}
			}
			sinceRestart++;
		}
	}
	return grid;
}
