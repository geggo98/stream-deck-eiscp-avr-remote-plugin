/**
 * A minimal baseline-JPEG writer, so the DC decoder can be tested against real
 * Huffman-coded bytes rather than against a fixture nobody can vary.
 *
 * It writes only what `image-luma.ts` reads: a quantisation table of all ones (so a
 * block's DC coefficient *is* eight times its mean), a frame header, two small Huffman
 * tables, and one entropy-coded scan in which every block carries a DC value and then
 * ends immediately. No AC coefficients are emitted at all — which is fine, because an
 * end-of-block symbol is exactly what the decoder must handle to reach the next block.
 *
 * The point is control: `luma(col, row)` decides what every single 8x8 block averages
 * to, including the ones the encoder has to pad past the image edge. That is what makes
 * "padding blocks must not reach the grid" a testable claim.
 */

export interface TinyJpegSpec {
	width: number;
	height: number;
	/** Mean sample for the luminance block at this position, 0…255. */
	luma: (col: number, row: number) => number;
	/**
	 * Mean Cb/Cr for the chroma block at this position, 0…255 with 128 neutral.
	 *
	 * Ignored for a greyscale layout, which has no chroma to write. The coordinates are
	 * the *chroma* plane's own — at 4:2:0 one chroma block covers a 2x2 group of luma
	 * blocks, which is precisely the subsampling the decoder has to undo, so testing it
	 * needs the two grids to be addressable apart.
	 */
	chroma?: (col: number, row: number) => { cb: number; cr: number };
	/**
	 * AC coefficients for the luminance block at this position, as zig-zag index (1…63)
	 * to quantised value.
	 *
	 * Without these every block is flat, which is enough to test a decoder that only reads
	 * DC — and not enough for one that reconstructs pixels, where the whole question is
	 * whether a coefficient ends up in the right place. Values are stored as-is: the
	 * quantisation table this writes is all ones.
	 */
	ac?: (col: number, row: number) => ReadonlyMap<number, number>;
	/**
	 * `grayscale` is one component; `420` is Y at 2x2 with two chroma planes; `cmyk` is
	 * four components all at 1x1, which is what an Adobe CMYK or YCCK file looks like.
	 */
	layout?: "grayscale" | "420" | "cmyk";
	/**
	 * Sampling factors to *declare* for the first component, without changing how the
	 * blocks are written.
	 *
	 * Only meaningful for the greyscale layout, and it is not a contradiction: a scan
	 * carrying one component is not interleaved, so its blocks are a plain raster whatever
	 * the frame header claims about sampling. Real encoders do exactly this — the Library
	 * of Congress's greyscale scans declare `2x2` — and a decoder that groups blocks by the
	 * declared factors reads the wrong number of them.
	 */
	declaredSampling?: { h: number; v: number };
	/** Emit SOF2 instead of SOF0, i.e. claim to be progressive. */
	progressive?: boolean;
	/** MCUs between restart markers; 0 for none. */
	restartInterval?: number;
	/** Extra APPn/COM segments before the frame header, to be walked over. */
	extraSegments?: number;
}

class BitWriter {
	private readonly bytes: number[] = [];
	private current = 0;
	private filled = 0;

	write(value: number, length: number): void {
		for (let i = length - 1; i >= 0; i--) this.bit((value >> i) & 1);
	}

	bit(b: number): void {
		this.current = (this.current << 1) | b;
		this.filled++;
		if (this.filled === 8) this.flushByte();
	}

	/** Pad the part-filled byte with ones, as the spec requires before a marker. */
	align(): void {
		while (this.filled !== 0) this.bit(1);
	}

	private flushByte(): void {
		this.bytes.push(this.current);
		// 0xFF in the entropy stream is written as 0xFF 0x00, so it cannot be mistaken
		// for a marker. The decoder has to undo this, so the writer has to do it.
		if (this.current === 0xff) this.bytes.push(0x00);
		this.current = 0;
		this.filled = 0;
	}

	marker(byte: number): void {
		this.align();
		this.bytes.push(0xff, byte);
	}

	toBuffer(): Buffer {
		this.align();
		return Buffer.from(this.bytes);
	}
}

/** Category (bit length) and the sign-folded value bits, as the DC coding wants them. */
function category(diff: number): { size: number; bits: number } {
	if (diff === 0) return { size: 0, bits: 0 };
	const magnitude = Math.abs(diff);
	let size = 0;
	while (magnitude >= 1 << size) size++;
	return { size, bits: diff > 0 ? diff : diff + (1 << size) - 1 };
}

function segment(marker: number, body: Buffer): Buffer {
	const header = Buffer.alloc(4);
	header.writeUInt16BE(0xff00 | marker, 0);
	header.writeUInt16BE(body.length + 2, 2);
	return Buffer.concat([header as unknown as Uint8Array, body as unknown as Uint8Array]);
}

export function tinyJpeg(spec: TinyJpegSpec): Buffer {
	const layout = spec.layout ?? "grayscale";
	const wide = layout === "420";
	const componentCount = wide ? 3 : layout === "cmyk" ? 4 : 1;
	const yh = wide ? 2 : 1;
	const yv = wide ? 2 : 1;
	const mcuWidth = 8 * yh;
	const mcuHeight = 8 * yv;
	const mcusX = Math.ceil(spec.width / mcuWidth);
	const mcusY = Math.ceil(spec.height / mcuHeight);

	const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

	for (let i = 0; i < (spec.extraSegments ?? 0); i++) {
		parts.push(segment(0xe0 + (i % 16), Buffer.alloc(24, 0x20)));
	}

	// DQT: every entry 1, so the dequantised DC is the raw coefficient.
	const dqt = Buffer.alloc(65);
	dqt[0] = 0x00; // 8-bit, table 0
	dqt.fill(1, 1);
	parts.push(segment(0xdb, dqt));

	// SOF: precision, height, width, then one triple per component.
	const sof = Buffer.alloc(6 + componentCount * 3);
	sof[0] = 8;
	sof.writeUInt16BE(spec.height, 1);
	sof.writeUInt16BE(spec.width, 3);
	sof[5] = componentCount;
	sof[6] = 1;
	sof[7] = spec.declaredSampling ? (spec.declaredSampling.h << 4) | spec.declaredSampling.v : (yh << 4) | yv;
	sof[8] = 0;
	for (let c = 1; c < componentCount; c++) {
		sof[6 + c * 3] = c + 1;
		sof[7 + c * 3] = 0x11;
		sof[8 + c * 3] = 0;
	}
	parts.push(segment(spec.progressive ? 0xc2 : 0xc0, sof));

	// DC table 0: twelve symbols, all four bits long, so symbol s has code s.
	const dcCounts = Buffer.alloc(16);
	dcCounts[3] = 12;
	parts.push(segment(0xc4, Buffer.concat([Buffer.from([0x00]) as unknown as Uint8Array, dcCounts as unknown as Uint8Array, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) as unknown as Uint8Array])));
	// AC table 0: end-of-block plus every (run, size) pair a small coefficient needs, all
	// eight bits long — so a symbol's code is simply its position in this list, which is
	// what lets the writer below encode without carrying a second table.
	const acSymbols = [0x00];
	for (let run = 0; run <= 15; run++) for (let size = 1; size <= 10; size++) acSymbols.push((run << 4) | size);
	const acCounts = Buffer.alloc(16);
	acCounts[7] = acSymbols.length;
	parts.push(
		segment(
			0xc4,
			Buffer.concat([
				Buffer.from([0x10]) as unknown as Uint8Array,
				acCounts as unknown as Uint8Array,
				Buffer.from(acSymbols) as unknown as Uint8Array,
			]),
		),
	);

	if (spec.restartInterval) {
		const dri = Buffer.alloc(2);
		dri.writeUInt16BE(spec.restartInterval, 0);
		parts.push(segment(0xdd, dri));
	}

	const sos = Buffer.alloc(4 + componentCount * 2);
	sos[0] = componentCount;
	for (let c = 0; c < componentCount; c++) {
		sos[1 + c * 2] = c + 1;
		sos[2 + c * 2] = 0x00; // DC table 0, AC table 0
	}
	sos[1 + componentCount * 2] = 0;
	sos[2 + componentCount * 2] = 63;
	sos[3 + componentCount * 2] = 0;
	parts.push(segment(0xda, sos));

	const bits = new BitWriter();
	const predictors = new Array<number>(componentCount).fill(0);
	let sinceRestart = 0;
	let restartIndex = 0;
	const acCode = (run: number, size: number): number => acSymbols.indexOf((run << 4) | size);
	const block = (componentIndex: number, dc: number, ac?: ReadonlyMap<number, number>): void => {
		const { size, bits: valueBits } = category(dc - predictors[componentIndex]!);
		predictors[componentIndex] = dc;
		bits.write(size, 4); // DC category, via the flat table above
		if (size > 0) bits.write(valueBits, size);
		let previous = 0;
		for (const index of [...(ac?.keys() ?? [])].sort((a, b) => a - b)) {
			const value = ac!.get(index)!;
			if (value === 0 || index < 1 || index > 63) continue;
			const coded = category(value);
			// Both limits are the writer's, not the format's. Refusing loudly beats emitting
			// a symbol the table does not contain, which would decode as something else
			// entirely and look like a decoder bug.
			const run = index - previous - 1;
			if (run > 15) throw new Error(`tinyJpeg: an AC gap of ${run} needs a ZRL symbol`);
			if (coded.size > 10) throw new Error(`tinyJpeg: AC value ${value} is outside the table`);
			bits.write(acCode(run, coded.size), 8);
			bits.write(coded.bits, coded.size);
			previous = index;
		}
		// End of block, which is symbol 0x00 and therefore code 0.
		if (previous < 63) bits.write(0, 8);
	};

	for (let my = 0; my < mcusY; my++) {
		for (let mx = 0; mx < mcusX; mx++) {
			if (spec.restartInterval && sinceRestart === spec.restartInterval) {
				bits.marker(0xd0 + (restartIndex % 8));
				restartIndex++;
				predictors.fill(0);
				sinceRestart = 0;
			}
			for (let by = 0; by < yv; by++) {
				for (let bx = 0; bx < yh; bx++) {
					const col = mx * yh + bx;
					const row = my * yv + by;
					block(0, Math.round((spec.luma(col, row) - 128) * 8), spec.ac?.(col, row));
				}
			}
			// One chroma block per MCU at 4:2:0, addressed by the MCU: that *is* the chroma
			// plane's coordinate system, so `spec.chroma` is called with it directly.
			const chroma = spec.chroma?.(mx, my);
			for (let c = 1; c < componentCount; c++) {
				const mean = c === 1 ? (chroma?.cb ?? 128) : (chroma?.cr ?? 128);
				block(c, Math.round((mean - 128) * 8));
			}
			sinceRestart++;
		}
	}

	parts.push(bits.toBuffer(), Buffer.from([0xff, 0xd9]));
	return Buffer.concat(parts as unknown as Uint8Array[]);
}
