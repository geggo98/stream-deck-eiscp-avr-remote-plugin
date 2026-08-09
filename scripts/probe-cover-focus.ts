/**
 * Put the face-aware crop in front of real album art and look at what it decided.
 *
 * The rule in `src/actions/face-crop.ts` is a heuristic over unit tests it cannot fail:
 * the fixtures there are encoded by the suite, so "there is a head at the top of this
 * picture" is true by construction. Whether the same rule finds heads on a real sleeve —
 * and, much more importantly, whether it finds them on a wooden table — is not something
 * an assertion can settle. It has to be looked at.
 *
 * So this writes a contact sheet: every cover, the regions it found, where the strip
 * would have cropped before, and where it crops now. Both crops are composed by the
 * **plugin's own composer**, at the size the touch strip actually uses, so what the page
 * shows is what the hardware would show.
 *
 * ```
 * npm run probe:focus -- ~/Music/covers            # a folder of your own artwork
 * npm run probe:focus -- 10.2.0.32                 # whatever the receiver is playing
 * npm run probe:focus -- tests/fixtures/cover-corpus.json   # the shared corpus
 * npm run probe:focus -- a.jpg b.jpg --out /tmp/sheet.html
 * ```
 *
 * **The corpus is a manifest, not a folder of pictures.** `cover-corpus.json` holds
 * Commons file titles, their licences and where each one's crop ought to go; the images
 * are fetched once into `.cache/commons/` and never committed. That is what lets a corpus
 * of real photographs of real people be shared at all — see `lib/commons-cache.ts` for the
 * rate limiting and caching that fetching them politely requires.
 *
 * Nothing it reads is written anywhere but the output page and that cache, and no artwork
 * belongs in this repository — point it at your own collection or at the manifest.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { ArtImage } from "../src/adapter/eiscp/jacket-art.ts";
import {
	composeCoverImage,
	DEFAULT_SCRIM,
	STRIP_HEIGHT,
	STRIP_SEGMENT_WIDTH,
	imageSize,
} from "../src/actions/cover-image.ts";
import { coverFocus, faceRegions, visibleShare } from "../src/actions/face-crop.ts";
import { coverGrids, LUMA_BLOCK } from "../src/actions/image-luma.ts";
import { commonsImage, type CorpusEntry, readCorpus } from "./lib/commons-cache.ts";

const STRIP = { width: STRIP_SEGMENT_WIDTH, height: STRIP_HEIGHT };
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".bmp"]);
/** The receiver serves its cover here; see `src/adapter/eiscp/art-http.ts`. */
const ART_PATH = "/album_art.cgi";

interface Sample {
	label: string;
	art: ArtImage;
	/** Where the manifest says the crop ought to go, when it came from one. */
	expect?: CorpusEntry["expect"];
	/** Set when the manifest already knows this one does not land there, and why. */
	knownGap?: string;
}

/**
 * What the decision amounts to, for comparing against a manifest's expectation.
 *
 * The dead band is deliberately wide. The whole travel available is ±25 % of the picture's
 * height, so a fifth of it moves the crop by about 5 % — a couple of dozen pixels on a
 * 512-pixel sleeve, which is not a decision anybody would describe as "it moved up". A
 * corpus that failed on the difference between 0.10 and 0.16 would be testing the last
 * digit of an arithmetic mean rather than whether a face survived the crop.
 */
const DEAD_BAND = 0.2;

function direction(y: number): CorpusEntry["expect"] {
	if (y <= -DEAD_BAND) return "up";
	if (y >= DEAD_BAND) return "down";
	return "centred";
}

function artOf(label: string, bytes: Buffer): Sample | undefined {
	const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
	const bmp = bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d;
	if (!jpeg && !bmp) return undefined;
	return { label, art: { type: jpeg ? "jpeg" : "bmp", bytes, frames: 0, hash: label } };
}

async function collect(target: string): Promise<Sample[]> {
	// An address rather than a path: ask the receiver for whatever is on screen.
	if (/^\d+\.\d+\.\d+\.\d+$/.test(target) || target.startsWith("http")) {
		const url = target.startsWith("http") ? target : `http://${target}${ART_PATH}`;
		const response = await fetch(url, { cache: "no-store" });
		if (!response.ok) throw new Error(`${url} answered ${response.status}`);
		const bytes = Buffer.from(await response.arrayBuffer());
		const sample = artOf(url, bytes);
		return sample ? [sample] : [];
	}
	const path = resolve(target);
	// A manifest of Commons titles rather than a folder: the images arrive from the cache,
	// or are fetched once, spaced out, and kept.
	if (path.endsWith(".json")) {
		const entries = readCorpus(path);
		const samples: Sample[] = [];
		for (const entry of entries) {
			const image = await commonsImage(entry.file, entry.sha256 ? { sha256: entry.sha256 } : {});
			if (image.fetched) console.log(`  fetched ${entry.file} (${image.bytes} B)`);
			const sample = artOf(entry.file.replace(/^File:/, ""), readFileSync(image.path));
			if (sample) samples.push({ ...sample, expect: entry.expect, ...(entry.knownGap ? { knownGap: entry.knownGap } : {}) });
		}
		return samples;
	}
	if (statSync(path).isDirectory()) {
		const samples: Sample[] = [];
		for (const entry of readdirSync(path).sort()) {
			if (!IMAGE_EXTENSIONS.has(extname(entry).toLowerCase())) continue;
			const sample = artOf(entry, readFileSync(join(path, entry)));
			if (sample) samples.push(sample);
		}
		return samples;
	}
	const sample = artOf(target, readFileSync(path));
	return sample ? [sample] : [];
}

/** The original, with the regions and both crop windows drawn over it. */
function annotated(sample: Sample): string {
	const size = imageSize(sample.art) ?? { width: 512, height: 512 };
	const grids = coverGrids(sample.art);
	const regions = faceRegions(sample.art);
	const focus = coverFocus(sample.art, STRIP);
	const share = visibleShare(size, STRIP, "cover") ?? 1;
	const scale = grids ? size.height / grids.luma.height : LUMA_BLOCK;

	const windowHeight = size.height * share;
	const overhang = size.height - windowHeight;
	const before = overhang / 2;
	const after = (overhang / 2) * (1 + focus.y);

	const boxes = regions
		.map((r) => {
			const x = r.left * scale;
			const y = r.top * scale;
			const w = (r.right - r.left) * scale;
			const h = (r.bottom - r.top) * scale;
			return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#00E5FF" stroke-width="3"/>`;
		})
		.join("");
	const window = (top: number, colour: string, dash: string): string =>
		`<rect x="1" y="${top}" width="${size.width - 2}" height="${windowHeight}" fill="none" stroke="${colour}" stroke-width="4" stroke-dasharray="${dash}"/>`;

	const href = `data:image/${sample.art.type};base64,${sample.art.bytes.toString("base64")}`;
	return (
		`<svg viewBox="0 0 ${size.width} ${size.height}" width="260">` +
		`<image x="0" y="0" width="${size.width}" height="${size.height}" href="${href}"/>` +
		boxes +
		window(before, "#FF5252", "12 8") +
		window(after, "#69F0AE", "") +
		`</svg>`
	);
}

/** The strip segment as the hardware would draw it, before and after. */
function strip(sample: Sample, focusY: number): string {
	const uri = composeCoverImage({
		art: sample.art,
		...STRIP,
		fit: "cover",
		scrimOpacity: DEFAULT_SCRIM,
		focusY,
	});
	return uri ? `<img class="strip" src="${uri}" alt="">` : `<div class="strip missing">over budget</div>`;
}

function row(sample: Sample): string {
	const focus = coverFocus(sample.art, STRIP);
	const regions = faceRegions(sample.art);
	const grids = coverGrids(sample.art);
	const facts = [
		`${sample.art.bytes.length} B`,
		grids ? `${grids.luma.width}x${grids.luma.height} cells` : "undecodable",
		grids?.cb ? "colour" : "no colour",
		`${regions.length} region(s)`,
		`${focus.reason} ${focus.y.toFixed(2)}`,
		`${focus.cut} cut`,
	];
	// The verdict is the whole point of a manifest run: a sheet of pictures nobody compares
	// against an expectation is a sheet of pictures.
	const got = direction(focus.y);
	const verdict = sample.expect === undefined ? "" : verdictMarkup(sample, got);
	return `<tr>
		<td><div class="label">${escapeHtml(sample.label)}</div><div class="facts">${facts.map(escapeHtml).join(" · ")}</div>${verdict}</td>
		<td>${annotated(sample)}</td>
		<td>${strip(sample, 0)}<div class="caption">before — centred</div></td>
		<td>${strip(sample, focus.y)}<div class="caption">after — ${focus.reason}</div></td>
	</tr>`;
}

/**
 * The verdict cell, which has three outcomes rather than two.
 *
 * A known gap that still fails is not a red mark — it is a documented limitation doing
 * exactly what the note says. A known gap that *passes* is the interesting one: the note
 * has become untrue and somebody should delete it.
 */
function verdictMarkup(sample: Sample, got: CorpusEntry["expect"]): string {
	const matched = got === sample.expect;
	if (sample.knownGap) {
		return matched
			? `<div class="verdict fixed">! now lands on ${escapeHtml(sample.expect!)} — the known gap is out of date: ${escapeHtml(sample.knownGap)}</div>`
			: `<div class="verdict gap">~ known gap: ${escapeHtml(sample.knownGap)} (wanted ${escapeHtml(sample.expect!)}, got ${escapeHtml(got)})</div>`;
	}
	return `<div class="verdict ${matched ? "ok" : "bad"}">${matched ? "✓" : "✗"} expected ${escapeHtml(sample.expect!)}, got ${escapeHtml(got)}</div>`;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex >= 0 ? args[outIndex + 1]! : "cover-focus.html";
const targets = args.filter((a, i) => a !== "--out" && i !== outIndex + 1);
if (targets.length === 0) {
	console.error("usage: npm run probe:focus -- <file|folder|receiver-ip> [...] [--out sheet.html]");
	process.exit(2);
}

const samples: Sample[] = [];
for (const target of targets) samples.push(...(await collect(target)));
if (samples.length === 0) {
	console.error("no JPEG or BMP artwork found");
	process.exit(1);
}

const html = `<!doctype html><meta charset="utf-8"><title>Cover crop probe</title>
<style>
 body { background:#151515; color:#eee; font:13px/1.5 system-ui, sans-serif; margin:24px }
 table { border-collapse:collapse } td { padding:10px; vertical-align:top; border-bottom:1px solid #333 }
 .label { font-weight:600; word-break:break-all; max-width:220px }
 .facts { color:#9e9e9e; margin-top:4px; max-width:220px }
 .strip { width:400px; height:200px; image-rendering:pixelated; display:block; background:#000 }
 .missing { width:400px; height:200px; display:grid; place-items:center; background:#300 }
 .caption { color:#9e9e9e; margin-top:4px
 }
 .key { margin-bottom:16px; color:#bbb }
 .key b { color:#FF5252 } .key i { color:#69F0AE; font-style:normal } .key u { color:#00E5FF; text-decoration:none }
 .verdict { margin-top:6px; font-weight:600 } .verdict.ok { color:#69F0AE } .verdict.bad { color:#FF5252 }
 .verdict.gap { color:#FFB74D; font-weight:400 } .verdict.fixed { color:#4FC3F7 }
</style>
<p class="key"><b>— — the crop as it was (centred)</b> · <i>—— the crop as chosen</i> · <u>▭ a region worth not cutting</u></p>
<table>${samples.map(row).join("")}</table>`;

writeFileSync(out, html);
console.log(`${samples.length} cover(s) → ${resolve(out)}`);
let wrong = 0;
for (const sample of samples) {
	const focus = coverFocus(sample.art, STRIP);
	const got = direction(focus.y);
	let verdict = "";
	if (sample.expect !== undefined) {
		const matched = got === sample.expect;
		if (sample.knownGap) verdict = matched ? `  ! now passes — delete the knownGap note` : `  ~ known gap`;
		else if (matched) verdict = "  ✓";
		else {
			verdict = `  ✗ expected ${sample.expect}`;
			wrong++;
		}
	}
	console.log(`  ${sample.label}: ${focus.reason} y=${focus.y.toFixed(2)} regions=${focus.regions} cut=${focus.cut}${verdict}`);
}
// A non-zero exit so this can gate something later without anyone having to read the page.
if (wrong > 0) {
	console.error(`\n${wrong} cover(s) did not land where the manifest says they should`);
	process.exit(1);
}
