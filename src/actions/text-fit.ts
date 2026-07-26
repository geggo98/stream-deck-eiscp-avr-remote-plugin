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
	if (trimmed.length <= budget) return { text: trimmed, fontSize: smallest, clipped: false };
	// Cut on a word boundary when one is close enough to the limit; a title cut
	// mid-word reads as corruption, which this repo has already been bitten by
	// ("...Baby One M" learned as a listening-mode name).
	const hard = trimmed.slice(0, Math.max(0, budget - ellipsis.length));
	const lastSpace = hard.lastIndexOf(" ");
	const body = lastSpace >= hard.length - 8 && lastSpace > 0 ? hard.slice(0, lastSpace) : hard;
	return { text: `${body}${ellipsis}`, fontSize: smallest, clipped: true };
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
