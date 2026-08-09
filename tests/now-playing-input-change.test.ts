/**
 * A source that stops when the input moves away — and never says so.
 *
 * This case cannot be captured from the reference VSX-S520D: that unit hops back to its
 * network input by itself while music is still arriving, so the input never stays away
 * long enough to observe. It is nonetheless real on other receivers, so it is modelled
 * in the double (`playback` in `mock-receiver.ts`) rather than assumed away.
 *
 * What makes it awkward is the shape of the evidence. There is no "stopped" message to
 * react to: the metadata frames simply cease. Anything that treats its last known track
 * as still true therefore keeps showing it forever — a permanent now-playing display
 * would go on naming a song that ended when the user switched to the Blu-ray player.
 *
 * So the input itself is the signal, and the tests below pin both halves of that: the
 * state is dropped when the input leaves, and it comes back on its own when the input
 * returns, without anybody having to ask.
 *
 * Driven through the real ConnectionManager over a real socket, the same way
 * `device-status-tracker.test.ts` does — the point is the wire behaviour, and a
 * hand-fed fake would only prove the fake.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ConnectionManager } from "../src/adapter/eiscp/connection-manager.ts";
import { NowPlayingTracker } from "../src/adapter/eiscp/now-playing.ts";
import { loadCapturedResponses, startMockReceiver, type MockReceiver } from "./helpers/mock-receiver.ts";

const HOST = "127.0.0.1";
/** Codes from the command registry: NET streams, BD/DVD does not. */
const NET = "2B";
const BLURAY = "10";

const TRACK = { title: "Cruel Summer", artist: "Taylor Swift", album: "Lover" };

/**
 * A receiver playing on NET, which also *answers* the metadata queries.
 *
 * The captured response map has no NTI/NAT/NAL/NTM/NMS in it — the real unit was in
 * standby when it was recorded — so a pre-fill against the bare double sits through six
 * five-second timeouts. Empty answers are the right stand-in: they are what a receiver
 * with nothing playing says, and the source pushes the real values a moment later.
 */
function playingReceiver(tickMs?: number): Promise<MockReceiver> {
	return startMockReceiver({
		responses: {
			...loadCapturedResponses(),
			SLI: NET,
			NTI: "",
			NAT: "",
			NAL: "",
			NTM: "--:--/--:--",
			NST: "Sxx",
			NMS: "xxxxxxx44",
		},
		playback: { input: NET, ...TRACK, totalSeconds: 221, ...(tickMs ? { tickMs } : {}) },
	});
}

async function until(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!check() && Date.now() - start < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (!check()) throw new Error(`timed out waiting for ${what}`);
}

/** A tracker on its own ConnectionManager, pointed at the mock's port. */
function makeTracker(mock: MockReceiver): { tracker: NowPlayingTracker; mgr: ConnectionManager; dispose: () => void } {
	const mgr = new ConnectionManager();
	const tracker = new NowPlayingTracker(
		{
			queryCommand: (host, command) => mgr.ensureConnected(host, mock.port).then((client) => client.query(command)),
			addMessageObserver: (cb) => mgr.addMessageObserver(cb),
			addConnectionObserver: (cb) => mgr.addConnectionObserver(cb),
		},
		// The cover is a separate concern with its own tests; keep this about the text.
		{ httpEnabled: () => false },
	);
	tracker.start();
	return {
		tracker,
		mgr,
		dispose: () => tracker.stop(),
	};
}

async function playing(mock: MockReceiver, tracker: NowPlayingTracker, mgr: ConnectionManager): Promise<void> {
	await mgr.ensureConnected(HOST, mock.port);
	await mock.waitForClient();
	tracker.onUpdate(HOST, () => {});
	mock.state["SLI"] = NET;
	// The pre-fill is what a bound element does, and it is what establishes the input
	// baseline — without it the *first* change is indistinguishable from the first
	// sighting, which is a production gap and not a test convenience.
	await tracker.prime(HOST);
	mock.startPlayback();
	await until(() => tracker.get(HOST).track === TRACK.title, "the track to arrive");
}

describe("a source that loses its input", () => {
	it("stops announcing anything at all — the double says nothing on the way out", async () => {
		// The premise, asserted rather than assumed: after the input change no further
		// metadata arrives. If the double ever grew a farewell message the tests below
		// would be proving something easier than the real problem.
		const mock = await playingReceiver(10);
		const { tracker, mgr, dispose } = makeTracker(mock);
		try {
			await playing(mock, tracker, mgr);
			assert.equal(mock.isPlaying(), true);

			const client = await mgr.ensureConnected(HOST, mock.port);
			const seen: string[] = [];
			const stop = mgr.addMessageObserver((_h, command) => seen.push(command));
			await client.send("SLI", BLURAY);
			await until(() => !mock.isPlaying(), "playback to stop");
			seen.length = 0;
			await new Promise((resolve) => setTimeout(resolve, 60)); // several tick periods
			stop();
			assert.deepEqual(
				seen.filter((c) => c.startsWith("N")),
				[],
				"nothing announces the end; the frames just stop",
			);
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("forgets the track, instead of naming a song that has ended", async () => {
		const mock = await playingReceiver(10);
		const { tracker, mgr, dispose } = makeTracker(mock);
		try {
			await playing(mock, tracker, mgr);
			assert.equal(tracker.get(HOST).artist, TRACK.artist);

			const client = await mgr.ensureConnected(HOST, mock.port);
			await client.send("SLI", BLURAY);

			await until(() => tracker.get(HOST).track === undefined, "the track to be dropped");
			const state = tracker.get(HOST);
			assert.equal(state.artist, undefined, "the artist goes with it");
			assert.equal(state.album, undefined);
			assert.equal(state.elapsed, undefined, "and so does a clock that has stopped counting");
			assert.equal(state.art, undefined);
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("tells its listeners, so a display repaints instead of waiting for a tick", async () => {
		// The state going empty is no use to a permanent display that only redraws when
		// it is told something changed.
		const mock = await playingReceiver();
		const { tracker, mgr, dispose } = makeTracker(mock);
		try {
			await mgr.ensureConnected(HOST, mock.port);
			await mock.waitForClient();
			const changes: string[] = [];
			tracker.onUpdate(HOST, (_state, change) => changes.push(change));
			await tracker.prime(HOST);
			mock.startPlayback();
			await until(() => tracker.get(HOST).track === TRACK.title, "the track to arrive");

			changes.length = 0;
			const client = await mgr.ensureConnected(HOST, mock.port);
			await client.send("SLI", BLURAY);
			await until(() => changes.includes("text"), "a text change to be reported");
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("picks the track up again when the input comes back, unasked", async () => {
		// The other half, and the reason dropping the state is safe: a receiver whose
		// source is still playing announces again the moment the input returns. On the
		// reference unit this is the *only* half that is observable, because it switches
		// back by itself.
		const mock = await playingReceiver();
		const { tracker, mgr, dispose } = makeTracker(mock);
		try {
			await playing(mock, tracker, mgr);
			const client = await mgr.ensureConnected(HOST, mock.port);

			await client.send("SLI", BLURAY);
			await until(() => tracker.get(HOST).track === undefined, "the track to be dropped");

			await client.send("SLI", NET);
			await until(() => tracker.get(HOST).track === TRACK.title, "the track to come back");
			assert.equal(tracker.get(HOST).artist, TRACK.artist);
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("keeps the track when the input is merely re-announced", async () => {
		// The receiver broadcasts `SLI` on connect and on power-on as well, and it is
		// re-broadcast when the listening mode changes. Treating every `SLI` frame as a
		// change would blank a correct display on a reconnect — which the offline backoff
		// does every few seconds.
		const mock = await playingReceiver();
		const { tracker, mgr, dispose } = makeTracker(mock);
		try {
			await playing(mock, tracker, mgr);
			const client = await mgr.ensureConnected(HOST, mock.port);

			await client.send("SLI", NET);
			await client.query("SLI");
			await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(tracker.get(HOST).track, TRACK.title, "the same input is not a change");
		} finally {
			dispose();
			await mock.close();
		}
	});
});
