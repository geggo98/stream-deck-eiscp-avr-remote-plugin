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
	setSliSweeping,
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

/** The Auto-Discover recording, whose SLI sweep is where the receiver's own LMD shows. */
const sweepCapture = JSON.parse(
	readFileSync(new URL("./fixtures/name-discovery-capture.json", import.meta.url), "utf-8"),
) as { sweeps: Record<string, { frames: Frame[] }> };

const hex = (s: string) => Buffer.from(s, "ascii").toString("hex");

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

	it("still learns the mode name the recording legitimately shows", () => {
		// 21254 LMD 00 -> 21274 FLD "    Stereo    ", 2410 ms after the last input
		// change: a mode the user chose, not one the receiver announced for itself.
		// This is the case that set INPUT_ECHO_MS — a wider window ate it.
		const host = "capture-legit-mode";
		replay(host);
		assert.equal(nameFor(host, "LMD", "00"), "Stereo");
	});

	it("refuses a swept name taken while the volume was on the display", () => {
		// recordSli is the sweep's path and used to trust its FLD query blindly.
		const host = "capture-sweep";
		const realNow = Date.now;
		try {
			Date.now = () => 30_497; // the recording's MVL 0E
			noteDisplayChange(host, "MVL");
			Date.now = () => 30_515; // the FLD 18 ms later
			assert.equal(recordSli(host, "10", Buffer.from("Volume      14", "ascii").toString("hex")), "rejected");
		} finally {
			Date.now = realNow;
		}
		assert.equal(serialize()[host], undefined);
	});
});

// --- an input change is a display change ------------------------------------

/** Inbound frames of the recorded SLI sweep, which is where the receiver echoes. */
const sliSweepFrames = (sweepCapture.sweeps["SLI"]?.frames ?? []).filter(
	(f): f is Frame & { command: string; parameter: string } =>
		f.dir === "in" && f.command !== undefined && f.parameter !== undefined,
);

/**
 * Input changes the receiver answered with a listening mode of its own, read out of
 * the recording: the `SLI`, the `LMD` that followed it, and the first display text
 * after that.
 */
function inputEchoes(): { code: string; at: number; mode: string; lmdAt: number; fldAt: number }[] {
	const found: { code: string; at: number; mode: string; lmdAt: number; fldAt: number }[] = [];
	let last: string | undefined;
	for (const [i, frame] of sliSweepFrames.entries()) {
		if (frame.command !== "SLI" || frame.parameter === last) continue;
		last = frame.parameter;
		const rest = sliSweepFrames.slice(i + 1);
		const lmd = rest.find((f) => f.command === "LMD");
		const fld = rest.find((f) => f.command === "FLD");
		if (!lmd || !fld || lmd.ms - frame.ms > 300) continue;
		found.push({ code: frame.parameter, at: frame.ms, mode: lmd.parameter, lmdAt: lmd.ms, fldAt: fld.ms });
	}
	return found;
}

/**
 * Replay one recorded input change — the `SLI`, the receiver's `LMD`, and then a
 * display text of our choosing at the recorded moment.
 *
 * Only the text is substituted. What the recording cannot supply is the text itself:
 * it was taken with a station playing, not with AirPlay, and this receiver puts the
 * *service* name on the display when it returns to its network input.
 */
function replayEcho(host: string, echo: ReturnType<typeof inputEchoes>[number], text: string, opts: { sweeping?: boolean } = {}): void {
	const realNow = Date.now;
	try {
		if (opts.sweeping) setSliSweeping(host, true);
		Date.now = () => echo.at;
		noteChange(host, "SLI", echo.code);
		Date.now = () => echo.lmdAt;
		noteChange(host, "LMD", echo.mode);
		Date.now = () => echo.fldAt;
		noteFld(host, hex(text));
	} finally {
		Date.now = realNow;
		if (opts.sweeping) setSliSweeping(host, false);
	}
}

describe("name store: the receiver's own mode is not a mode the user chose", () => {
	it("the recording really does show the receiver answering an input change with a mode", () => {
		// The premise the tests below stand on, asserted from the fixture rather than
		// typed in — a re-capture may legitimately produce different numbers.
		const echoes = inputEchoes();
		assert.ok(echoes.length >= 3, `expected the receiver to echo several input changes, got ${echoes.length}`);
		const gaps = echoes.map((e) => e.lmdAt - e.at);
		assert.ok(Math.max(...gaps) <= 300, `LMD echo gaps: ${gaps.join(", ")} ms`);
		// And the display text that follows lands inside the window that echo opens,
		// which is what makes it learnable as a mode name in the first place.
		const delays = echoes.map((e) => e.fldAt - e.lmdAt);
		assert.ok(Math.max(...delays) <= 2500, `FLD after the echo: ${delays.join(", ")} ms`);
	});

	it("does not learn the input's own display text as the mode's name", () => {
		// The defect, at the recorded timings: with AirPlay playing, moving the input
		// away makes this receiver hop back by itself; it announces `LMD 82` 10 ms
		// after the `SLI`, then shows "Airplay" — and mode 82 ("DTS Neural:X") was
		// renamed after the service.
		const echo = inputEchoes().find((e) => e.code === "2B") ?? inputEchoes()[0]!;
		const host = "capture-echo";
		replayEcho(host, echo, "Airplay");
		assert.equal(serialize()[host]?.LMD, undefined, "the receiver's own mode announcement taught us nothing");
		assert.notEqual(nameFor(host, "LMD", echo.mode), "Airplay");
	});

	it("does not learn it during an Auto-Discover sweep either", () => {
		// The sweep changes the input twelve times and the receiver answers each one,
		// so the input change has to be recorded even while SLI pairing is suppressed.
		const echo = inputEchoes().find((e) => e.code === "2B") ?? inputEchoes()[0]!;
		const host = "capture-echo-sweeping";
		replayEcho(host, echo, "Airplay", { sweeping: true });
		assert.equal(serialize()[host]?.LMD, undefined);
	});

	it("learns nothing from the recorded sweep's own display texts", () => {
		// Two of them do not end in digits — "TEDDY       --" and "FM 87.50MHz --" —
		// so they are shaped like a mode name and nothing but the input rule keeps
		// them out of the mode map.
		const host = "capture-sweep-replay";
		const realNow = Date.now;
		try {
			setSliSweeping(host, true);
			for (const frame of sliSweepFrames) {
				Date.now = () => frame.ms;
				if (frame.command === "SLI" || frame.command === "LMD") noteChange(host, frame.command, frame.parameter);
				else if (frame.command === "FLD") noteFld(host, frame.parameter);
				else noteDisplayChange(host, frame.command, frame.parameter);
			}
		} finally {
			Date.now = realNow;
			setSliSweeping(host, false);
		}
		assert.equal(serialize()[host]?.LMD, undefined, "a station name is not a listening mode");
	});
});

describe("name store: a track title is not an input name", () => {
	it("every digit-terminated readout in the recording ends in the volume", () => {
		// The premise for the rule below: "<input>      <volume>" means what it says.
		let volume: number | undefined;
		const checked: string[] = [];
		for (const frame of capture.frames) {
			if (frame.dir !== "in" || !frame.command || frame.parameter === undefined) continue;
			if (frame.command === "MVL" && /^[0-9A-Fa-f]{2}$/.test(frame.parameter))
				volume = parseInt(frame.parameter, 16);
			if (frame.command !== "FLD" || volume === undefined) continue;
			const text = decodeDisplayText(frame.parameter);
			const digits = /(\d+)\s*$/.exec(text);
			if (!digits) continue;
			checked.push(`${text} @MVL ${volume}`);
			assert.equal(parseInt(digits[1]!, 10), volume, `"${text}" should end in the volume`);
		}
		assert.ok(checked.length >= 4, `expected several readouts to check, got ${checked.join(" | ")}`);
	});

	it("refuses a scrolling title whose window happens to end in a digit", () => {
		// What the user saw: the Input encoder read "at is Love (". The display is 14
		// characters wide and scrolls, so a title lands there ending in a digit often
		// enough — and right after the input change, no metadata frame has arrived yet
		// to give the display back to the source.
		const echo = inputEchoes().find((e) => e.code === "2B") ?? inputEchoes()[0]!;
		const host = "capture-title";
		const realNow = Date.now;
		try {
			Date.now = () => echo.at - 1;
			noteDisplayChange(host, "MVL", "0E"); // volume 14, as the other recording shows it
			Date.now = () => echo.at;
			noteChange(host, "SLI", echo.code);
			Date.now = () => echo.fldAt;
			assert.equal(noteFld(host, hex("at is Love (7")), false);
		} finally {
			Date.now = realNow;
		}
		assert.equal(serialize()[host], undefined, "nothing at all should have been learned");
	});
});
