/**
 * Name discovery: a centralized passive observer plus an active sweep.
 *
 * Passive: registers ONE observer on the ConnectionManager that feeds every
 * SLI/LMD/FLD message into the name store, so the receiver's own option names
 * are learned whenever the device is used (front panel, remote, or plugin),
 * regardless of which actions are placed.
 *
 * Active: runSweep() cycles a command with UP until it wraps, letting the
 * passive observer learn each option's name, then restores the original value.
 */
import { streamDeck, type SendToPluginEvent } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { ConnectionManager } from "../../adapter/eiscp/connection-manager.ts";
import { type EiscpActionSettings, fireAndLog, resolveDeviceIp } from "../eiscp-base.ts";
import { nameFor, noteChange, noteFld, recordSli, setSliSweeping, type TrackedCommand } from "./name-store.ts";

const logger = streamDeck.logger.createScope("Discovery");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let registered = false;

/** Register the always-on passive observer (idempotent). */
export function register(mgr: ConnectionManager): void {
	if (registered) return;
	registered = true;
	mgr.addMessageObserver((host, command, parameter) => {
		if (command === "SLI" || command === "LMD") {
			noteChange(host, command, parameter);
		} else if (command === "FLD") {
			noteFld(host, parameter);
		}
	});
	logger.info("passive name discovery registered");
}

export interface SweepProgress {
	done: number;
	current: string;
}

/**
 * "Available-now" sweep: cycle `command` with UP until it returns to the start
 * (or a safety cap), learning each option's name passively, then restore the
 * original value. Disruptive — only call on explicit user request.
 */
export async function runSweep(
	host: string,
	command: TrackedCommand,
	onProgress?: (p: SweepProgress) => void,
): Promise<{ count: number }> {
	const mgr = ConnectionManager.getInstance();
	// This receiver's state events lag the change by ~1.5s, so wait for the code
	// to actually change rather than guessing a fixed delay.
	const POLL_MS = 200;
	const MAX_WAIT_MS = 3000;
	// LMD's transient mode-name FLD lags ~1.4s after the code; wait it out so the
	// passive window learns it before the next UP. SLI names are queried directly.
	const NAME_SETTLE_MS = command === "LMD" ? 1500 : 500;
	const CAP = 60;

	const start = await mgr.queryCommand(host, command);
	const visited = new Set<string>([start]);
	let prev = start;
	let count = 0;
	let movedAway = false;

	// SLI input names are learned deterministically below (the name FLD leads the
	// code event on UP, which would mis-pair the passive learner); suppress it.
	if (command === "SLI") setSliSweeping(host, true);

	logger.info(`sweep ${command} starting from ${start}`);
	try {
		for (let i = 0; i < CAP; i++) {
			await mgr.sendCommand(host, command, "UP");

			// Wait for the code to change (auto-broadcast lags); fall back to prev on timeout.
			let current = prev;
			for (let waited = 0; waited < MAX_WAIT_MS; waited += POLL_MS) {
				await sleep(POLL_MS);
				const v = mgr.getCachedValue(host, command);
				if (v && v !== prev) {
					current = v;
					break;
				}
			}
			await sleep(NAME_SETTLE_MS); // let the name FLD arrive (LMD: passive window; SLI: query below)
			count++;

			if (command === "SLI" && current !== prev) {
				try {
					recordSli(host, current, await mgr.queryCommand(host, "FLD"));
				} catch (err) {
					logger.debug(`sweep SLI name read failed: ${err}`);
				}
			}
			onProgress?.({ done: count, current: nameFor(host, command, current) });

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
		if (command === "SLI") setSliSweeping(host, false);
		await mgr.sendCommand(host, command, start); // restore original
		logger.info(`sweep ${command} done (${count} steps), restored ${start}`);
	}
	return { count };
}

/**
 * Handle the Property Inspector "Auto-Discover" button for a learned-name action
 * (key OR dial): run the sweep for `command`, learning each option's name, and
 * stream progress back to the visible PI. Shared by the input/mode key cyclers
 * and the input/mode dials — both controllers expose getSettings/showOk/showAlert.
 */
export async function handleDiscoverMessage(
	ev: SendToPluginEvent<JsonValue, EiscpActionSettings>,
	command: TrackedCommand,
	log: { error(msg: string): void },
): Promise<void> {
	const payload = ev.payload as { action?: string } | null;
	if (!payload || typeof payload !== "object" || payload.action !== "discover") return;
	if (!ev.action.isKey() && !ev.action.isDial()) return;
	const action = ev.action;
	const settings = await action.getSettings();
	const host = resolveDeviceIp(settings);
	// Plugin -> PI messages go through the global UI controller (the currently
	// visible property inspector, i.e. this action's PI).
	const send = (m: JsonValue) =>
		fireAndLog(streamDeck.ui.sendToPropertyInspector(m), log, "sendToPropertyInspector");

	if (!host) {
		send({ event: "discover", phase: "error", message: "No device IP configured" });
		if (action.isKey()) await action.showAlert();
		return;
	}

	send({ event: "discover", phase: "start", command });
	try {
		const { count } = await runSweep(host, command, (p) =>
			send({ event: "discover", phase: "progress", done: p.done, current: p.current }),
		);
		send({ event: "discover", phase: "done", count });
		// showOk is Keypad-only; dials report status via the PI messages.
		if (action.isKey()) await action.showOk();
	} catch (err) {
		log.error(`discover sweep failed: ${err}`);
		send({ event: "discover", phase: "error", message: String(err) });
		if (action.isKey()) await action.showAlert();
	}
}
