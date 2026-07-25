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
 * The sweep state machine itself is SDK-free (see sweep.ts); this file wires
 * in the real ConnectionManager, name store, timer and logger.
 */
import { streamDeck, type SendToPluginEvent } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { ConnectionManager } from "../../adapter/eiscp/connection-manager.ts";
import { type EiscpActionSettings, fireAndLog, resolveDeviceIp } from "../eiscp-base.ts";
import { nameFor, noteChange, noteFld, recordSli, setSliSweeping, type TrackedCommand } from "./name-store.ts";
import { runSweep as runSweepWithDeps, type SweepDeps, type SweepProgress } from "./sweep.ts";

export type { SweepProgress } from "./sweep.ts";

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

/** The sweep's real side effects: ConnectionManager I/O, name store, timers, logging. */
function realSweepDeps(): SweepDeps {
	const mgr = ConnectionManager.getInstance();
	return {
		send: (host, command, param) => mgr.sendCommand(host, command, param),
		query: (host, command) => mgr.queryCommand(host, command),
		getCached: (host, command) => mgr.getCachedValue(host, command),
		sleep,
		nameFor,
		recordSli,
		setSliSweeping,
		log: logger,
	};
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
	return runSweepWithDeps(host, command, onProgress, realSweepDeps());
}

/**
 * Handle the Property Inspector "Auto-Discover" button for a learned-name action
 * (key OR dial): run the sweep for `command`, learning each option's name, and
 * stream progress back to the visible PI. Shared by the input/mode key cyclers
 * and the input/mode dials — both controllers expose getSettings/showAlert
 * (showOk exists only on keys).
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
	// Plugin -> PI messages go through the global UI controller (the currently
	// visible property inspector, i.e. this action's PI).
	const send = (m: JsonValue) =>
		fireAndLog(streamDeck.ui.sendToPropertyInspector(m), log, "sendToPropertyInspector");

	// The SDK invokes onSendToPlugin without awaiting or catching it, so anything
	// that rejects here escapes as an unhandled rejection. Route every SDK call
	// through fireAndLog / an explicit catch rather than a bare await.
	let settings: EiscpActionSettings;
	try {
		settings = await action.getSettings();
	} catch (err) {
		log.error(`discover: failed to read settings: ${err}`);
		send({ event: "discover", phase: "error", message: "Could not read action settings" });
		return;
	}
	const host = resolveDeviceIp(settings);

	if (!host) {
		send({ event: "discover", phase: "error", message: "No device IP configured" });
		if (action.isKey()) fireAndLog(action.showAlert(), log, "showAlert");
		return;
	}

	send({ event: "discover", phase: "start", command });
	try {
		const { count } = await runSweep(host, command, (p) =>
			send({ event: "discover", phase: "progress", done: p.done, current: p.current }),
		);
		send({ event: "discover", phase: "done", count });
		// showOk is Keypad-only; dials report status via the PI messages.
		if (action.isKey()) fireAndLog(action.showOk(), log, "showOk");
	} catch (err) {
		log.error(`discover sweep failed: ${err}`);
		send({ event: "discover", phase: "error", message: String(err) });
		if (action.isKey()) fireAndLog(action.showAlert(), log, "showAlert");
	}
}
