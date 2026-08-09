/**
 * "Available-now" sweep state machine, SDK-free.
 *
 * Cycles a command with UP until it wraps back to the start (or a safety cap),
 * letting the passive observer learn each option's name, then restores the
 * original value. All side effects — receiver I/O, name store, sleeping,
 * logging — come in through SweepDeps, so tests can drive the machine with a
 * fake receiver; discovery.ts supplies the real implementations.
 */
import type { SliRecordOutcome, TrackedCommand } from "./name-store.ts";

/** FLD readings per input before giving up on its name. */
export const MAX_NAME_SAMPLES = 5;
/** From this many readings on, the most frequent text wins. */
export const MAJORITY_AT = 3;
/**
 * Gap between readings. Deliberately longer than the ~1.5 s a volume or tone
 * readout occupies the display, so three readings outlast one transient instead of
 * all three catching it.
 */
export const RESAMPLE_MS = 800;

export interface SweepProgress {
	done: number;
	current: string;
}

/** Injectable side effects of the sweep (real wiring lives in discovery.ts). */
export interface SweepDeps {
	/** Send a command parameter to the receiver (ConnectionManager.sendCommand). */
	send(host: string, command: string, param: string): Promise<unknown>;
	/** Query a command's current value (ConnectionManager.queryCommand). */
	query(host: string, command: string): Promise<string>;
	/** Last known value from the live cache (ConnectionManager.getCachedValue). */
	getCached(host: string, command: string): string | undefined;
	sleep(ms: number): Promise<void>;
	/** name-store lookups/recorders (name-store imports the SDK, hence injected). */
	nameFor(host: string, command: TrackedCommand, code: string | undefined): string;
	recordSli(
		host: string,
		code: string,
		fldHex: string,
		options?: { corroborated?: boolean; tentative?: boolean },
	): SliRecordOutcome;
	/** Whether this option has a name from the receiver (name-store.hasLearnedName). */
	hasLearnedName(host: string, command: TrackedCommand, code: string): boolean;
	setSliSweeping(host: string, on: boolean): void;
	log?: { info(msg: string): void; debug(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

const NO_LOG: NonNullable<SweepDeps["log"]> = { info() {}, debug() {}, warn() {}, error() {} };

/**
 * Read one input's name off the display, measuring again when the reading is
 * doubtful.
 *
 * A single reading is enough when it is trustworthy, which is the normal case and
 * costs one query. When the store refuses it — something else owned the display,
 * or the text is not what the spec calls this input — the reading is repeated, and
 * from `MAJORITY_AT` readings on the most frequent text wins, up to
 * `MAX_NAME_SAMPLES`. That works because the input readout is the *persistent* one:
 * a volume or tone readout pushes it aside for a moment, so the text that keeps
 * coming back is the input's.
 *
 * A majority is stronger evidence than either check the store applies, so the
 * winner is recorded even if it still disagrees with the spec — that is how an
 * honest relabel ("BT AUDIO" where the spec says "BLUETOOTH") and a tuner showing
 * its station survive. Only a genuine tie is dropped, because there is nothing to
 * prefer. Limitation worth knowing: if something rewrites the display for the whole
 * sampling window — the volume being turned *during* a sweep — the transient can
 * win, and re-running Auto-Discover on a quiet receiver is the cure.
 *
 * The samples are taken `tentative`, which is what makes the paragraph above true.
 * They used to be stored as they were taken, so a display that never settles — a
 * scrolling track title on a streaming input — left its last reading in the store
 * while this function logged "leaving it unnamed". A user's input was called
 * "at is Love (" that way.
 */
async function learnInputName(host: string, code: string, deps: SweepDeps): Promise<boolean> {
	const log = deps.log ?? NO_LOG;
	const votes = new Map<string, number>();
	for (let sample = 1; sample <= MAX_NAME_SAMPLES; sample++) {
		const hex = await deps.query(host, "FLD");
		// The input can move under us — this receiver hops back to a playing network
		// source by itself — and the display then describes where it went, not the code
		// we are naming. The cache is the same evidence the sweep's own poll uses.
		const now = deps.getCached(host, "SLI");
		if (now && now !== code) {
			log.info(`sweep SLI ${code}: the input is ${now} now, so this reading is not its name`);
			return true;
		}
		const outcome = deps.recordSli(host, code, hex, { tentative: true });
		if (outcome === "learned" || outcome === "unchanged") return false;
		// A rejected reading is not evidence of anything, so it does not get a vote.
		// It used to: three identical rejects reached MAJORITY_AT and were re-recorded
		// as `corroborated`, which is precisely the escalation that turned a refused
		// track title into a stored input name.
		if (hex && outcome !== "rejected") votes.set(hex, (votes.get(hex) ?? 0) + 1);

		const total = [...votes.values()].reduce((sum, n) => sum + n, 0);
		if (total >= MAJORITY_AT) {
			const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
			const [best, bestCount] = ranked[0]!;
			const runnerUp = ranked[1]?.[1] ?? 0;
			if (bestCount > runnerUp) {
				log.debug(`sweep SLI ${code}: taking the majority reading (${bestCount}/${total})`);
				deps.recordSli(host, code, best, { corroborated: true });
				return false;
			}
		}
		if (sample < MAX_NAME_SAMPLES) await deps.sleep(RESAMPLE_MS);
	}
	log.info(`sweep SLI ${code}: no reading won a majority in ${MAX_NAME_SAMPLES} tries; leaving it unnamed`);
	return false;
}

/**
 * Cycle `command` with UP until it returns to the start (or a safety cap),
 * learning each option's name, then restore the original value. Disruptive —
 * only call on explicit user request.
 */
export async function runSweep(
	host: string,
	command: TrackedCommand,
	onProgress: ((p: SweepProgress) => void) | undefined,
	deps: SweepDeps,
): Promise<{ count: number; options: number; named: number; interrupted: boolean }> {
	const log = deps.log ?? NO_LOG;
	// This receiver's state events lag the change by ~1.5s, so wait for the code
	// to actually change rather than guessing a fixed delay.
	const POLL_MS = 200;
	const MAX_WAIT_MS = 3000;
	// LMD's transient mode-name FLD lags ~1.4s after the code; wait it out so the
	// passive window learns it before the next UP. SLI names are queried directly.
	const NAME_SETTLE_MS = command === "LMD" ? 1500 : 500;
	const CAP = 60;

	const start = await deps.query(host, command);
	const visited = new Set<string>([start]);
	/**
	 * Options this sweep came back from with a name — SLI from its own FLD query,
	 * LMD from the passive learner during the settle window. A set, so the wrap step
	 * onto the start value cannot count it twice.
	 *
	 * "Has a name" rather than "was newly learned", and the difference is worth being
	 * precise about: on a receiver whose names are already known a sweep legitimately
	 * changes nothing, and reporting 0 there would read as failure. So for a step that
	 * moved, this reports whether that option *has* a name — which for LMD, where the
	 * passive learner may simply not have fired, can include one from an earlier run.
	 *
	 * What it does guarantee is the case that misled a user: only steps that actually
	 * moved are counted, so a sweep against a sleeping receiver — where `UP` never
	 * advances — reports 0 and cannot dress up old names as this run's work.
	 */
	const named = new Set<string>();
	let prev = start;
	let count = 0;
	let movedAway = false;
	/**
	 * Whether the receiver moved the value while this sweep was reading it.
	 *
	 * It cannot be prevented from here — an unsolicited frame is indistinguishable
	 * from the answer to our own `UP` — but it must not be reported as a clean run.
	 * A receiver that hops back to its playing network input truncates the walk at
	 * the first hop (measured against the double: 2 steps, then `current === start`
	 * reads as a wrap), and without this the Property Inspector says "Done, but no
	 * names were read — is the receiver switched on?" about a receiver that is on,
	 * awake, and playing.
	 */
	let interrupted = false;

	// SLI input names are learned deterministically below (the name FLD leads the
	// code event on UP, which would mis-pair the passive learner); suppress it.
	if (command === "SLI") deps.setSliSweeping(host, true);

	log.info(`sweep ${command} starting from ${start}`);
	let sweepFailed = false;
	try {
		for (let i = 0; i < CAP; i++) {
			await deps.send(host, command, "UP");

			// Wait for the code to change (auto-broadcast lags); fall back to prev on timeout.
			let current = prev;
			let waited = 0;
			for (; waited < MAX_WAIT_MS; waited += POLL_MS) {
				await deps.sleep(POLL_MS);
				const v = deps.getCached(host, command);
				if (v && v !== prev) {
					current = v;
					break;
				}
			}
			await deps.sleep(NAME_SETTLE_MS); // let the name FLD arrive (LMD: passive window; SLI: query below)
			count++;

			// One line per step, and the only place the run's actual path is recorded.
			// A sweep is rare and explicitly asked for, so ~12 lines is proportionate —
			// and without them a truncated run is indistinguishable in the log from a
			// complete one, since everything else here is either constant or silent.
			log.info(
				current === prev
					? `sweep ${command} step ${count}: UP did not move ${prev} within ${MAX_WAIT_MS} ms`
					: `sweep ${command} step ${count}: ${prev} -> ${current} after ${waited + POLL_MS} ms`,
			);

			if (current !== prev) {
				if (command === "SLI") {
					try {
						if (await learnInputName(host, current, deps)) interrupted = true;
					} catch (err) {
						log.info(`sweep SLI name read failed: ${err}`);
					}
				}
				if (deps.hasLearnedName(host, command, current)) named.add(current);
			}

			// Nothing here can tell an answer to our own UP from the receiver changing
			// its mind — an unsolicited frame lands in the same cache. Re-reading after
			// the reading window at least *names* the case: silent on a healthy sweep,
			// one line when the receiver is steering.
			const settled = deps.getCached(host, command);
			if (settled && settled !== current) {
				interrupted = true;
				log.warn(`sweep ${command}: ${current} became ${settled} while it was being read — the receiver is moving on its own`);
			}
			onProgress?.({ done: count, current: deps.nameFor(host, command, current) });

			// Every way out of this loop says so. There are four, they were all silent,
			// and the `done` line below reads identically for all of them — so a run cut
			// short at 7 of 12 by a receiver that steered itself back to the input it
			// started on was reported as a complete, successful sweep.
			if (current === prev || current === start) {
				if (movedAway) {
					log.info(`sweep ${command} stopping: back at ${start} after ${visited.size} options`);
					break;
				}
				if (count >= 5) {
					log.info(`sweep ${command} stopping: UP did not move ${prev} in ${count} steps`);
					break;
				}
				prev = current;
				continue; // ignore an initial no-op step
			}
			if (visited.has(current)) {
				log.info(`sweep ${command} stopping: ${current} had already been visited`);
				break;
			}
			visited.add(current);
			movedAway = true;
			prev = current;
			if (i === CAP - 1) log.warn(`sweep ${command} stopping: hit the ${CAP}-step safety cap without wrapping`);
		}
	} catch (err) {
		sweepFailed = true;
		throw err;
	} finally {
		if (command === "SLI") deps.setSliSweeping(host, false);
		try {
			await deps.send(host, command, start); // restore original
			log.info(
				`sweep ${command} done (${count} steps over ${visited.size} options, ${named.size} named), restored ${start}`,
			);
		} catch (err) {
			log.error(`sweep ${command}: failed to restore ${start}: ${err}`);
			// A failing restore must not mask the sweep's own error — but
			// after a SUCCESSFUL sweep it must not be swallowed either: the
			// receiver was left on the wrong option and the user would see
			// "Done" + a green checkmark.
			if (!sweepFailed) {
				throw new Error(`Sweep finished (${count} steps) but restoring ${start} failed: ${err}`);
			}
		}
	}
	return { count, options: visited.size, named: named.size, interrupted };
}
