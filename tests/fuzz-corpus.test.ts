/**
 * Deterministic replay of the fuzz regression corpus.
 *
 * This is what makes the fuzzing durable. The fuzzers explore randomly, so a bug
 * they found once is only guaranteed to be caught again if the offending input is
 * recorded — otherwise a regression waits for the same seed to come round. Every
 * finding goes into tests/fixtures/fuzz-corpus.json and is replayed here, in the
 * normal suite, with no randomness and no time budget of its own.
 *
 * Adding a case is editing the JSON; this file needs no changes.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodePacket, parseIscpMessage } from "../src/adapter/eiscp/protocol.ts";
import { parseEcnResponse } from "../src/adapter/eiscp/discover.ts";
import { buildFrame, expectFastCompletion, expectOnlyDeliberateErrors } from "./helpers/fuzz.ts";

/** How an entry is expected to behave. */
type Expectation = "parses-or-rejects" | "fast" | "rejected";

interface BuildSpec {
	prefix: string;
	repeat: string;
	count: number;
	suffix: string;
}

interface TextEntry {
	id: string;
	text?: string;
	build?: BuildSpec;
	expect: Expectation;
	note: string;
}

interface FrameEntry {
	id: string;
	frame: { magic?: string; headerSize?: number; dataSize?: number; version?: string; bodyText?: string };
	expect: Expectation;
	note: string;
}

interface Corpus {
	iscpMessages: TextEntry[];
	ecnBodies: TextEntry[];
	frames: FrameEntry[];
}

const corpus = JSON.parse(
	readFileSync(new URL("./fixtures/fuzz-corpus.json", import.meta.url), "utf-8"),
) as Corpus;

/** Time budget for `fast` entries: generous enough not to fail on a loaded runner. */
const FAST_BUDGET_MS = 250;

function materialise(entry: TextEntry): string {
	if (entry.build) {
		const { prefix, repeat, count, suffix } = entry.build;
		return prefix + repeat.repeat(count) + suffix;
	}
	assert.ok(entry.text !== undefined, `corpus entry ${entry.id} has neither text nor build`);
	return entry.text;
}

/**
 * Apply an entry's expectation to a parse.
 *
 * @param parse - Runs the parser; must throw to signal rejection.
 */
function check(id: string, expectation: Expectation, parse: () => unknown): void {
	switch (expectation) {
		case "rejected":
			assert.throws(() => parse(), `${id}: expected the parser to refuse this input`);
			return;
		case "fast":
			// Also asserts the parse-or-reject invariant: a ReDoS guard is worthless
			// if the input crashes instead of hanging.
			expectFastCompletion(
				() => void expectOnlyDeliberateErrors(parse, id),
				FAST_BUDGET_MS,
				id,
			);
			return;
		case "parses-or-rejects":
			expectOnlyDeliberateErrors(parse, id);
			return;
	}
}

describe("fuzz corpus: ISCP messages", () => {
	assert.ok(corpus.iscpMessages.length > 0, "corpus must not be empty");
	for (const entry of corpus.iscpMessages) {
		it(`${entry.id} — ${entry.note.split(".")[0]}`, () => {
			const input = materialise(entry);
			check(entry.id, entry.expect, () => parseIscpMessage(input));
		});
	}
});

describe("fuzz corpus: ECN discovery bodies", () => {
	assert.ok(corpus.ecnBodies.length > 0, "corpus must not be empty");
	for (const entry of corpus.ecnBodies) {
		it(`${entry.id} — ${entry.note.split(".")[0]}`, () => {
			const input = materialise(entry);
			check(entry.id, entry.expect, () => parseEcnResponse(parseIscpMessage(input)));
		});
	}
});

describe("fuzz corpus: eISCP frames", () => {
	assert.ok(corpus.frames.length > 0, "corpus must not be empty");
	for (const entry of corpus.frames) {
		it(`${entry.id} — ${entry.note.split(".")[0]}`, () => {
			const frame = buildFrame({
				magic: entry.frame.magic,
				headerSize: entry.frame.headerSize,
				dataSize: entry.frame.dataSize,
				version: entry.frame.version ? Buffer.from(entry.frame.version, "hex") : undefined,
				body: entry.frame.bodyText ?? "",
			});
			check(entry.id, entry.expect, () => decodePacket(frame));
		});
	}
});
