/**
 * The Auto-Discover sweep against *recorded hardware*.
 *
 * tests/fixtures/name-discovery-capture.json holds the wire traffic of both
 * sweeps as the real VSX-S520D produced it (`npm run capture:names`), so CI can
 * cover the behaviour that has no synthetic equivalent:
 *
 *  - `UP` does not step numerically through the codes (10 -> 01 -> 02 -> 11 …),
 *    so a mock that increments hex would never reproduce the real order,
 *  - the input *name* (FLD) arrives ~1 s BEFORE the input code, which is exactly
 *    the mis-pairing the sweep suppresses passive learning for,
 *  - unrelated commands (LMD, MOT) broadcast in the middle of a step,
 *  - the listening-mode name lags the code instead of leading it.
 *
 * SDK-free: the sweep state machine and the eISCP client both are, which is why
 * this can run in CI at all.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runSweep, type SweepDeps } from "../src/actions/dedicated/sweep.ts";
import type { TrackedCommand } from "../src/actions/dedicated/name-store.ts";
import { createClient } from "../src/adapter/eiscp/client.ts";
import { startMockReceiver, type CapturedFrame } from "./helpers/mock-receiver.ts";

interface CapturedSweep {
	start: string;
	steps: number;
	names: Record<string, string>;
	frames: CapturedFrame[];
}

const capture = JSON.parse(
	readFileSync(new URL("./fixtures/name-discovery-capture.json", import.meta.url), "utf-8"),
) as { model: string; sweeps: Record<string, CapturedSweep> };

/** Poll until `done()` or the deadline; fails loudly rather than asserting on a race. */
async function waitUntil(done: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!done()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the mock to receive the frame");
		await new Promise((resolve) => {
			setTimeout(resolve, 5).unref?.();
		});
	}
}

/** The codes the recording shows the receiver reporting, in order. */
function capturedCodeOrder(sweep: CapturedSweep, command: string): string[] {
	const codes: string[] = [];
	for (const frame of sweep.frames) {
		if (frame.dir !== "in" || frame.command !== command || frame.parameter === undefined) continue;
		if (codes[codes.length - 1] !== frame.parameter) codes.push(frame.parameter);
	}
	return codes;
}

/**
 * Drive one recorded sweep through the real state machine and client.
 *
 * `sleep` yields to the event loop instead of waiting: the replay answers
 * immediately, so the captured delays would only make the suite slow.
 */
async function replaySweep(command: TrackedCommand): Promise<{
	count: number;
    visited: string[];
	names: Record<string, string>;
	sent: { command: string; parameter: string }[];
}> {
	const sweep = capture.sweeps[command]!;
	const mock = await startMockReceiver({ replay: sweep, replayTimeScale: 0 });
	const client = createClient({
		host: "127.0.0.1",
		port: mock.port,
		autoQuery: false,
		debugLog: true,
		commandTimeoutMs: 2000,
	});

	// Raw codes per command, the way ConnectionManager caches them for the sweep.
	const codes: Record<string, string> = {};
	const visited: string[] = [];
	// Resolved by the next inbound frame; see sleepUntilFrame below.
	let wakeOnFrame: (() => void) | undefined;
	client.on("rawPacket", (direction, packet) => {
		if (direction !== "received") return;
		const message = "message" in packet ? packet.message : "";
		const m = /^!.(\w{3})(.*)$/.exec(message.replace(/[\x1a\r\n]+$/, ""));
		if (!m) return;
		codes[m[1]!] = m[2]!;
		if (m[1] === command && visited[visited.length - 1] !== m[2]) visited.push(m[2]!);
		wakeOnFrame?.();
	});
	client.on("error", () => {});
	await client.connect();
	await mock.waitForClient();

	/**
	 * Stand-in for the sweep's real waits (200 ms per poll, 1.5 s for a name).
	 *
	 * The captured delays are deliberately dropped (`replayTimeScale: 0`), so a
	 * fixed pause here would be a bet on how fast the loopback happens to be — and
	 * `setImmediate` lost that bet: on a loaded CI runner all 15 poll iterations
	 * elapsed before the answer to `UP` arrived, so every step read the *previous*
	 * code and the pairing came out shifted by one. Wait for the frame instead, and
	 * fall through after a bounded pause for the steps where the receiver has
	 * nothing more to say. The sweep's own poll loop supplies the patience; this
	 * only has to not spend it all before the first frame lands.
	 */
	const QUIET_MS = 60;
	const sleepUntilFrame = (): Promise<void> =>
		new Promise<void>((resolve) => {
			const finish = (): void => {
				clearTimeout(timer);
				wakeOnFrame = undefined;
				resolve();
			};
			const timer = setTimeout(finish, QUIET_MS);
			timer.unref?.();
			wakeOnFrame = finish;
		});

	const names: Record<string, string> = {};
	const deps: SweepDeps = {
		send: (_h, cmd, param) => client.send(cmd, param),
		query: (_h, cmd) => client.query(cmd),
		getCached: (_h, cmd) => codes[cmd],
		sleep: sleepUntilFrame,
		nameFor: (_h, _cmd, code) => code ?? "",
		recordSli: (_h, code, fldHex) => {
			names[code] = fldHex;
			// The recording holds one FLD exchange per step, so the reading has to
			// count as trustworthy here — otherwise the sweep would re-measure and
			// consume exchanges the real device never answered.
			return "learned";
		},
		setSliSweeping: () => {},
	};

	try {
		const { count } = await runSweep("127.0.0.1", command, undefined, deps);
		// The restore is a fire-and-forget set: client.send resolves when the local
		// write completes, which can be before the server has parsed the frame.
		await waitUntil(() => {
			const sets = mock.received.filter((m) => m.command === command && m.parameter !== "QSTN");
			return sets.length > 0 && sets[sets.length - 1]!.parameter !== "UP";
		});
		return { count, visited, names, sent: [...mock.received] };
	} finally {
		client.disconnect();
		await mock.close();
	}
}

describe(`Auto-Discover sweep against the recorded ${capture.model}`, () => {
	it("walks the inputs in the order the real receiver reports them", async () => {
		const sweep = capture.sweeps["SLI"]!;
		const result = await replaySweep("SLI");

		assert.equal(result.count, sweep.steps, "step count must match the captured sweep");
		assert.deepEqual(
			result.visited,
			capturedCodeOrder(sweep, "SLI"),
			"UP walks the receiver's own input order, not a numeric sequence",
		);
	});

	it("pairs every input with the name the receiver displayed for it", async () => {
		const sweep = capture.sweeps["SLI"]!;
		const result = await replaySweep("SLI");

		// The FLD name leads the code on the wire; the sweep only records a name
		// after an explicit FLD query, so the pairing must come out exact.
		assert.deepEqual(result.names, sweep.names);
		assert.ok(Object.keys(result.names).length >= 10, "the captured unit offers a dozen inputs");
	});

	it("restores the input it started from", async () => {
		const sweep = capture.sweeps["SLI"]!;
		const result = await replaySweep("SLI");

		const sets = result.sent.filter((m) => m.command === "SLI" && m.parameter !== "QSTN");
		assert.equal(sets[sets.length - 1]?.parameter, sweep.start, "the last SLI write restores the start value");
	});

	it("sweeps the listening modes, whose names lag their codes", async () => {
		const sweep = capture.sweeps["LMD"]!;
		const result = await replaySweep("LMD");

		assert.equal(result.count, sweep.steps);
		assert.deepEqual(result.visited, capturedCodeOrder(sweep, "LMD"));
		const sets = result.sent.filter((m) => m.command === "LMD" && m.parameter !== "QSTN");
		assert.equal(sets[sets.length - 1]?.parameter, sweep.start);
	});

	it("keeps a name-leading FLD out of the code stream", async () => {
		// Regression guard for the reason SLI names are queried instead of learned
		// passively: in the recording the name frame precedes the code frame.
		const frames = capture.sweeps["SLI"]!.frames;
		const firstUp = frames.findIndex((f) => f.dir === "out" && f.command === "SLI" && f.parameter === "UP");
		const rest = frames.slice(firstUp + 1);
		const fldAt = rest.findIndex((f) => f.dir === "in" && f.command === "FLD");
		const sliAt = rest.findIndex((f) => f.dir === "in" && f.command === "SLI");
		assert.ok(fldAt !== -1 && sliAt !== -1, "the capture must contain both frames");
		assert.ok(fldAt < sliAt, "the captured FLD name arrives before the SLI code");
	});
});
