/**
 * Now-playing metadata: the parsers, and the tracker's notification rules.
 *
 * The values here are the ones measured off the reference VSX-S520D under AirPlay,
 * not invented ones — `NMS = "xxxxxx144"`, `NST = "Pxx"`, `NTM` in the long
 * `hh:mm:ss/hh:mm:ss` form, `NTR = "----/----"`. Where a test asserts a *timing*
 * relationship it uses the measured spread (cover ~760 ms before the text, the three
 * text fields ~90 ms apart).
 *
 * SDK-free: the tracker lives in the adapter layer and takes its dependencies as
 * plain functions, so none of this needs a socket or a Stream Deck.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ConnectionEvent } from "../src/adapter/eiscp/connection-manager.ts";
import {
	MAX_TEXT_LENGTH,
	NowPlayingTracker,
	parseMenuStatus,
	parsePlayStatus,
	parseTimeField,
	parseTimeInfo,
	PRIME_COOLDOWN_MS,
	TRACK_CHANGE_COOLDOWN_MS,
	type NowPlaying,
	type NowPlayingChange,
} from "../src/adapter/eiscp/now-playing.ts";

// ---------------------------------------------------------------------------

describe("now-playing parsers", () => {
	it("parses both time forms the receiver uses", () => {
		// Measured: this firmware sends the long form even for a 3-minute track.
		assert.equal(parseTimeField("00:01:08"), 68);
		assert.equal(parseTimeField("00:03:41"), 221);
		// The short form is equally legal per spec.
		assert.equal(parseTimeField("01:08"), 68);
		assert.equal(parseTimeField("99:59:59"), 99 * 3600 + 59 * 60 + 59);
	});

	it("treats the documented unknown form as unknown, not as zero", () => {
		// "If time is unknown, this response is --:--". Zero would draw a progress bar
		// at the start of the track, which is a lie; absent draws none.
		assert.equal(parseTimeField("--:--"), undefined);
		assert.equal(parseTimeField("--:--:--"), undefined);
		assert.deepEqual(parseTimeInfo("--:--/--:--"), { elapsed: undefined, total: undefined });
	});

	it("never yields NaN or an out-of-range number", () => {
		// A NaN reaching setFeedback was a real finding in this repo (M10), and these
		// values come straight off the wire.
		for (const bad of ["", "x", "1:2:3:4", "00:99", "-1:00", "9999:00:00", "00:60", "١٢:٣٤"]) {
			const value = parseTimeField(bad);
			assert.ok(value === undefined || (Number.isInteger(value) && value >= 0), `${JSON.stringify(bad)} -> ${value}`);
		}
	});

	it("parses elapsed and total independently", () => {
		assert.deepEqual(parseTimeInfo("00:01:08/00:03:41"), { elapsed: 68, total: 221 });
		// A known elapsed with an unknown total is a real case (live streams).
		assert.deepEqual(parseTimeInfo("00:01:08/--:--"), { elapsed: 68, total: undefined });
	});

	it("parses the play status field", () => {
		assert.equal(parsePlayStatus("Pxx"), "play"); // measured
		assert.equal(parsePlayStatus("pxx"), "pause"); // lower-case p is a different state
		assert.equal(parsePlayStatus("S--"), "stop");
		assert.equal(parsePlayStatus("F--"), "ff");
		assert.equal(parsePlayStatus("R--"), "rew");
		assert.equal(parsePlayStatus("E--"), "eof");
		assert.equal(parsePlayStatus(""), undefined);
		assert.equal(parsePlayStatus("?--"), undefined);
	});

	it("reads the menu status the way the measured device reports it", () => {
		// xxxxxx144: m=x aa=xx bb=xx s=x t=1 ii=44 — no track menu, seeking DISABLED,
		// elapsed+total meaningful, service icon 44 (which the spec does not assign;
		// it lists 18 for Airplay). Kept raw rather than mapped to a name we'd be
		// guessing at.
		assert.deepEqual(parseMenuStatus("xxxxxx144"), {
			timeDisplay: "elapsed-total",
			seekEnabled: false,
			serviceIcon: "44",
		});
		// Field offsets are easy to get wrong in a 9-character packed string, so pin
		// them: here the "S" sits at index 6 (the time field) and must NOT be read as
		// "seek enabled" — index 5 is still "x", so seeking stays disabled.
		assert.equal(parseMenuStatus("xxxxxxS1F0").seekEnabled, false);
		assert.deepEqual(parseMenuStatus("MxxxxSx0A"), { timeDisplay: "off", seekEnabled: true, serviceIcon: "0A" });
		assert.equal(parseMenuStatus("short").timeDisplay, "unknown");
	});
});

// ---------------------------------------------------------------------------

interface Harness {
	tracker: NowPlayingTracker;
	send(host: string, command: string, parameter: string): void;
	connection(host: string, event: ConnectionEvent): void;
	queried: string[];
	setNow(ms: number): void;
}

function harness(options: { maxHosts?: number; failCommands?: string[] } = {}): Harness {
	let messageCb: ((host: string, command: string, parameter: string) => void) | undefined;
	let connectionCb: ((host: string, event: ConnectionEvent) => void) | undefined;
	const queried: string[] = [];
	let clock = 10_000;

	const tracker = new NowPlayingTracker(
		{
			addMessageObserver: (cb) => {
				messageCb = cb;
				return () => (messageCb = undefined);
			},
			addConnectionObserver: (cb) => {
				connectionCb = cb;
				return () => (connectionCb = undefined);
			},
			queryCommand: async (host, command) => {
				queried.push(`${host} ${command}`);
				if (options.failCommands?.includes(command)) throw new Error(`${command} timed out`);
				return "";
			},
		},
		{ ...options, now: () => clock },
	);
	tracker.start();
	return {
		tracker,
		send: (host, command, parameter) => messageCb?.(host, command, parameter),
		connection: (host, event) => connectionCb?.(host, event),
		queried,
		setNow: (ms) => (clock = ms),
	};
}

/** A minimal JPEG, split into `chunk`-byte frames so the chunking can be varied. */
function artFrames(fill = 0x41, chunk = 20): string[] {
	const image = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(40, fill), Buffer.from([0xff, 0xd9])]);
	const parts: string[] = [];
	for (let i = 0; i < image.length; i += chunk) parts.push(image.subarray(i, i + chunk).toString("hex").toUpperCase());
	return parts.map((hex, i) => `1${i === 0 ? "0" : i === parts.length - 1 ? "2" : "1"}${hex}`);
}

describe("NowPlayingTracker", () => {
	it("ignores hosts nobody is watching", () => {
		// Not an optimisation detail: during a cover transfer this observer is called
		// ~1 800 times a second, so a plugin with no now-playing action on the deck
		// must do nothing at all.
		const h = harness();
		for (const frame of artFrames()) h.send("10.0.0.1", "NJA", frame);
		h.send("10.0.0.1", "NTI", "Cruel Summer");

		assert.deepEqual(h.tracker.get("10.0.0.1"), { timeDisplay: "unknown" });
	});

	it("collects text, time, status and menu for a watched host", () => {
		const h = harness();
		const changes: NowPlayingChange[] = [];
		h.tracker.onUpdate("10.0.0.1", (_s, change) => changes.push(change));

		h.send("10.0.0.1", "NTI", "Cruel Summer");
		h.send("10.0.0.1", "NAL", "Lover");
		h.send("10.0.0.1", "NAT", "Taylor Swift");
		h.send("10.0.0.1", "NTM", "00:01:08/00:03:41");
		h.send("10.0.0.1", "NST", "Pxx");
		h.send("10.0.0.1", "NMS", "xxxxxx144");

		const state = h.tracker.get("10.0.0.1");
		assert.equal(state.track, "Cruel Summer");
		assert.equal(state.album, "Lover");
		assert.equal(state.artist, "Taylor Swift");
		assert.equal(state.elapsed, 68);
		assert.equal(state.total, 221);
		assert.equal(state.playStatus, "play");
		assert.equal(state.timeDisplay, "elapsed-total");
		assert.equal(state.seekEnabled, false);
		assert.deepEqual(changes, ["text", "text", "text", "time", "status", "menu"]);
	});

	it("assembles the cover art and reports it once", () => {
		const h = harness();
		const changes: NowPlayingChange[] = [];
		h.tracker.onUpdate("10.0.0.1", (_s, change) => changes.push(change));

		const frames = artFrames();
		for (const frame of frames.slice(0, -1)) h.send("10.0.0.1", "NJA", frame);
		assert.equal(changes.length, 0, "a partial transfer is not a change");
		h.send("10.0.0.1", "NJA", frames[frames.length - 1]!);

		assert.deepEqual(changes, ["art"], "one event for the whole transfer, on the last frame");
		assert.equal(h.tracker.get("10.0.0.1").art?.type, "jpeg");
	});

	it("clears the art when the receiver says there is none", () => {
		const h = harness();
		h.tracker.onUpdate("10.0.0.1", () => {});
		for (const frame of artFrames()) h.send("10.0.0.1", "NJA", frame);
		assert.ok(h.tracker.get("10.0.0.1").art);

		h.send("10.0.0.1", "NJA", "n-");
		assert.equal(h.tracker.get("10.0.0.1").art, undefined);
	});

	it("sanitises and clamps device text", () => {
		const h = harness();
		h.tracker.onUpdate("10.0.0.1", () => {});
		// The receiver prefixes display payloads with 0x1a; control bytes must not
		// reach a Stream Deck title.
		h.send("10.0.0.1", "NTI", "\u001aGrüße aus Köln\u0000");
		assert.equal(h.tracker.get("10.0.0.1").track, "Grüße aus Köln");

		h.send("10.0.0.1", "NAT", "A".repeat(200));
		assert.equal(h.tracker.get("10.0.0.1").artist?.length, MAX_TEXT_LENGTH);
	});

	it("treats an empty text field as absent rather than as an empty title", () => {
		const h = harness();
		h.tracker.onUpdate("10.0.0.1", () => {});
		h.send("10.0.0.1", "NTI", "   ");
		assert.equal(h.tracker.get("10.0.0.1").track, undefined);
	});
});

describe("NowPlayingTracker: track changes", () => {
	it("does not fire for the first track it ever learns about", () => {
		// A display that flashed on every connect would be worse than one that misses
		// the very first track, so the initial fill is silent.
		const h = harness();
		const fired: NowPlaying[] = [];
		h.tracker.onTrackChange("10.0.0.1", (s) => fired.push(s));

		h.send("10.0.0.1", "NTI", "What the Hell");
		h.send("10.0.0.1", "NAT", "Avril Lavigne");
		assert.equal(fired.length, 0);
	});

	it("fires exactly once for a real change, coalescing the burst", () => {
		// Measured spread for one change: NTI +761 ms after the art, NAL +12 ms after
		// NTI, NAT +75 ms after that. Three fields, one change.
		const h = harness();
		const fired: NowPlaying[] = [];
		h.tracker.onTrackChange("10.0.0.1", (s) => fired.push(s));

		h.setNow(10_000);
		h.send("10.0.0.1", "NTI", "What the Hell");
		h.send("10.0.0.1", "NAT", "Avril Lavigne");
		h.send("10.0.0.1", "NAL", "Goodbye Lullaby");
		assert.equal(fired.length, 0, "still the initial fill");

		h.setNow(200_000);
		h.send("10.0.0.1", "NTI", "Cruel Summer");
		h.setNow(200_012);
		h.send("10.0.0.1", "NAL", "Lover");
		h.setNow(200_087);
		h.send("10.0.0.1", "NAT", "Taylor Swift");

		assert.equal(fired.length, 1, "one track change, one notification");
		// Leading edge: the notification comes with the first field, so a display
		// reacts at once. The rest of the burst arrives through onUpdate.
		assert.equal(fired[0]!.track, "Cruel Summer");
		assert.equal(h.tracker.get("10.0.0.1").artist, "Taylor Swift");
	});

	it("fires again for the next track, once the cooldown has passed", () => {
		const h = harness();
		let count = 0;
		h.tracker.onTrackChange("10.0.0.1", () => count++);

		h.setNow(10_000);
		h.send("10.0.0.1", "NTI", "First");
		h.setNow(100_000);
		h.send("10.0.0.1", "NTI", "Second");
		assert.equal(count, 1);

		h.setNow(100_000 + TRACK_CHANGE_COOLDOWN_MS + 1);
		h.send("10.0.0.1", "NTI", "Third");
		assert.equal(count, 2);
	});

	it("is not fired by the once-a-second time tick", () => {
		// The whole point of separating onTrackChange from onUpdate: NTM arrives every
		// second, and a short display that re-triggered on it would never go away.
		const h = harness();
		let changes = 0;
		let updates = 0;
		h.tracker.onTrackChange("10.0.0.1", () => changes++);
		h.tracker.onUpdate("10.0.0.1", () => updates++);

		h.send("10.0.0.1", "NTI", "Cruel Summer");
		for (let s = 0; s < 30; s++) {
			h.setNow(200_000 + s * 1000);
			h.send("10.0.0.1", "NTM", `00:00:${String(s).padStart(2, "0")}/00:03:41`);
		}
		assert.equal(changes, 0, "no track change from a time tick");
		assert.equal(updates, 31, "but every tick is an update");
	});

	it("is not fired by the same text arriving again", () => {
		// The receiver re-announces metadata (measured: NMS and NFI twice in one
		// burst), and a repeat is not a change.
		const h = harness();
		let changes = 0;
		h.tracker.onTrackChange("10.0.0.1", () => changes++);

		h.send("10.0.0.1", "NTI", "First");
		h.setNow(100_000);
		h.send("10.0.0.1", "NTI", "Second");
		h.setNow(200_000);
		h.send("10.0.0.1", "NTI", "Second");
		h.send("10.0.0.1", "NTI", "Second");
		assert.equal(changes, 1);
	});

	it("keeps one throwing listener from silencing the others", () => {
		const h = harness();
		let reached = 0;
		h.tracker.onTrackChange("10.0.0.1", () => {
			throw new Error("boom");
		});
		h.tracker.onTrackChange("10.0.0.1", () => reached++);

		h.send("10.0.0.1", "NTI", "First");
		h.setNow(100_000);
		h.send("10.0.0.1", "NTI", "Second");
		assert.equal(reached, 1);
	});
});

describe("NowPlayingTracker: lifecycle and bounds", () => {
	it("stops paying for a host once nothing watches it", () => {
		const h = harness();
		const off = h.tracker.onUpdate("10.0.0.1", () => {});
		h.send("10.0.0.1", "NTI", "Cruel Summer");
		assert.equal(h.tracker.get("10.0.0.1").track, "Cruel Summer");

		off();
		h.send("10.0.0.1", "NTI", "Something Else");
		assert.equal(h.tracker.get("10.0.0.1").track, undefined, "state dropped with the last listener");
	});

	it("keeps a host alive while any listener remains", () => {
		const h = harness();
		const offA = h.tracker.onUpdate("10.0.0.1", () => {});
		h.tracker.onTrackChange("10.0.0.1", () => {});
		h.send("10.0.0.1", "NTI", "Cruel Summer");
		offA();

		h.send("10.0.0.1", "NAT", "Taylor Swift");
		assert.equal(h.tracker.get("10.0.0.1").artist, "Taylor Swift");
	});

	it("bounds the number of hosts, preferring to evict unwatched ones", () => {
		const h = harness({ maxHosts: 2 });
		h.tracker.onUpdate("10.0.0.1", () => {});
		h.tracker.prime("10.0.0.2"); // creates an entry with no listeners
		h.tracker.prime("10.0.0.3");

		h.send("10.0.0.1", "NTI", "Watched");
		assert.equal(h.tracker.get("10.0.0.1").track, "Watched", "the watched host survives the cap");
	});

	it("drops a partial cover transfer when the connection goes away", () => {
		const h = harness();
		h.tracker.onUpdate("10.0.0.1", () => {});
		const frames = artFrames();
		h.send("10.0.0.1", "NJA", frames[0]!);
		h.connection("10.0.0.1", "disconnected");

		// The continuation now has nothing to attach to, so no image is produced from
		// two halves that came from different sockets.
		h.send("10.0.0.1", "NJA", frames[1]!);
		assert.equal(h.tracker.get("10.0.0.1").art, undefined);
	});

	it("queries the commands the receiver never volunteers", async () => {
		// None of these is pushed on connect (measured), only on a track change — so a
		// freshly placed key would stay blank for the rest of the song without this.
		const h = harness();
		await h.tracker.prime("10.0.0.1");
		assert.deepEqual(h.queried, [
			"10.0.0.1 NTI",
			"10.0.0.1 NAT",
			"10.0.0.1 NAL",
			"10.0.0.1 NTM",
			"10.0.0.1 NST",
			"10.0.0.1 NMS",
		]);
	});

	it("folds simultaneous pre-fills into one round of queries", async () => {
		// The reason this matters: every element that watches metadata primes when it
		// binds, and they all bind together at startup or on a profile switch. Eight
		// elements meant 48 queries at once, at a receiver that answers one connection.
		const h = harness();
		await Promise.all([
			h.tracker.prime("10.0.0.1"),
			h.tracker.prime("10.0.0.1"),
			h.tracker.prime("10.0.0.1"),
			h.tracker.prime("10.0.0.1"),
		]);
		assert.equal(h.queried.length, 6, `expected one round, got ${h.queried.join(", ")}`);
	});

	it("does not re-prime a host it has just primed", async () => {
		const h = harness();
		await h.tracker.prime("10.0.0.1");
		await h.tracker.prime("10.0.0.1");
		assert.equal(h.queried.length, 6, "the second call is inside the cooldown");

		h.setNow(10_000 + PRIME_COOLDOWN_MS + 1);
		await h.tracker.prime("10.0.0.1");
		assert.equal(h.queried.length, 12, "past the cooldown it asks again");
	});

	it("keeps asking the rest after one command times out", async () => {
		// NTC has no QSTN and simply times out; that must not stop the pre-fill. (This
		// is the shape of a real defect: a now-playing key that queried a command with
		// no QSTN sat through a 5 s timeout on every bind.)
		const h = harness({ failCommands: ["NAT"] });
		await h.tracker.prime("10.0.0.1");
		assert.equal(h.queried.length, 6);
	});
});

describe("NowPlayingTracker: the same cover twice", () => {
	it("does not re-report a cover whose content is unchanged", () => {
		// The receiver retransmits the whole image on *every* connect, and the offline
		// backoff reconnects at 5/10/30/60 s — so on a flapping link the identical
		// ~97 KB arrives over and over. Recognising it by content makes the whole
		// downstream chain a no-op: no recompose, no repaint.
		const h = harness();
		const changes: NowPlayingChange[] = [];
		h.tracker.onUpdate("10.0.0.1", (_s, change) => changes.push(change));

		for (const frame of artFrames()) h.send("10.0.0.1", "NJA", frame);
		assert.deepEqual(changes, ["art"]);
		const first = h.tracker.get("10.0.0.1").art;

		// The very same picture again, as a fresh transfer.
		for (const frame of artFrames()) h.send("10.0.0.1", "NJA", frame);
		assert.deepEqual(changes, ["art"], "an identical cover is not a change");
		assert.ok(
			h.tracker.get("10.0.0.1").art === first,
			"the existing object is kept, so the composition cache still hits",
		);
	});

	it("still reports a genuinely different cover", () => {
		const h = harness();
		const changes: NowPlayingChange[] = [];
		h.tracker.onUpdate("10.0.0.1", (_s, change) => changes.push(change));

		for (const frame of artFrames()) h.send("10.0.0.1", "NJA", frame);
		for (const frame of artFrames(0x42)) h.send("10.0.0.1", "NJA", frame);
		assert.deepEqual(changes, ["art", "art"]);
	});

	it("hashes the assembled image, not the frames it arrived in", () => {
		// Same bytes, different chunking: still one cover.
		const h = harness();
		let arts = 0;
		h.tracker.onUpdate("10.0.0.1", (_s, change) => { if (change === "art") arts++; });

		for (const frame of artFrames()) h.send("10.0.0.1", "NJA", frame);
		for (const frame of artFrames(0x41, 8)) h.send("10.0.0.1", "NJA", frame);
		assert.equal(arts, 1, "re-chunking the same picture is not a new picture");
	});
});
