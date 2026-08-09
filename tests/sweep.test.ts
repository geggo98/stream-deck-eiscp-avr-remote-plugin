/**
 * Tests for the SDK-free sweep state machine (src/actions/dedicated/sweep.ts)
 * with an injected fake receiver and an instant sleep — no timers, no SDK.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	MAX_NAME_SAMPLES,
	runSweep,
	type SweepDeps,
	type SweepProgress,
} from "../src/actions/dedicated/sweep.ts";
import type { SliRecordOutcome } from "../src/actions/dedicated/name-store.ts";

interface FakeReceiver {
	deps: SweepDeps;
	/** Every send as "<command>:<param>", in order. */
	sent: string[];
	/** name-store interactions, in order: "sweeping:on/off", "recordSli:<code>:<fld>". */
	nameEvents: string[];
	value: () => string;
}

/**
 * Fake receiver whose value advances through `advance(current)` on each UP; any
 * other sent param is treated as an absolute set (the restore). getCached
 * reflects the new value immediately, so the sweep's poll loop exits on its
 * first probe.
 */
function fakeReceiver(
	start: string,
	advance: (current: string) => string,
	opts: {
		failUpAt?: number;
		failRestore?: boolean;
		fld?: string;
		/** Successive FLD readings, cycled; models a display that changes under us. */
		fldSequence?: string[];
		/** What the store makes of a reading — the trigger for re-measuring. */
		recordOutcome?: (fldHex: string) => SliRecordOutcome;
		/** Codes that count as named, overriding what this fake stored. */
		namedCodes?: string[];
		/** Starting values for the commands the quieting touches (PWR/MVL/AMT/NST). */
		others?: Record<string, string>;
		/** Commands whose query rejects, for the "never mutate what you cannot read" paths. */
		failQuery?: readonly string[];
	} = {},
): FakeReceiver {
	let value = start;
	let ups = 0;
	let fldReads = 0;
	const sent: string[] = [];
	const nameEvents: string[] = [];
	/** Codes a reading was stored for, so hasLearnedName can answer honestly. */
	const stored = new Set<string>();
	/**
	 * State for the commands the sweep touches that are *not* the one it is walking.
	 *
	 * This used to be one `value` shared by every command, which was harmless while the
	 * sweep only ever sent `SLI`/`LMD` — and stopped being harmless the moment it also
	 * quietened the receiver: `PWR QSTN` answered with the input code, and `AMT 01`
	 * overwrote the very value the walk was tracking. A per-command map, with the swept
	 * command still held in `value` so the ring logic is unchanged.
	 */
	const others: Record<string, string> = { PWR: "01", MVL: "0E", AMT: "00", NST: "S--", NTC: "", ...opts.others };
	const isSwept = (command: string) => command !== "FLD" && !(command in others);
	const deps: SweepDeps = {
		send: (_host, command, param) => {
			sent.push(`${command}:${param}`);
			if (!isSwept(command)) {
				others[command] = param;
				return Promise.resolve();
			}
			if (param === "UP") {
				ups++;
				if (opts.failUpAt === ups) return Promise.reject(new Error("boom"));
				value = advance(value);
			} else {
				if (opts.failRestore) return Promise.reject(new Error("restore-fail"));
				value = param;
			}
			return Promise.resolve();
		},
		query: (_host, command) => {
			if (opts.failQuery?.includes(command)) return Promise.reject(new Error(`${command} query failed`));
			if (command in others) return Promise.resolve(others[command]!);
			if (command !== "FLD") return Promise.resolve(value);
			const sequence = opts.fldSequence;
			if (!sequence || sequence.length === 0) return Promise.resolve(opts.fld ?? "00");
			return Promise.resolve(sequence[Math.min(fldReads++, sequence.length - 1)]!);
		},
		getCached: (_host, command) => (command in others ? others[command] : value),
		sleep: () => Promise.resolve(),
		nameFor: (_host, _command, code) => `name:${code}`,
		recordSli: (_host, code, fldHex, options) => {
			const how = options?.corroborated ? ":corroborated" : options?.tentative ? ":tentative" : "";
			nameEvents.push(`recordSli:${code}:${fldHex}${how}`);
			const outcome = opts.recordOutcome ? opts.recordOutcome(fldHex) : "learned";
			// Only these two mean the store kept it; see SliRecordOutcome. A tentative
			// reading the store called doubtful is *reported*, not stored — which is what
			// lets the loop below discard it.
			if (outcome === "learned" || outcome === "unchanged" || options?.corroborated) stored.add(code);
			return outcome;
		},
		// Mirrors the name store: a code counts as named once a reading was stored
		// for it. `opts.namedCodes` lets a test say "this option never got a name".
		hasLearnedName: (_host, _command, code) => (opts.namedCodes ? opts.namedCodes.includes(code) : stored.has(code)),
		setSliSweeping: (_host, on) => {
			nameEvents.push(`sweeping:${on ? "on" : "off"}`);
		},
	};
	return { deps, sent, nameEvents, value: () => value };
}

/** UP cycles through the given ring of values. */
function ring(values: string[]): (current: string) => string {
	return (current) => values[(values.indexOf(current) + 1) % values.length]!;
}

describe("runSweep", () => {
	it("stops on wrap-around and restores the start value", async () => {
		const rx = fakeReceiver("A", ring(["A", "B", "C"]));
		const progress: SweepProgress[] = [];
		const { count } = await runSweep("h", "LMD", (p) => progress.push(p), rx.deps);
		assert.equal(count, 3); // A -> B -> C -> A
		assert.deepEqual(rx.sent, ["LMD:UP", "LMD:UP", "LMD:UP", "LMD:A"]);
		assert.equal(rx.value(), "A", "original value restored");
		assert.deepEqual(
			progress,
			[
				{ done: 1, current: "name:B" },
				{ done: 2, current: "name:C" },
				{ done: 3, current: "name:A" },
			],
		);
	});

	it("bails after 5 steps when UP does not advance the value", async () => {
		const rx = fakeReceiver("A", () => "A"); // never changes
		const { count } = await runSweep("h", "LMD", undefined, rx.deps);
		assert.equal(count, 5);
		assert.deepEqual(rx.sent, ["LMD:UP", "LMD:UP", "LMD:UP", "LMD:UP", "LMD:UP", "LMD:A"]);
	});

	it("caps a never-repeating sweep at 60 steps and still restores", async () => {
		let n = 0;
		const rx = fakeReceiver("v0", () => `v${++n}`); // unique value every UP
		const { count } = await runSweep("h", "LMD", undefined, rx.deps);
		assert.equal(count, 60);
		assert.equal(rx.sent.filter((s) => s === "LMD:UP").length, 60);
		assert.equal(rx.sent[rx.sent.length - 1], "LMD:v0", "restore sent after the cap");
	});

	it("stops when the value returns to an already-seen option that is not the start", async () => {
		// A -> B -> C -> B: the receiver skips the start and loops B/C.
		const seq: Record<string, string> = { A: "B", B: "C", C: "B" };
		const rx = fakeReceiver("A", (c) => seq[c]!, { namedCodes: ["B", "C"] });
		const { count, named } = await runSweep("h", "LMD", undefined, rx.deps);
		assert.equal(count, 3);
		assert.equal(named, 2, "B was stepped onto twice but is one option");
		assert.equal(rx.sent[rx.sent.length - 1], "LMD:A");
	});

	it("restores the start value when a send fails mid-sweep and rethrows the original error", async () => {
		let n = 0;
		const rx = fakeReceiver("v0", () => `v${++n}`, { failUpAt: 3 });
		await assert.rejects(runSweep("h", "LMD", undefined, rx.deps), /boom/);
		assert.equal(rx.sent[rx.sent.length - 1], "LMD:v0", "restore sent despite the failure");
		assert.equal(rx.value(), "v0");
	});

	it("does not let a failing restore mask the sweep's original error", async () => {
		const rx = fakeReceiver("A", ring(["A", "B"]), { failUpAt: 2, failRestore: true });
		await assert.rejects(runSweep("h", "LMD", undefined, rx.deps), /boom/);
		assert.equal(rx.sent[rx.sent.length - 1], "LMD:A", "restore was attempted");
	});

	it("a failing restore after a SUCCESSFUL sweep rejects instead of reporting success", async () => {
		// Otherwise the PI would show "Done" + a green checkmark while the
		// receiver is left on the wrong option.
		const rx = fakeReceiver("A", ring(["A", "B", "C"]), { failRestore: true });
		await assert.rejects(runSweep("h", "LMD", undefined, rx.deps), /restoring A failed.*restore-fail/);
	});

	it("SLI: suppresses passive pairing during the sweep and learns names from FLD queries", async () => {
		const rx = fakeReceiver("10", ring(["10", "11", "12"]), { fld: "4344202020203134" });
		const { count } = await runSweep("h", "SLI", undefined, rx.deps);
		assert.equal(count, 3);
		// Sweeping flag on before the first UP, off again before the restore;
		// each changed step records the input name from a direct FLD query.
		assert.deepEqual(rx.nameEvents, [
			"sweeping:on",
			"recordSli:11:4344202020203134:tentative",
			"recordSli:12:4344202020203134:tentative",
			"recordSli:10:4344202020203134:tentative",
			"sweeping:off",
		]);
		// The input goes back first and the unmute is last, deliberately: the resume is
		// the step most likely to be refused, and a receiver left silent reads as broken
		// hardware while a source left paused is one button.
		assert.equal(rx.sent.at(-1), "AMT:00", `unmute last, got ${rx.sent.join(" ")}`);
		assert.ok(rx.sent.includes("SLI:10"), "and the input was restored before it");
	});

	it("turns the SLI sweeping flag off even when the sweep fails", async () => {
		const rx = fakeReceiver("10", ring(["10", "11", "12"]), { failUpAt: 1 });
		await assert.rejects(runSweep("h", "SLI", undefined, rx.deps), /boom/);
		assert.deepEqual(rx.nameEvents, ["sweeping:on", "sweeping:off"]);
		// A failed sweep still gives the receiver back: input restored, then unmuted.
		assert.ok(rx.sent.includes("SLI:10"));
		assert.equal(rx.sent.at(-1), "AMT:00");
	});
});

// --- quietening the receiver for an input sweep -----------------------------

describe("runSweep: silencing the receiver before it walks the inputs", () => {
	const inputs = (opts: Parameters<typeof fakeReceiver>[2] = {}) =>
		fakeReceiver("10", ring(["10", "11"]), { fld: "4344202020203134", ...opts });

	it("pauses and mutes before the first UP, and puts both back afterwards", async () => {
		const rx = inputs({ others: { NST: "P--" } }); // something is playing
		await runSweep("h", "SLI", undefined, rx.deps);
		const order = rx.sent.filter((s) => !s.startsWith("SLI:UP"));
		assert.deepEqual(order, ["NTC:PAUSE", "AMT:01", "SLI:10", "NTC:PLAY", "AMT:00"], rx.sent.join(" "));
	});

	it("leaves the listening-mode sweep completely alone", async () => {
		// It never walks the input away from a playing source, so it has no reason to
		// touch the transport or the volume — and the user asked for it to stay as it is.
		const rx = fakeReceiver("80", ring(["80", "82"]), { others: { NST: "P--" } });
		await runSweep("h", "LMD", undefined, rx.deps);
		assert.deepEqual(
			rx.sent.filter((s) => !s.startsWith("LMD:")),
			[],
			`the mode sweep sent something else: ${rx.sent.join(" ")}`,
		);
	});

	it("does not resume a source that was not playing", async () => {
		// The pause is harmless on an idle source; starting one is not. `NST` says which.
		const rx = inputs({ others: { NST: "S--" } });
		await runSweep("h", "SLI", undefined, rx.deps);
		assert.ok(rx.sent.includes("NTC:PAUSE"));
		assert.ok(!rx.sent.includes("NTC:PLAY"), `it started playback: ${rx.sent.join(" ")}`);
	});

	it("asks the receiver when no NST frame has been broadcast yet", async () => {
		// This one cost a user their music. `NST` is broadcast only when the transport
		// *changes*, so a plugin that connected while the music was already playing has
		// never seen one — and the first live sweep duly reported "not playing" about a
		// source that was, paused it, and left it paused. An empty cache is a question.
		const rx = inputs({ others: { NST: "" } });
		rx.deps.getCached = (_h, command) => (command === "NST" ? undefined : rx.value());
		let asked = false;
		const query = rx.deps.query;
		rx.deps.query = (host, command) => {
			if (command === "NST") {
				asked = true;
				return Promise.resolve("P--");
			}
			return query(host, command);
		};
		await runSweep("h", "SLI", undefined, rx.deps);
		assert.ok(asked, "it never asked what the transport was doing");
		assert.ok(rx.sent.includes("NTC:PLAY"), `it did not resume: ${rx.sent.join(" ")}`);
	});

	it("does not resume when even asking gets no answer", async () => {
		// No cached frame and no reply: no evidence is still not evidence of playing.
		const rx = inputs({ others: { NST: "" }, failQuery: ["NST"] });
		rx.deps.getCached = (_h, command) => (command === "NST" ? undefined : rx.value());
		await runSweep("h", "SLI", undefined, rx.deps);
		assert.ok(!rx.sent.includes("NTC:PLAY"));
	});

	it("does not mute what it could not read back", async () => {
		// Never change a state you cannot restore — the rule the capture scripts follow.
		// A sweep at full volume is loud; a receiver left muted for good is a fault report.
		const rx = inputs({ failQuery: ["AMT"] });
		await runSweep("h", "SLI", undefined, rx.deps);
		assert.ok(!rx.sent.some((s) => s.startsWith("AMT:")), `it muted anyway: ${rx.sent.join(" ")}`);
	});

	it("leaves an already-muted receiver muted", async () => {
		const rx = inputs({ others: { AMT: "01" } });
		await runSweep("h", "SLI", undefined, rx.deps);
		assert.ok(!rx.sent.some((s) => s.startsWith("AMT:")), `it touched the mute: ${rx.sent.join(" ")}`);
	});

	it("wakes a sleeping receiver first, and puts it back to sleep", async () => {
		// In standby every quieting command is dropped in silence while `SLI` is honoured
		// *and* powers the unit on — so an unguarded sweep would assert a mute that never
		// landed and then walk the inputs at full volume.
		const rx = inputs({ others: { PWR: "00" } });
		await runSweep("h", "SLI", undefined, rx.deps);
		const power = rx.sent.filter((s) => s.startsWith("PWR:"));
		assert.deepEqual(power, ["PWR:01", "PWR:00"], `power handling: ${rx.sent.join(" ")}`);
		assert.ok(rx.sent.indexOf("PWR:01") < rx.sent.indexOf("AMT:01"), "woken before the mute");
		assert.ok(rx.sent.lastIndexOf("PWR:00") > rx.sent.indexOf("AMT:00"), "unmuted before going back to sleep");
	});

	it("sweeps without quietening when the power state cannot be read", async () => {
		const rx = inputs({ failQuery: ["PWR"] });
		const { count } = await runSweep("h", "SLI", undefined, rx.deps);
		assert.equal(count, 2, "the sweep still ran");
		assert.deepEqual(
			rx.sent.filter((s) => !s.startsWith("SLI:")),
			[],
			`it quietened blindly: ${rx.sent.join(" ")}`,
		);
	});
});

describe("runSweep: re-measuring a doubtful input name", () => {
	// A -> B, then B -> A: the wrap step records the start code too (see the
	// suppression test above), so the assertions below look at code B alone.
	const oneStep = (opts: Parameters<typeof fakeReceiver>[2]) => fakeReceiver("A", ring(["A", "B"]), opts);
	const reads = (rx: FakeReceiver) => rx.nameEvents.filter((e) => e.startsWith("recordSli:B:"));

	it("takes a trustworthy reading once", async () => {
		// The normal case must not get slower: one query, one record.
		const rx = oneStep({ fld: "GOOD", recordOutcome: () => "learned" });
		await runSweep("h", "SLI", undefined, rx.deps);
		assert.deepEqual(reads(rx), ["recordSli:B:GOOD:tentative"]);
	});

	it("measures again when the store refuses the reading, and keeps the good one", async () => {
		// First reading caught a transient readout (volume/tone), the display then
		// returns to the input — which is why re-measuring works at all.
		const rx = oneStep({
			fldSequence: ["TRANSIENT", "PERSISTENT", "PERSISTENT"],
			recordOutcome: (fld) => (fld === "TRANSIENT" ? "rejected" : "learned"),
		});
		await runSweep("h", "SLI", undefined, rx.deps);
		assert.deepEqual(reads(rx), ["recordSli:B:TRANSIENT:tentative", "recordSli:B:PERSISTENT:tentative"]);
	});

	it("accepts a stable reading the spec disagrees with, once it wins a majority", async () => {
		// The "BT AUDIO where the spec says BLUETOOTH" case: doubtful every time, but
		// it is what the receiver actually shows, so it must survive.
		const rx = oneStep({ fld: "RELABELLED", recordOutcome: () => "doubtful" });
		await runSweep("h", "SLI", undefined, rx.deps);
		assert.deepEqual(reads(rx), [
			"recordSli:B:RELABELLED:tentative",
			"recordSli:B:RELABELLED:tentative",
			"recordSli:B:RELABELLED:tentative",
			"recordSli:B:RELABELLED:corroborated",
		]);
	});

	it("decides by majority rather than by the last reading", async () => {
		// 2 of 3 for GOOD; NOISE must not win just by arriving last.
		const rx = oneStep({
			fldSequence: ["GOOD", "NOISE", "GOOD"],
			recordOutcome: () => "doubtful",
		});
		await runSweep("h", "SLI", undefined, rx.deps);
		assert.equal(reads(rx).at(-1), "recordSli:B:GOOD:corroborated");
	});

	it("gives up after the sample cap when nothing repeats", async () => {
		const rx = oneStep({
			fldSequence: ["A1", "B2", "C3", "D4", "E5"],
			recordOutcome: () => "doubtful",
		});
		await runSweep("h", "SLI", undefined, rx.deps);
		const attempts = reads(rx);
		assert.equal(attempts.length, MAX_NAME_SAMPLES, `capped at ${MAX_NAME_SAMPLES} readings`);
		assert.equal(
			attempts.filter((e) => e.endsWith(":corroborated")).length,
			0,
			"a tie decides nothing, so no name is stored",
		);
	});

	it("takes every sample tentatively, so a display that never settles leaves no name", async () => {
		// A display that reads differently every time is a *scrolling* one — a track
		// title on a streaming input. Each sample used to be stored as it was taken, so
		// the last one stayed behind while this loop logged "leaving it unnamed"; a
		// user's input ended up called "at is Love (".
		const rx = oneStep({
			fldSequence: ["at is Love (", "t is Love (R", " is Love (Ra", "is Love (Rad", "s Love (Radi"],
			recordOutcome: () => "doubtful",
		});
		await runSweep("h", "SLI", undefined, rx.deps);
		assert.deepEqual(
			reads(rx).filter((e) => !e.endsWith(":tentative")),
			[],
			"nothing was ever offered to the store for keeps",
		);
		assert.equal(rx.deps.hasLearnedName("h", "SLI", "B"), false, "so the option is genuinely unnamed");
	});

	it("does not re-measure while sweeping listening modes", async () => {
		// LMD names arrive passively; there is no FLD query to repeat.
		const rx = fakeReceiver("A", ring(["A", "B"]), { fld: "X", recordOutcome: () => "doubtful" });
		await runSweep("h", "LMD", undefined, rx.deps);
		assert.deepEqual(reads(rx), []);
	});
});

describe("runSweep: what it reports back", () => {
	it("counts the options that came back with a name, not the steps taken", async () => {
		const rx = fakeReceiver("10", ring(["10", "11", "12"]), { fld: "4344202020203134" });
		const { count, named } = await runSweep("h", "SLI", undefined, rx.deps);
		assert.equal(count, 3, "three steps");
		assert.equal(named, 3, "and all three options named");
	});

	it("reports zero names when the receiver never moves — the standby case", async () => {
		// This is what actually happened: a sweep against a sleeping receiver bailed
		// after 5 steps having learned nothing, and the PI reported "5 names".
		const rx = fakeReceiver("10", () => "10", { fld: "4344202020203134" });
		const { count, named } = await runSweep("h", "SLI", undefined, rx.deps);
		assert.equal(count, 5, "bails out after five fruitless steps");
		assert.equal(named, 0, "and says so");
		assert.deepEqual(
			rx.nameEvents.filter((e) => e.startsWith("recordSli:")),
			[],
			"nothing was even read, so nothing could be named",
		);
	});

	it("does not borrow names it did not read this time", async () => {
		// hasLearnedName is true for everything (names from an earlier sweep), but the
		// receiver does not move: the count must still be 0 rather than inheriting them.
		const rx = fakeReceiver("10", () => "10", { namedCodes: ["10", "11", "12"] });
		const { named } = await runSweep("h", "SLI", undefined, rx.deps);
		assert.equal(named, 0);
	});

	it("counts an option whose name the passive learner supplied (LMD)", async () => {
		// LMD names arrive passively during the settle window, so the sweep only asks
		// the store afterwards.
		const rx = fakeReceiver("80", ring(["80", "82"]), { namedCodes: ["82", "80"] });
		const { count, named } = await runSweep("h", "LMD", undefined, rx.deps);
		assert.equal(count, 2);
		assert.equal(named, 2);
	});

	it("does not count an option that stayed unnamed", async () => {
		const rx = fakeReceiver("80", ring(["80", "82", "83"]), { namedCodes: ["82"] });
		const { count, named } = await runSweep("h", "LMD", undefined, rx.deps);
		assert.equal(count, 3);
		assert.equal(named, 1, "only the one the store has a name for");
	});

	it("counts the start option once, not twice, when the sweep wraps onto it", async () => {
		const rx = fakeReceiver("10", ring(["10", "11"]), { fld: "4344202020203134" });
		const { count, named } = await runSweep("h", "SLI", undefined, rx.deps);
		assert.equal(count, 2, "step onto 11, then back onto 10");
		assert.equal(named, 2, "two distinct options, each counted once");
	});
});

describe("runSweep: a mode sweep over a playing source", () => {
	it("reports that a source was playing, so a zero-name run is not read as a fault", async () => {
		// The store refuses every reading while a source owns the display (see noteFld),
		// which makes an empty run the expected outcome rather than a broken receiver.
		const rx = fakeReceiver("A", ring(["A", "B", "C"]), { others: { NST: "Pxx" }, namedCodes: [] });
		const result = await runSweep("h", "LMD", undefined, rx.deps);
		assert.equal(result.sourcePlaying, true);
		assert.equal(result.named, 0);
	});

	it("asks the transport when nothing was broadcast", async () => {
		// NST is re-broadcast only when the transport changes, so a plugin that
		// connected mid-playback has never seen one — and the query's answer is also
		// what arms the store's guard, through the message observer.
		const rx = fakeReceiver("A", ring(["A", "B"]), { others: { NST: "Pxx" } });
		const queried: string[] = [];
		const cached = rx.deps.getCached;
		rx.deps.getCached = (h, command) => (command === "NST" ? undefined : cached(h, command));
		const query = rx.deps.query;
		rx.deps.query = (h, command) => {
			queried.push(command);
			return query(h, command);
		};
		const result = await runSweep("h", "LMD", undefined, rx.deps);
		assert.ok(queried.includes("NST"), "an empty cache is a question, not an answer");
		assert.equal(result.sourcePlaying, true);
	});

	it("says nothing about playback for an input sweep", async () => {
		// That one pauses the source itself; blaming playback for its result would be
		// both wrong and unactionable.
		const rx = fakeReceiver("A", ring(["A", "B"]), { others: { NST: "Pxx" } });
		const result = await runSweep("h", "SLI", undefined, rx.deps);
		assert.equal(result.sourcePlaying, false);
	});

	it("is silent about playback when the source is stopped", async () => {
		const rx = fakeReceiver("A", ring(["A", "B"]), { others: { NST: "Sxx" } });
		const result = await runSweep("h", "LMD", undefined, rx.deps);
		assert.equal(result.sourcePlaying, false);
	});
});
