/**
 * Fuzzing for the cover-art reassembler — the plugin's first binary decoder over
 * device-controlled bytes, and its first accumulator across frames.
 *
 * The invariants matter more than any single output, because the input is
 * generated. What a hostile or broken peer must never be able to do:
 *
 *   - make the reducer throw an unchecked `TypeError`/`RangeError` (that is an
 *     unguarded access reachable from the network),
 *   - grow the accumulator past its caps, which is a memory-exhaustion primitive
 *     given a receiver can send `p=1` frames forever,
 *   - get a "complete" image out that is not actually a decodable JPEG or BMP —
 *     that byte string is handed straight to a renderer,
 *   - retain anything after a transfer ends, is rejected, or stalls.
 *
 * Structure-aware on purpose: uniformly random strings barely get past the two
 * header characters, so most generators emit things that *look* like NJA frames
 * and lie about one field.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	ART_IDLE_MS,
	INITIAL_ART_STATE,
	JacketArtAccumulator,
	MAX_ART_BYTES,
	MAX_ART_FRAMES,
	nextArtState,
	parseArtFrame,
	type ArtState,
} from "../src/adapter/eiscp/jacket-art.ts";
import { expectFastCompletion, expectOnlyDeliberateErrors, fuzzConfig, fuzzEach, randomAscii, type Rng } from "./helpers/fuzz.ts";

const config = fuzzConfig();

const TYPES = ["0", "1", "2", "n", "-", "9", "B", "\u0020", "\u0000", "\u00ff"] as const;
const FLAGS = ["0", "1", "2", "-", "3", "x", "\u0020", "\u0000"] as const;

/** Hex, sometimes deliberately not. */
function randomPayload(rng: Rng): string {
	const length = rng.between(0, 64);
	switch (rng.between(0, 4)) {
		case 0: {
			// Valid even-length hex.
			let out = "";
			for (let i = 0; i < length * 2; i++) out += "0123456789ABCDEF"[rng.below(16)];
			return out;
		}
		case 1: {
			// Valid hex characters, odd length — the case Buffer.from truncates.
			let out = "";
			for (let i = 0; i < length * 2 + 1; i++) out += "0123456789abcdef"[rng.below(16)];
			return out;
		}
		case 2:
			// Hex with one intruder somewhere.
			return "FFD8" + randomAscii(rng, 1) + "AABB";
		case 3:
			return randomAscii(rng, length);
		default:
			return rng.bytes(length).toString("hex").toUpperCase();
	}
}

function randomFrameString(rng: Rng): string {
	if (rng.bool(0.05)) return randomAscii(rng, rng.between(0, 3)); // too short / junk
	return rng.pick(TYPES) + rng.pick(FLAGS) + randomPayload(rng);
}

describe("fuzz: nextArtState", () => {
	it("never throws an unchecked error, whatever the frame says", () => {
		fuzzEach(
			config,
			(rng) => randomFrameString(rng),
			(parameter) => {
				const frame = parseArtFrame(parameter);
				if (frame === undefined) return; // too short to be a data frame
				expectOnlyDeliberateErrors(() => nextArtState(INITIAL_ART_STATE, frame, 1_000), "nextArtState");
			},
		);
	});

	it("keeps the accumulator inside its caps across a random frame stream", () => {
		// A single sequence of random frames, folded as the real observer would fold
		// it, checking the bounds after every step. This is the property that actually
		// protects memory: individual frames are tiny, the *stream* is not.
		fuzzEach(
			config,
			(rng) => Array.from({ length: rng.between(1, 200) }, () => randomFrameString(rng)),
			(parameters) => {
				let state: ArtState = INITIAL_ART_STATE;
				for (const parameter of parameters) {
					const frame = parseArtFrame(parameter);
					if (frame === undefined) continue;
					const step = expectOnlyDeliberateErrors(() => nextArtState(state, frame, 1_000), "nextArtState");
					if (step === undefined) continue;
					state = step.state;

					const pending = state.pending;
					if (pending) {
						assert.ok(pending.bytes <= MAX_ART_BYTES, `pending bytes ${pending.bytes} over cap`);
						assert.ok(pending.frames <= MAX_ART_FRAMES, `pending frames ${pending.frames} over cap`);
						assert.equal(
							pending.chunks.reduce((n, c) => n + c.length, 0),
							pending.bytes,
							"the byte counter must match the chunks it claims to count",
						);
					}
					if (step.outcome.kind === "complete" || step.outcome.kind === "rejected" || step.outcome.kind === "cleared") {
						assert.equal(state.pending, undefined, `${step.outcome.kind} must not retain a partial transfer`);
					}
				}
			},
		);
	});

	it("only ever reports an image a decoder would accept", () => {
		// "complete" hands a byte string to setImage/pixmap.value. If the reducer can be
		// talked into completing on something that is not an image, the deck renders
		// nothing and the failure is invisible — so assert the container from scratch.
		fuzzEach(
			config,
			(rng) => Array.from({ length: rng.between(1, 40) }, () => randomFrameString(rng)),
			(parameters) => {
				let state: ArtState = INITIAL_ART_STATE;
				for (const parameter of parameters) {
					const frame = parseArtFrame(parameter);
					if (frame === undefined) continue;
					const step = nextArtState(state, frame, 1_000);
					state = step.state;
					if (step.outcome.kind !== "complete") continue;

					const { bytes, type } = step.outcome.image;
					if (type === "jpeg") {
						assert.equal(bytes[0], 0xff);
						assert.equal(bytes[1], 0xd8);
						assert.equal(bytes[bytes.length - 2], 0xff);
						assert.equal(bytes[bytes.length - 1], 0xd9);
					} else {
						assert.equal(bytes[0], 0x42);
						assert.equal(bytes[1], 0x4d);
					}
					assert.ok(bytes.length >= 2 && bytes.length <= MAX_ART_BYTES);
				}
			},
		);
	});

	it("stays linear: a long legal transfer costs no more than a short one per frame", () => {
		// Guards the reason chunks are concatenated once at the end rather than per
		// frame. The removed quadratic pattern (Buffer.concat per data event) was a real
		// finding in the receive buffer; 792 back-to-back frames would resurrect it.
		const frames = ["10" + Buffer.from([0xff, 0xd8]).toString("hex")];
		for (let i = 0; i < 4000; i++) frames.push("11" + "41".repeat(100));
		frames.push("12" + Buffer.from([0xff, 0xd9]).toString("hex"));

		expectFastCompletion(
			() => {
				let state: ArtState = INITIAL_ART_STATE;
				for (const parameter of frames) {
					state = nextArtState(state, parseArtFrame(parameter)!, 1_000).state;
				}
			},
			2_000,
			"folding 4002 frames",
		);
	});
});

describe("fuzz: JacketArtAccumulator", () => {
	it("bounds hosts and never retains a finished or rejected transfer", () => {
		fuzzEach(
			config,
			(rng) => ({
				hosts: Array.from({ length: rng.between(1, 20) }, (_, i) => `10.0.0.${i}`),
				parameters: Array.from({ length: rng.between(1, 120) }, () => randomFrameString(rng)),
				maxHosts: rng.between(1, 4),
			}),
			({ hosts, parameters, maxHosts }) => {
				const acc = new JacketArtAccumulator({ maxHosts });
				let now = 1_000;
				for (const parameter of parameters) {
					const host = hosts[now % hosts.length]!;
					// Occasionally jump the clock past the idle window, which is what a
					// receiver that goes quiet mid-transfer looks like.
					now += now % 7 === 0 ? ART_IDLE_MS + 1 : 1;
					expectOnlyDeliberateErrors(() => acc.accept(host, parameter, now), "accumulator.accept");

					const held = hosts.filter((h) => acc.pendingBytes(h) > 0);
					assert.ok(held.length <= maxHosts, `${held.length} hosts held, cap ${maxHosts}`);
					for (const h of held) assert.ok(acc.pendingBytes(h) <= MAX_ART_BYTES);
				}
			},
		);
	});
});
