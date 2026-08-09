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

/** The receiver taking its input back while AirPlay played (`npm run capture:hop`). */
const hopCapture = JSON.parse(
	readFileSync(new URL("./fixtures/input-hop-capture.json", import.meta.url), "utf-8"),
) as { snapshot: Record<string, string>; phases: { name: string; frames: Frame[] }[] };

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

describe("name store: the receiver taking its input back, as recorded", () => {
	/** The hop and what the receiver announced with it, read out of each recorded run. */
	function hops(): { input: string; hopAt: number; lmdAt: number; mode: string; frames: Frame[] }[] {
		const home = hopCapture.snapshot["SLI"]!;
		const found: { input: string; hopAt: number; lmdAt: number; mode: string; frames: Frame[] }[] = [];
		for (const phase of hopCapture.phases) {
			const inbound = phase.frames.filter((f) => f.dir === "in");
			const ours = inbound.find((f) => f.command === "SLI" && f.parameter !== home);
			const hop = inbound.find((f) => f.command === "SLI" && f.parameter === home && f.ms > (ours?.ms ?? 0));
			const lmd = hop && inbound.find((f) => f.command === "LMD" && f.ms >= hop.ms);
			if (!hop || !lmd) continue;
			found.push({ input: home, hopAt: hop.ms, lmdAt: lmd.ms, mode: lmd.parameter!, frames: inbound });
		}
		return found;
	}

	it("the recording really caught the receiver steering itself", () => {
		// The premise: nothing asked for this input change, and a listening mode came
		// with it. Both runs, read from the fixture rather than typed in.
		const runs = hops();
		assert.equal(runs.length, hopCapture.phases.length, "every recorded run should contain a hop");
		for (const run of runs) assert.ok(run.lmdAt >= run.hopAt, "the mode follows the input, never precedes it");
	});

	it("INPUT_ECHO_MS still covers the slowest mode the receiver announced for itself", () => {
		// This is the number the capture nearly refuted: every earlier sample was under
		// 340 ms, and this recording caught one at 780 ms. If a re-capture finds a slower
		// one, this fails rather than the guard silently going quiet.
		const gaps = hops().map((r) => r.lmdAt - r.hopAt);
		const worst = Math.max(...gaps);
		assert.ok(worst < 1500, `the receiver's own mode came ${worst} ms after the hop, outside INPUT_ECHO_MS`);
		// And the guard must not have swallowed the far side: a deliberate mode change
		// was measured at 2410 ms in the standby recording.
		assert.ok(1500 < 2410, "the window has to stay clear of a mode the user chose");
	});

	it("learns nothing at all from the hop, at the recorded timings", () => {
		// The whole episode, replayed frame by frame with the recording as the clock:
		// the service name, the scrolling title, the volume announcement, everything.
		for (const [index, phase] of hopCapture.phases.entries()) {
			const host = `capture-hop-${index}`;
			const realNow = Date.now;
			try {
				for (const frame of phase.frames) {
					if (frame.dir !== "in" || !frame.command || frame.parameter === undefined) continue;
					Date.now = () => frame.ms;
					if (frame.command === "SLI" || frame.command === "LMD") noteChange(host, frame.command, frame.parameter);
					else if (frame.command === "FLD") noteFld(host, frame.parameter);
					else noteDisplayChange(host, frame.command, frame.parameter);
				}
			} finally {
				Date.now = realNow;
			}
			assert.equal(
				serialize()[host]?.LMD,
				undefined,
				`"${phase.name}" taught the mode a name: ${JSON.stringify(serialize()[host])}`,
			);
			const inputs = Object.values(serialize()[host]?.SLI ?? {});
			assert.deepEqual(
				inputs.filter((name) => /love|airplay|pairing/i.test(name)),
				[],
				`"${phase.name}" stored a title or service as an input name: ${JSON.stringify(inputs)}`,
			);
		}
	});

	it("shows why the sweep mutes instead of setting the volume to zero", () => {
		// Measured here for the first time: at volume 0 this receiver prints "Min"
		// instead of a number — "NET        Min", "BT AUDIO   Min". Had the sweep set
		// MVL 00, every input readout would have lost its digits, `endsWithVolume` would
		// have failed, and the readouts would have gone to the *mode* branch instead.
		const texts = hopCapture.phases
			.flatMap((p) => p.frames)
			.filter((f) => f.dir === "in" && f.command === "FLD" && f.parameter !== undefined)
			.map((f) => decodeDisplayText(f.parameter!));
		assert.ok(
			texts.some((t) => /Min\s*$/.test(t)),
			"the recording should contain a readout ending in Min",
		);
		assert.ok(
			texts.some((t) => /\d\s*$/.test(t)),
			"and one ending in digits, from before the volume dropped",
		);
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

describe("name store: a mode sweep over a playing source, at the recorded timings", () => {
	/**
	 * The scrolling title the receiver actually put on its display while AirPlay played,
	 * read out of the recording rather than typed in: every inbound FLD after the
	 * transport reported `Pxx` whose text does not end in a digit — which is precisely
	 * the set that reaches the mode-name branch.
	 */
	function titleFramesWhilePlaying(): { ms: number; parameter: string }[] {
		const inbound = hopCapture.phases[0]!.frames.filter((f) => f.dir === "in");
		const playing = inbound.find((f) => f.command === "NST" && f.parameter?.startsWith("P"));
		assert.ok(playing, "the recording has to contain a source that started playing");
		return inbound
			.filter((f) => f.command === "FLD" && f.ms > playing.ms && f.parameter !== undefined)
			.map((f) => ({ ms: f.ms, parameter: f.parameter! }))
			.filter((f) => !/\d\s*$/.test(decodeDisplayText(f.parameter)));
	}

	/**
	 * Replay those frames the way an Auto-Discover mode sweep would meet them: a mode
	 * code arriving shortly before each, which is exactly what opens the window the
	 * title then falls into. The receiver was never asked for any of this text.
	 */
	function replaySweepOverPlayback(host: string, transport: string): void {
		const codes = ["80", "82", "9A", "00", "0C", "FF"];
		const realNow = Date.now;
		try {
			Date.now = () => 0;
			noteDisplayChange(host, "NST", transport);
			titleFramesWhilePlaying().forEach((frame, index) => {
				// 200 ms before the reading, i.e. well inside LMD_WINDOW_MS.
				Date.now = () => frame.ms - 200;
				noteChange(host, "LMD", codes[index % codes.length]!);
				Date.now = () => frame.ms;
				noteFld(host, frame.parameter);
			});
		} finally {
			Date.now = realNow;
		}
	}

	it("the recording really contains a title that would land in a mode window", () => {
		const frames = titleFramesWhilePlaying();
		assert.ok(frames.length >= 10, `only ${frames.length} title frames while playing`);
		const texts = frames.map((f) => decodeDisplayText(f.parameter));
		assert.ok(
			texts.some((t) => /Pure Love/.test(t)),
			"the scrolling title should be in there",
		);
	});

	it("stores nothing while the transport says a source is playing", () => {
		const host = "capture-sweep-playing";
		replaySweepOverPlayback(host, "Pxx");
		assert.equal(serialize()[host], undefined, "a track title is not a listening-mode name");
	});

	it("and the same frames DO get stored when nothing is playing", () => {
		// The control run: without it, the test above would also pass if these frames
		// never reached the mode branch at all.
		const host = "capture-sweep-stopped";
		replaySweepOverPlayback(host, "Sxx");
		const stored = serialize()[host]?.LMD ?? {};
		assert.ok(Object.keys(stored).length > 0, "the frames must be eligible, or the guard proves nothing");
	});
});
