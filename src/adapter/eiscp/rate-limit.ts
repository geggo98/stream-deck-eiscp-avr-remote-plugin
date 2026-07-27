/**
 * A ceiling on how fast the plugin may talk to one receiver.
 *
 * These devices accept a **single** connection and are not built for bursts. The
 * plugin has several subsystems that each ask for something on their own schedule —
 * every action's bind, the power heartbeat, the now-playing pre-fill — and they all
 * fire together at startup or on a profile switch. That is how a pre-fill that looked
 * harmless per element turned into 48 simultaneous queries, and per-call-site
 * discipline is exactly the kind of rule that holds until the next call site.
 *
 * So the limit lives at the boundary instead: one gate every automated request passes
 * through, whoever wrote it.
 *
 * **Queued, never dropped.** A discarded query is a key that never finishes binding,
 * which is worse than a key that binds a moment later. The queue is bounded all the
 * same — a caller that outruns the drain forever should fail loudly rather than grow.
 *
 * Deterministic by construction: `now` and `sleep` are injected, so the behaviour is
 * testable without waiting for real time.
 */

export interface RateLimiterOptions {
	/** Sustained rate. */
	perSecond: number;
	/**
	 * How much may go out back to back before the sustained rate applies.
	 *
	 * Sized for the real burst it has to let through unimpeded: every action on a
	 * profile binds at once, and a full profile is a couple of dozen.
	 */
	burst: number;
	/** Requests allowed to wait; beyond this `acquire` rejects. */
	maxQueue?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_MAX_QUEUE = 256;

const realSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});

export class RateLimiter {
	private readonly intervalMs: number;
	private readonly burstMs: number;
	private readonly maxQueue: number;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;
	/** When the next request may go out; may sit in the past by up to `burstMs`. */
	private nextAt = 0;
	private queued = 0;

	constructor(options: RateLimiterOptions) {
		const perSecond = Number.isFinite(options.perSecond) && options.perSecond > 0 ? options.perSecond : 1;
		const burst = Number.isFinite(options.burst) && options.burst > 0 ? Math.floor(options.burst) : 1;
		this.intervalMs = 1000 / perSecond;
		// (burst - 1), not burst: the first request never waits, so the allowance only
		// has to cover how far the *following* ones may run ahead. Using `burst` here
		// let one extra request through, and using `nextAt < now - burstMs` as the
		// refill rule let the very second request wait — both off by one in opposite
		// directions, which is why the tests count exact slots rather than "roughly".
		this.burstMs = this.intervalMs * Math.max(0, burst - 1);
		this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? realSleep;
	}

	/** Requests currently waiting. */
	get waiting(): number {
		return this.queued;
	}

	/**
	 * Wait for permission to send.
	 *
	 * Slots are reserved in call order, so callers are served FIFO rather than
	 * racing each other awake.
	 */
	async acquire(): Promise<void> {
		const now = this.now();
		// A request may arrive up to `burstMs` before its nominal slot; that is what
		// "burst" means. Everything beyond waits for the difference.
		const slot = Math.max(now, this.nextAt - this.burstMs);
		// The nominal schedule advances by one interval per request, clamped to now so
		// an idle stretch refills the allowance — but only up to the burst, never a
		// whole idle minute's worth at once.
		this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;

		const wait = slot - now;
		if (wait <= 0) return;

		if (this.queued >= this.maxQueue) {
			// Undo the reservation so a rejected caller does not also slow the others.
			this.nextAt -= this.intervalMs;
			throw new Error(`rate limiter queue is full (${this.maxQueue} waiting)`);
		}
		this.queued++;
		try {
			await this.sleep(wait);
		} finally {
			this.queued--;
		}
	}
}

/**
 * One limiter per host, bounded.
 *
 * Hosts come from user configuration rather than off the wire, but the map is capped
 * like every other one here; an evicted host simply gets a fresh limiter, which costs
 * one burst.
 */
export class PerHostRateLimiter {
	private readonly limiters = new Map<string, RateLimiter>();
	private readonly options: RateLimiterOptions;
	private readonly maxHosts: number;

	constructor(options: RateLimiterOptions & { maxHosts?: number }) {
		this.options = options;
		this.maxHosts = options.maxHosts ?? 16;
	}

	async acquire(host: string): Promise<void> {
		let limiter = this.limiters.get(host);
		if (!limiter) {
			if (this.limiters.size >= this.maxHosts) {
				const oldest = this.limiters.keys().next().value;
				if (oldest !== undefined) this.limiters.delete(oldest);
			}
			limiter = new RateLimiter(this.options);
			this.limiters.set(host, limiter);
		}
		await limiter.acquire();
	}

	waiting(host: string): number {
		return this.limiters.get(host)?.waiting ?? 0;
	}
}
