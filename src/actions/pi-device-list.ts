/**
 * Pure logic behind the Property Inspector "device list" data source.
 *
 * SDK-free on purpose: pi-devices.ts is the thin adapter that parses the PI
 * event, injects the real discovery + global settings, and sends the reply.
 * Everything testable — item building, caching, refresh and fallback — lives
 * here (see tests/pi-device-list.test.ts).
 */

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

/** Build the sdpi-components item list (grouped) from discovered devices. */
export function buildItems(
	devices: Device[],
	opts: { discoveryFailed?: boolean; configuredIp?: string } = {},
): DeviceListItem[] {
	const seen = new Set<string>();
	const children: DeviceListEntry[] = [];
	for (const d of devices) {
		if (seen.has(d.host)) continue;
		seen.add(d.host);
		children.push({ label: d.model ? `${d.model} (${d.host})` : d.host, value: d.host });
	}
	const discoveredCount = children.length;
	// Offer the plugin-wide configured IP (if any) so the dropdown still works
	// when discovery is blocked (e.g. the macOS local-network firewall).
	const configured = opts.configuredIp;
	if (configured && !seen.has(configured)) {
		children.push({ label: `Configured (${configured})`, value: configured });
	}
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
			: "Pre-configured";
	return [
		{ label: groupLabel, children },
		{ label: "Custom IP…", value: "custom" },
	];
}

export interface ResolveDeviceListArgs {
	/** The user explicitly asked to refresh: bypass the cache. */
	isRefresh: boolean;
	/** Clock, injectable for tests (called again after discovery to stamp the cache). */
	now: () => number;
	/** Previous cache state; the caller keeps the returned one for the next call. */
	cache: DeviceCache | undefined;
	/** Plugin-wide configured device IP (global settings), if any. */
	configuredIp?: string | undefined;
	/** Run eISCP broadcast discovery (real: discoverEiscpDevicesStreaming). */
	discover: () => Promise<DiscoverResult>;
}

export interface ResolvedDeviceList {
	items: DeviceListItem[];
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
	const { isRefresh, now, cache, configuredIp, discover } = args;
	// Serve a fresh-enough cache unless the user explicitly asked to refresh.
	if (!isRefresh && cache && now() - cache.at < CACHE_TTL_MS) {
		return { items: buildItems(cache.devices, { configuredIp }), cache, failed: false };
	}
	try {
		const result = await discover();
		const blocked = result.devices.length === 0 && result.errors.length > 0;
		if (blocked) {
			// Keep any previously discovered devices instead of caching emptiness.
			return {
				items: buildItems(cache?.devices ?? [], { discoveryFailed: true, configuredIp }),
				cache,
				failed: true,
				blockedErrors: result.errors,
			};
		}
		const fresh = { at: now(), devices: result.devices };
		return { items: buildItems(result.devices, { configuredIp }), cache: fresh, failed: false };
	} catch (err) {
		return {
			items: buildItems(cache?.devices ?? [], { discoveryFailed: true, configuredIp }),
			cache,
			failed: true,
			error: err,
		};
	}
}
