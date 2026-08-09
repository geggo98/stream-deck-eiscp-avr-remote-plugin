/**
 * Where to put the crop window so it does not run through somebody's face.
 *
 * The Now Playing dial wears its cover full-bleed across a 200x100 touch-strip segment.
 * Album art is square, so filling that segment shows **half** the picture — source rows
 * 128…384 of a 512² sleeve — and a head that happens to sit in the top or bottom quarter
 * gets sliced. Nobody has to look for that: human face detection is not something a
 * viewer can switch off, and a bisected head reads as a fault in the plugin, while a
 * bisected guitar reads as a crop.
 *
 * ## What is actually decided here
 *
 * One number: how far up or down the visible window sits, `-1` at the top of the picture,
 * `+1` at the bottom, `0` centred as before. The window's *size* is not negotiable — it
 * follows from the two aspect ratios — so the whole feature is a choice between at most a
 * few dozen positions, and it is made by walking all of them.
 *
 * ## Where the evidence comes from, and what it is worth
 *
 * `image-luma.ts` hands over three planes of block averages. Skin has a famously compact
 * signature in chrominance (Chai/Ngan): a narrow Cb/Cr box that is largely independent of
 * how brightly the person is lit, which is exactly why it is used in preference to
 * anything in RGB. It is evidence about *people*, not about faces — a hand and a shoulder
 * answer to it too — and for a vertical crop that is mostly the same question.
 *
 * It is also wrong in one specific, common way: a flat orange or brown expanse — wood,
 * sand, a sepia wash — sits inside the same box. That is what the detail test is for, and
 * it is measured over the region's **bounding box**, not over the skin itself. A face's
 * box is mostly not skin: eyes, mouth and hair are holes in the blob, and they are what
 * make it vary. Measuring the skin alone would only find how evenly the person is lit,
 * and measuring whether the blob has a boundary would pass everything — every blob has
 * one.
 *
 * ## The rules, in order, and why the second one is not decoration
 *
 *   1. **Cut as little face as possible.** Only regions that *straddle* an edge count. A
 *      region entirely outside the window has not been cut — it simply is not shown, and
 *      nobody notices a person who is not in the picture.
 *   2. **Then show as much of them as possible.** Without this, the minimiser discovers
 *      that it can "solve" a straddling face by pushing it out of frame altogether, which
 *      is a worse answer than pulling it in and was the first thing it tried.
 *   3. **Then stay near the middle.** No movement without a reason.
 *
 * **Rule two decides nearly everything, and rule one hardly ever fires** — which is worth
 * knowing before reading the code as though the first rule were the interesting one. Any
 * single region can be stepped around, because the window is half the picture and the two
 * extreme positions are disjoint: a face at the top is dodged by sitting at the bottom.
 * So "two faces, one of them has to go" resolves at zero cost, and it is rule two that
 * decides *which* goes — the larger stays. The one shape that forces a cut is a portrait
 * taller than the window itself, which no placement can hold whole.
 *
 * Costs are rounded to whole weighted cells before they are compared, so shaving a
 * fraction of a cell off a face is not a reason to move the picture.
 *
 * Pure and SDK-free, like `progress-colour.ts` and for the same reason: the tests must not
 * drag in `@elgato/streamdeck`.
 */

import type { ArtImage } from "../adapter/eiscp/jacket-art.ts";
import { type CoverFit, imageSize } from "./cover-image.ts";
import { detectFaces } from "./face-cascade.ts";
import { type CoverGrids, coverGrids, DETAIL_BLOCK, LUMA_BLOCK, type LumaGrid } from "./image-luma.ts";

/**
 * The chrominance box skin falls into, in JPEG's own units.
 *
 * From Chai & Ngan's segmentation work, which is where the numbers that get quoted
 * everywhere originate. Their value is that they are stated in chrominance alone: the
 * same box holds across a wide range of skin tones, because what varies most between
 * them is luminance, and luminance is not part of the test.
 */
const SKIN_CB_MIN = 77;
const SKIN_CB_MAX = 127;
const SKIN_CR_MIN = 133;
const SKIN_CR_MAX = 173;

/**
 * Where the chrominance test stops being trustworthy.
 *
 * At the ends of the brightness range the chroma of a real photograph collapses towards
 * neutral and the box above starts accepting things that are not skin — and, in the other
 * direction, stops describing skin that is in deep shadow. Excluding both ends is the
 * honest bound rather than a fudge: outside it this file has no opinion, which resolves to
 * "leave the cover where it was".
 */
const SKIN_LUMA_MIN = 40;
const SKIN_LUMA_MAX = 250;

/**
 * How much the brightness inside a region's bounding box must vary for it to be a face
 * rather than a wall — as a **share of that box's own brightness**, not as a number of
 * levels.
 *
 * Relative is not a refinement here, it is the whole point, and an absolute threshold was
 * measured doing real harm. Eyes and a mouth are dark *in proportion* to the skin around
 * them: a pupil reflects roughly a tenth of what the cheek does, whoever it belongs to.
 * sRGB then compresses that ratio into far fewer levels at the dark end — around 147
 * levels between cheek and pupil on light skin, around 59 on dark skin for the same
 * reflectances. So a fixed threshold of "16 levels of spread" quietly asks darker-skinned
 * subjects to be more contrasty than lighter-skinned ones to be recognised at all. With
 * one, the same synthetic face passed at Fitzpatrick I and IV and was refused at VI.
 *
 * Dividing by the region's own mean removes the scale: both the spread and the mean scale
 * with exposure and with reflectance, so the ratio does not. `tests/face-crop.test.ts`
 * holds the seven tones that pin it.
 *
 * The value itself is a starting point, and it is the number a real sleeve can most
 * easily disprove — `scripts/probe-cover-focus.ts` exists to put it in front of artwork
 * rather than to argue about it here. Spread rather than range on purpose: a range is
 * decided by its two most extreme cells, so one dark speck would carry a flat wall.
 */
const MIN_REGION_VARIATION = 0.12;

/** Keeps the ratio finite for a region that is essentially black; skin never is. */
const VARIATION_FLOOR = 16;

/**
 * Smallest region worth protecting, as a share of the grid and as an absolute floor.
 *
 * These began ten times smaller and every wrong decision this feature made came through
 * them. Measured on real sleeves: a 7-cell patch of shadow on one cover and an 8-cell
 * piece of the *lettering* on another were enough to swing the crop the full ±1, away
 * from a face that was plainly there. Three of four covers with faces went the wrong way.
 *
 * The floor follows from the premise rather than from those cases: this exists because a
 * **big** face gets sliced by the crop, and something under 2 % of the picture cannot be a
 * face whose slicing anybody would notice. Anything smaller has no business moving a
 * picture, so it does not get a vote.
 */
const MIN_REGION_SHARE = 0.02;
const MIN_REGION_CELLS = 40;
/** Above this, it is a backdrop rather than a head. */
const MAX_REGION_SHARE = 0.25;
/** A head is roughly as tall as it is wide; a wall is not. */
const MIN_ASPECT = 0.5;
const MAX_ASPECT = 2;
const MAX_REGION_WIDTH_SHARE = 0.6;

/**
 * How far above the skin a region is extended, as a share of its own height.
 *
 * Hair and forehead are not skin-coloured, so the blob stops at the brow — and a cut just
 * above someone's eyes looks exactly as wrong as one through their chin.
 */
const HAIR_HEADROOM = 0.4;

/** Grids smaller than this have nothing to say; a cover that small is not a photograph. */
const MIN_GRID = 8;

/** Confidence attached to a region found by colour alone. */
export const SKIN_WEIGHT = 0.5;

/**
 * Confidence attached to a region the cascade recognised as a face.
 *
 * Twice the colour test's, because it is a different kind of statement. Skin says "there
 * is a person-coloured, person-shaped, person-textured thing here"; the cascade says
 * "this is a face", having been told by several thousand photographs what one looks like.
 * The weight only ever matters when the two disagree about which region to save.
 */
export const FACE_WEIGHT = 1;

/**
 * How much two regions must overlap before they are treated as the same head.
 *
 * A face found by both routes must not be counted twice: it would outweigh a genuinely
 * separate face by two to one for no reason other than being easy to see.
 */
const SAME_REGION_OVERLAP = 0.3;

/** A region of the picture that should not be cut through. */
export interface FaceRegion {
	/** Grid rows and columns, `top`/`left` inclusive, `bottom`/`right` exclusive. */
	top: number;
	bottom: number;
	left: number;
	right: number;
	/** Cells actually in the region, which is less than the bounding box holds. */
	area: number;
	/** How far it is to be believed. */
	weight: number;
}

export interface CropFocus {
	/** Where the window sits: -1 the top of the picture, 0 centred, +1 the bottom. */
	y: number;
	reason: "unreadable" | "none" | "uncropped" | "centred" | "shifted";
	/** Regions found, and how much weighted area is still crossing an edge. */
	regions: number;
	cut: number;
}

const CENTRED: CropFocus = { y: 0, reason: "none", regions: 0, cut: 0 };

/** Regions are a property of the picture alone, so they outlive any one box. */
const regionsByArt = new WeakMap<Buffer, FaceRegion[]>();

/**
 * The regions of a cover worth not cutting through.
 *
 * Computed once per cover: the permanent display repaints every second, and this is the
 * only part of the decision that costs anything.
 */
export function faceRegions(art: ArtImage): FaceRegion[] {
	const cached = regionsByArt.get(art.bytes);
	if (cached) return cached;
	let regions: FaceRegion[] = [];
	try {
		const grids = coverGrids(art);
		// Detector first, so a face it recognised keeps its own weight when a skin blob
		// covering the same head is absorbed into it.
		regions = merge(cascadeRegions(grids), skinRegions(grids));
	} catch {
		// Same posture as the decoder underneath: the input is device-controlled and the
		// consequence of giving up is a centred crop, which is what happens today.
		regions = [];
	}
	regionsByArt.set(art.bytes, regions);
	return regions;
}

/**
 * What the cascade found, expressed on the same grid as everything else.
 *
 * The detector works on `detail`, which is half the source resolution, while the regions
 * are in grid cells of eight source pixels — so its boxes are divided by four on the way
 * out. Doing the conversion here keeps one coordinate system for the whole decision.
 */
function cascadeRegions(grids: CoverGrids | undefined): FaceRegion[] {
	if (!grids?.detail) return [];
	const perCell = LUMA_BLOCK / DETAIL_BLOCK;
	return detectFaces(grids.detail).map((box) => {
		const top = Math.floor(box.y / perCell);
		const bottom = Math.min(grids.luma.height, Math.ceil((box.y + box.height) / perCell));
		const left = Math.floor(box.x / perCell);
		const right = Math.min(grids.luma.width, Math.ceil((box.x + box.width) / perCell));
		return {
			// The window is the face, not the head: it stops at the brow, so the same
			// allowance the skin blobs get for hair applies here too.
			top: Math.max(0, top - Math.round((bottom - top) * HAIR_HEADROOM)),
			bottom,
			left,
			right,
			area: Math.max(1, (bottom - top) * (right - left)),
			weight: FACE_WEIGHT,
		};
	});
}

/** Do these two regions describe the same head? */
function overlaps(a: FaceRegion, b: FaceRegion): boolean {
	const rows = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
	const columns = Math.min(a.right, b.right) - Math.max(a.left, b.left);
	if (rows <= 0 || columns <= 0) return false;
	const shared = rows * columns;
	const smaller = Math.min((a.bottom - a.top) * (a.right - a.left), (b.bottom - b.top) * (b.right - b.left));
	return smaller > 0 && shared / smaller >= SAME_REGION_OVERLAP;
}

/** Keep every region from the first list, and only those of the second nothing covers. */
function merge(first: FaceRegion[], second: FaceRegion[]): FaceRegion[] {
	return [...first, ...second.filter((region) => !first.some((kept) => overlaps(kept, region)))];
}

/**
 * How much the brightness varies over a rectangle of the grid, relative to how bright it
 * is — the standard deviation over the mean.
 *
 * Scale-free by construction, which is what makes it fair across skin tones and across
 * exposures; see `MIN_REGION_VARIATION`.
 */
export function variationOver(luma: LumaGrid, top: number, bottom: number, left: number, right: number): number {
	let count = 0;
	let sum = 0;
	let sumSquares = 0;
	for (let y = Math.max(0, top); y < Math.min(luma.height, bottom); y++) {
		for (let x = Math.max(0, left); x < Math.min(luma.width, right); x++) {
			const value = luma.data[y * luma.width + x]!;
			count++;
			sum += value;
			sumSquares += value * value;
		}
	}
	if (count === 0) return 0;
	const mean = sum / count;
	const spread = Math.sqrt(Math.max(0, sumSquares / count - mean * mean));
	return spread / Math.max(mean, VARIATION_FLOOR);
}

function skinMask(grids: CoverGrids): Uint8Array | undefined {
	const { luma, cb, cr } = grids;
	if (!cb || !cr) return undefined;
	if (luma.width < MIN_GRID || luma.height < MIN_GRID) return undefined;
	const mask = new Uint8Array(luma.width * luma.height);
	for (let i = 0; i < mask.length; i++) {
		const l = luma.data[i]!;
		const b = cb.data[i]!;
		const r = cr.data[i]!;
		const skin =
			l >= SKIN_LUMA_MIN &&
			l <= SKIN_LUMA_MAX &&
			b >= SKIN_CB_MIN &&
			b <= SKIN_CB_MAX &&
			r >= SKIN_CR_MIN &&
			r <= SKIN_CR_MAX;
		mask[i] = skin ? 1 : 0;
	}
	return mask;
}

/**
 * Connected runs of skin, filtered down to the ones shaped like a head.
 *
 * Four-neighbour flood fill with an explicit stack — no recursion, because the depth would
 * otherwise be the size of the region and the input is not ours.
 */
function skinRegions(grids: CoverGrids | undefined): FaceRegion[] {
	if (!grids) return [];
	const mask = skinMask(grids);
	if (!mask) return [];
	const { luma } = grids;
	const cells = luma.width * luma.height;
	const minCells = Math.max(MIN_REGION_CELLS, Math.round(cells * MIN_REGION_SHARE));
	const maxCells = Math.round(cells * MAX_REGION_SHARE);
	const maxWidth = luma.width * MAX_REGION_WIDTH_SHARE;

	const seen = new Uint8Array(cells);
	const stack: number[] = [];
	const regions: FaceRegion[] = [];
	for (let start = 0; start < cells; start++) {
		if (!mask[start] || seen[start]) continue;
		seen[start] = 1;
		stack.push(start);
		let area = 0;
		let top = luma.height;
		let bottom = 0;
		let left = luma.width;
		let right = 0;
		while (stack.length > 0) {
			const index = stack.pop()!;
			const x = index % luma.width;
			const y = (index - x) / luma.width;
			area++;
			if (y < top) top = y;
			if (y >= bottom) bottom = y + 1;
			if (x < left) left = x;
			if (x >= right) right = x + 1;
			const neighbours = [x > 0 ? index - 1 : -1, x + 1 < luma.width ? index + 1 : -1, y > 0 ? index - luma.width : -1, y + 1 < luma.height ? index + luma.width : -1];
			for (const neighbour of neighbours) {
				if (neighbour < 0 || !mask[neighbour] || seen[neighbour]) continue;
				seen[neighbour] = 1;
				stack.push(neighbour);
			}
		}

		if (area < minCells || area > maxCells) continue;
		const boxWidth = right - left;
		const boxHeight = bottom - top;
		if (boxWidth > maxWidth) continue;
		const aspect = boxWidth / boxHeight;
		if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;
		if (variationOver(luma, top, bottom, left, right) < MIN_REGION_VARIATION) continue;
		regions.push({
			top: Math.max(0, top - Math.round(boxHeight * HAIR_HEADROOM)),
			bottom,
			left,
			right,
			area,
			weight: SKIN_WEIGHT,
		});
	}
	return regions;
}

/**
 * How much of the picture's height the box will actually show, 0…1.
 *
 * `undefined` means nothing is cropped away vertically — a square cover on a square key,
 * or `contain`, where the whole picture is fitted inside the box. That is the signal that
 * there is no decision to make here at all, and it is the ordinary case for every element
 * except the touch strip.
 */
export function visibleShare(
	image: { width: number; height: number },
	box: { width: number; height: number },
	fit: CoverFit,
): number | undefined {
	if (fit !== "cover") return undefined;
	const scale = Math.max(box.width / image.width, box.height / image.height);
	const drawnHeight = image.height * scale;
	if (drawnHeight <= box.height) return undefined;
	return box.height / drawnHeight;
}

/**
 * Where the crop window should sit for this cover in this box.
 *
 * Cheap enough to call per render: the regions are cached per cover and what is left is a
 * loop over the possible positions.
 */
export function coverFocus(art: ArtImage, box: { width: number; height: number }, fit: CoverFit = "cover"): CropFocus {
	const size = imageSize(art);
	if (!size) return { ...CENTRED, reason: "unreadable" };
	const share = visibleShare(size, box, fit);
	if (share === undefined) return { ...CENTRED, reason: "uncropped" };

	const grids = coverGrids(art);
	if (!grids) return { ...CENTRED, reason: "unreadable" };
	// **No early return for a greyscale cover.** It used to stop here, which quietly meant
	// that a black-and-white sleeve got no face detection at all — and the cascade, which is
	// the whole answer for black-and-white, reads brightness and has never wanted chroma.
	// The colour test below simply finds nothing, which is the correct amount for it to say.
	// Found the moment the corpus contained a real single-component JPEG.

	const rows = grids.luma.height;
	const window = Math.max(1, Math.min(rows, Math.round(rows * share)));
	const span = rows - window;
	const regions = faceRegions(art);
	if (span <= 0 || regions.length === 0) {
		return { y: 0, reason: regions.length === 0 ? "none" : "centred", regions: regions.length, cut: 0 };
	}

	const centre = span / 2;
	let best = { top: Math.round(centre), cut: Number.POSITIVE_INFINITY, shown: -1, distance: 0 };
	for (let top = 0; top <= span; top++) {
		let cut = 0;
		let shown = 0;
		for (const region of regions) {
			const height = region.bottom - region.top;
			const inside = Math.max(0, Math.min(region.bottom, top + window) - Math.max(region.top, top));
			shown += region.weight * region.area * (inside / height);
			// **Only regions a placement could actually save count towards the cut.** One
			// taller than the window is cut wherever the window goes, so what it
			// contributes is not a reason to prefer one position over another — it is a
			// constant with a tilt on it, and the tilt is enough to drown out a region that
			// genuinely can be rescued.
			//
			// That is not a hypothetical. On a portrait whose face the crop cut in half,
			// the skin of the subject's hand and the desk below him formed one tall region
			// down the left of the frame; it could not be shown whole from anywhere, it was
			// three times the face's area, and minimising the total cut therefore moved the
			// picture *away* from the face to lose slightly less of the desk.
			//
			// They still count towards `shown` below, which is what places the window to
			// show as much of a too-tall face as it can.
			if (height > window) continue;
			// Nothing in view and nothing missing: a region wholly outside the window was
			// not cut, it was left out, and that is not what anybody complains about.
			if (inside > 0 && inside < height) cut += region.weight * region.area * (1 - inside / height);
		}
		// Whole cells, so a sliver off a chin is not a reason to move the picture.
		cut = Math.round(cut);
		shown = Math.round(shown);
		const distance = Math.abs(top - centre);
		const better =
			cut < best.cut ||
			(cut === best.cut && shown > best.shown) ||
			(cut === best.cut && shown === best.shown && distance < best.distance);
		if (better) best = { top, cut, shown, distance };
	}

	const y = (best.top / span) * 2 - 1;
	return { y, reason: best.top === Math.round(centre) ? "centred" : "shifted", regions: regions.length, cut: best.cut };
}
