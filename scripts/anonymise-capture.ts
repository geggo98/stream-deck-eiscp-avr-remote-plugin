#!/usr/bin/env tsx
/**
 * Turn a raw now-playing recording into a fixture that can live in a public repo.
 *
 * A capture of real playback contains real cover art and real track, artist and album
 * names. None of that may be committed. Truncating the recording instead would throw
 * away the properties the tests exist to check, so this **substitutes, preserving
 * structure**:
 *
 *   - the cover is replaced by a picture of our own at **exactly the same byte
 *     length**, re-chunked into frames with byte-identical hex lengths and the same
 *     packet-flag sequence — so frame count, chunk sizes and the remainder in the end
 *     frame are all unchanged, and a replay behaves the way the hardware did;
 *   - every text field is replaced by an invented string of **exactly the same UTF-8
 *     byte length**, so the wire framing is untouched;
 *   - timings, command order and everything else are copied verbatim, because those
 *     are the parts a synthetic mock cannot reproduce and the only reason to record
 *     hardware at all.
 *
 * The substitutions are deterministic, so re-running produces the same fixture.
 *
 * Deliberately better than the original in one respect: the invented text includes
 * non-ASCII, which the measured tracks did not. The receiver declares these fields as
 * "64 Unicode letters [UTF-8 encoded]", so the fixture now exercises the decoding path
 * that the real recording left untested.
 *
 * Usage: npm run capture:anonymise -- <input.json> <output.json>
 */

import { readFileSync, writeFileSync } from "node:fs";
import { syntheticJpeg } from "./lib/synthetic-jpeg.ts";

interface RawFrame {
	ms: number;
	command: string;
	parameter: string;
	len?: number;
}

interface RawCapture {
	host?: string;
	frames: RawFrame[];
}

/** Text-carrying commands. Their content is replaced; their length is not. */
const TEXT_COMMANDS = new Set(["NTI", "NAT", "NAL"]);

/**
 * Invented words, with accents on purpose.
 *
 * Nothing here refers to a real recording, and the non-ASCII is deliberate: it makes
 * the fixture cover the UTF-8 path that the measured tracks (both plain ASCII) did
 * not.
 */
const WORDS = [
	"an", "im", "und", "vom", "Weg", "Zeit", "Ufer", "Nord", "Stern", "Zwölf",
	"Grüße", "Fjörd", "Wörter", "Halbmond", "Steinweg", "Übergang", "Rückkehr",
	"Weitblick", "Frühnebel", "Ankerplatz", "Silberpfad", "Küstenlicht",
	"Nebelmorgen", "Sonnenstaub", "Tiefenklang", "Wandelstern", "Sommerflut",
];

/**
 * Words indexed by their **UTF-8 byte** length, not their character count.
 *
 * Byte length is what has to come out exact, and an umlaut costs two — so a five-letter
 * "Grüße" fills six bytes. Indexing by bytes means the last word of a phrase can be
 * chosen to land on the target precisely, instead of the earlier approach of padding
 * with loose letters, which produced things like "tuvwx" and read as a defect rather
 * than as a deliberate substitution.
 */
const BY_BYTE_LENGTH = new Map<number, string[]>();
for (const word of WORDS) {
	const n = Buffer.byteLength(word, "utf8");
	BY_BYTE_LENGTH.set(n, [...(BY_BYTE_LENGTH.get(n) ?? []), word]);
}
const LONGEST_WORD = Math.max(...BY_BYTE_LENGTH.keys());
const SHORTEST_WORD = Math.min(...BY_BYTE_LENGTH.keys());

/** Deterministic index from a label, so the same field always yields the same text. */
function seedOf(label: string): number {
	let h = 2166136261;
	for (const ch of label) {
		h ^= ch.codePointAt(0)!;
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h;
}

/**
 * Invent a string whose UTF-8 encoding is exactly `bytes` long.
 *
 * Words are added while they fit, then the last one is trimmed or extended letter by
 * letter. Exactness matters: the byte length is what the wire framing is made of, so
 * "about the same" would change the recording.
 */
export interface InventOptions {
	/**
	 * Refuse to answer with a single word.
	 *
	 * Used when the obvious choice is already taken: the pool holds exactly one word of
	 * some byte lengths (12 bytes is only "Küstenlicht"), so re-rolling the seed cannot
	 * escape a collision — building a phrase instead can.
	 */
	avoidSingleWord?: boolean;
}

export function inventText(label: string, bytes: number, options: InventOptions = {}): string {
	if (bytes <= 0) return "";
	let seed = seedOf(label);
	const pick = (candidates: string[]): string => {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		return candidates[seed % candidates.length]!;
	};
	const wordOf = (n: number): string | undefined => {
		const options = BY_BYTE_LENGTH.get(n);
		return options ? pick(options) : undefined;
	};

	const parts: string[] = [];
	let remaining = bytes;
	// Lay down whole words separated by single spaces, always leaving enough room to
	// finish exactly. A word that fits the remainder precisely ends the phrase.
	for (let guard = 0; guard < 32 && remaining > 0; guard++) {
		const singleWordAllowed = !(options.avoidSingleWord && parts.length === 0);
		const exact = singleWordAllowed && remaining <= LONGEST_WORD ? wordOf(remaining) : undefined;
		if (exact) {
			parts.push(exact);
			remaining = 0;
			break;
		}
		// Otherwise take a word short enough that what is left can still be finished:
		// the space plus at least the shortest word.
		const room = remaining - 1 - SHORTEST_WORD;
		const fitting = [...BY_BYTE_LENGTH.entries()].filter(([n]) => n <= room).flatMap(([, w]) => w);
		if (fitting.length === 0) break;
		const word = pick(fitting);
		parts.push(word);
		remaining -= Buffer.byteLength(word, "utf8") + 1;
	}

	let out = parts.join(" ");
	// The loop lands exactly for every length the pool can express. Anything left over
	// is a length no combination reaches (a 1-byte field, say); a truncated word is the
	// honest fallback, and a display truncating a title is realistic anyway.
	if (Buffer.byteLength(out, "utf8") !== bytes) {
		const filler = pick([...BY_BYTE_LENGTH.values()].flat().filter((w) => /^[\x20-\x7e]+$/.test(w)));
		out = (out ? `${out} ${filler}` : filler).slice(0, bytes);
		while (Buffer.byteLength(out, "utf8") > bytes) out = out.slice(0, -1);
		while (Buffer.byteLength(out, "utf8") < bytes) out += "e";
	}
	if (Buffer.byteLength(out, "utf8") !== bytes) {
		throw new Error(`inventText(${label}, ${bytes}) produced ${Buffer.byteLength(out, "utf8")} bytes`);
	}
	return out;
}

/** One cover transfer, as it appeared on the wire. */
interface Transfer {
	indices: number[];
	/** Hex-payload length of each frame, so the replacement is chunked identically. */
	hexLengths: number[];
	flags: string[];
	type: string;
	bytes: number;
}

function findTransfers(frames: RawFrame[]): Transfer[] {
	const out: Transfer[] = [];
	frames.forEach((frame, index) => {
		if (frame.command !== "NJA" || frame.parameter.length < 2) return;
		const flag = frame.parameter[1]!;
		if (flag === "0" || out.length === 0) {
			out.push({ indices: [], hexLengths: [], flags: [], type: frame.parameter[0]!, bytes: 0 });
		}
		const current = out[out.length - 1]!;
		const hex = frame.parameter.length - 2;
		current.indices.push(index);
		current.hexLengths.push(hex);
		current.flags.push(flag);
		current.bytes += hex / 2;
	});
	return out;
}

function main(): void {
	const [input, output] = process.argv.slice(2);
	if (!input || !output) {
		console.error("Usage: npm run capture:anonymise -- <input.json> <output.json>");
		process.exit(2);
	}

	const raw = JSON.parse(readFileSync(input, "utf-8")) as RawCapture;
	const frames: RawFrame[] = raw.frames.map((f) => ({ ...f }));

	// --- Cover art ---------------------------------------------------------
	const transfers = findTransfers(frames);
	let coversReplaced = 0;
	for (const [n, transfer] of transfers.entries()) {
		const replacement = syntheticJpeg(transfer.bytes, { size: 512 });
		let offset = 0;
		transfer.indices.forEach((frameIndex, i) => {
			const hexLength = transfer.hexLengths[i]!;
			const slice = replacement.subarray(offset, offset + hexLength / 2);
			offset += hexLength / 2;
			const hex = slice.toString("hex").toUpperCase();
			if (hex.length !== hexLength) {
				throw new Error(`transfer ${n} frame ${i}: produced ${hex.length} hex chars, wanted ${hexLength}`);
			}
			frames[frameIndex]!.parameter = `${transfer.type}${transfer.flags[i]}${hex}`;
		});
		if (offset !== transfer.bytes) throw new Error(`transfer ${n}: consumed ${offset} of ${transfer.bytes} bytes`);
		coversReplaced++;
	}

	// --- Text --------------------------------------------------------------
	let textsReplaced = 0;
	const seen = new Map<string, string>();
	for (const frame of frames) {
		if (!TEXT_COMMANDS.has(frame.command)) continue;
		const original = frame.parameter;
		if (original.trim() === "") continue;
		// The same original must map to the same replacement, or a track that is
		// announced twice would look like two different tracks.
		const key = `${frame.command}:${original}`;
		let replacement = seen.get(key);
		if (replacement === undefined) {
			// Distinct originals must stay distinct. Two fields of the same byte length
			// otherwise collide on the same invented word — and a fixture where the title
			// equals the artist would quietly pass a test that mixed the two up.
			const bytes = Buffer.byteLength(original, "utf8");
			const used = new Set(seen.values());
			replacement = inventText(key, bytes);
			for (let attempt = 1; attempt < 32 && used.has(replacement); attempt++) {
				replacement = inventText(`${key}#${attempt}`, bytes, { avoidSingleWord: true });
			}
		}
		seen.set(key, replacement);
		frame.parameter = replacement;
		textsReplaced++;
	}

	const fixture = {
		capturedAt: new Date(0).toISOString().replace(/\.\d+Z$/, "Z"),
		host: raw.host ?? "10.0.0.1",
		model: "VSX-S520D",
		note:
			"Now-playing traffic recorded from real hardware, then ANONYMISED: the cover art " +
			"is a generated grey JPEG of exactly the original byte length, re-chunked into " +
			"byte-identical frames, and every NTI/NAT/NAL string is invented text of exactly " +
			"the original UTF-8 byte length. Timings, command order and framing are verbatim. " +
			"Do not treat the text or the image as what the device actually reported; " +
			"re-capture with npm run capture:names-style tooling if that matters. " +
			"Produced by scripts/anonymise-capture.ts.",
		coverTransfers: transfers.map((t) => ({ frames: t.indices.length, bytes: t.bytes })),
		frames: frames.map((f) => ({ ms: f.ms, command: f.command, parameter: f.parameter })),
	};

	writeFileSync(output, `${JSON.stringify(fixture, null, "\t")}\n`);
	console.log(
		`Anonymised ${frames.length} frames -> ${output}\n` +
			`  cover transfers replaced: ${coversReplaced} (${transfers.map((t) => `${t.indices.length} frames / ${t.bytes} B`).join(", ")})\n` +
			`  text fields replaced:     ${textsReplaced} (${seen.size} distinct)`,
	);
}

main();
