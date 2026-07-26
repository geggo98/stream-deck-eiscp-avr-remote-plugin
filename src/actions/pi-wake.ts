/**
 * The Property Inspector's "wake the receiver on press" switch.
 *
 * A one-message round trip rather than sdpi-components' `global` attribute, and
 * that is deliberate: a `global`-bound input keeps its own snapshot of the whole
 * settings object and writes all of it back on change. With a Property Inspector
 * left open while the plugin learns option names (the Auto-Discover button is in
 * that very panel), toggling the switch would write a snapshot from before those
 * names existed and silently revert them. Routing the write through
 * `setWakeOnPress` puts it in the same serialised funnel as every other writer —
 * see the `updateGlobalSettings` doc comment for the two ways that goes wrong.
 *
 * Reading is safe from either side, so the PI reads the value itself.
 */

import { streamDeck, type SendToPluginEvent } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { type EiscpActionSettings, fireAndLog, setWakeOnPress, wakeOnPressEnabled } from "./eiscp-base.ts";

const logger = streamDeck.logger.createScope("PiWake");

/** Message name, shared with ui/eiscp-pi.js. */
export const WAKE_SETTING_EVENT = "setWakeOnPress";

/**
 * Handle the switch being toggled. Returns true if the message was ours, so the
 * shared onSendToPlugin can stop looking.
 */
export async function handleWakeSettingMessage<T extends EiscpActionSettings>(
	ev: SendToPluginEvent<JsonValue, T>,
): Promise<boolean> {
	const payload = ev.payload as { event?: string; value?: unknown } | null;
	if (!payload || typeof payload !== "object" || payload.event !== WAKE_SETTING_EVENT) return false;
	// The PI is the only sender, but this is still untyped JSON off a socket.
	const enabled = payload.value !== false;
	try {
		await setWakeOnPress(enabled);
		logger.debug(`wake on press -> ${enabled}`);
	} catch (err) {
		logger.error(`could not persist the wake-on-press setting: ${err}`);
		// Tell the PI what the value actually is now, so a failed write does not
		// leave the checkbox showing something that was never saved.
		fireAndLog(
			streamDeck.ui.sendToPropertyInspector({ event: WAKE_SETTING_EVENT, value: wakeOnPressEnabled() }),
			logger,
			"sendToPropertyInspector",
		);
	}
	return true;
}
