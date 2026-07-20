/**
 * Per-action bind bookkeeping, extracted SDK-free so it can be unit-tested.
 *
 * An action's key/dial is (re-)bound on appear and on every settings change.
 * Two hazards fall out of that, both fixed here and exercised by
 * tests/bind-coordinator.test.ts:
 *
 * 1. Stale continuations. A bind's initial query can take up to the connect
 *    timeout (~10 s). If the user changes settings meanwhile, a newer bind
 *    starts; the old query's late resolve/reject must NOT paint the key with
 *    results from the old configuration. Each bind captures a generation token
 *    (`nextGeneration`) and checks `isCurrent` after every await — a superseded
 *    bind goes quiet.
 * 2. Typing floods. The Property Inspector persists the Custom IP field on
 *    roughly every keystroke (~200 ms), and re-binding each partial value would
 *    open TCP connections to unintended hosts and pool a dead client per
 *    keystroke. Settings re-binds are debounced (`scheduleRebind`); only the
 *    last change within the window binds. onWillAppear still binds immediately.
 *
 * This class owns only the maps and timers; it imports nothing from the SDK so
 * that test files stay free of the SDK's log-rotation import side effect (see
 * the adapter-layer rule in CLAUDE.md).
 */

/** Default debounce for settings-triggered re-binds. */
export const REBIND_DEBOUNCE_MS = 400;

export class BindCoordinator {
	private readonly generations = new Map<string, number>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly debounceMs: number;

	constructor(debounceMs: number = REBIND_DEBOUNCE_MS) {
		this.debounceMs = debounceMs;
	}

	/**
	 * Start a new bind generation for `actionId` and return its token. The
	 * caller holds the token and checks {@link isCurrent} after each await; once
	 * a newer bind (or {@link invalidate}) has bumped the counter, the old bind
	 * must stop touching the action.
	 */
	nextGeneration(actionId: string): number {
		const gen = (this.generations.get(actionId) ?? 0) + 1;
		this.generations.set(actionId, gen);
		return gen;
	}

	/** True while `generation` is still the newest bind for `actionId`. */
	isCurrent(actionId: string, generation: number): boolean {
		return this.generations.get(actionId) === generation;
	}

	/**
	 * Debounce a settings-triggered re-bind: replace any pending timer for
	 * `actionId` so only the last change within the window runs. `onError`
	 * receives a rejection from `run` (the class stays SDK/logger-free).
	 */
	scheduleRebind(actionId: string, run: () => Promise<void>, onError: (err: unknown) => void): void {
		this.cancelRebind(actionId);
		const timer = setTimeout(() => {
			this.timers.delete(actionId);
			run().catch(onError);
		}, this.debounceMs);
		timer.unref?.();
		this.timers.set(actionId, timer);
	}

	/** Cancel a pending re-bind for `actionId` (no-op if none is queued). */
	cancelRebind(actionId: string): void {
		const timer = this.timers.get(actionId);
		if (timer) {
			clearTimeout(timer);
			this.timers.delete(actionId);
		}
	}

	/**
	 * Invalidate any in-flight bind and cancel a queued re-bind for `actionId`.
	 * Called when the action disappears: a bind whose query is still pending
	 * finds `isCurrent` false and goes quiet, and no debounced re-bind fires for
	 * a key that is no longer on screen.
	 */
	invalidate(actionId: string): void {
		this.nextGeneration(actionId);
		this.cancelRebind(actionId);
	}
}
