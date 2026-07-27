/**
 * The ceiling on how fast the plugin may query one receiver.
 *
 * These devices accept a single connection and cope badly with bursts. The plugin has
 * several subsystems that each ask on their own schedule and all fire together at
 * startup — which is how a pre-fill that looked harmless per element became 48
 * simultaneous queries. The limiter exists so that class of mistake is bounded by the
 * boundary rather than by every call site remembering.
 *
 * Time is injected, so none of this waits for real time.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { PerHostRateLimiter, RateLimiter } from "../src/adapter/eiscp/rate-limit.ts";

/** A limiter on a clock the test drives, recording what it was asked to wait. */
function harness(options: { perSecond?: number; burst?: number; maxQueue?: number } = {}) {
	let clock = 1_000;
	const waits: number[] = [];
	const limiter = new RateLimiter({
		perSecond: options.perSecond ?? 10,
		burst: options.burst ?? 3,
		maxQueue: options.maxQueue,
		now: () => clock,
		// Sleeping advances the clock, which is what real time would do.
		sleep: async (ms) => {
			waits.push(ms);
			clock += ms;
		},
	});
	return { limiter, waits, advance: (ms: number) => (clock += ms), at: () => clock };
}

describe("RateLimiter", () => {
	it("lets a burst straight through", async () => {
		// The burst has to cover the real one: every action on a profile binds at once.
		// If that were throttled, the whole deck would fill in slowly for nothing.
		const h = harness({ perSecond: 10, burst: 3 });
		const done: Promise<void>[] = [];
		for (let i = 0; i < 3; i++) done.push(h.limiter.acquire());
		assert.deepEqual(h.waits, [], "nothing waited");
		await Promise.all(done);
	});

	it("spaces out everything past the burst at the sustained rate", async () => {
		const h = harness({ perSecond: 10, burst: 2 });
		await h.limiter.acquire();
		await h.limiter.acquire();
		await h.limiter.acquire();
		await h.limiter.acquire();
		// 10/s means one every 100 ms once the burst is spent.
		assert.deepEqual(h.waits, [100, 100]);
	});

	it("serves callers in the order they asked", async () => {
		// Slots are reserved on entry rather than raced for on wake-up, so a caller
		// cannot be starved by later ones.
		const h = harness({ perSecond: 10, burst: 1 });
		const order: number[] = [];
		await Promise.all([
			h.limiter.acquire().then(() => order.push(1)),
			h.limiter.acquire().then(() => order.push(2)),
			h.limiter.acquire().then(() => order.push(3)),
		]);
		assert.deepEqual(order, [1, 2, 3]);
	});

	it("refills while idle, but no further than the burst", async () => {
		// An idle minute must not buy a minute's worth of requests all at once — that
		// would reproduce exactly the flood this exists to prevent.
		const h = harness({ perSecond: 10, burst: 3 });
		for (let i = 0; i < 3; i++) await h.limiter.acquire();
		h.advance(60_000);

		const before = h.waits.length;
		for (let i = 0; i < 3; i++) await h.limiter.acquire();
		assert.equal(h.waits.length, before, "the burst is available again");
		await h.limiter.acquire();
		assert.equal(h.waits.length, before + 1, "but only the burst, not the whole idle minute");
	});

	it("queues rather than dropping, because a dropped query is a key that never binds", async () => {
		const h = harness({ perSecond: 10, burst: 1 });
		let resolved = 0;
		const all = Promise.all(Array.from({ length: 5 }, () => h.limiter.acquire().then(() => resolved++)));
		await all;
		assert.equal(resolved, 5, "every caller is eventually served");
	});

	it("refuses once the queue is absurd, instead of growing without bound", async () => {
		const h = harness({ perSecond: 1, burst: 1, maxQueue: 2 });
		await h.limiter.acquire(); // consumes the burst
		const queued = [h.limiter.acquire(), h.limiter.acquire()];
		await assert.rejects(() => h.limiter.acquire(), /queue is full/);
		await Promise.all(queued);
	});

	it("does not penalise the others when it refuses one", async () => {
		// A rejected caller must not also have consumed a slot, or a full queue would
		// slow everything down twice.
		const h = harness({ perSecond: 10, burst: 1, maxQueue: 1 });
		await h.limiter.acquire();
		const queued = h.limiter.acquire();
		await assert.rejects(() => h.limiter.acquire(), /queue is full/);
		await queued;
		assert.deepEqual(h.waits, [100], "the surviving caller waited one interval, not two");
	});

	it("survives nonsense configuration rather than dividing by zero", async () => {
		for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const limiter = new RateLimiter({ perSecond: bad, burst: bad, now: () => 0, sleep: async () => {} });
			await limiter.acquire();
			assert.ok(true, `perSecond=${bad} did not throw`);
		}
	});
});

describe("PerHostRateLimiter", () => {
	it("limits each receiver independently", async () => {
		// One busy receiver must not throttle another.
		let clock = 0;
		const waits: string[] = [];
		const limiter = new PerHostRateLimiter({
			perSecond: 10,
			burst: 1,
			now: () => clock,
			sleep: async (ms) => {
				waits.push(`${ms}`);
				clock += ms;
			},
		});
		await limiter.acquire("10.0.0.1");
		await limiter.acquire("10.0.0.2");
		assert.deepEqual(waits, [], "two hosts, two separate burst allowances");

		await limiter.acquire("10.0.0.1");
		assert.equal(waits.length, 1, "the second request to the same host waits");
	});

	it("bounds the number of hosts it tracks", async () => {
		const limiter = new PerHostRateLimiter({ perSecond: 10, burst: 1, maxHosts: 2, now: () => 0, sleep: async () => {} });
		for (const host of ["a", "b", "c"]) await limiter.acquire(host);
		// The evicted host simply starts fresh; the cost is one burst, not a leak.
		assert.equal(limiter.waiting("a"), 0);
	});
});
