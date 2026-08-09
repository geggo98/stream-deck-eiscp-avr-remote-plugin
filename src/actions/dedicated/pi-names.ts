/**
 * The Property Inspector's option-name editor (SDK adapter).
 *
 * Answers the panel's request for this receiver's option list, and stores the names
 * the user types. The list itself is assembled in `option-names.ts`; this file only
 * parses the message, resolves the host, and sends the reply.
 *
 * Two things it deliberately does not do:
 *
 * - **It never calls `action.getSettings()`.** That is a WebSocket round trip whose
 *   `didReceiveSettings` reply also reaches the action's own handler, so merely
 *   opening a panel would re-bind the action — and this request fires on open. The
 *   settings the action was last seen with are recorded for exactly this
 *   (`rememberActionSettings`).
 * - **It does not write global settings itself.** `setOverride` marks the name store
 *   dirty and the store's single debounced writer persists names, user names and seen
 *   codes together; a second writer for the same subject is how this data gets lost.
 */
import { streamDeck, type SendToPluginEvent } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import {
	fireAndLog,
	getRememberedActionSettings,
	resolveDeviceIp,
	type EiscpActionSettings,
} from "../eiscp-base.ts";
import { noteOptionCode, optionNameState, setOverride, type TrackedCommand } from "./name-store.ts";
import { buildOptionNames } from "./option-names.ts";

const logger = streamDeck.logger.createScope("PiNames");

/** Message names, shared with ui/name-editor.js. */
export const OPTION_NAMES_EVENT = "optionNames";
const GET_EVENT = "getOptionNames";
const SET_EVENT = "setOptionName";
const ADD_EVENT = "addOptionCode";

/** What the panel calls the thing it is editing. */
const LABELS: Record<TrackedCommand, string> = { SLI: "input", LMD: "listening mode" };

/**
 * Handle the editor's messages. Returns true if the message was ours, so the
 * caller can stop looking.
 */
export function handleOptionNamesMessage<T extends EiscpActionSettings>(
	ev: SendToPluginEvent<JsonValue, T>,
	command: TrackedCommand,
): boolean {
	const payload = ev.payload as { event?: string; code?: unknown; name?: unknown; use?: unknown } | null;
	if (!payload || typeof payload !== "object") return false;
	const event = payload.event;
	if (event !== GET_EVENT && event !== SET_EVENT && event !== ADD_EVENT) return false;

	const send = (m: JsonValue): void =>
		fireAndLog(streamDeck.ui.sendToPropertyInspector(m), logger, "sendToPropertyInspector");

	// The settings the action already has; a PI cannot open without its action having
	// appeared, so an absent entry means something is wrong rather than "not yet".
	const settings = getRememberedActionSettings(ev.action.id);
	const host = settings ? resolveDeviceIp(settings) : undefined;
	if (!host) {
		send({ event: OPTION_NAMES_EVENT, command, label: LABELS[command], error: "no-ip" });
		return true;
	}

	const code = typeof payload.code === "string" ? payload.code : "";
	if (event === SET_EVENT && code) {
		const name = typeof payload.name === "string" ? payload.name : "";
		const stored = setOverride(host, command, code, { name, use: payload.use !== false });
		// The value as stored, not as asked for: a name is clamped and stripped on the
		// way in, and a panel showing something that was never saved is the failure
		// this reply exists to prevent (same reason as pi-wake's).
		send({
			event: "optionNameStored",
			command,
			code,
			custom: stored?.name ?? "",
			use: stored?.use ?? false,
		});
		return true;
	}
	if (event === ADD_EVENT && code) {
		// A code the user picked from the spec dropdown: remember it so its row
		// survives the panel closing, even though the receiver never reported it.
		noteOptionCode(host, command, code);
	}

	const state = optionNameState(host, command);
	const { rows, addable } = buildOptionNames(state, command);
	send({ event: OPTION_NAMES_EVENT, command, label: LABELS[command], host, rows, addable });
	return true;
}
