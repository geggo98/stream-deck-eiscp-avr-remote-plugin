/**
 * DNS-SD (mDNS/Bonjour) adapter for discovering AirPlay devices on macOS
 *
 * This module provides a TypeScript interface to macOS's dns-sd command
 * for discovering and resolving AirPlay devices on the local network.
 *
 * @example
 * ```ts
 * import { discoverAirplayDevices } from './adapter/dnssd';
 *
 * const result = await discoverAirplayDevices({ timeout: 5000 });
 * console.log(`Found ${result.devices.length} devices`);
 * for (const device of result.devices) {
 *   console.log(`- ${device.instanceName} at ${device.ipv4Addresses[0]}`);
 * }
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
	getDevice,
	type DiscoveryError,
	type DiscoveryIntermediateResults,
	type DiscoveryOptions,
	type DiscoveryResult,
	type DiscoveryResultWithErrors,
} from "./controller.ts";
