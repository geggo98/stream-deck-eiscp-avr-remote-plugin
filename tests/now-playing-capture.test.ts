/**
 * The now-playing pipeline against *recorded hardware*.
 *
 * `tests/fixtures/now-playing-capture.json` is 60 seconds of real AirPlay traffic from
 * the reference VSX-S520D, including a track change — anonymised, not trimmed: the
 * cover is a generated grey JPEG of exactly the original byte length re-chunked into
 * byte-identical frames, and the text is invented at exactly the original UTF-8 byte
 * length. Everything a synthetic mock cannot reproduce is verbatim:
 *
 *   - 792 and 368 frames per cover, back to back, with the real chunk sizes,
 *   - the cover arriving ~760 ms *before* the text that describes it,
 *   - NTM ticking once a second throughout,
 *   - the three text fields landing ~90 ms apart, which is why a track change has to
 *     be coalesced rather than taken at face value.
 *
 * Counts and timings are read out of the fixture, never typed in: this device's timing
 * is not deterministic, so a re-capture may legitimately produce different totals.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { ConnectionEvent } from "../src/adapter/eiscp/connection-manager.ts";
import { NowPlayingTracker, type NowPlaying, type NowPlayingChange } from "../src/adapter/eiscp/now-playing.ts";

interface CaptureFrame {
	ms: number;
	command: string;
	parameter: string;
}
interface Capture {
	note: string;
	coverTransfers: { frames: number; bytes: number }[];
	frames: CaptureFrame[];
}

const capture = JSON.parse(
	readFileSync(new URL("./fixtures/now-playing-capture.json", import.meta.url), "utf-8"),
) as Capture;

/**
 * Replay the recording through the real tracker, on the recording's own clock.
 *
 * `primed` reproduces what production does before the pushed traffic arrives: the
 * tracker queries the current track once, because none of these commands is
 * volunteered on connect. Without that the recording's single text burst *is* the
 * first identity the tracker ever sees — the silent initial fill — and no track change
 * is reported. That is the intended behaviour (a display must not flash on every
 * connect) and it has its own test below; every other test wants the primed sequence.
 */
function replay(options: { watch?: boolean; primed?: boolean } = {}) {
	let messageCb: ((host: string, command: string, parameter: string) => void) | undefined;
	let clock = 0;
	const tracker = new NowPlayingTracker(
		{
			addMessageObserver: (cb) => {
				messageCb = cb;
				return () => (messageCb = undefined);
			},
			addConnectionObserver: () => () => {},
			queryCommand: async () => "",
		},
		{ now: () => clock },
	);
	tracker.start();

	const updates: { ms: number; change: NowPlayingChange }[] = [];
	const trackChanges: { ms: number; state: NowPlaying }[] = [];
	if (options.watch !== false) {
		tracker.onUpdate("10.0.0.1", (_s, change) => updates.push({ ms: clock, change }));
		tracker.onTrackChange("10.0.0.1", (state) => trackChanges.push({ ms: clock, state }));
	}

	if (options.primed !== false) {
		// Stands in for the pre-fill queries answering with whatever was playing before.
		clock = -10_000;
		messageCb?.("10.0.0.1", "NTI", "Vorheriger Titel");
		messageCb?.("10.0.0.1", "NAT", "Vorheriger Interpret");
	}
	for (const frame of capture.frames) {
		clock = frame.ms;
		messageCb?.("10.0.0.1", frame.command, frame.parameter);
	}
	return { tracker, updates, trackChanges, state: tracker.get("10.0.0.1") };
}

describe(`now-playing against the recorded VSX-S520D`, () => {
	it("is an anonymised recording, and says so", () => {
		// Guard against someone dropping a raw capture in here: the fixture is public,
		// and a real one carries copyrighted cover art and track names.
		assert.match(capture.note, /ANONYMISED/);
		const text = capture.frames.filter((f) => ["NTI", "NAT", "NAL"].includes(f.command));
		assert.ok(text.length > 0, "the recording must still contain text frames");
		// The substitute vocabulary is non-ASCII on purpose — the measured tracks were
		// plain ASCII, so the real recording never exercised the UTF-8 path.
		assert.ok(
			text.some((f) => /[^\x00-\x7f]/.test(f.parameter)),
			`expected non-ASCII in the substituted text, got ${text.map((f) => f.parameter).join(", ")}`,
		);
	});

	it("assembles every cover the receiver sent, at the recorded size", () => {
		const { updates, state } = replay();
		const arts = updates.filter((u) => u.change === "art");

		assert.equal(arts.length, capture.coverTransfers.length, "one event per completed transfer");
		assert.ok(state.art, "the last cover is held");
		assert.equal(state.art.type, "jpeg");
		// The size comes from the fixture, which recorded what the hardware sent.
		const last = capture.coverTransfers[capture.coverTransfers.length - 1]!;
		assert.equal(state.art.bytes.length, last.bytes);
		assert.equal(state.art.frames, last.frames);
		// And it really is an image, not just a length.
		assert.equal(state.art.bytes.readUInt16BE(0), 0xffd8, "SOI");
		assert.equal(state.art.bytes.readUInt16BE(state.art.bytes.length - 2), 0xffd9, "EOI");
	});

	it("does not announce the first track it ever learns about", () => {
		// A display that flashed on every connect would be worse than one that misses the
		// very first track, so the initial fill is silent — asserted here against real
		// traffic rather than only against a synthetic burst.
		const { trackChanges, state } = replay({ primed: false });
		assert.equal(trackChanges.length, 0);
		assert.ok(state.track, "the state is filled all the same");
	});

	it("costs nothing at all when no element is watching", () => {
		// The load case: ~1 800 frames a second during a transfer. A plugin with no
		// now-playing element must not accumulate a single one of them.
		const { state } = replay({ watch: false });
		assert.deepEqual(state, { timeDisplay: "unknown" });
	});

	it("has the cover ready by the time the title is known", () => {
		// This is what lets the track change be triggered by the *text* without anything
		// having to wait for a picture. Stated precisely, because the loose version was
		// wrong: the transfer *starts* ~760 ms before the text, but what matters is that
		// it *finishes* first — in this recording it completes 9 ms ahead.
		//
		// Unprimed on purpose, so both events come from the recording rather than from
		// the synthetic pre-fill.
		const { updates } = replay({ primed: false });
		const firstText = updates.find((u) => u.change === "text");
		assert.ok(firstText, "the recording contains text");
		const artBefore = updates.filter((u) => u.change === "art" && u.ms <= firstText.ms);
		assert.ok(
			artBefore.length > 0,
			`no cover completed before the text at ${firstText.ms} ms — ` +
				`art events at ${updates.filter((u) => u.change === "art").map((u) => u.ms).join(", ")}`,
		);
	});

	it("reports the track change once, though it arrives as several commands", () => {
		// NTI, NAL and NAT land ~90 ms apart in this recording. Without coalescing that
		// is three notifications for one change.
		const { trackChanges } = replay();
		const textFrames = capture.frames.filter((f) => ["NTI", "NAT", "NAL"].includes(f.command));
		assert.ok(textFrames.length >= 3, "the recording contains a full burst");
		assert.equal(trackChanges.length, 1, "one change, one notification");
		assert.ok(trackChanges[0]!.state.track, "and it carries the new track");
	});

	it("keeps the once-a-second tick out of the track-change signal", () => {
		// NTM ticks throughout the minute; if it could trigger the short display, that
		// display would never go away.
		const { updates, trackChanges } = replay();
		const ticks = updates.filter((u) => u.change === "time");
		assert.ok(ticks.length > 30, `expected a tick per second, got ${ticks.length}`);
		assert.equal(trackChanges.length, 1, "still exactly one track change");
	});

	it("decodes the substituted text as UTF-8, not as masked ASCII", () => {
		// The point of anonymising with accented words: "ascii" decoding would turn them
		// into different letters, and nothing downstream could tell.
		const { state } = replay();
		const fields = [state.track, state.artist, state.album].filter(Boolean) as string[];
		assert.ok(fields.length >= 2, `expected the text fields to be filled, got ${JSON.stringify(fields)}`);
		assert.ok(
			fields.some((f) => /[^\x00-\x7f]/.test(f)),
			`expected non-ASCII to survive, got ${fields.join(" | ")}`,
		);
		assert.ok(
			fields.every((f) => !f.includes("�")),
			`no replacement characters expected, got ${fields.join(" | ")}`,
		);
	});

	it("reads the receiver's own statement about the time display", () => {
		const { state } = replay();
		// Measured NMS = "xxxxxx144": elapsed+total meaningful, seeking disabled.
		assert.equal(state.timeDisplay, "elapsed-total");
		assert.equal(state.seekEnabled, false);
		assert.ok(state.total && state.total > 0, "and a usable total for the progress bar");
	});
});

describe("the recording itself", () => {
	it("still has the shape the hardware produced", () => {
		// Asserting the fixture, so a careless re-capture or a broken anonymiser fails
		// loudly instead of quietly weakening every test above.
		const nja = capture.frames.filter((f) => f.command === "NJA");
		assert.ok(nja.length > 1_000, `expected a full cover stream, got ${nja.length} frames`);
		const flags = nja.map((f) => f.parameter[1]);
		assert.equal(flags.filter((f) => f === "0").length, capture.coverTransfers.length, "one start per transfer");
		assert.equal(flags.filter((f) => f === "2").length, capture.coverTransfers.length, "one end per transfer");
		// The chunk size the device actually used.
		const payloads = new Set(nja.map((f) => f.parameter.length - 2));
		assert.ok(payloads.has(246), `expected 246-hex-character chunks, saw ${[...payloads].join(", ")}`);
	});

	it("covers more than a second of traffic, with the timings intact", () => {
		const span = capture.frames[capture.frames.length - 1]!.ms - capture.frames[0]!.ms;
		assert.ok(span > 30_000, `expected the full recording, got ${span} ms`);
	});
});
