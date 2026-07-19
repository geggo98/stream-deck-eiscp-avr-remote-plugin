/**
 * Property Inspector "device list" data source (SDK adapter).
 *
 * The PI's Device IP `<sdpi-select datasource="getDevices">` asks the plugin for
 * the list of receivers; we answer with the devices found by eISCP broadcast
 * discovery (plus the known default and a "Custom IP…" entry) in the shape
 * sdpi-components expects: { event: "getDevices", items: [...] }.
 *
 * sdpi-select only renders options present at first paint, so a static dropdown
 * built via innerHTML stays empty — the datasource round-trip is how options are
 * delivered (and refreshed, via the select's `hot-reload`).
 *
 * This file only parses the PI event, wires the real discovery/settings/clock
 * into the pure logic in pi-device-list.ts, and sends the reply + log lines.
 */
import { streamDeck, type SendToPluginEvent } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { discoverEiscpDevicesStreaming } from "../adapter/eiscp/discover.ts";
import { fireAndLog, getCachedGlobalSettings, type EiscpActionSettings } from "./eiscp-base.ts";
import { DISCOVERY_TIMEOUT_MS, resolveDeviceList, type DeviceCache } from "./pi-device-list.ts";

const logger = streamDeck.logger.createScope("PiDevices");

/** sdpi data-source event name used by the Device IP select. */
export const DEVICE_DATASOURCE = "getDevices";

let cache: DeviceCache | undefined;

/**
 * Handle the Device IP data-source request from any action's PI. Returns true if
 * the message was a getDevices request (so callers can short-circuit).
 */
export async function handleDeviceListMessage<T extends EiscpActionSettings>(
	ev: SendToPluginEvent<JsonValue, T>,
): Promise<boolean> {
	const payload = ev.payload as { event?: string; isRefresh?: boolean } | null;
	if (!payload || typeof payload !== "object" || payload.event !== DEVICE_DATASOURCE) return false;

	const result = await resolveDeviceList({
		isRefresh: Boolean(payload.isRefresh),
		now: Date.now,
		cache,
		configuredIp: getCachedGlobalSettings().deviceIp,
		discover: async () => {
			const r = await discoverEiscpDevicesStreaming({ timeout: DISCOVERY_TIMEOUT_MS });
			return {
				devices: r.devices.map((d) => ({ host: d.host, model: d.modelName })),
				errors: r.errors,
			};
		},
	});
	cache = result.cache;
	if (result.blockedErrors) {
		logger.warn(
			`getDevices discovery blocked: ${result.blockedErrors.map((e) => `${e.interfaceAddress}: ${e.message}`).join("; ")}`,
		);
	}
	if (result.error !== undefined) {
		logger.error(`getDevices discovery failed: ${result.error}`);
	}
	fireAndLog(
		streamDeck.ui.sendToPropertyInspector({ event: DEVICE_DATASOURCE, items: result.items }),
		logger,
		"sendToPropertyInspector",
	);
	return true;
}
