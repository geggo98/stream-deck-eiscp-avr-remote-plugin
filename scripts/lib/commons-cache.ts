/**
 * Fetching test images from Wikimedia Commons, once and politely.
 *
 * The face-crop rule can only be judged against real photographs, and real photographs of
 * a deliberately wide range of people. Committing them is not an option — the ones worth
 * testing against are other people's work — so the corpus is a **manifest of Commons file
 * titles** that is committed, and the images themselves are fetched on demand into a
 * cache that is not.
 *
 * That makes this code a client of somebody else's donated infrastructure, so the load it
 * generates is a design constraint rather than an afterthought:
 *
 *   - **A cached file is never re-requested.** Not revalidated, not `HEAD`ed — a Commons
 *     file title plus a width names one immutable image, so the second run of the corpus
 *     makes *zero* network requests. `refresh` exists for the rare case and is opt-in.
 *   - **Requests are serial and spaced.** One at a time, at least `MIN_INTERVAL_MS` apart,
 *     however many callers ask at once. A twelve-image corpus is then twelve requests
 *     spread over twelve seconds, once, ever.
 *   - **`429` and `503` are obeyed**, including `Retry-After`, and give up rather than
 *     hammer.
 *   - **The User-Agent identifies the tool and a contact address**, which Wikimedia's
 *     policy requires and which is the difference between being throttled and being
 *     blocked.
 *
 * ## The three URL facts, all measured
 *
 * 1. Requesting an arbitrary thumbnail width from `upload.wikimedia.org` — the shape every
 *    tutorial shows, `/thumb/a/bc/Foo.jpg/512px-Foo.jpg` — now answers **400, "Use
 *    thumbnail sizes listed on…"**. `Special:FilePath` with a `width` is used instead.
 * 2. **`Special:FilePath` does not refuse an unlisted width — it quietly serves a bigger
 *    picture.** Measured on one file: 250 gives 250x312 and 500 gives 500x625, but **640
 *    and 800 both give 960x1200**, with status 200 and no hint that the request was not
 *    honoured. That is worse than an error twice over: it pulls 244 KB where 77 KB was
 *    asked for, on somebody else's donated bandwidth, and it hands the caller an image of
 *    a shape it did not choose — which in this repo flipped a crop decision, because the
 *    visible share of a picture depends on its aspect. Hence `ALLOWED_WIDTHS`: asking for
 *    anything else is a programming error and is refused here rather than there.
 * 3. The original file also works and is often several megabytes, which is exactly what a
 *    considerate client should not be pulling for a 500-pixel test.
 */

import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Not committed; `.cache/` is already ignored. */
export const CACHE_DIR = fileURLToPath(new URL("../../.cache/commons/", import.meta.url));

/**
 * Identifies the tool and a way to reach whoever runs it.
 *
 * Wikimedia's User-Agent policy asks for exactly this and answers requests without it far
 * less kindly. Keep the contact address real.
 */
const USER_AGENT = "stream-deck-pioneer-tests/1.0 (https://github.com/geggo98/stream_deck_pioneer; stefan@schwetschke.de)";

/** Smallest gap between two requests to Wikimedia, in milliseconds. */
const MIN_INTERVAL_MS = 1_000;

/** Given up on after this many attempts, however politely it was asked. */
const MAX_ATTEMPTS = 3;

/** Longest a `Retry-After` will be honoured before giving up instead. */
const MAX_BACKOFF_MS = 30_000;

/** A test image has no business being larger than this. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Widths Wikimedia actually renders. Anything else is served larger, silently — see above.
 *
 * Verified by request on 2026-08-09; the list is theirs to change, which is why an
 * unexpected size is checked for after the fact as well as before.
 */
export const ALLOWED_WIDTHS = [120, 250, 500, 1280] as const;

/** Big enough that a face is several dozen pixels, small enough to be a polite request. */
export const DEFAULT_WIDTH = 500;

const REQUEST_TIMEOUT_MS = 20_000;

/** Serialises every caller onto one queue, so "parallel" callers still trickle. */
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function politely<T>(work: () => Promise<T>): Promise<T> {
	const run = queue.then(async () => {
		const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
		if (wait > 0) await sleep(wait);
		lastRequestAt = Date.now();
		return work();
	});
	// The queue must survive a failure, or one bad file stops every later fetch.
	queue = run.catch(() => undefined);
	return run;
}

/** `File:Some name.jpg` -> `Some_name.jpg`, which is what the URLs want. */
export function fileName(title: string): string {
	return title.replace(/^File:/i, "").replace(/ /g, "_");
}

function cachePath(title: string, width: number): string {
	const safe = fileName(title).replace(/[^A-Za-z0-9._-]/g, "_");
	return join(CACHE_DIR, `${width}-${safe}`);
}

async function request(url: string): Promise<Response> {
	for (let attempt = 1; ; attempt++) {
		const response = await politely(() =>
			fetch(url, {
				headers: { "User-Agent": USER_AGENT, Accept: "image/jpeg,image/png,*/*" },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}),
		);
		if (response.status !== 429 && response.status !== 503) return response;
		if (attempt >= MAX_ATTEMPTS) return response;
		// Their number, not ours: a server that says how long to wait has said it for a
		// reason, and guessing shorter is the behaviour that gets a client blocked.
		const after = Number(response.headers.get("retry-after"));
		const backoff = Math.min(MAX_BACKOFF_MS, Number.isFinite(after) && after > 0 ? after * 1000 : attempt * 5_000);
		await sleep(backoff);
	}
}

export interface CommonsImage {
	title: string;
	path: string;
	bytes: number;
	/** False means nothing was asked of Wikimedia at all. */
	fetched: boolean;
	sha256: string;
}

/**
 * Is this a JPEG our own decoder can actually read?
 *
 * `image-luma.ts` refuses progressive JPEGs and answers `undefined`, which the crop rule
 * turns into "leave it centred". A progressive entry in the corpus would therefore *pass*
 * any expectation of `centred` while testing precisely nothing — a green tick for a run
 * that never reached the code under test. Better to refuse it at the door and say why.
 *
 * PNG is let through: nothing decodes it yet, but that failure is loud rather than silent.
 */
function rejectProgressive(bytes: Buffer, title: string): void {
	if (!(bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8)) return;
	for (let pos = 2; pos + 3 < bytes.length; ) {
		if (bytes[pos] !== 0xff) return;
		const marker = bytes[pos + 1]!;
		if (marker === 0xff) {
			pos++;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
			pos += 2;
			continue;
		}
		// SOF0/SOF1 are the sequential frames this repo can decode; SOF2 is progressive.
		if (marker === 0xc0 || marker === 0xc1) return;
		if (marker === 0xc2) {
			throw new Error(`${title}: progressive JPEG — image-luma.ts cannot read it, so a test using it would prove nothing`);
		}
		if (marker === 0xda) return; // scan reached without a frame header we understand
		pos += 2 + bytes.readUInt16BE(pos + 2);
	}
}

/**
 * The image for a Commons file title, from the cache or from Commons.
 *
 * Throws with the reason rather than returning a placeholder: a corpus that silently ran
 * on eleven of twelve images would be worse than one that stopped.
 */
export async function commonsImage(
	title: string,
	options: { width?: number; refresh?: boolean; sha256?: string } = {},
): Promise<CommonsImage> {
	const width = options.width ?? DEFAULT_WIDTH;
	if (!(ALLOWED_WIDTHS as readonly number[]).includes(width)) {
		throw new Error(`width ${width} is not one Wikimedia renders (${ALLOWED_WIDTHS.join(", ")}); it would silently serve a larger picture`);
	}
	const path = cachePath(title, width);
	if (!options.refresh && existsSync(path)) {
		const cached = readFileSync(path);
		const digest = createHash("sha256").update(cached).digest("hex");
		verifyDigest(title, digest, options.sha256);
		return { title, path, bytes: cached.length, fetched: false, sha256: digest };
	}
	mkdirSync(dirname(path), { recursive: true });

	const url = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fileName(title))}?width=${width}`;
	const response = await request(url);
	if (!response.ok) throw new Error(`${title}: Commons answered ${response.status} for ${url}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length > MAX_BYTES) throw new Error(`${title}: ${bytes.length} bytes is larger than a test image should be`);
	const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
	const png = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50;
	if (!jpeg && !png) throw new Error(`${title}: what came back is not a JPEG or PNG (${bytes.length} bytes)`);
	rejectProgressive(bytes, title);
	const digest = createHash("sha256").update(bytes).digest("hex");
	verifyDigest(title, digest, options.sha256);

	writeFileSync(path, bytes);
	return { title, path, bytes: bytes.length, fetched: true, sha256: digest };
}

/**
 * Refuse bytes that are not the bytes the manifest was written against.
 *
 * A Commons file can be overwritten with a new version under the same title, and a CDN can
 * mis-serve — one candidate during the corpus search demonstrably returned two different
 * pictures from one URL. Either would turn an expectation about where a face sits into a
 * statement about a picture nobody looked at.
 */
function verifyDigest(title: string, actual: string, expected: string | undefined): void {
	if (expected && expected !== actual) {
		throw new Error(`${title}: expected sha256 ${expected} but got ${actual} — the file on Commons is not the one this corpus was written for`);
	}
}

/** One entry of the committed corpus manifest. Metadata only — no image data. */
export interface CorpusEntry {
	/** `File:...` on Commons. */
	file: string;
	licence: string;
	attribution: string;
	/** Where the crop should move: the point of the entry. */
	expect: "up" | "centred" | "down";
	/** Refuses bytes that are not the ones this entry was written against. */
	sha256?: string;
	/**
	 * Why this entry does **not** currently land where `expect` says it should.
	 *
	 * A corpus that only holds cases the code already passes is a corpus that cannot teach
	 * anybody anything. Present means "we know, here is why, do not let it block a run" —
	 * and the run says so out loud, both when it still fails and, more usefully, when it
	 * starts passing and the note has become a lie.
	 */
	knownGap?: string;
	note?: string;
}

export function readCorpus(path: string): CorpusEntry[] {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(parsed)) throw new Error(`${path}: expected an array of corpus entries`);
	return parsed as CorpusEntry[];
}
