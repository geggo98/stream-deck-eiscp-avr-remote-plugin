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
 * Everything else about the image (the IDCT, upsampling) is never touched.
 *
 * **All three planes are kept, not just luminance**, and that costs almost nothing: the
 * DC predictor is carried for every component anyway — a stream cannot be walked
 * otherwise — so Cb and Cr were being computed and dropped one line before they were
 * stored. What they buy is a rough answer to "where are there people in this picture",
 * which is what stops the touch strip cropping through a face. Chroma is subsampled
 * (usually 2x2), so it is nailed onto the luminance grid on the way out and everything
 * downstream can work on one raster.
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

/**
 * The three planes of a cover, all on the luminance grid.
 *
 * `cb`/`cr` are absent for a greyscale image, which is a normal answer rather than a
 * failure: there is no colour to read, so nothing downstream that needs colour can run.
 * Both are stored the way JPEG stores them — 128 is neutral, below is one direction and
 * above the other — so a consumer can use them without knowing where they came from.
 */
export interface CoverGrids {
	luma: LumaGrid;
	cb?: LumaGrid;
	cr?: LumaGrid;
	/**
	 * The brightness again, at half the source resolution — actual samples rather than
	 * block averages.
	 *
	 * Same shape as the grids above and a completely different meaning: here one entry is
	 * 2x2 source pixels (`DETAIL_BLOCK`), not 8x8. It exists because a face detector needs
	 * to see eyes, and a block average is exactly the resolution at which eyes disappear.
	 * Absent for BMP, for an image too large to be worth it, and whenever the scan did not
	 * produce one.
	 */
	detail?: LumaGrid;
}

/** Source pixels per grid cell, in both directions. */
export const LUMA_BLOCK = 8;

/**
 * Source pixels per sample of the `detail` image, in both directions.
 *
 * Half scale: four samples across each 8x8 block. See `decodeDetailBlock` for why that
 * falls out of keeping a 4x4 corner of the coefficients rather than being chosen.
 */
export const DETAIL_BLOCK = 2;

/** Largest detail image built, in samples. A cover is 256x256 here; this is 16x that. */
const MAX_DETAIL_SAMPLES = 1024 * 1024;

/** What a chroma sample means when it says "no colour in this direction". */
export const CHROMA_NEUTRAL = 128;

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
const gridsByArt = new WeakMap<Buffer, CoverGrids | null>();

/**
 * The block averages of a cover, or `undefined` when it cannot be read.
 *
 * `undefined` is a normal answer, not a failure to report: progressive JPEGs, unusual
 * BMP variants and anything malformed all land here, and every caller has a defined
 * fallback for it (a white ring, a centred crop).
 */
export function coverGrids(art: ArtImage): CoverGrids | undefined {
	const cached = gridsByArt.get(art.bytes);
	if (cached !== undefined) return cached ?? undefined;
	let grids: CoverGrids | undefined;
	try {
		grids = art.bytes.length > MAX_ART_BYTES ? undefined : decode(art);
	} catch {
		// Every parse error, cap breach and short read arrives here. There is nothing to
		// log: this runs per cover, the input is device-controlled, and the consequence
		// is a white ring.
		grids = undefined;
	}
	gridsByArt.set(art.bytes, grids ?? null);
	return grids;
}

/** The brightness plane on its own, which is all the progress colour needs. */
export function lumaGrid(art: ArtImage): LumaGrid | undefined {
	return coverGrids(art)?.luma;
}

function decode(art: ArtImage): CoverGrids | undefined {
	return art.type === "bmp" ? decodeBmp(art.bytes) : decodeJpegDc(art.bytes);
}

// ---------------------------------------------------------------------------
// BMP — the easy half: the pixels are simply there
// ---------------------------------------------------------------------------

function decodeBmp(b: Buffer): CoverGrids | undefined {
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

	const luma = emptyGrid(width, height);
	const cb = emptyGrid(width, height);
	const cr = emptyGrid(width, height);
	const cells = luma.width * luma.height;
	const lumaSums = new Float64Array(cells);
	const cbSums = new Float64Array(cells);
	const crSums = new Float64Array(cells);
	const counts = new Uint32Array(cells);
	for (let y = 0; y < height; y++) {
		const sourceRow = topDown ? y : height - 1 - y;
		const rowStart = dataOffset + sourceRow * stride;
		const cellRow = Math.floor(y / LUMA_BLOCK);
		for (let x = 0; x < width; x++) {
			const p = rowStart + x * bytesPerPixel;
			// BMP stores BGR. The same BT.601 conversion JPEG uses, so a cover in either
			// container produces comparable numbers — which matters, because the skin test
			// downstream is expressed in JPEG's own Cb/Cr units.
			const blue = b[p]!;
			const green = b[p + 1]!;
			const red = b[p + 2]!;
			const cell = cellRow * luma.width + Math.floor(x / LUMA_BLOCK);
			const y601 = 0.299 * red + 0.587 * green + 0.114 * blue;
			lumaSums[cell]! += y601;
			cbSums[cell]! += CHROMA_NEUTRAL + (0.5 * (blue - y601)) / (1 - 0.114);
			crSums[cell]! += CHROMA_NEUTRAL + (0.5 * (red - y601)) / (1 - 0.299);
			counts[cell]!++;
		}
	}
	for (const [plane, sums] of [
		[luma, lumaSums],
		[cb, cbSums],
		[cr, crSums],
	] as const) {
		for (let cell = 0; cell < plane.data.length; cell++) {
			plane.data[cell] = counts[cell] ? clampByte(sums[cell]! / counts[cell]!) : 0;
		}
	}
	return { luma, cb, cr };
}

function clampByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
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

/** Zig-zag order to natural `row * 8 + col`. The order coefficients arrive in. */
const ZIGZAG = new Uint8Array([
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
	28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
	47, 55, 62, 63,
]);

/** How far into the block a coefficient may sit and still be kept, per axis. */
const DETAIL_ORDER = 4;

/**
 * `C(u) * cos(u*pi/16) * cos((2X+1)*u*pi/8)`, indexed `[X * 4 + u]`.
 *
 * The whole of the transform below, and every term in it is there for a reason:
 *
 *   - `C(u)` is JPEG's own normalisation, `1/sqrt(2)` at `u = 0`.
 *   - `cos(u*pi/16)` is what averaging pairs of pixels does to the basis functions.
 *     Summing `cos((2x+1)u*pi/16)` over `x = 2X, 2X+1` gives exactly
 *     `2*cos(u*pi/16)*cos((2X+1)u*pi/8)`, so the pooling folds into the constants and
 *     costs nothing at run time.
 *   - the second cosine is the four-point basis the output is expressed in.
 */
const DETAIL_COS = buildDetailCosines();

function buildDetailCosines(): Float64Array {
	const table = new Float64Array(DETAIL_ORDER * DETAIL_ORDER);
	for (let x = 0; x < DETAIL_ORDER; x++) {
		for (let u = 0; u < DETAIL_ORDER; u++) {
			const normalise = u === 0 ? Math.SQRT1_2 : 1;
			table[x * DETAIL_ORDER + u] =
				normalise * Math.cos((u * Math.PI) / 16) * Math.cos(((2 * x + 1) * u * Math.PI) / 8);
		}
	}
	return table;
}

/**
 * Turn one block's low-frequency corner into 4x4 samples of the picture.
 *
 * **Half scale is what a 4x4 corner gives, not a target that was aimed at.** An 8x8 block
 * described by its lowest 4x4 coefficients reconstructs as 4x4 samples, each the average
 * of a 2x2 group of pixels — so keeping a quarter of the coefficients per axis halves the
 * resolution per axis. For the covers this sees that is 512 -> 256, which is what makes a
 * face detector's smallest window mean a face of ~90 source pixels rather than ~180.
 *
 * Everything above the corner is dropped rather than approximated. That is a downscale
 * with no low-pass filter, so it aliases, and for finding faces that does not matter: the
 * cost of the alternative is a full inverse transform and four times the samples, to give
 * a detector a sharper version of a picture it is going to blur into rectangle sums
 * anyway.
 *
 * The samples come back level-shifted and clamped, ready to use as pixels.
 */
function detailBlock(coefficients: Float64Array, out: Float64Array): void {
	// Rows first, then columns: 32 multiplications instead of 256 for the same result.
	const rows = new Float64Array(DETAIL_ORDER * DETAIL_ORDER);
	for (let v = 0; v < DETAIL_ORDER; v++) {
		for (let x = 0; x < DETAIL_ORDER; x++) {
			let sum = 0;
			for (let u = 0; u < DETAIL_ORDER; u++) sum += DETAIL_COS[x * DETAIL_ORDER + u]! * coefficients[v * DETAIL_ORDER + u]!;
			rows[v * DETAIL_ORDER + x] = sum;
		}
	}
	for (let y = 0; y < DETAIL_ORDER; y++) {
		for (let x = 0; x < DETAIL_ORDER; x++) {
			let sum = 0;
			for (let v = 0; v < DETAIL_ORDER; v++) sum += DETAIL_COS[y * DETAIL_ORDER + v]! * rows[v * DETAIL_ORDER + x]!;
			// A quarter, and then the level shift: at DC alone this has to come out as
			// `F(0,0) / 8 + 128`, the same block mean the grid above carries.
			out[y * DETAIL_ORDER + x] = sum / 4 + 128;
		}
	}
}

function decodeJpegDc(b: Buffer): CoverGrids | undefined {
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
): CoverGrids | undefined {
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

	/**
	 * **A scan carrying one component is not interleaved, and its data unit is one block.**
	 *
	 * The sampling factors in the frame header describe how components relate to each
	 * other; with only one component there is nothing to relate it to, so the spec says the
	 * blocks arrive as a plain raster and the factors group nothing. Greyscale JPEGs
	 * routinely still declare `2x2` — the Library of Congress's scans of the Gottlieb jazz
	 * photographs all do — and reading those as interleaved asks for 4x the blocks per MCU
	 * over an MCU grid that is half as wide and half as tall. For a 500x529 picture that is
	 * 4352 blocks demanded against 4221 present: the reader runs off the end of the scan and
	 * the whole cover comes back as "unreadable".
	 *
	 * Found by pointing the corpus at real photographs. Nothing synthetic had caught it,
	 * because the suite's own encoder writes `1x1` for greyscale — which is legal, common,
	 * and exactly the case that already worked.
	 */
	const interleaved = components.length > 1;
	const unitH = interleaved ? undefined : 1;
	const unitV = interleaved ? undefined : 1;
	const mcusX = interleaved ? Math.ceil(frameWidth / (LUMA_BLOCK * maxH)) : Math.ceil(frameWidth / LUMA_BLOCK);
	const mcusY = interleaved ? Math.ceil(frameHeight / (LUMA_BLOCK * maxV)) : Math.ceil(frameHeight / LUMA_BLOCK);
	/** Blocks of `component` in one data unit, which is one when the scan is not interleaved. */
	const unitsOf = (component: FrameComponent): { h: number; v: number } => ({
		h: unitH ?? component.h,
		v: unitV ?? component.v,
	});

	let blocksPerMcu = 0;
	for (const c of components) blocksPerMcu += unitsOf(c).h * unitsOf(c).v;
	if (mcusX * mcusY * blocksPerMcu > MAX_BLOCKS) return undefined;

	// Component 0 is the luminance plane in every layout this can meet: three-component
	// YCbCr, or a single-component greyscale image where it is the image itself.
	const luma = components[0]!;
	if (!tables.quantTables[luma.quantTable]?.[0]) return undefined;

	// One plane of block means per component, at that component's own sampling. They are
	// nailed onto a common grid at the end rather than here, because the alignment needs
	// the frame's maximum sampling factors and this loop is the hot one.
	//
	// A component whose quantisation table is missing is simply not collected. Strictly
	// that file is broken — but only the luminance table was ever required here, so
	// rejecting the whole cover for a missing chroma table would turn covers that render
	// today into "unreadable", i.e. a white ring, to gain nothing.
	const planes = components.map((c) => {
		const quant = tables.quantTables[c.quantTable];
		const unit = unitsOf(c);
		return quant?.[0] ? new Uint8Array(mcusX * unit.h * mcusY * unit.v) : undefined;
	});

	// The half-resolution picture, built as the scan goes rather than from stored
	// coefficients: one block's worth of scratch is all it needs, so a cover of any size
	// costs the output image and nothing else.
	const detail =
		Math.ceil(frameWidth / DETAIL_BLOCK) * Math.ceil(frameHeight / DETAIL_BLOCK) <= MAX_DETAIL_SAMPLES
			? { width: Math.ceil(frameWidth / DETAIL_BLOCK), height: Math.ceil(frameHeight / DETAIL_BLOCK), data: new Uint8Array(0) }
			: undefined;
	if (detail) detail.data = new Uint8Array(detail.width * detail.height);
	const lumaQuant = tables.quantTables[luma.quantTable]!;
	const coefficients = new Float64Array(DETAIL_ORDER * DETAIL_ORDER);
	const samples = new Float64Array(DETAIL_ORDER * DETAIL_ORDER);

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
				const unit = unitsOf(component);
				for (let by = 0; by < unit.v; by++) {
					for (let bx = 0; bx < unit.h; bx++) {
						const length = reader.decode(dcTable);
						if (length > 16) return undefined;
						const diff = length === 0 ? 0 : extend(reader.receive(length), length);
						predictors[ci] = predictors[ci]! + diff;
						// The AC coefficients have to be walked whatever happens — a Huffman
						// stream cannot be skipped through — so the only question is whether
						// anything is done with them. For the brightness plane the lowest 4x4
						// are kept, which is a store rather than any extra decoding; the rest
						// are still read and dropped. `k` strictly increases, so this cannot
						// run more than 64 times.
						const wantDetail = detail !== undefined && component === luma;
						if (wantDetail) coefficients.fill(0);
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
							const raw = reader.receive(size);
							if (!wantDetail) continue;
							// `k` has already moved past this coefficient, so it belongs to
							// `k - 1` — and the quantisation table is stored in the same
							// zig-zag order the coefficients arrive in.
							const natural = ZIGZAG[k - 1]!;
							const row = natural >> 3;
							const col = natural & 7;
							if (row < DETAIL_ORDER && col < DETAIL_ORDER) {
								coefficients[row * DETAIL_ORDER + col] = extend(raw, size) * lumaQuant[k - 1]!;
							}
						}
						if (wantDetail && detail) {
							coefficients[0] = predictors[ci]! * lumaQuant[0]!;
							detailBlock(coefficients, samples);
							writeDetail(detail, samples, (mx * unit.h + bx) * DETAIL_ORDER, (my * unit.v + by) * DETAIL_ORDER);
						}
						const plane = planes[ci];
						if (!plane) continue;
						// The DC coefficient dequantised is eight times the block's mean, and
						// samples are stored level-shifted by 128. True for chroma as well —
						// there 128 is the neutral point rather than mid grey.
						const mean = (predictors[ci]! * tables.quantTables[component.quantTable]![0]!) / 8 + 128;
						const row = my * unit.v + by;
						const col = mx * unit.h + bx;
						plane[row * (mcusX * unit.h) + col] = clampByte(mean);
					}
				}
			}
			sinceRestart++;
		}
	}

	// MCUs are padded out past the image edge, so the planes are at least as large as the
	// grid and often larger; the sampling below simply never reaches the padding.
	const grids: CoverGrids = { luma: emptyGrid(frameWidth, frameHeight), ...(detail ? { detail } : {}) };
	// Components 1 and 2 are Cb and Cr **only** in a three-component frame. One component
	// is greyscale, and four is CMYK or YCCK — where the same indices mean something else
	// entirely, so the colour is left unread rather than misread.
	const hasChroma = components.length === 3;
	for (const [ci, component] of components.entries()) {
		const plane = planes[ci];
		if (!plane || (ci > 0 && !hasChroma)) continue;
		const target = ci === 0 ? grids.luma : emptyGrid(frameWidth, frameHeight);
		const unit = unitsOf(component);
		resample(plane, mcusX * unit.h, target, component.h / maxH, component.v / maxV);
		if (ci === 1) grids.cb = target;
		else if (ci === 2) grids.cr = target;
	}
	return grids;
}

/**
 * Copy a component's own block plane onto the grid every consumer works on.
 *
 * Nearest neighbour, which for the ratios JPEG actually uses (1 or 1/2) means each chroma
 * block is repeated over the two-by-two luminance cells it covers. Interpolating would be
 * inventing detail that is not in the file, and everything downstream averages over
 * regions far larger than a cell anyway.
 */
/** Place one block's samples, dropping whatever falls past the picture's edge. */
function writeDetail(detail: LumaGrid, samples: Float64Array, left: number, top: number): void {
	for (let y = 0; y < DETAIL_ORDER; y++) {
		const row = top + y;
		if (row >= detail.height) break;
		for (let x = 0; x < DETAIL_ORDER; x++) {
			const col = left + x;
			if (col >= detail.width) break;
			detail.data[row * detail.width + col] = clampByte(samples[y * DETAIL_ORDER + x]!);
		}
	}
}

function resample(plane: Uint8Array, planeWidth: number, target: LumaGrid, ratioX: number, ratioY: number): void {
	const planeHeight = Math.floor(plane.length / planeWidth);
	for (let y = 0; y < target.height; y++) {
		const sourceRow = Math.min(planeHeight - 1, Math.floor(y * ratioY));
		for (let x = 0; x < target.width; x++) {
			const sourceCol = Math.min(planeWidth - 1, Math.floor(x * ratioX));
			target.data[y * target.width + x] = plane[sourceRow * planeWidth + sourceCol]!;
		}
	}
}
