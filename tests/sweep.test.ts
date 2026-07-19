/**
 * Tests for the SDK-free sweep state machine (src/actions/dedicated/sweep.ts)
 * with an injected fake receiver and an instant sleep — no timers, no SDK.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runSweep, type SweepDeps, type SweepProgress } from "../src/actions/dedicated/sweep.ts";

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
	opts: { failUpAt?: number; failRestore?: boolean; fld?: string } = {},
): FakeReceiver {
	let value = start;
	let ups = 0;
	const sent: string[] = [];
	const nameEvents: string[] = [];
	const deps: SweepDeps = {
		send: (_host, command, param) => {
			sent.push(`${command}:${param}`);
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
		query: (_host, command) => Promise.resolve(command === "FLD" ? (opts.fld ?? "00") : value),
		getCached: () => value,
		sleep: () => Promise.resolve(),
		nameFor: (_host, _command, code) => `name:${code}`,
		recordSli: (_host, code, fldHex) => {
			nameEvents.push(`recordSli:${code}:${fldHex}`);
			return true;
		},
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
		const rx = fakeReceiver("A", (c) => seq[c]!);
		const { count } = await runSweep("h", "LMD", undefined, rx.deps);
		assert.equal(count, 3);
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
			"recordSli:11:4344202020203134",
			"recordSli:12:4344202020203134",
			"recordSli:10:4344202020203134",
			"sweeping:off",
		]);
		assert.equal(rx.sent[rx.sent.length - 1], "SLI:10");
	});

	it("turns the SLI sweeping flag off even when the sweep fails", async () => {
		const rx = fakeReceiver("10", ring(["10", "11", "12"]), { failUpAt: 1 });
		await assert.rejects(runSweep("h", "SLI", undefined, rx.deps), /boom/);
		assert.deepEqual(rx.nameEvents, ["sweeping:on", "sweeping:off"]);
		assert.equal(rx.sent[rx.sent.length - 1], "SLI:10");
	});
});
