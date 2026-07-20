/**
 * Unit tests for BindCoordinator — the per-action generation guard and re-bind
 * debounce extracted from EiscpActionBase. These lock in the round-2/round-3
 * fixes (a stale continuation must not clobber a fresh bind; typing a Custom IP
 * must not open a TCP connect per keystroke) so a regression fails a test
 * instead of silently returning the bug.
 *
 * Timers are driven by node:test mock timers, so the 400 ms debounce is
 * asserted deterministically with zero wall-clock wait.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BindCoordinator, REBIND_DEBOUNCE_MS } from "../src/actions/bind-coordinator.ts";

/** Flush the microtask queue so a settled run()/.catch() has been observed. */
const flush = async () => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("BindCoordinator generation guard", () => {
	it("hands out increasing tokens per action, starting at 1", () => {
		const c = new BindCoordinator();
		assert.equal(c.nextGeneration("a"), 1);
		assert.equal(c.nextGeneration("a"), 2);
		assert.equal(c.nextGeneration("a"), 3);
	});

	it("keeps generations independent across actions", () => {
		const c = new BindCoordinator();
		assert.equal(c.nextGeneration("a"), 1);
		assert.equal(c.nextGeneration("b"), 1);
		assert.equal(c.nextGeneration("a"), 2);
		assert.equal(c.nextGeneration("b"), 2);
		assert.ok(c.isCurrent("a", 2));
		assert.ok(c.isCurrent("b", 2));
	});

	it("treats only the newest token as current", () => {
		const c = new BindCoordinator();
		const gen1 = c.nextGeneration("a");
		assert.ok(c.isCurrent("a", gen1));
		const gen2 = c.nextGeneration("a");
		// The old bind's late continuation must see itself as superseded.
		assert.equal(c.isCurrent("a", gen1), false);
		assert.ok(c.isCurrent("a", gen2));
	});

	it("reports an unknown token as not current", () => {
		const c = new BindCoordinator();
		assert.equal(c.isCurrent("never-bound", 1), false);
		assert.equal(c.isCurrent("never-bound", 0), false);
	});

	it("invalidate bumps the generation so an in-flight bind goes quiet", () => {
		const c = new BindCoordinator();
		const gen = c.nextGeneration("a");
		assert.ok(c.isCurrent("a", gen));
		c.invalidate("a"); // action disappeared while the bind's query was pending
		assert.equal(c.isCurrent("a", gen), false);
	});
});

describe("BindCoordinator re-bind debounce", () => {
	it("runs only the last scheduled re-bind within the window", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = new BindCoordinator(REBIND_DEBOUNCE_MS);
		const ran: string[] = [];
		const onError = () => {};

		// Simulate the PI flushing "1", "10", "10." … while the user types.
		c.scheduleRebind("a", async () => void ran.push("1"), onError);
		c.scheduleRebind("a", async () => void ran.push("10"), onError);
		c.scheduleRebind("a", async () => void ran.push("10.2.0.32"), onError);

		assert.deepEqual(ran, [], "nothing runs before the window elapses");
		t.mock.timers.tick(REBIND_DEBOUNCE_MS);
		assert.deepEqual(ran, ["10.2.0.32"], "only the final value binds, exactly once");
	});

	it("does not fire before the debounce window elapses", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = new BindCoordinator(REBIND_DEBOUNCE_MS);
		let ran = 0;
		c.scheduleRebind("a", async () => void ran++, () => {});

		t.mock.timers.tick(REBIND_DEBOUNCE_MS - 1);
		assert.equal(ran, 0, "must wait the full window");
		t.mock.timers.tick(1);
		assert.equal(ran, 1);
	});

	it("debounces each action independently", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = new BindCoordinator(REBIND_DEBOUNCE_MS);
		const ran: string[] = [];
		c.scheduleRebind("a", async () => void ran.push("a"), () => {});
		c.scheduleRebind("b", async () => void ran.push("b"), () => {});
		t.mock.timers.tick(REBIND_DEBOUNCE_MS);
		assert.deepEqual(ran.sort(), ["a", "b"], "both fire; one action does not cancel another");
	});

	it("cancelRebind prevents a queued re-bind from firing", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = new BindCoordinator(REBIND_DEBOUNCE_MS);
		let ran = 0;
		c.scheduleRebind("a", async () => void ran++, () => {});
		c.cancelRebind("a");
		t.mock.timers.tick(REBIND_DEBOUNCE_MS);
		assert.equal(ran, 0, "a cancelled re-bind never runs");
	});

	it("cancelRebind on an action with nothing queued is a no-op", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = new BindCoordinator(REBIND_DEBOUNCE_MS);
		assert.doesNotThrow(() => c.cancelRebind("never-scheduled"));
	});

	it("invalidate cancels a pending re-bind (disappear during typing)", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = new BindCoordinator(REBIND_DEBOUNCE_MS);
		let ran = 0;
		c.scheduleRebind("a", async () => void ran++, () => {});
		c.invalidate("a"); // key removed from the profile before the window elapsed
		t.mock.timers.tick(REBIND_DEBOUNCE_MS);
		assert.equal(ran, 0, "no debounced re-bind fires for a key no longer on screen");
	});

	it("routes a rejecting re-bind to onError instead of throwing", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = new BindCoordinator(REBIND_DEBOUNCE_MS);
		const errors: unknown[] = [];
		c.scheduleRebind(
			"a",
			async () => {
				throw new Error("bind boom");
			},
			(err) => errors.push(err),
		);
		t.mock.timers.tick(REBIND_DEBOUNCE_MS);
		await flush();
		assert.equal(errors.length, 1, "the rejection is handed to onError");
		assert.match(String(errors[0]), /bind boom/);
	});

	it("a fresh schedule after the window fires again", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const c = new BindCoordinator(REBIND_DEBOUNCE_MS);
		let ran = 0;
		c.scheduleRebind("a", async () => void ran++, () => {});
		t.mock.timers.tick(REBIND_DEBOUNCE_MS);
		assert.equal(ran, 1);
		// A later settings change must not be swallowed by the spent timer.
		c.scheduleRebind("a", async () => void ran++, () => {});
		t.mock.timers.tick(REBIND_DEBOUNCE_MS);
		assert.equal(ran, 2);
	});
});
