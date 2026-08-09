/**
 * "Available-now" sweep state machine, SDK-free.
 *
 * Cycles a command with UP until it wraps back to the start (or a safety cap),
 * letting the passive observer learn each option's name, then restores the
 * original value. All side effects — receiver I/O, name store, sleeping,
 * logging — come in through SweepDeps, so tests can drive the machine with a
 * fake receiver; discovery.ts supplies the real implementations.
 */
import { parsePlayStatus } from "../../adapter/eiscp/play-status.ts";
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
 * How long the muted display keeps the input readout off the panel.
 *
 * `AMT` is one of the DISPLAY_OWNING_COMMANDS, so its echo starts a `DISPLAY_OWNED_MS`
 * (1500 ms) window in which `recordSli` refuses every reading. The sweep's own slack
 * before the first FLD query is one poll tick + NAME_SETTLE_MS + two queries, so the
 * structural floor is ~850 ms; 1000 ms is that plus margin. On the reference unit the
 * first query lands 1653 ms after the mute even with no wait at all — the margin is for
 * a receiver that answers `SLI` on the first tick. Getting it wrong costs one resample
 * on the first input, nothing more.
 */
const MUTE_SETTLE_MS = 1000;
/** How long a paused source is given to actually stop before the walk starts. */
const PAUSE_SETTLE_MS = 500;

/**
 * Silence the receiver for the duration of an input sweep, and return the undo.
 *
 * Why this exists: with AirPlay playing, this receiver hops back to its network input a
 * few seconds after the input moves away from it. That hop is indistinguishable from
 * the answer to the sweep's own `UP`, and lands as an exact `current === start`, so the
 * walk ends after two of twelve inputs. Silencing the source removes the reason to
 * steer — and stops a twelve-input walk being audible.
 *
 * Deliberately **mute, not volume 0**. `trailingNumberIsVolume` — the sweep's only
 * defence against a streaming source — asks whether a digit-terminated readout ends in
 * the *current* volume. At volume 0 that degrades to "must end in a run of zeros",
 * which "Loveless 2.0" and every other `.0` boundary satisfies, so setting the volume
 * to 0 would switch off the guard for exactly the sweep that needs it. The `MVL` query
 * stays: neither recorded sweep contains an `MVL` frame, so `s.volume` is undefined and
 * that guard is dormant during sweeps today — asking *arms* it.
 *
 * Three things that cannot be observed, and are therefore never assumed:
 *  - **the pause**: `NTC` answers no query (confirmed on hardware) and `send` resolves
 *    at the write, so nothing here is conditioned on it having worked;
 *  - **standby**: `NTC`, `MVL` and `AMT` are all swallowed while `SLI` is honoured *and
 *    powers the unit on*, so an unguarded sequence would assert a mute that never landed
 *    and then wake the receiver into a full-volume walk. Hence the `PWR` check;
 *  - **what we could not read**: a failed `AMT` query means no mute at all. Never change
 *    a state you cannot put back — the same rule the capture scripts follow.
 */
async function quietenForSweep(host: string, deps: SweepDeps): Promise<(expectedInput?: string) => Promise<void>> {
	const log = deps.log ?? NO_LOG;
	const undo: (() => Promise<void>)[] = [];

	// Power first: everything below is dropped in silence while the unit is asleep.
	let power: string | undefined;
	try {
		power = await deps.query(host, "PWR");
	} catch (err) {
		log.info(`sweep: could not read the power state (${err}); sweeping without quietening`);
		return async () => {};
	}
	if (power === "00") {
		log.info("sweep: the receiver is in standby; waking it so the mute is not swallowed");
		await deps.send(host, "PWR", "01");
		// The receiver announces the change itself; give it the same patience a step gets.
		for (let waited = 0; waited < 3000 && deps.getCached(host, "PWR") !== "01"; waited += 200) {
			await deps.sleep(200);
		}
		undo.push(async () => {
			log.info("sweep: putting the receiver back into standby");
			await deps.send(host, "PWR", "00");
		});
	}

	// Was it playing? `NST` says so directly — and unlike a "metadata arrived recently"
	// heuristic it cannot mistake a *browsed* network source for a playing one: the idle
	// recording contains 29 NLS + 4 NLT + 2 NFI and no playback at all.
	//
	// The cache is tried first because `NST` is broadcast on every transport change, but
	// it is **not enough on its own**, and that cost a user their music: the receiver
	// broadcasts it only when the state *changes*, so a plugin that connected while the
	// music was already playing has never seen one. Measured — the first live sweep
	// reported "not playing" about a source that was, paused it, and then honoured its
	// own safe default by not resuming. So an empty cache is a question, not an answer,
	// and `NST QSTN` does answer (`input-hop-capture.json` snapshots it as `Pxx`).
	let status = parsePlayStatus(deps.getCached(host, "NST"));
	if (status === undefined) {
		try {
			status = parsePlayStatus(await deps.query(host, "NST"));
		} catch (err) {
			log.info(`sweep: the receiver did not say what the transport is doing (${err})`);
		}
	}
	const wasPlaying = status === "play";
	await deps.send(host, "NTC", "PAUSE");
	log.info(`sweep: paused the source (it was ${status ?? "not reported"}${wasPlaying ? ", so it will be resumed" : ""})`);
	await deps.sleep(PAUSE_SETTLE_MS);

	// Snapshot before silencing. The volume is read but never written; see above.
	let muted: string | undefined;
	try {
		const volume = await deps.query(host, "MVL");
		muted = await deps.query(host, "AMT");
		log.info(`sweep: volume ${volume}, mute ${muted}`);
	} catch (err) {
		log.info(`sweep: could not read the volume/mute state (${err}); sweeping unmuted`);
	}
	if (muted !== undefined) {
		if (muted === "01") {
			log.info("sweep: already muted; leaving it alone");
		} else {
			await deps.send(host, "AMT", "01");
			log.info("sweep: muted for the walk");
			undo.push(async () => {
				await deps.send(host, "AMT", "00");
				log.info("sweep: unmuted");
			});
			await deps.sleep(MUTE_SETTLE_MS);
		}
	}

	return async (expectedInput?: string) => {
		// `NTC` addresses the *selected* network source, so resuming while the receiver is
		// parked on another input would talk to the wrong one — and re-create the very hop
		// this exists to prevent. `send` does not await an echo and this unit's SLI code
		// lags 1103-2044 ms, so wait for the cache to show the sweep's own restore landed.
		if (wasPlaying && expectedInput !== undefined) {
			let waited = 0;
			for (; waited < 3000 && deps.getCached(host, "SLI") !== expectedInput; waited += 200) {
				await deps.sleep(200);
			}
			if (deps.getCached(host, "SLI") !== expectedInput) {
				log.warn(`sweep: the input is not back on ${expectedInput}; leaving the source paused`);
			} else {
				await deps.send(host, "NTC", "PLAY");
				log.info(`sweep: resumed playback (input back on ${expectedInput} after ${waited} ms)`);
			}
		}
		// Unmute — and, if we woke the receiver, standby — last: the resume is the step
		// most likely to be refused, and a receiver left muted reads as broken hardware
		// while a source left paused is one button.
		for (const step of undo.reverse()) await step();
	};
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

	// Only the input sweep: it is the one that walks the receiver off a playing source
	// and so provokes the hop back. A listening-mode sweep never leaves the input.
	const restoreQuiet = command === "SLI" ? await quietenForSweep(host, deps) : undefined;

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
	/** Raised only after a successful sweep; see the restore block below. */
	let restoreError: Error | undefined;
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
				sweepFailed = true;
				restoreError = new Error(`Sweep finished (${count} steps) but restoring ${start} failed: ${err}`);
			}
		}
		// Unmute and resume even when everything above failed — this is the half the
		// user *hears*, and the same asymmetry applies: a receiver left silent by a
		// discovery run is unattributable, while a failed restore is one more press.
		try {
			await restoreQuiet?.(start);
		} catch (err) {
			log.error(`sweep ${command}: failed to unmute or resume: ${err}`);
			if (!sweepFailed) {
				restoreError = new Error(`Sweep finished (${count} steps) but the receiver may still be muted: ${err}`);
			}
		}
		if (restoreError) throw restoreError;
	}
	return { count, options: visited.size, named: named.size, interrupted };
}
