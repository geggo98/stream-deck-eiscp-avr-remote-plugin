/**
 * Replay recorded receiver traffic through the real name store.
 *
 * This is the regression test for a defect found in the wild: a user's learned
 * input names contained an input called "Bass : +" and, reproduced from this very
 * recording, three inputs called "Volume". The display readout for volume and tone
 * is shaped exactly like the input readout — a label, padding, a trailing number —
 * so the passive pairer adopted it and overwrote a correct name.
 *
 * The recording is `npm run capture:standby`, i.e. real frames with real
 * timestamps, and the interesting stretch is entirely in the *awake* phase: no
 * standby and no Auto-Discover sweep is needed to corrupt a name, which is what
 * made the first hypothesis about this bug wrong.
 *
 * Timestamps are replayed by stubbing the clock rather than by sleeping: the rule
 * under test is about which change is more recent, and the recording spans ~30 s.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { decodeDisplayText } from "../src/actions/eiscp-base.ts";
import {
	nameFor,
	noteChange,
	noteDisplayChange,
	noteFld,
	recordSli,
	serialize,
} from "../src/actions/dedicated/name-store.ts";

interface Frame {
	dir: "out" | "in";
	ms: number;
	command?: string;
	parameter?: string;
}

const capture = JSON.parse(
	readFileSync(new URL("./fixtures/standby-behaviour-capture.json", import.meta.url), "utf-8"),
) as { frames: Frame[] };

/**
 * Feed every inbound frame to the name store the way discovery.ts's observer
 * does, with the captured timestamp as "now".
 */
function replay(host: string): void {
	const realNow = Date.now;
	try {
		for (const frame of capture.frames) {
			if (frame.dir !== "in" || !frame.command || frame.parameter === undefined) continue;
			// The store reads Date.now() internally; the recording *is* the clock here.
			Date.now = () => frame.ms;
			if (frame.command === "SLI" || frame.command === "LMD") noteChange(host, frame.command, frame.parameter);
			else if (frame.command === "FLD") noteFld(host, frame.parameter);
			else noteDisplayChange(host, frame.command);
		}
	} finally {
		Date.now = realNow;
	}
}

/** The display texts the recording contains, for the assertions below to lean on. */
function displayTexts(): string[] {
	const texts: string[] = [];
	for (const frame of capture.frames) {
		if (frame.dir !== "in" || frame.command !== "FLD" || frame.parameter === undefined) continue;
		const text = decodeDisplayText(frame.parameter);
		if (text && !texts.includes(text)) texts.push(text);
	}
	return texts;
}

describe("name store against recorded traffic", () => {
	it("the recording really does contain a readout that mimics an input", () => {
		// If a re-capture ever loses this, the test below stops proving anything.
		const texts = displayTexts();
		assert.ok(
			texts.some((t) => t.startsWith("Volume") && /\d$/.test(t)),
			`expected a "Volume …<digits>" readout, got ${JSON.stringify(texts)}`,
		);
		assert.ok(
			texts.some((t) => t.startsWith("BD/DVD")),
			"and a genuine input readout to compare it against",
		);
	});

	it("learns no input name from a volume readout, however well it is disguised", () => {
		const host = "capture-passive";
		replay(host);
		const learned = serialize()[host]?.SLI ?? {};
		const offenders = Object.entries(learned).filter(([, name]) => /^(Volume|Bass|Treble)\b/.test(name));
		assert.deepEqual(offenders, [], `these came from a transient readout: ${JSON.stringify(learned)}`);
	});

	it("still learns the input names the recording legitimately shows", () => {
		// The same replay has to keep working: 28600 SLI 10 -> 28640 FLD "BD/DVD  1".
		const host = "capture-legit";
		replay(host);
		assert.equal(nameFor(host, "SLI", "10"), "BD/DVD");
	});

	it("refuses a swept name taken while the volume was on the display", () => {
		// recordSli is the sweep's path and used to trust its FLD query blindly.
		const host = "capture-sweep";
		const realNow = Date.now;
		try {
			Date.now = () => 30_497; // the recording's MVL 0E
			noteDisplayChange(host, "MVL");
			Date.now = () => 30_515; // the FLD 18 ms later
			assert.equal(recordSli(host, "10", Buffer.from("Volume      14", "ascii").toString("hex")), false);
		} finally {
			Date.now = realNow;
		}
		assert.equal(serialize()[host], undefined);
	});
});
