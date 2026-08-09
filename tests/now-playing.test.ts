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
import { setAdapterLogger } from "../src/adapter/logging.ts";
import { describe, it } from "node:test";
import type { ConnectionEvent } from "../src/adapter/eiscp/connection-manager.ts";
import {
	MAX_TEXT_LENGTH,
	NowPlayingTracker,
	parseMenuStatus,
	parsePlayStatus,
	parseTimeField,
	parseTimeInfo,
	PRIME_COMMANDS,
	PRIME_COOLDOWN_MS,
	TRACK_CHANGE_COOLDOWN_MS,
	type NowPlaying,
	type NowPlayingChange,
} from "../src/adapter/eiscp/now-playing.ts";

/** Derived, never typed in: the pre-fill list is allowed to grow. */
const PRIME_COMMANDS_COUNT = PRIME_COMMANDS.length;

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
	fetched: string[];
	setNow(ms: number): void;
	/**
	 * Run whatever the tracker scheduled.
	 *
	 * The track-change notification is deliberately on the *trailing* edge of the
	 * announcement burst (see `TRACK_CHANGE_SETTLE_MS`), so a test that never lets the
	 * window expire sees nothing — which is the point: it is the same "has the burst
	 * finished?" question the real thing has to answer.
	 */
	settle(): Promise<void>;
}

/** A distinct JPEG for the HTTP path, so it cannot be confused with the inline one. */
function httpJpeg(): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(96, 0x7a), Buffer.from([0xff, 0xd9])]);
}

function harness(
	options: {
		maxHosts?: number;
		failCommands?: string[];
		httpEnabled?: boolean;
		httpBody?: Buffer | null;
		/** What a query answers with, by command. Absent means the empty reply. */
		answers?: Record<string, string>;
	} = {},
): Harness {
	const fetched: string[] = [];
	let messageCb: ((host: string, command: string, parameter: string) => void) | undefined;
	let connectionCb: ((host: string, event: ConnectionEvent) => void) | undefined;
	const queried: string[] = [];
	let clock = 10_000;
	let pending: (() => void)[] = [];

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
				return options.answers?.[command] ?? "";
			},
		},
		{
			...options,
			now: () => clock,
			schedule: (fn) => {
				pending.push(fn);
				return () => {
					pending = pending.filter((p) => p !== fn);
				};
			},
			httpEnabled: () => options.httpEnabled ?? false,
			fetchOptions: {
				fetchImpl: (async (url: string | URL) => {
					fetched.push(String(url));
					const body = options.httpBody === undefined ? httpJpeg() : options.httpBody;
					if (!body) throw new Error("refused");
					return {
						ok: true,
						status: 200,
						headers: new Headers(),
						arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
					} as unknown as Response;
				}) as unknown as typeof fetch,
			},
		},
	);
	tracker.start();
	return {
		tracker,
		fetched,
		send: (host, command, parameter) => messageCb?.(host, command, parameter),
		connection: (host, event) => connectionCb?.(host, event),
		queried,
		setNow: (ms) => (clock = ms),
		settle: async () => {
			const due = pending;
			pending = [];
			for (const fn of due) fn();
			// The announcement confirms itself against the receiver before it goes out,
			// so settling is not synchronous any more.
			await tracker.whenSettled();
		},
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

	it("waits for the whole announcement before reporting it", async () => {
		// The regression this exists for, found on the hardware: the fields do not arrive
		// together (measured 87 ms between NTI and NAT), and the notification used to go
		// out with the first of them. A consumer that freezes the state — the
		// track-change display does, on purpose — then showed the new title beside the
		// **previous song's artist**. Seen in the wild: "Sweet About Me" credited to the
		// artist before it.
		const h = harness();
		const fired: NowPlaying[] = [];
		h.tracker.onTrackChange("10.0.0.1", (s) => fired.push(s));

		h.setNow(10_000);
		h.send("10.0.0.1", "NTI", "What the Hell");
		h.send("10.0.0.1", "NAT", "Avril Lavigne");
		h.send("10.0.0.1", "NAL", "Goodbye Lullaby");
		await h.settle();
		assert.equal(fired.length, 0, "still the initial fill");

		h.setNow(200_000);
		h.send("10.0.0.1", "NTI", "Cruel Summer");
		assert.equal(fired.length, 0, "nothing goes out while the burst is still arriving");
		h.setNow(200_012);
		h.send("10.0.0.1", "NAL", "Lover");
		h.setNow(200_087);
		h.send("10.0.0.1", "NAT", "Taylor Swift");
		assert.equal(fired.length, 0);

		await h.settle();
		assert.equal(fired.length, 1, "one track change, one notification");
		assert.equal(fired[0]!.track, "Cruel Summer");
		// The whole point: the artist in the notification is this song's, not the last.
		assert.equal(fired[0]!.artist, "Taylor Swift");
		assert.equal(fired[0]!.album, "Lover");
	});

	it("waits for a field that arrives after the window would have closed", async () => {
		// The second round of the same bug. A *fixed* window started by the title assumes
		// the artist is inside it — and how far apart the receiver spaces its fields is
		// the receiver's business. So every field re-arms the window.
		const h = harness();
		const fired: NowPlaying[] = [];
		h.tracker.onTrackChange("10.0.0.1", (s) => fired.push(s));

		h.setNow(10_000);
		h.send("10.0.0.1", "NTI", "First");
		h.send("10.0.0.1", "NAT", "First Artist");
		await h.settle();
		assert.equal(fired.length, 0, "the initial fill");

		h.setNow(200_000);
		h.send("10.0.0.1", "NTI", "Cruel Summer");
		// Far beyond TRACK_CHANGE_SETTLE_MS: a fixed window would already have fired,
		// carrying "First Artist" with it.
		h.setNow(201_200);
		h.send("10.0.0.1", "NAT", "Taylor Swift");
		await h.settle();

		assert.equal(fired.length, 1, "still one notification for one change");
		assert.equal(fired[0]!.artist, "Taylor Swift");
	});

	it("stops waiting once the burst has had long enough", async () => {
		// The bound on the above: a source that sends one field at a time must not be
		// able to hold the display back for ever.
		const h = harness();
		const fired: NowPlaying[] = [];
		h.tracker.onTrackChange("10.0.0.1", (s) => fired.push(s));

		h.setNow(10_000);
		h.send("10.0.0.1", "NTI", "First");
		await h.settle();

		h.setNow(200_000);
		h.send("10.0.0.1", "NTI", "Second");
		for (let i = 1; i <= 10; i++) {
			h.setNow(200_000 + i * 500);
			h.send("10.0.0.1", "NAL", `Album ${i}`);
		}
		await h.settle();
		assert.ok(fired.length >= 1, "it gave up waiting and showed what it had");
	});

	it("asks the receiver before it announces, and takes that answer", async () => {
		// The reason waiting alone is not enough: a field the receiver never pushes for
		// this track leaves the *previous* song's value in the state, and no window
		// length can fix that. NTI/NAT/NAL all answer QSTN, so the display asks rather
		// than assembling fragments.
		const h = harness({ answers: { NTI: "Cruel Summer", NAT: "Taylor Swift", NAL: "Lover" } });
		const fired: NowPlaying[] = [];
		h.tracker.onTrackChange("10.0.0.1", (s) => fired.push(s));

		h.setNow(10_000);
		h.send("10.0.0.1", "NTI", "Sweet About Me");
		h.send("10.0.0.1", "NAT", "Miss Kenichi");
		await h.settle();
		assert.equal(fired.length, 0, "the initial fill");

		// Only the title is pushed; the artist in the state is still the previous song's.
		h.setNow(200_000);
		h.send("10.0.0.1", "NTI", "Cruel Summer");
		await h.settle();

		assert.equal(fired.length, 1);
		assert.equal(fired[0]!.artist, "Taylor Swift", "the query supplied what the push did not");
		assert.notEqual(fired[0]!.artist, "Miss Kenichi");
	});

	it("keeps a pushed value when the query comes back empty", async () => {
		// A firmware that does not answer, or a reply lost in a cover transfer, must not
		// wipe what the receiver announced a moment earlier.
		const h = harness({ answers: {} });
		const fired: NowPlaying[] = [];
		h.tracker.onTrackChange("10.0.0.1", (s) => fired.push(s));

		h.setNow(10_000);
		h.send("10.0.0.1", "NTI", "First");
		await h.settle();

		h.setNow(200_000);
		h.send("10.0.0.1", "NTI", "Cruel Summer");
		h.send("10.0.0.1", "NAT", "Taylor Swift");
		await h.settle();

		assert.equal(fired.length, 1);
		assert.equal(fired[0]!.track, "Cruel Summer");
		assert.equal(fired[0]!.artist, "Taylor Swift");
	});

	it("announces anyway when the receiver will not answer at all", async () => {
		// Best-effort: a failed confirmation costs the correction, never the display.
		const h = harness({ failCommands: ["NTI", "NAT", "NAL"] });
		const fired: NowPlaying[] = [];
		h.tracker.onTrackChange("10.0.0.1", (s) => fired.push(s));

		h.setNow(10_000);
		h.send("10.0.0.1", "NTI", "First");
		await h.settle();
		h.setNow(200_000);
		h.send("10.0.0.1", "NTI", "Cruel Summer");
		await h.settle();

		assert.equal(fired.length, 1);
		assert.equal(fired[0]!.track, "Cruel Summer");
	});

	it("does not query for a host nobody is watching", async () => {
		// The interest gate, again: an unwatched host must cost nothing at all.
		const h = harness({ answers: { NTI: "x" } });
		const off = h.tracker.onTrackChange("10.0.0.1", () => {});
		h.setNow(10_000);
		h.send("10.0.0.1", "NTI", "First");
		await h.settle();
		h.setNow(200_000);
		h.send("10.0.0.1", "NTI", "Second");
		off();
		const before = h.queried.length;
		await h.settle();
		assert.equal(h.queried.length, before, "no confirmation queries once nothing is listening");
	});

	it("fires again for the next track, once the cooldown has passed", async () => {
		const h = harness();
		let count = 0;
		h.tracker.onTrackChange("10.0.0.1", () => count++);

		h.setNow(10_000);
		h.send("10.0.0.1", "NTI", "First");
		h.setNow(100_000);
		h.send("10.0.0.1", "NTI", "Second");
		await h.settle();
		assert.equal(count, 1);

		h.setNow(100_000 + TRACK_CHANGE_COOLDOWN_MS + 1);
		h.send("10.0.0.1", "NTI", "Third");
		await h.settle();
		assert.equal(count, 2);
	});

	it("is not fired by the once-a-second time tick", async () => {
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
		await h.settle();
		assert.equal(changes, 0, "no track change from a time tick");
		assert.equal(updates, 31, "but every tick is an update");
	});

	it("is not fired by the same text arriving again", async () => {
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
		await h.settle();
		assert.equal(changes, 1);
	});

	it("keeps one throwing listener from silencing the others", async () => {
		const h = harness();
		let reached = 0;
		h.tracker.onTrackChange("10.0.0.1", () => {
			throw new Error("boom");
		});
		h.tracker.onTrackChange("10.0.0.1", () => reached++);

		h.send("10.0.0.1", "NTI", "First");
		h.setNow(100_000);
		h.send("10.0.0.1", "NTI", "Second");
		await h.settle();
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
			// Not metadata. The selected input is the only evidence that what the receiver
			// told us is still true, and only a *change* says anything — so the baseline
			// has to be established here or the first change looks like the first sighting.
			"10.0.0.1 SLI",
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
		assert.equal(h.queried.length, PRIME_COMMANDS_COUNT, `expected one round, got ${h.queried.join(", ")}`);
	});

	it("does not re-prime a host it has just primed", async () => {
		const h = harness();
		await h.tracker.prime("10.0.0.1");
		await h.tracker.prime("10.0.0.1");
		assert.equal(h.queried.length, PRIME_COMMANDS_COUNT, "the second call is inside the cooldown");

		h.setNow(10_000 + PRIME_COOLDOWN_MS + 1);
		await h.tracker.prime("10.0.0.1");
		assert.equal(h.queried.length, PRIME_COMMANDS_COUNT * 2, "past the cooldown it asks again");
	});

	it("primes again after the state it had was thrown away", async () => {
		// The cooldown exists so eight elements binding together ask once. It must not
		// outlive the data it was protecting: when the last watcher of a host goes away
		// the tracker deletes that host's whole state, and if the next watcher is then
		// refused a pre-fill it has nothing to show.
		//
		// This is not a corner case, it is what a settings change does. Every element
		// re-binds through `clearSubs` *before* it re-subscribes, so a lone Now Playing
		// dial or key drops to zero watchers for an instant every time its Property
		// Inspector is touched — and a permanent display then sat blank until the next
		// track change, minutes away.
		const h = harness();
		const unsub = h.tracker.onUpdate("10.0.0.1", () => {});
		await h.tracker.prime("10.0.0.1");
		h.send("10.0.0.1", "NTI", "Cruel Summer");
		assert.equal(h.tracker.get("10.0.0.1").track, "Cruel Summer");

		unsub(); // last watcher gone: the host's state is dropped
		assert.equal(h.tracker.get("10.0.0.1").track, undefined, "the state really is gone");

		h.tracker.onUpdate("10.0.0.1", () => {});
		await h.tracker.prime("10.0.0.1");
		assert.equal(h.queried.length, PRIME_COMMANDS_COUNT * 2, "the new watcher gets a pre-fill, cooldown or not");
	});

	it("still refuses a second pre-fill while somebody is watching", async () => {
		// The other half of the same rule: the cooldown is about how often we ask a
		// receiver, so it has to keep working for every case that did not lose its data.
		const h = harness();
		h.tracker.onUpdate("10.0.0.1", () => {});
		await h.tracker.prime("10.0.0.1");
		const second = h.tracker.onUpdate("10.0.0.1", () => {});
		second();
		await h.tracker.prime("10.0.0.1");
		assert.equal(h.queried.length, PRIME_COMMANDS_COUNT, "one watcher remained, so nothing was dropped");
	});

	it("keeps asking the rest after one command times out", async () => {
		// NTC has no QSTN and simply times out; that must not stop the pre-fill. (This
		// is the shape of a real defect: a now-playing key that queried a command with
		// no QSTN sat through a 5 s timeout on every bind.)
		const h = harness({ failCommands: ["NAT"] });
		await h.tracker.prime("10.0.0.1");
		assert.equal(h.queried.length, PRIME_COMMANDS_COUNT);
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

describe("NowPlayingTracker: cover over HTTP", () => {
	const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

	it("fetches the cover when the receiver announces a URL instead of streaming it", async () => {
		// LINK mode, measured: one frame with image type 2 carrying
		// "http://<ip>/album_art.cgi", where data mode sends 368-792 frames of hex.
		const h = harness({ httpEnabled: true });
		const changes: NowPlayingChange[] = [];
		h.tracker.onUpdate("10.0.0.1", (_s, change) => changes.push(change));
		h.fetched.length = 0;

		h.send("10.0.0.1", "NJA", "2-http://10.0.0.1/album_art.cgi");
		await settle();

		assert.deepEqual(h.fetched, ["http://10.0.0.1/album_art.cgi"]);
		assert.deepEqual(changes, ["art"]);
		assert.equal(h.tracker.get("10.0.0.1").art?.bytes.length, httpJpeg().length);
	});

	it("goes to the receiver it is connected to, not to the host the device named", async () => {
		const h = harness({ httpEnabled: true });
		h.tracker.onUpdate("10.0.0.1", () => {});
		h.fetched.length = 0;

		h.send("10.0.0.1", "NJA", "2-http://somewhere.else/album_art.cgi");
		await settle();
		assert.deepEqual(h.fetched, ["http://10.0.0.1/album_art.cgi"]);
	});

	it("still reassembles inline art, so the mode is the device's choice", async () => {
		// The requirement: the manufacturer's app may switch the receiver to either mode
		// and the plugin must simply serve whichever it finds — never force one back.
		const h = harness({ httpEnabled: true });
		h.tracker.onUpdate("10.0.0.1", () => {});
		h.fetched.length = 0;

		for (const frame of artFrames()) h.send("10.0.0.1", "NJA", frame);
		await settle();
		assert.deepEqual(h.fetched, [], "inline data needs no request");
		assert.ok(h.tracker.get("10.0.0.1").art, "and is assembled as before");
	});

	it("ignores an announced URL when the setting is off", async () => {
		// With HTTP disabled and the receiver in LINK mode there is simply no cover —
		// the honest outcome, since the alternative would be to change the device.
		const h = harness({ httpEnabled: false });
		h.tracker.onUpdate("10.0.0.1", () => {});
		h.fetched.length = 0;

		h.send("10.0.0.1", "NJA", "2-http://10.0.0.1/album_art.cgi");
		await settle();
		assert.deepEqual(h.fetched, []);
		assert.equal(h.tracker.get("10.0.0.1").art, undefined);
	});

	it("starts one request per host, however many announcements arrive", async () => {
		const h = harness({ httpEnabled: true });
		h.tracker.onUpdate("10.0.0.1", () => {});
		h.fetched.length = 0;

		for (let i = 0; i < 5; i++) h.send("10.0.0.1", "NJA", "2-http://10.0.0.1/album_art.cgi");
		await settle();
		assert.equal(h.fetched.length, 1, `expected one in-flight request, got ${h.fetched.length}`);
	});

	it("survives a web server that is not there", async () => {
		const h = harness({ httpEnabled: true, httpBody: null });
		const changes: NowPlayingChange[] = [];
		h.tracker.onUpdate("10.0.0.1", (_s, change) => changes.push(change));

		h.send("10.0.0.1", "NJA", "2-http://10.0.0.1/album_art.cgi");
		await settle();
		assert.deepEqual(changes, [], "a failed fetch is not a change");
		assert.equal(h.tracker.get("10.0.0.1").art, undefined);
	});

	it("asks for a cover as soon as a host is primed", async () => {
		// Neither text nor art is volunteered on connect, so without this a freshly
		// started plugin has no cover until the track ends.
		const h = harness({ httpEnabled: true });
		h.tracker.onUpdate("10.0.0.1", () => {});
		h.fetched.length = 0;

		await h.tracker.prime("10.0.0.1");
		await settle();
		assert.deepEqual(h.fetched, ["http://10.0.0.1/album_art.cgi"]);
	});
});

describe("NowPlayingTracker: what the log is told about playback", () => {
	/** Capture adapter logging for the duration of one test, then put it back. */
	function captureLogs(body: (lines: string[]) => void): void {
		const lines: string[] = [];
		const sink = {
			debug: () => {},
			info: (m: string) => lines.push(m),
			warn: (m: string) => lines.push(m),
			error: (m: string) => lines.push(m),
		};
		setAdapterLogger(sink);
		try {
			body(lines);
		} finally {
			setAdapterLogger(console);
		}
	}

	it("records a change of playback state once, however often it is repeated", () => {
		// `NST` is re-broadcast, and this is the line that explains a play symbol
		// appearing over a cover — so it has to be there, and it has to be there once.
		// A line per repetition is how a log stops being readable on someone else's
		// machine, which is the only reason it exists.
		captureLogs((lines) => {
			const h = harness();
			h.tracker.onUpdate("10.0.0.1", () => {});
			for (let i = 0; i < 5; i++) h.send("10.0.0.1", "NST", "Pxx");
			const playing = lines.filter((l) => /playback/.test(l));
			assert.equal(playing.length, 1, `expected one line, got ${JSON.stringify(playing)}`);
			assert.match(playing[0]!, /10\.0\.0\.1: playback play/);

			for (let i = 0; i < 3; i++) h.send("10.0.0.1", "NST", "pxx");
			const all = lines.filter((l) => /playback/.test(l));
			assert.equal(all.length, 2, "the change to paused is worth exactly one more");
			assert.match(all[1]!, /playback pause/);
			h.tracker.stop();
		});
	});

	it("says nothing at all about the clock, which ticks once a second", () => {
		// The rule the whole logging design rests on: nothing may be written per tick.
		captureLogs((lines) => {
			const h = harness();
			h.tracker.onUpdate("10.0.0.1", () => {});
			for (let i = 0; i < 60; i++) h.send("10.0.0.1", "NTM", `00:0${Math.floor(i / 10)}:${String(i % 10).padStart(2, "0")}/00:05:00`);
			assert.deepEqual(lines, [], `a minute of ticks wrote ${lines.length} lines`);
			h.tracker.stop();
		});
	});
});
