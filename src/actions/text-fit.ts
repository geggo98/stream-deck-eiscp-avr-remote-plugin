/**
 * Getting a track title into the space a touch strip actually offers.
 *
 * This is the real constraint of a now-playing display, and it is not the cover:
 * album art is square, so it fits comfortably into part of a single 200x100 segment.
 * Long titles and artist names do not. Beside a 92 px cover only ~100 px are left —
 * about eleven characters — and "Taylor Swift" is twelve.
 *
 * What the layout gives us to work with, and what it does not:
 *
 *   - `font.size` and `font.weight`. **No font family**, so the exact metrics are not
 *     knowable from here; the width estimate below is an estimate and says so.
 *   - `text-overflow: clip | ellipsis | fade`. Useful as a backstop, but it decides
 *     *after* the fact — it cannot pick a size that would have fitted.
 *   - **No marquee.** Nothing scrolls, so a long string either shrinks, wraps across
 *     segments, or gets cut.
 *
 * Hence the two tools here: shrink through a size ladder before giving up and
 * clipping, and — when a group of dials has segments to spare — split one string
 * across them at word boundaries, which buys real width instead of smaller type.
 */

/**
 * Average glyph advance as a fraction of the font size.
 *
 * An estimate, and deliberately a slightly pessimistic one: the layout exposes no
 * font family, so this cannot be measured from the plugin. 0.55 is typical for a
 * humanist sans at mixed case. Being wrong low means text is smaller than it had to
 * be; being wrong high means it gets clipped — so the bias is toward the former.
 */
export const AVG_CHAR_WIDTH_RATIO = 0.55;

/** Sizes we are willing to use, largest first. */
export const FONT_SIZE_LADDER: readonly number[] = [16, 14, 12, 11, 10];

export interface FittedText {
	text: string;
	fontSize: number;
	/** True when the text had to be cut even at the smallest size. */
	clipped: boolean;
}

/** How many characters of `text` fit into `width` at `fontSize`. */
export function charBudget(width: number, fontSize: number): number {
	if (!Number.isFinite(width) || !Number.isFinite(fontSize) || fontSize <= 0) return 0;
	return Math.max(0, Math.floor(width / (fontSize * AVG_CHAR_WIDTH_RATIO)));
}

/**
 * Pick the largest ladder size at which `text` fits, shrinking before clipping.
 *
 * Clipping is done here rather than left to `text-overflow` so the caller knows it
 * happened — a display that silently truncates every title looks like a bug, and the
 * honest answer is usually "give this line its own segment" (see `strip-group.ts`).
 */
export function fitText(
	text: string,
	width: number,
	options: { sizes?: readonly number[]; ellipsis?: string } = {},
): FittedText {
	const sizes = options.sizes?.length ? options.sizes : FONT_SIZE_LADDER;
	const ellipsis = options.ellipsis ?? "…";
	const trimmed = text.trim();

	for (const fontSize of sizes) {
		if (trimmed.length <= charBudget(width, fontSize)) {
			return { text: trimmed, fontSize, clipped: false };
		}
	}

	const smallest = sizes[sizes.length - 1]!;
	const budget = charBudget(width, smallest);
	if (budget <= 0) return { text: "", fontSize: smallest, clipped: trimmed.length > 0 };
	return { ...clipToChars(trimmed, budget, ellipsis), fontSize: smallest };
}

/**
 * Cut a string to `budget` characters, on a word boundary where one is near enough.
 *
 * A title cut mid-word reads as corruption, which this repo has already been bitten by
 * ("...Baby One M" learned as a listening-mode name). Shared by both fitters so the
 * two cannot disagree about what "too long" does.
 */
export function clipToChars(text: string, budget: number, ellipsis = "…"): { text: string; clipped: boolean } {
	const trimmed = text.trim();
	if (budget <= 0) return { text: "", clipped: trimmed.length > 0 };
	if (trimmed.length <= budget) return { text: trimmed, clipped: false };
	const hard = trimmed.slice(0, Math.max(0, budget - ellipsis.length));
	const lastSpace = hard.lastIndexOf(" ");
	const body = lastSpace >= hard.length - 8 && lastSpace > 0 ? hard.slice(0, lastSpace) : hard;
	return { text: `${body}${ellipsis}`, clipped: true };
}

/** Sizes for a cooperating panel, which has a full segment rather than a corner. */
export const PANEL_FONT_SIZE_LADDER: readonly number[] = [24, 20, 18, 16, 14];

export interface FittedLines {
	/** At most `maxLines` entries; empty for empty input. */
	lines: string[];
	fontSize: number;
	clipped: boolean;
}

/**
 * Wrap to a character budget, cutting only when nothing else works.
 *
 * The char-based core the two fitters share. It exists as its own export because one
 * caller has no pixels to work with at all: a Stream Deck **key title** is drawn by
 * the app in the *user's* font at the *user's* size, and neither is knowable from
 * here — but it is also not wrapped or shrunk by the app, so a long title runs off the
 * key and over its neighbours. All this side can do is hand over a string that is
 * already short enough.
 */
export function wrapToChars(text: string, charsPerLine: number, maxLines: number): FittedLines {
	const trimmed = text.trim();
	if (!trimmed || charsPerLine <= 0 || maxLines <= 0) {
		return { lines: [], fontSize: 0, clipped: trimmed.length > 0 };
	}
	const wrapped = wrapWords(trimmed, charsPerLine, maxLines);
	if (wrapped) return { lines: wrapped, fontSize: 0, clipped: false };

	const lines: string[] = [];
	let rest = trimmed;
	while (rest && lines.length < maxLines) {
		if (lines.length === maxLines - 1) {
			lines.push(clipToChars(rest, charsPerLine).text);
			break;
		}
		lines.push(rest.slice(0, charsPerLine));
		rest = rest.slice(charsPerLine);
	}
	return { lines, fontSize: 0, clipped: true };
}

/**
 * Greedy word wrap into at most `maxLines` lines of `budget` characters.
 *
 * Returns `undefined` when it does not fit, which is what drives the size ladder in
 * `fitLines`: "try the next size down" rather than "wrap it badly at this one".
 */
function wrapWords(text: string, budget: number, maxLines: number): string[] | undefined {
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		// A single word wider than the line can only be cut, which is a job for the
		// clipping path, not for the wrapper.
		if (word.length > budget) return undefined;
		const candidate = current ? `${current} ${word}` : word;
		if (candidate.length <= budget) {
			current = candidate;
			continue;
		}
		lines.push(current);
		if (lines.length >= maxLines) return undefined;
		current = word;
	}
	if (current) lines.push(current);
	return lines.length <= maxLines ? lines : undefined;
}

/**
 * Lay a string out over the lines a panel offers, largest size that still fits.
 *
 * The panel counterpart to `fitText`: a cooperating touch-strip segment has two full
 * lines rather than one narrow one, so the size ladder can start far larger. Same
 * order of preference throughout the feature — spread across panels first (see
 * `planPanels`), then shrink here, then clip.
 */
export function fitLines(
	text: string,
	width: number,
	maxLines = 2,
	options: { sizes?: readonly number[]; ellipsis?: string } = {},
): FittedLines {
	const sizes = options.sizes?.length ? options.sizes : PANEL_FONT_SIZE_LADDER;
	const smallest = sizes[sizes.length - 1]!;
	const trimmed = text.trim();
	if (!trimmed) return { lines: [], fontSize: sizes[0]!, clipped: false };

	for (const fontSize of sizes) {
		const budget = charBudget(width, fontSize);
		if (budget <= 0) continue;
		const wrapped = wrapWords(trimmed, budget, maxLines);
		if (wrapped) return { lines: wrapped, fontSize, clipped: false };
	}

	// Nothing fitted: fill the lines at the smallest size and cut the last one. Done
	// here rather than left to `text-overflow` so the caller knows it happened.
	const budget = charBudget(width, smallest);
	if (budget <= 0) return { lines: [], fontSize: smallest, clipped: true };
	return { ...wrapToChars(trimmed, budget, maxLines), fontSize: smallest };
}

/**
 * Split one string across `count` segments at word boundaries.
 *
 * Used when a group of dials has segments to spare: two 200 px segments at a readable
 * size beat one 200 px segment at 10 px. Splits on words rather than characters
 * because "Bohemian" / "Rhapsody" reads, while "Bohemian Rha" / "psody" does not.
 *
 * Returns exactly `count` entries; trailing ones are empty when there are fewer words
 * than segments, which the caller simply draws as empty.
 */
export function splitTextAcross(text: string, count: number): string[] {
	const n = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
	const trimmed = text.trim();
	if (n === 1) return [trimmed];

	const words = trimmed.split(/\s+/).filter(Boolean);
	if (words.length === 0) return Array.from({ length: n }, () => "");
	// One word cannot be split without cutting it, so it stays whole on the first
	// segment rather than being chopped.
	if (words.length === 1) return [words[0]!, ...Array.from({ length: n - 1 }, () => "")];

	const target = Math.ceil(trimmed.length / n);
	const parts: string[] = [];
	let current: string[] = [];
	let currentLength = 0;
	for (const word of words) {
		const wouldBe = currentLength === 0 ? word.length : currentLength + 1 + word.length;
		// Start a new segment once this one has reached its share — but never leave a
		// segment empty while words remain and never overflow the segment count.
		if (current.length > 0 && wouldBe > target && parts.length < n - 1) {
			parts.push(current.join(" "));
			current = [word];
			currentLength = word.length;
			continue;
		}
		current.push(word);
		currentLength = wouldBe;
	}
	parts.push(current.join(" "));
	while (parts.length < n) parts.push("");
	return parts;
}
