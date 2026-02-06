/**
 * DNS-SD (mDNS/Bonjour) adapter for discovering AirPlay devices on macOS
 *
 * This module provides a TypeScript interface to macOS's dns-sd command
 * for discovering and resolving AirPlay devices on the local network.
 *
 * @example
 * ```ts
 * import { discoverAirplayDevices, discoverAirplayDevicesStreaming } from './adapter/dnssd';
 *
 * // Non-streaming (wait for timeout)
 * const result = await discoverAirplayDevices({ timeout: 5000 });
 * console.log(`Found ${result.devices.length} devices`);
 *
 * // Streaming (results as they arrive)
 * await discoverAirplayDevicesStreaming({
 *   timeout: 5000,
 *   onDevice: (device) => console.log(`Found: ${device.instanceName}`),
 * });
 * ```
 */

// Caller functions - execute dns-sd commands
export {
	browseAirplayDevices,
	getHostAddresses,
	isDnsSdAvailable,
	lookupDevice,
	type DnsSdOptions,
	type DnsSdResult,
} from "./caller.ts";

// Parser functions - parse dns-sd output
export {
	combineDeviceInfo,
	parseBrowseOutput,
	parseGetAddrOutput,
	parseLookupOutput,
	type AddressResult,
	type AirPlayDevice,
	type BrowseResult,
	type LookupResult,
	type ParseError,
	type TxtRecord,
} from "./parser.ts";

// Controller functions - coordinate the discovery workflow
export {
	discoverAirplayDevices,
	discoverAirplayDevicesWithErrorReporting,
	discoverAirplayDevicesStreaming,
	getDevice,
	type DiscoveryError,
	type DiscoveryIntermediateResults,
	type DiscoveryOptions,
	type DiscoveryResult,
	type DiscoveryResultWithErrors,
	type StreamCallback,
	type StreamDiscoveryEvent,
	type StreamingDiscoveryOptions,
} from "./controller.ts";
