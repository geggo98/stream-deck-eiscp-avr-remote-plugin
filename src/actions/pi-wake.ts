/**
 * The Property Inspector's plugin-wide switches.
 *
 * A one-message round trip rather than sdpi-components' `global` attribute, and
 * that is deliberate: a `global`-bound input keeps its own snapshot of the whole
 * settings object and writes all of it back on change. With a Property Inspector
 * left open while the plugin learns option names (the Auto-Discover button is in
 * that very panel), toggling a switch would write a snapshot from before those
 * names existed and silently revert them. Routing the write through a named message
 * puts it in the same serialised funnel as every other writer — see the
 * `updateGlobalSettings` doc comment for the two ways that goes wrong.
 *
 * Reading is safe from either side, so the PI reads the values itself.
 *
 * Table-driven because there is now more than one: a second copy of this handler
 * would be a second place to get the funnel wrong.
 */

import { streamDeck, type SendToPluginEvent } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import {
	coverOverHttpEnabled,
	type EiscpActionSettings,
	fireAndLog,
	setCoverOverHttp,
	setWakeOnPress,
	wakeOnPressEnabled,
} from "./eiscp-base.ts";

const logger = streamDeck.logger.createScope("PiToggles");

/** Message name, shared with ui/eiscp-pi.js. */
export const WAKE_SETTING_EVENT = "setWakeOnPress";
/** Message name, shared with ui/eiscp-pi.js. */
export const COVER_HTTP_SETTING_EVENT = "setCoverOverHttp";

interface GlobalToggle {
	event: string;
	read: () => boolean;
	write: (enabled: boolean) => Promise<void>;
	label: string;
}

const TOGGLES: readonly GlobalToggle[] = [
	{ event: WAKE_SETTING_EVENT, read: wakeOnPressEnabled, write: setWakeOnPress, label: "wake on press" },
	{ event: COVER_HTTP_SETTING_EVENT, read: coverOverHttpEnabled, write: setCoverOverHttp, label: "cover over HTTP" },
];

/**
 * Handle a switch being toggled. Returns true if the message was ours, so the
 * shared onSendToPlugin can stop looking.
 */
export async function handleWakeSettingMessage<T extends EiscpActionSettings>(
	ev: SendToPluginEvent<JsonValue, T>,
): Promise<boolean> {
	const payload = ev.payload as { event?: string; value?: unknown } | null;
	if (!payload || typeof payload !== "object") return false;
	const toggle = TOGGLES.find((t) => t.event === payload.event);
	if (!toggle) return false;

	// The PI is the only sender, but this is still untyped JSON off a socket.
	const enabled = payload.value !== false;
	try {
		await toggle.write(enabled);
		logger.debug(`${toggle.label} -> ${enabled}`);
	} catch (err) {
		logger.error(`could not persist the ${toggle.label} setting: ${err}`);
		// Tell the PI what the value actually is now, so a failed write does not
		// leave the checkbox showing something that was never saved.
		fireAndLog(
			streamDeck.ui.sendToPropertyInspector({ event: toggle.event, value: toggle.read() }),
			logger,
			"sendToPropertyInspector",
		);
	}
	return true;
}
