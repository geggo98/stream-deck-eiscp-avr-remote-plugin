/**
 * What colour to draw the progress in, given the cover it will sit on.
 *
 * Only the strip the progress actually covers is looked at — the ring's border band,
 * the bar's bottom edge — and in **sections**, because the middle of the artwork says
 * nothing about whether a line along the rim will be visible, and neither does the
 * average of a cover that is light at one end and dark at the other.
 *
 * ## The rule: whichever candidate is worst off the least
 *
 * Three candidates — white, mid grey, black — and the one chosen is the one whose
 * *smallest* difference from any section is largest. That single sentence produces all
 * three answers and needs no thresholds:
 *
 *   - an even dark cover → white, an even bright one → black;
 *   - a cover that is white at the top and black at the bottom → **grey**, because
 *     either extreme vanishes along half the ring while grey survives both;
 *   - nothing readable → white, which is also right for the near-black placeholder.
 *
 * Grey can only ever win on a split cover: for a uniform backdrop the better of white
 * and black is always at least 0.5 away from it, and grey is at most 0.5 away by
 * definition. That is the whole reason the third candidate exists.
 *
 * This replaced three brightness bands, and the measurement is worth keeping: with the
 * default scrim a bright sleeve lands around 0.53, which the bands answered with light
 * grey — a difference of 0.17, and on the device that reads as no ring at all. The rule
 * here never does worse than 0.5 on an even cover.
 *
 * The scrim belongs in the calculation, not beside it: the progress is drawn on the
 * *darkened* cover, and at the default 0.45 even pure white arrives at 0.55.
 */

import type { ProgressShape } from "./cover-image.ts";
import type { LumaGrid } from "./image-luma.ts";

export const PROGRESS_WHITE = "#FFFFFF";
export const PROGRESS_GREY = "#808080";
export const PROGRESS_BLACK = "#000000";

/**
 * The candidates, with the brightness each actually has.
 *
 * Ordered so a tie goes to white: it is the fallback everywhere else in this feature,
 * and on a mid backdrop white and black are equally readable anyway.
 */
const CANDIDATES: { colour: string; luma: number }[] = [
	{ colour: PROGRESS_WHITE, luma: 1 },
	{ colour: PROGRESS_BLACK, luma: 0 },
	{ colour: PROGRESS_GREY, luma: 0x80 / 255 },
];

/**
 * How far in from the edge the progress reaches, as a share of the picture.
 *
 * Taken from the ring's own geometry — inset plus stroke, over the key size — so the
 * sampled band is the band that gets painted rather than a number chosen to look right.
 */
const EDGE_BAND = 14 / 144;

/**
 * Share of the band a colour is allowed to blend into before it counts against it.
 *
 * A ring is readable if it stands out along most of its length; a few blocks that
 * happen to match are not a reason to reject a colour. Without a tolerance the score
 * would be the single closest block, and one mid-grey pixel anywhere on the rim would
 * veto grey for good.
 */
const TOLERANCE = 0.1;

/**
 * Every grid cell the progress will be drawn over.
 *
 * Cells rather than a handful of section averages, and that is the whole difference:
 * averages over the ring's four sides *hide* a top-to-bottom split, because the left and
 * right sides each contain both halves and come out in the middle. The distribution
 * keeps the split visible.
 */
function bandCells(grid: LumaGrid, shape: ProgressShape): number[] {
	const band = Math.max(1, Math.round(Math.min(grid.width, grid.height) * EDGE_BAND));
	const cells: number[] = [];
	for (let y = 0; y < grid.height; y++) {
		for (let x = 0; x < grid.width; x++) {
			const inBar = y >= grid.height - band;
			const inRing = x < band || y < band || x >= grid.width - band || y >= grid.height - band;
			if (shape === "bar" ? inBar : inRing) cells.push(grid.data[y * grid.width + x]! / 255);
		}
	}
	return cells;
}

/**
 * How far this colour stands off the backdrop along all but the worst `TOLERANCE` of it.
 *
 * The number to maximise: "for 90 % of its length, the ring is at least this far from
 * what is behind it."
 */
function standoff(colour: number, cells: number[]): number {
	const diffs = cells.map((cell) => Math.abs(colour - cell)).sort((a, b) => a - b);
	return diffs[Math.floor(TOLERANCE * (diffs.length - 1))]!;
}

/**
 * The chosen colour together with the numbers behind it.
 *
 * The numbers exist so a log line can explain a choice on a machine nobody can look at:
 * "ring #000000 (band 0.945 → 0.520 at scrim 0.45)" is a complete account of why, and
 * it is the difference between a bug report and a guess. Absent when there was no grid
 * to measure.
 */
export interface ProgressColourChoice {
	colour: string;
	/** Mean brightness of the sampled band, before the scrim. */
	bandMean?: number;
	/** Brightness of that band as it will actually appear, after the scrim. */
	bandOnScreen?: number;
	/** How far the winner stands off, along all but the worst `TOLERANCE` of the band. */
	standoff?: number;
}

/** As `progressColour`, but keeping what it worked out. */
export function chooseProgressColour(
	grid: LumaGrid | undefined,
	shape: ProgressShape,
	scrimOpacity: number,
): ProgressColourChoice {
	if (!grid || grid.data.length === 0) return { colour: PROGRESS_WHITE };
	const scrim = Number.isFinite(scrimOpacity) ? Math.min(1, Math.max(0, scrimOpacity)) : 0;
	const raw = bandCells(grid, shape);
	const cells = raw.map((v) => v * (1 - scrim));
	if (cells.length === 0) return { colour: PROGRESS_WHITE };

	let best = CANDIDATES[0]!.colour;
	let bestScore = -1;
	for (const candidate of CANDIDATES) {
		const score = standoff(candidate.luma, cells);
		if (score > bestScore) {
			bestScore = score;
			best = candidate.colour;
		}
	}
	const bandMean = raw.reduce((a, b) => a + b, 0) / raw.length;
	return { colour: best, bandMean, bandOnScreen: bandMean * (1 - scrim), standoff: bestScore };
}

/**
 * The colour for the progress ring or bar.
 *
 * @param grid - Block brightness of the cover, or `undefined` when it could not be read.
 * @param shape - Which area will be painted.
 * @param scrimOpacity - The darkening already applied to the cover, 0…1.
 */
export function progressColour(grid: LumaGrid | undefined, shape: ProgressShape, scrimOpacity: number): string {
	return chooseProgressColour(grid, shape, scrimOpacity).colour;
}
