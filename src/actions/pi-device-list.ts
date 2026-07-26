/**
 * Pure logic behind the Property Inspector "device list" data source.
 *
 * SDK-free on purpose: pi-devices.ts is the thin adapter that parses the PI
 * event, injects the real discovery + global settings, and sends the reply.
 * Everything testable — item building, caching, refresh and fallback — lives
 * here (see tests/pi-device-list.test.ts).
 */
import { isIP } from "node:net";

/** A receiver as offered in the Device IP dropdown. */
export interface Device {
	host: string;
	model: string;
}

/** Last discovery result, kept so switching between actions doesn't re-broadcast each time. */
export interface DeviceCache {
	at: number;
	devices: Device[];
}

/** One broadcast-socket failure from discovery (used for the caller's log line). */
export interface DiscoveryError {
	interfaceAddress: string;
	message: string;
}

/** What the injected discovery yields: found devices plus per-interface errors. */
export interface DiscoverResult {
	devices: Device[];
	errors: DiscoveryError[];
}

/**
 * sdpi-components item shapes: flat entries and one-level groups. Type aliases
 * (not interfaces) so they stay assignable to the SDK's JsonValue.
 */
export type DeviceListEntry = { label: string; value: string; disabled?: boolean };
export type DeviceListItem = DeviceListEntry | { label: string; children: DeviceListEntry[] };

export const DISCOVERY_TIMEOUT_MS = 2500;
/** Serve a recent result so switching between actions doesn't re-broadcast each time. */
export const CACHE_TTL_MS = 8000;

/**
 * Build the sdpi-components item list (grouped) from discovered devices.
 *
 * `pinned` are entries that must appear even though this discovery did not find
 * them: the remembered receiver, and the asking action's own current selection.
 * The latter matters because sdpi-select renders a value that is missing from
 * its items as an empty field — a switched-off receiver would look unconfigured.
 */
export function buildItems(
	devices: Device[],
	opts: { discoveryFailed?: boolean; pinned?: Device[] } = {},
): DeviceListItem[] {
	const seen = new Set<string>();
	const children: DeviceListEntry[] = [];
	const add = (d: Device): void => {
		// Only literal addresses become entries. Discovered hosts are IPs by
		// construction, but pinned ones come from persisted settings that other
		// tooling (or an older build) may have written, and both the label and the
		// value end up in the PI and eventually in socket.connect().
		if (!d.host || isIP(d.host) === 0 || seen.has(d.host)) return;
		seen.add(d.host);
		children.push({ label: d.model ? `${d.model} (${d.host})` : d.host, value: d.host });
	};
	devices.forEach(add);
	const discoveredCount = children.length;
	// Keep the dropdown usable when discovery finds nothing — blocked broadcast
	// (macOS local-network permission), receiver asleep, or simply not scanned yet.
	(opts.pinned ?? []).forEach(add);
	const pinnedCount = children.length - discoveredCount;
	if (children.length === 0) {
		// Keep the group visible (it carries the failure label) but make the
		// placeholder harmless: selecting it leaves the action unconfigured.
		children.push({ label: "(none found)", value: "", disabled: true });
	}
	// Name the failure instead of pretending the fallback was configured on
	// purpose — a blocked broadcast otherwise looks like "no devices in LAN".
	const groupLabel = opts.discoveryFailed
		? "Discovery failed — check Local Network permission"
		: discoveredCount > 0
			? "Discovered"
			: pinnedCount > 0
				? "Last used"
				: "Pre-configured";
	return [
		{ label: groupLabel, children },
		{ label: "Custom IP…", value: "custom" },
	];
}

/** What to answer right now, and whether a discovery still has to run. */
export interface DeviceListPlan {
	/**
	 * Items to send immediately. `undefined` means there is nothing worth
	 * showing yet, so the caller must wait for the scan — the only case where
	 * the dropdown's "Scanning the network…" text is honest. Implies `scan`.
	 */
	items?: DeviceListItem[];
	/** Run discovery (in the background when `items` is set). */
	scan: boolean;
}

/**
 * Stale-while-revalidate for the Device IP dropdown.
 *
 * Waiting for a 2.5 s broadcast before answering meant every action added after
 * the 8 s cache TTL expired — i.e. every real-world one — opened its PI on
 * "Scanning the network…". Anything already known (last discovery, remembered
 * receiver, the action's own selection) is answered instantly instead; the scan
 * then refreshes the list through the select's `hot-reload` push.
 */
export function planDeviceListReply(args: {
	isRefresh: boolean;
	now: () => number;
	cache: DeviceCache | undefined;
	pinned: Device[];
}): DeviceListPlan {
	const { isRefresh, now, cache, pinned } = args;
	const known = cache?.devices ?? [];
	const usable = pinned.filter((d) => d.host);
	const scan = isRefresh || cache === undefined || now() - cache.at >= CACHE_TTL_MS;
	// Nothing to show and a scan on the way: let the loading text stand.
	if (known.length === 0 && usable.length === 0 && scan) return { scan };
	return { items: buildItems(known, { pinned: usable }), scan };
}

export interface ResolveDeviceListArgs {
	/** The user explicitly asked to refresh: bypass the cache. */
	isRefresh: boolean;
	/** Clock, injectable for tests (called again after discovery to stamp the cache). */
	now: () => number;
	/** Previous cache state; the caller keeps the returned one for the next call. */
	cache: DeviceCache | undefined;
	/** Run eISCP broadcast discovery (real: discoverEiscpDevicesStreaming). */
	discover: () => Promise<DiscoverResult>;
}

export interface ResolvedDeviceList {
	/**
	 * The devices to render: the fresh result, or the preserved cache when
	 * discovery was blocked or threw. Rendering is left to the caller (via
	 * buildItems) because each PI pins its own selection into the list, and one
	 * scan is shared between concurrent callers.
	 */
	devices: Device[];
	/** New cache state — the caller must store it for the next call. */
	cache: DeviceCache | undefined;
	/** True when the reply carries the failure group label. */
	failed: boolean;
	/** Interface errors when discovery was blocked (no devices, some errors). */
	blockedErrors?: DiscoveryError[];
	/** The thrown error when discovery itself failed. */
	error?: unknown;
}

/**
 * Decide what the Device IP dropdown shows: serve a fresh-enough cache, else
 * discover; on a blocked or failing discovery fall back to the cached devices
 * with the failure label — and never overwrite the cache with emptiness.
 */
export async function resolveDeviceList(args: ResolveDeviceListArgs): Promise<ResolvedDeviceList> {
	const { isRefresh, now, cache, discover } = args;
	// Serve a fresh-enough cache unless the user explicitly asked to refresh.
	if (!isRefresh && cache && now() - cache.at < CACHE_TTL_MS) {
		return { devices: cache.devices, cache, failed: false };
	}
	try {
		const result = await discover();
		const blocked = result.devices.length === 0 && result.errors.length > 0;
		if (blocked) {
			// Keep any previously discovered devices instead of caching emptiness.
			return {
				devices: cache?.devices ?? [],
				cache,
				failed: true,
				blockedErrors: result.errors,
			};
		}
		const fresh = { at: now(), devices: result.devices };
		return { devices: result.devices, cache: fresh, failed: false };
	} catch (err) {
		return {
			devices: cache?.devices ?? [],
			cache,
			failed: true,
			error: err,
		};
	}
}
