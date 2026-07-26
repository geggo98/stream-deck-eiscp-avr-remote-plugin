/**
 * Property Inspector "device list" data source (SDK adapter).
 *
 * The PI's Device IP `<sdpi-select datasource="getDevices">` asks the plugin for
 * the list of receivers; we answer with the devices found by eISCP broadcast
 * discovery (plus the remembered receiver, the action's own selection and a
 * "Custom IP…" entry) in the shape sdpi-components expects:
 * { event: "getDevices", items: [...] }.
 *
 * The reply is sent **immediately** from what is already known and the discovery
 * runs in the background, pushing the completed list afterwards. Awaiting the
 * 2.5 s broadcast first meant every action added after the cache TTL expired
 * opened its PI on "Scanning the network…" — see planDeviceListReply.
 *
 * The datasource round-trip is used because sdpi-select only picks up
 * <option>s from DOM mutations AFTER the component upgraded (see the
 * sdpi-select notes in CLAUDE.md) — injecting a complete select with options
 * via innerHTML leaves the dropdown empty, and the datasource sidesteps the
 * whole question (plus enables the `hot-reload` push used here).
 *
 * This file only parses the PI event, wires the real discovery/settings/clock
 * into the pure logic in pi-device-list.ts, and sends the reply + log lines.
 */
import { streamDeck, type SendToPluginEvent } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { discoverEiscpDevicesStreaming } from "../adapter/eiscp/discover.ts";
import {
	explicitDeviceIp,
	fireAndLog,
	getCachedGlobalSettings,
	getRememberedActionSettings,
	readLastDevice,
	resolveDeviceIp,
	updateGlobalSettings,
	type EiscpActionSettings,
} from "./eiscp-base.ts";
import {
	buildItems,
	DISCOVERY_TIMEOUT_MS,
	planDeviceListReply,
	resolveDeviceList,
	type Device,
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
 * and the last one to finish won the cache. Callers now await the same run and
 * render its result with their own pinned entries.
 */
let inFlight: Promise<Awaited<ReturnType<typeof resolveDeviceList>>> | undefined;

/** The host the last queued write intends to persist; suppresses repeat writes. */
let intendedHost: string | undefined;

/**
 * Remember the receiver an action is bound to, so a freshly added action can
 * adopt it instead of starting out unconfigured (see deviceIpToAdopt).
 *
 * Fire-and-forget. `updateGlobalSettings` holds the write until the initial load
 * has landed (before that, the snapshot every writer merges over is empty and
 * persisting it drops the learned-name map) and serialises it against
 * name-store's writes.
 */
export function rememberDevice(host: string): void {
	if (host === intendedHost) return;
	intendedHost = host;
	persistLastDevice(host).catch((err) => {
		// Clear the suppression so a later pick retries instead of trusting a
		// memory that was never persisted.
		if (intendedHost === host) intendedHost = undefined;
		logger.error(`could not remember the last device: ${err}`);
	});
}

async function persistLastDevice(host: string): Promise<void> {
	await updateGlobalSettings((current) => {
		const remembered = readLastDevice(current);
		// Prefer a model from the last discovery; otherwise keep the one already
		// remembered for this host rather than downgrading it to a bare IP.
		const model =
			cache?.devices.find((d) => d.host === host)?.model ||
			(remembered?.host === host ? remembered.model : "");
		if (remembered?.host === host && remembered.model === model) return undefined;
		return { ...current, lastDevice: { host, model } };
	});
	logger.debug(`remembered last device ${host}`);
}

/**
 * This action's own current selection.
 *
 * Read from what the action last recorded, never via `ev.action.getSettings()`:
 * that is a WebSocket round-trip whose `didReceiveSettings` reply is delivered to
 * the action's own handler as well, so asking for the settings here would
 * re-enter onDidReceiveSettings and re-bind the action every time a PI opens.
 * `explicitDeviceIp` also applies the same IP validation as the rest of this
 * file — a hand-edited profile must not put an unvalidated string into the
 * dropdown's labels and values.
 */
function selectedDeviceIp<T extends EiscpActionSettings>(ev: SendToPluginEvent<JsonValue, T>): string | undefined {
	const settings = getRememberedActionSettings(ev.action.id);
	return settings ? explicitDeviceIp(settings) : undefined;
}

/**
 * Entries the list must contain regardless of what discovery finds: the
 * remembered receiver, and this action's own current selection (sdpi-select
 * renders a value that is missing from its items as an empty field).
 */
function pinnedDevices<T extends EiscpActionSettings>(ev: SendToPluginEvent<JsonValue, T>): Device[] {
	const pinned: Device[] = [];
	const last = readLastDevice(getCachedGlobalSettings());
	if (last) pinned.push(last);
	// The plugin-wide fallback. Nothing writes it any more, but resolveDeviceIp
	// still honours it, so a profile carrying one from an older build must keep
	// seeing it in the list — it is the address those actions actually use.
	// `resolveDeviceIp({})` is that lookup, validation included.
	const global = resolveDeviceIp({});
	if (global) pinned.push({ host: global, model: "" });
	const selected = selectedDeviceIp(ev);
	if (selected) pinned.push({ host: selected, model: "" });
	return pinned;
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

	// `scanning` rides on the getDevices message rather than travelling as its own
	// event: the select's hot-reload subscriber renders `items` from *any* message
	// with this event name, so a status-only message would blank the dropdown.
	const reply = (items: DeviceListItem[], scanning: boolean): void => {
		fireAndLog(
			streamDeck.ui.sendToPropertyInspector({ event: DEVICE_DATASOURCE, items, scanning }),
			logger,
			"sendToPropertyInspector",
		);
	};

	const pinned = pinnedDevices(ev);
	const plan = planDeviceListReply({
		isRefresh: Boolean(payload.isRefresh),
		now: Date.now,
		cache,
		pinned,
	});
	if (plan.items) reply(plan.items, plan.scan);
	if (!plan.scan) return true;

	// The dropdown shows its "loading" text until a reply arrives, so a request
	// that produces no reply leaves the PI stuck on "Scanning the network…" with no
	// explanation. resolveDeviceList is written not to reject, but this handler
	// must not be the reason the UI hangs — so always answer, even with a minimal
	// list that at least carries the "Custom IP…" escape hatch.
	let items: DeviceListItem[];
	try {
		// Every concurrent caller gets the same scan; only the first starts work.
		inFlight ??= resolveDeviceList({
			isRefresh: Boolean(payload.isRefresh),
			now: Date.now,
			cache,
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

		const result = await inFlight;
		cache = result.cache;
		items = buildItems(result.devices, { discoveryFailed: result.failed, pinned });
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
		items = buildItems([], { discoveryFailed: true, pinned });
	}

	reply(items, false);
	return true;
}
