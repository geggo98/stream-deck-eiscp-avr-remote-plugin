/**
 * Property Inspector "device list" data source.
 *
 * The PI's Device IP `<sdpi-select datasource="getDevices">` asks the plugin for
 * the list of receivers; we answer with the devices found by eISCP broadcast
 * discovery (plus the known default and a "Custom IP…" entry) in the shape
 * sdpi-components expects: { event: "getDevices", items: [...] }.
 *
 * sdpi-select only renders options present at first paint, so a static dropdown
 * built via innerHTML stays empty — the datasource round-trip is how options are
 * delivered (and refreshed, via the select's `hot-reload`).
 */
import { streamDeck, type SendToPluginEvent } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { discoverEiscpDevicesStreaming } from "../adapter/eiscp/discover.ts";
import { DEFAULT_DEVICE_IP, type EiscpActionSettings } from "./eiscp-base.ts";

const logger = streamDeck.logger.createScope("PiDevices");

/** sdpi data-source event name used by the Device IP select. */
export const DEVICE_DATASOURCE = "getDevices";
const DISCOVERY_TIMEOUT_MS = 2500;
/** Serve a recent result so switching between actions doesn't re-broadcast each time. */
const CACHE_TTL_MS = 8000;

interface Device {
	host: string;
	model: string;
}
let cache: { at: number; devices: Device[] } | undefined;

/** Build the sdpi-components item list (grouped) from discovered devices. */
function buildItems(devices: Device[], discoveryFailed = false): JsonValue {
	const seen = new Set<string>();
	const children: JsonValue[] = [];
	for (const d of devices) {
		if (seen.has(d.host)) continue;
		seen.add(d.host);
		children.push({ label: d.model ? `${d.model} (${d.host})` : d.host, value: d.host });
	}
	// Always offer the known default so the dropdown works even if discovery is
	// blocked (e.g. the macOS local-network firewall) or finds nothing.
	if (!seen.has(DEFAULT_DEVICE_IP)) {
		children.push({ label: `Receiver (${DEFAULT_DEVICE_IP})`, value: DEFAULT_DEVICE_IP });
	}
	// Name the failure instead of pretending the fallback was configured on
	// purpose — a blocked broadcast otherwise looks like "no devices in LAN".
	const groupLabel = discoveryFailed
		? "Discovery failed — check Local Network permission"
		: children.length > 1
			? "Discovered"
			: "Pre-configured";
	return [
		{ label: groupLabel, children },
		{ label: "Custom IP…", value: "custom" },
	];
}

/**
 * Handle the Device IP data-source request from any action's PI. Returns true if
 * the message was a getDevices request (so callers can short-circuit).
 */
export async function handleDeviceListMessage<T extends EiscpActionSettings>(
	ev: SendToPluginEvent<JsonValue, T>,
): Promise<boolean> {
	const payload = ev.payload as { event?: string; isRefresh?: boolean } | null;
	if (!payload || typeof payload !== "object" || payload.event !== DEVICE_DATASOURCE) return false;
	const reply = (devices: Device[], discoveryFailed = false) =>
		void streamDeck.ui.sendToPropertyInspector({
			event: DEVICE_DATASOURCE,
			items: buildItems(devices, discoveryFailed),
		});

	// Serve a fresh-enough cache unless the user explicitly asked to refresh.
	if (!payload.isRefresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
		reply(cache.devices);
		return true;
	}
	try {
		const result = await discoverEiscpDevicesStreaming({ timeout: DISCOVERY_TIMEOUT_MS });
		const devices = result.devices.map((d) => ({ host: d.host, model: d.modelName }));
		const blocked = devices.length === 0 && result.errors.length > 0;
		if (blocked) {
			logger.warn(
				`getDevices discovery blocked: ${result.errors.map((e) => `${e.interfaceAddress}: ${e.message}`).join("; ")}`,
			);
			// Keep any previously discovered devices instead of caching emptiness.
			reply(cache?.devices ?? [], true);
			return true;
		}
		cache = { at: Date.now(), devices };
		reply(devices);
	} catch (err) {
		logger.error(`getDevices discovery failed: ${err}`);
		reply(cache?.devices ?? [], true);
	}
	return true;
}
