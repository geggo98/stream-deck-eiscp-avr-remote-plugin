/**
 * "Available-now" sweep state machine, SDK-free.
 *
 * Cycles a command with UP until it wraps back to the start (or a safety cap),
 * letting the passive observer learn each option's name, then restores the
 * original value. All side effects — receiver I/O, name store, sleeping,
 * logging — come in through SweepDeps, so tests can drive the machine with a
 * fake receiver; discovery.ts supplies the real implementations.
 */
import type { TrackedCommand } from "./name-store.ts";

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
	recordSli(host: string, code: string, fldHex: string): unknown;
	setSliSweeping(host: string, on: boolean): void;
	log?: { info(msg: string): void; debug(msg: string): void; error(msg: string): void };
}

const NO_LOG: NonNullable<SweepDeps["log"]> = { info() {}, debug() {}, error() {} };

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
): Promise<{ count: number }> {
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
	let prev = start;
	let count = 0;
	let movedAway = false;

	// SLI input names are learned deterministically below (the name FLD leads the
	// code event on UP, which would mis-pair the passive learner); suppress it.
	if (command === "SLI") deps.setSliSweeping(host, true);

	log.info(`sweep ${command} starting from ${start}`);
	try {
		for (let i = 0; i < CAP; i++) {
			await deps.send(host, command, "UP");

			// Wait for the code to change (auto-broadcast lags); fall back to prev on timeout.
			let current = prev;
			for (let waited = 0; waited < MAX_WAIT_MS; waited += POLL_MS) {
				await deps.sleep(POLL_MS);
				const v = deps.getCached(host, command);
				if (v && v !== prev) {
					current = v;
					break;
				}
			}
			await deps.sleep(NAME_SETTLE_MS); // let the name FLD arrive (LMD: passive window; SLI: query below)
			count++;

			if (command === "SLI" && current !== prev) {
				try {
					deps.recordSli(host, current, await deps.query(host, "FLD"));
				} catch (err) {
					log.debug(`sweep SLI name read failed: ${err}`);
				}
			}
			onProgress?.({ done: count, current: deps.nameFor(host, command, current) });

			if (current === prev || current === start) {
				if (movedAway) break; // wrapped back to the start
				if (count >= 5) break; // UP isn't advancing — bail
				prev = current;
				continue; // ignore an initial no-op step
			}
			if (visited.has(current)) break; // returned to a seen option
			visited.add(current);
			movedAway = true;
			prev = current;
		}
	} finally {
		if (command === "SLI") deps.setSliSweeping(host, false);
		// A failing restore must not mask the sweep's original error.
		try {
			await deps.send(host, command, start); // restore original
			log.info(`sweep ${command} done (${count} steps), restored ${start}`);
		} catch (err) {
			log.error(`sweep ${command}: failed to restore ${start}: ${err}`);
		}
	}
	return { count };
}
