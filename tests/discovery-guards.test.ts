/**
 * Tests for the in-flight guard that stops a Property Inspector message from
 * being amplified into unbounded work.
 *
 * `runSweep` is the sharp case: one sweep sends up to 60 steps, each waiting up
 * to 3 s plus a settle delay, so a single message can manipulate the receiver for
 * minutes. The PI's confirm dialog is no protection — anything with PI access can
 * send the message directly — so concurrency has to be refused in the plugin.
 *
 * The host is 127.0.0.1 with nothing listening on the eISCP port, so every sweep
 * fails fast with ECONNREFUSED (~2 ms) instead of waiting out a connect timeout.
 * The lock is taken synchronously before `runSweep`'s first await, so the second
 * call is made without yielding to the event loop and the assertions do not race.
 *
 * Note this file imports `dedicated/discovery.ts`, which transitively imports the
 * SDK; the lock lives next to the handler it protects. That is why the
 * mock-receiver-based transport tests live in separate, SDK-free files.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runSweep, SweepInProgressError } from "../src/actions/dedicated/discovery.ts";

const HOST = "127.0.0.1";

/** Await a sweep we expect to fail on the unreachable port, ignoring that error. */
const settle = (p: Promise<unknown>) => p.then(() => undefined, () => undefined);

describe("runSweep concurrency guard", () => {
	it("refuses a second sweep for the same host and command", async () => {
		// Both calls happen with no await in between, so the first still holds the
		// lock — this asserts the guard, not a timing coincidence.
		const first = runSweep(HOST, "SLI");
		const second = runSweep(HOST, "SLI");

		await assert.rejects(() => second, SweepInProgressError);
		await settle(first);
	});

	it("releases the lock once the sweep settles, so a later sweep is allowed", async () => {
		await settle(runSweep(HOST, "SLI"));

		// The retry still fails on the unreachable port; the point is *which* error.
		await runSweep(HOST, "SLI").then(
			() => undefined,
			(err) => assert.ok(!(err instanceof SweepInProgressError), `lock was not released: ${err}`),
		);
	});

	it("locks per host and command, not globally", async () => {
		const sli = runSweep(HOST, "SLI");
		// A different command targets different receiver state and a different
		// name-store map, so it must not be blocked while SLI is sweeping.
		const lmd = runSweep(HOST, "LMD");

		await lmd.then(
			() => undefined,
			(err) => assert.ok(!(err instanceof SweepInProgressError), `LMD was blocked by SLI: ${err}`),
		);
		await settle(sli);
	});
});
