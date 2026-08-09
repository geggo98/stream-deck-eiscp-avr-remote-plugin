/**
 * A cover with skin-coloured, face-shaped patches in known places.
 *
 * Shared rather than written out per test file, because the first duplicate of it was
 * already subtly wrong: a chequerboard of light and dark over the *whole* patch leaves
 * the skin cells touching only at their corners, and the region finder joins cells
 * edge-to-edge. The patch dissolved into single cells and nothing was found — a fixture
 * that looks like a face to a reader and like noise to the code.
 *
 * So the shape here is deliberate: a solid skin field with dark specks *inside* it, which
 * is both what a face looks like at this scale (eyes and a mouth are holes in the skin)
 * and what makes the region's bounding box vary enough to pass the flatness test.
 */

import { tinyJpeg } from "./tiny-jpeg.ts";

/**
 * A 24-bit BMP with a face-shaped patch of one exact colour on a dark background.
 *
 * BMP rather than JPEG because the point is the *colour*: here the bytes are the pixels,
 * so a test about which skin tones are recognised is testing the rule and not the
 * encoder's chroma rounding.
 *
 * The patch carries dark features — eyes and a mouth — which is not decoration: a
 * perfectly flat patch is refused on purpose, and without them this would only ever prove
 * that the refusal works.
 *
 * Those features are a **fraction of the skin colour**, not a fixed dark value, and that
 * detail is the difference between a fair fixture and a flattering one. A pupil reflects
 * roughly a tenth of what a cheek does whoever it belongs to, so painting every face's
 * eyes the same near-black would hand light skin a large contrast and dark skin almost
 * none — and the test would then "prove" that dark faces are harder to find, when what it
 * had actually done was build them that way.
 */
const FEATURE_REFLECTANCE = 0.3;

export function toneCoverBmp(rgb: readonly [number, number, number], size = 256): Buffer {
	const stride = Math.floor((size * 3 + 3) / 4) * 4;
	const offset = 54;
	const bytes = Buffer.alloc(offset + stride * size);
	bytes.write("BM", 0, "ascii");
	bytes.writeUInt32LE(bytes.length, 2);
	bytes.writeUInt32LE(offset, 10);
	bytes.writeUInt32LE(40, 14);
	bytes.writeInt32LE(size, 18);
	// Negative height: rows top-down, so the coordinates below read the way they look.
	bytes.writeInt32LE(-size, 22);
	bytes.writeUInt16LE(1, 26);
	bytes.writeUInt16LE(24, 28);

	const face = { top: size * 0.16, bottom: size * 0.55, left: size * 0.35, right: size * 0.66 };
	const feature = (x: number, y: number): boolean => {
		const eyes = y > size * 0.26 && y < size * 0.31 && ((x > size * 0.4 && x < size * 0.45) || (x > size * 0.56 && x < size * 0.61));
		const mouth = y > size * 0.44 && y < size * 0.47 && x > size * 0.44 && x < size * 0.57;
		return eyes || mouth;
	};
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const inFace = y >= face.top && y < face.bottom && x >= face.left && x < face.right;
			const dark = rgb.map((c) => Math.round(c * FEATURE_REFLECTANCE)) as unknown as [number, number, number];
			const [r, g, b] = inFace ? (feature(x, y) ? dark : rgb) : ([20, 24, 40] as const);
			const p = offset + y * stride + x * 3;
			bytes[p] = b;
			bytes[p + 1] = g;
			bytes[p + 2] = r;
		}
	}
	return bytes;
}

/** Chrominance well inside the skin box, and a colour well outside it. */
export const SKIN_CHROMA = { cb: 100, cr: 155 };
export const NOT_SKIN_CHROMA = { cb: 160, cr: 100 };

export interface FacePatch {
	/** In chroma-cell coordinates, `bottom`/`right` exclusive. */
	top: number;
	bottom: number;
	left: number;
	right: number;
	/** Skin-coloured but featureless — wood, sand, a sepia wash. Must be refused. */
	flat?: boolean;
}

/**
 * A square cover made of `cells` chroma cells a side.
 *
 * At 4:2:0 one chroma cell covers a 2x2 group of luminance blocks, i.e. 16 source pixels
 * a side — so `cells: 32` is a 512-pixel cover with a 64x64 luminance grid, which is the
 * shape the reference receiver actually sends.
 */
export function faceCoverBytes(cells: number, patches: readonly FacePatch[]): Buffer {
	const size = cells * 16;
	const patchAt = (col: number, row: number): FacePatch | undefined =>
		patches.find((p) => row >= p.top && row < p.bottom && col >= p.left && col < p.right);
	return tinyJpeg({
		width: size,
		height: size,
		layout: "420",
		chroma: (col, row) => (patchAt(col, row) ? SKIN_CHROMA : NOT_SKIN_CHROMA),
		luma: (col, row) => {
			const patch = patchAt(col >> 1, row >> 1);
			if (!patch) return 30;
			if (patch.flat) return 150;
			const inner =
				col >> 1 > patch.left && col >> 1 < patch.right - 1 && row >> 1 > patch.top && row >> 1 < patch.bottom - 1;
			return inner && (col + row) % 2 === 0 ? 20 : 150;
		},
	});
}
