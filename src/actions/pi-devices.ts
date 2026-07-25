/**
 * Property Inspector "device list" data source (SDK adapter).
 *
 * The PI's Device IP `<sdpi-select datasource="getDevices">` asks the plugin for
 * the list of receivers; we answer with the devices found by eISCP broadcast
 * discovery (plus the globally configured IP, if any, and a "Custom IP…"
 * entry) in the shape sdpi-components expects:
 * { event: "getDevices", items: [...] }.
 *
 * The datasource round-trip is used because sdpi-select only picks up
 * <option>s from DOM mutations AFTER the component upgraded (see the
 * sdpi-select notes in CLAUDE.md) — injecting a complete select with options
 * via innerHTML leaves the dropdown empty, and the datasource sidesteps the
 * whole question (plus enables `hot-reload` refreshes).
 *
 * This file only parses the PI event, wires the real discovery/settings/clock
 * into the pure logic in pi-device-list.ts, and sends the reply + log lines.
 */
import { streamDeck, type SendToPluginEvent } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { discoverEiscpDevicesStreaming } from "../adapter/eiscp/discover.ts";
import { fireAndLog, getCachedGlobalSettings, type EiscpActionSettings } from "./eiscp-base.ts";
import {
	buildItems,
	DISCOVERY_TIMEOUT_MS,
	resolveDeviceList,
	type DeviceCache,
	type DeviceListItem,
} from "./pi-device-list.ts";

const logger = streamDeck.logger.createScope("PiDevices");

/** sdpi data-source event name used by the Device IP select. */
export const DEVICE_DATASOURCE = "getDevices";

let cache: DeviceCache | undefined;

/**
 * The discovery currently running, if any.
 *
 * `isRefresh: true` deliberately bypasses the TTL cache, and the PI can send it
 * as often as it likes (`hot-reload`, or anything with access to the PI). Without
 * sharing the in-flight run, each message started a full broadcast sweep — one
 * UDP socket per interface times four probe packets, for 2.5 s — concurrently,
 * and the last one to finish won the cache. Callers now await the same run.
 */
let inFlight: Promise<Awaited<ReturnType<typeof resolveDeviceList>>> | undefined;

/**
 * Handle the Device IP data-source request from any action's PI. Returns true if
 * the message was a getDevices request (so callers can short-circuit).
 */
export async function handleDeviceListMessage<T extends EiscpActionSettings>(
	ev: SendToPluginEvent<JsonValue, T>,
): Promise<boolean> {
	const payload = ev.payload as { event?: string; isRefresh?: boolean } | null;
	if (!payload || typeof payload !== "object" || payload.event !== DEVICE_DATASOURCE) return false;

	// Every concurrent caller gets the same answer; only the first starts work.
	inFlight ??= resolveDeviceList({
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
	}).finally(() => {
		inFlight = undefined;
	});

	// The dropdown shows its "loading" text until a reply arrives, so a request
	// that produces no reply leaves the PI stuck on "Scanning the network…" with no
	// explanation. resolveDeviceList is written not to reject, but this handler
	// must not be the reason the UI hangs — so always answer, even with a minimal
	// list that at least carries the "Custom IP…" escape hatch.
	let items: DeviceListItem[];
	try {
		const result = await inFlight;
		cache = result.cache;
		items = result.items;
		if (result.blockedErrors) {
			logger.warn(
				`getDevices discovery blocked: ${result.blockedErrors.map((e) => `${e.interfaceAddress}: ${e.message}`).join("; ")}`,
			);
		}
		if (result.error !== undefined) {
			logger.error(`getDevices discovery failed: ${result.error}`);
		}
	} catch (err) {
		logger.error(`getDevices failed unexpectedly, replying with a fallback list: ${err}`);
		items = buildItems([], {
			discoveryFailed: true,
			configuredIp: getCachedGlobalSettings().deviceIp,
		});
	}

	fireAndLog(
		streamDeck.ui.sendToPropertyInspector({ event: DEVICE_DATASOURCE, items }),
		logger,
		"sendToPropertyInspector",
	);
	return true;
}
