/**
 * Finding frontal faces with the cascade in `generated/face-cascade.ts`.
 *
 * This is the half of the crop decision that does not care what colour anybody is: it
 * looks at brightness patterns, so it works on a black-and-white sleeve, on a duotone, and
 * on a drawing — all of which the skin test in `face-crop.ts` is blind to. In exchange it
 * only recognises faces that are roughly frontal and roughly upright, which the skin test
 * does not mind at all. Neither covers the other's gap, which is why both are here.
 *
 * ## How a decision is made
 *
 * A local binary pattern feature is a 3x3 grid of equal cells. Each of the eight outer
 * cells is brighter or darker than the centre, giving eight bits — a number from 0 to 255
 * describing the *shape* of a neighbourhood without reference to its brightness. That is
 * the property worth having here: it survives exposure, contrast and the heavy grading
 * album covers get, because only the ordering matters.
 *
 * Each weak classifier owns one feature and a 256-bit table saying which codes it votes
 * yes on. Stages add up their classifiers' votes and compare against a threshold; a window
 * has to pass **every** stage. Almost all windows die in the first two, which is what makes
 * scanning a whole picture affordable.
 *
 * Rectangle sums come from an integral image, so a cell costs four lookups whatever its
 * size.
 *
 * ## Bounded, because the picture is not ours
 *
 * `MAX_WINDOWS` caps the total work regardless of what the image claims to be, and the
 * caller runs this inside the same `try/catch` as everything else that touches a cover:
 * the cost of giving up is a centred crop. There is no allocation per window and no
 * recursion.
 */

import {
	CASCADE_FEATURES,
	CASCADE_STAGE_SIZES,
	CASCADE_STAGE_THRESHOLDS,
	CASCADE_TREE_FEATURES,
	CASCADE_TREE_LEAVES,
	CASCADE_TREE_SUBSETS,
	CASCADE_WINDOW,
} from "./generated/face-cascade.ts";
import type { LumaGrid } from "./image-luma.ts";

/** Words of bitmask per classifier — 8 x 32 bits covers all 256 pattern codes. */
const SUBSET_WORDS = 8;

/**
 * How much the window grows between passes.
 *
 * 1.2 rather than the 1.1 a still image would use: a cover is one picture with a handful
 * of faces in it, not a security camera, and eleven passes over a 256-pixel image is
 * already more scales than there are plausible head sizes.
 */
const SCALE_STEP = 1.2;

/**
 * Detections that must agree before one is believed.
 *
 * OpenCV's usual advice is three, and this started at four on the reasoning that a
 * phantom face is more expensive here than a missed one. Measured against six real
 * sleeves, that reasoning was wrong about the facts: at three or four the detector found
 * **nothing** on either of the two big-single-face covers, and at one it found both while
 * still finding nothing on either faceless cover. Requiring agreement was not buying
 * safety, it was buying silence.
 *
 * The reason so few windows agree is the step below: it grows with the scale, so a *large*
 * face — exactly the kind that gets cut — is sampled by only a handful of windows. Fixing
 * that instead was tried and measured: stepping by `scale` rather than `scale * 2` with a
 * 1.1 ladder cost **7x the time** (520 ms against 73 ms), still failed on the hardest
 * cover, and produced a new false positive on a black-and-white abstract that had been
 * clean. So the sampling stays cheap and the bar comes down.
 *
 * What still guards against a phantom is `group` below — overlapping detections are merged
 * rather than counted twice — and the fact that a window has to pass all twenty stages to
 * be a detection at all.
 */
const MIN_NEIGHBOURS = 1;

/** How close two detections must be to count as the same face, relative to their size. */
const OVERLAP_EPSILON = 0.2;

/** Hard ceiling on windows evaluated for one picture, whatever its size. */
const MAX_WINDOWS = 400_000;

export interface FaceBox {
	x: number;
	y: number;
	width: number;
	height: number;
	/** How many overlapping detections agreed on it. */
	confidence: number;
}

/**
 * Sums of every rectangle, as `(width + 1) * (height + 1)` running totals.
 *
 * `Float64Array` and not an integer type: for a 4096-pixel picture the total is about
 * 4 billion, which overflows a signed 32-bit accumulator — and the failure mode of that
 * would be a detector that works on covers and mysteriously does not on large images.
 */
function integralImage(image: LumaGrid): Float64Array {
	const stride = image.width + 1;
	const sums = new Float64Array(stride * (image.height + 1));
	for (let y = 0; y < image.height; y++) {
		let row = 0;
		for (let x = 0; x < image.width; x++) {
			row += image.data[y * image.width + x]!;
			sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1]! + row;
		}
	}
	return sums;
}

/** One scale's worth of feature geometry, laid out for the inner loop. */
interface ScaledFeatures {
	/** `x, y, cellWidth, cellHeight` per feature, already scaled and rounded. */
	rects: Int32Array;
	window: { width: number; height: number };
}

function scaleFeatures(scale: number): ScaledFeatures {
	const rects = new Int32Array(CASCADE_FEATURES.length);
	for (let i = 0; i < CASCADE_FEATURES.length; i += 4) {
		rects[i] = Math.round(CASCADE_FEATURES[i]! * scale);
		rects[i + 1] = Math.round(CASCADE_FEATURES[i + 1]! * scale);
		// At least one pixel: a cell rounded away to nothing would make every one of its
		// nine sums zero, and the feature would answer the same code everywhere.
		rects[i + 2] = Math.max(1, Math.round(CASCADE_FEATURES[i + 2]! * scale));
		rects[i + 3] = Math.max(1, Math.round(CASCADE_FEATURES[i + 3]! * scale));
	}
	return {
		rects,
		window: {
			width: Math.round(CASCADE_WINDOW.width * scale),
			height: Math.round(CASCADE_WINDOW.height * scale),
		},
	};
}

/**
 * Does this window pass every stage?
 *
 * Written as one function over flat arrays rather than as objects per classifier: it runs
 * hundreds of thousands of times for one picture, and the whole point of a cascade is that
 * the common case — rejection in the first stage — is cheap.
 */
function passes(sums: Float64Array, stride: number, originX: number, originY: number, features: Int32Array): boolean {
	let tree = 0;
	for (let stage = 0; stage < CASCADE_STAGE_SIZES.length; stage++) {
		let vote = 0;
		const end = tree + CASCADE_STAGE_SIZES[stage]!;
		for (; tree < end; tree++) {
			const feature = CASCADE_TREE_FEATURES[tree]! * 4;
			const x = originX + features[feature]!;
			const y = originY + features[feature + 1]!;
			const w = features[feature + 2]!;
			const h = features[feature + 3]!;

			// The 4x4 lattice of corners that bounds the 3x3 grid of cells.
			const r0 = y * stride;
			const r1 = (y + h) * stride;
			const r2 = (y + 2 * h) * stride;
			const r3 = (y + 3 * h) * stride;
			const c0 = x;
			const c1 = x + w;
			const c2 = x + 2 * w;
			const c3 = x + 3 * w;
			const cell = (top: number, bottom: number, left: number, right: number): number =>
				sums[top + left]! - sums[top + right]! - sums[bottom + left]! + sums[bottom + right]!;

			const centre = cell(r1, r2, c1, c2);
			// Bit order is the cascade's, clockwise from the top-left; getting it wrong
			// gives a detector that runs and finds nothing.
			const code =
				(cell(r0, r1, c0, c1) >= centre ? 128 : 0) |
				(cell(r0, r1, c1, c2) >= centre ? 64 : 0) |
				(cell(r0, r1, c2, c3) >= centre ? 32 : 0) |
				(cell(r1, r2, c2, c3) >= centre ? 16 : 0) |
				(cell(r2, r3, c2, c3) >= centre ? 8 : 0) |
				(cell(r2, r3, c1, c2) >= centre ? 4 : 0) |
				(cell(r2, r3, c0, c1) >= centre ? 2 : 0) |
				(cell(r1, r2, c0, c1) >= centre ? 1 : 0);

			const word = CASCADE_TREE_SUBSETS[tree * SUBSET_WORDS + (code >> 5)]!;
			const inSubset = (word & (1 << (code & 31))) !== 0;
			vote += CASCADE_TREE_LEAVES[tree * 2 + (inSubset ? 0 : 1)]!;
		}
		if (vote < CASCADE_STAGE_THRESHOLDS[stage]!) return false;
	}
	return true;
}

/** Two detections are the same face if each fits inside the other's tolerance. */
function similar(a: FaceBox, b: FaceBox): boolean {
	const tolerance = OVERLAP_EPSILON * Math.min(a.width, b.width);
	return (
		Math.abs(a.x - b.x) <= tolerance &&
		Math.abs(a.y - b.y) <= tolerance &&
		Math.abs(a.x + a.width - (b.x + b.width)) <= tolerance &&
		Math.abs(a.y + a.height - (b.y + b.height)) <= tolerance
	);
}

/**
 * Merge overlapping detections and throw away the ones nothing agreed with.
 *
 * Single-link clustering: a detection joins the first cluster it resembles. Good enough
 * for a handful of faces on one sleeve, and the alternative — proper connected components
 * over the similarity graph — buys nothing at this scale.
 */
function group(found: FaceBox[], required: number): FaceBox[] {
	const clusters: FaceBox[][] = [];
	for (const box of found) {
		const cluster = clusters.find((c) => similar(c[0]!, box));
		if (cluster) cluster.push(box);
		else clusters.push([box]);
	}
	const merged: FaceBox[] = [];
	for (const cluster of clusters) {
		if (cluster.length < required) continue;
		const mean = (pick: (box: FaceBox) => number): number =>
			Math.round(cluster.reduce((total, box) => total + pick(box), 0) / cluster.length);
		merged.push({
			x: mean((b) => b.x),
			y: mean((b) => b.y),
			width: mean((b) => b.width),
			height: mean((b) => b.height),
			confidence: cluster.length,
		});
	}
	return merged;
}

export interface DetectOptions {
	/** Lowered in tests to prove the cap is real. */
	maxWindows?: number;
	/** Lowered in tests; production wants the agreement. */
	minNeighbours?: number;
}

/**
 * Every frontal face in the picture, in its own pixel coordinates.
 *
 * Returns an empty list rather than throwing for an image too small to hold the cascade's
 * window, which is the ordinary answer for a thumbnail.
 */
export function detectFaces(image: LumaGrid, options: DetectOptions = {}): FaceBox[] {
	const limit = options.maxWindows ?? MAX_WINDOWS;
	const required = options.minNeighbours ?? MIN_NEIGHBOURS;
	if (image.width < CASCADE_WINDOW.width || image.height < CASCADE_WINDOW.height) return [];

	const sums = integralImage(image);
	const stride = image.width + 1;
	const found: FaceBox[] = [];
	let budget = limit;

	const maxScale = Math.min(image.width / CASCADE_WINDOW.width, image.height / CASCADE_WINDOW.height);
	for (let scale = 1; scale <= maxScale; scale *= SCALE_STEP) {
		const { rects, window } = scaleFeatures(scale);
		// Step with the window: a face found at one position is found at its neighbours
		// too, so a finer step buys agreement rather than coverage — and agreement is what
		// `MIN_NEIGHBOURS` needs, hence a step that is a fraction of the window rather than
		// a fixed number of pixels.
		const step = Math.max(1, Math.round(scale * 2));
		for (let y = 0; y + window.height < image.height; y += step) {
			for (let x = 0; x + window.width < image.width; x += step) {
				if (budget-- <= 0) return group(found, required);
				if (passes(sums, stride, x, y, rects)) {
					found.push({ x, y, width: window.width, height: window.height, confidence: 1 });
				}
			}
		}
	}
	return group(found, required);
}
