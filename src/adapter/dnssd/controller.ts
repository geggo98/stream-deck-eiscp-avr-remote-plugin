import type { AddressResult, AirPlayDevice, LookupResult } from "./parser.ts";
import {
  browseAirplayDevices,
  getHostAddresses,
  isDnsSdAvailable,
  lookupDevice,
  type DnsSdOptions,
  type DnsSdResult,
} from "./caller.ts";
import {
  combineDeviceInfo,
  parseBrowseOutput,
  parseGetAddrOutput,
  parseLookupOutput,
  type ParseError,
} from "./parser.ts";

/**
 * Raw intermediate results from the discovery process
 */
export interface DiscoveryIntermediateResults {
  readonly browseRaw: string;
  readonly browseParsed: ReturnType<typeof parseBrowseOutput>;
  readonly lookups: Map<string, { raw: string; parsed: LookupResult }>;
  readonly addresses: Map<
    string,
    { raw: string; parsed: readonly AddressResult[] }
  >;
}

/**
 * Result of a successful discovery operation
 */
export interface DiscoveryResult {
  readonly devices: readonly AirPlayDevice[];
  readonly intermediate: DiscoveryIntermediateResults;
}

/**
 * Result of a discovery operation with possible partial failures
 */
export interface DiscoveryResultWithErrors {
  readonly devices: readonly AirPlayDevice[];
  readonly intermediate: DiscoveryIntermediateResults;
  readonly errors: readonly DiscoveryError[];
}

/**
 * Error that occurred during discovery of a specific device
 */
export interface DiscoveryError {
  readonly instanceName: string;
  readonly stage: "lookup" | "getaddr";
  readonly error: string;
}

/**
 * Options for the discovery process
 */
export interface DiscoveryOptions {
  /**
   * Timeout for each dns-sd command in milliseconds
   * @default 5000
   */
  readonly timeout?: number;
  /**
   * Include intermediate results (raw and parsed output)
   * @default false
   */
  readonly includeIntermediate?: boolean;
  /**
   * Continue on error - if true, collect all devices possible and return errors
   * @default true
   */
  readonly continueOnError?: boolean;
  /**
   * Specific instance names to discover (if empty, discovers all)
   * @default []
   */
  readonly instanceNames?: readonly string[];
}

/**
 * Discovers all AirPlay devices on the local network
 *
 * @param options - Discovery options
 * @returns Promise resolving to discovered devices and optional intermediate results
 * @throws {Error} If dns-sd is not available or discovery fails completely
 */
export async function discoverAirplayDevices(
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const { timeout = 1000, instanceNames = [] } = options;

  if (!isDnsSdAvailable()) {
    throw new Error("dns-sd is only available on macOS");
  }

  const dnsOptions: DnsSdOptions = { timeout };

  // Step 1: Browse for devices
  const browseResult = await browseAirplayDevices(dnsOptions);

  if (browseResult.stderr && !browseResult.stdout) {
    throw new Error(`Browse failed: ${browseResult.stderr}`);
  }

  const browseResults = parseBrowseOutput(browseResult.stdout);

  // Filter instance names if specific ones were requested
  let targetInstanceNames: string[];
  if (instanceNames.length > 0) {
    targetInstanceNames = instanceNames;
  } else {
    // Get unique instance names from browse results (only "add" actions)
    const seen = new Set<string>();
    targetInstanceNames = [];
    for (const result of browseResults) {
      if (result.action === "add" && !seen.has(result.instanceName)) {
        seen.add(result.instanceName);
        targetInstanceNames.push(result.instanceName);
      }
    }
  }

  if (targetInstanceNames.length === 0) {
    return {
      devices: [],
      intermediate: {
        browseRaw: browseResult.stdout,
        browseParsed: browseResults,
        lookups: new Map(),
        addresses: new Map(),
      },
    };
  }

  // Step 2: Resolve each device to get metadata and hostname
  const lookups = new Map<string, { raw: string; parsed: LookupResult }>();
  const addresses = new Map<
    string,
    { raw: string; parsed: readonly AddressResult[] }
  >();

  for (const instanceName of targetInstanceNames) {
    try {
      const lookupResult = await lookupDevice(instanceName, dnsOptions);
      const parsed = parseLookupOutput(lookupResult.stdout);
      lookups.set(instanceName, { raw: lookupResult.stdout, parsed });
    } catch (e) {
      if (options.continueOnError !== false) {
        // Continue to next device on error
        continue;
      }
      throw e;
    }
  }

  // Step 3: Get IP addresses for each successfully resolved device
  for (const [instanceName, lookup] of lookups) {
    try {
      const addrResult = await getHostAddresses(
        lookup.parsed.hostname,
        dnsOptions,
      );
      const parsed = parseGetAddrOutput(addrResult.stdout);
      addresses.set(instanceName, { raw: addrResult.stdout, parsed });
    } catch (e) {
      if (options.continueOnError !== false) {
        // Continue to next device on error
        continue;
      }
      throw e;
    }
  }

  // Step 4: Combine results into device info
  const devices: AirPlayDevice[] = [];
  for (const [instanceName, lookup] of lookups) {
    const addrData = addresses.get(instanceName);
    if (addrData) {
      const device = combineDeviceInfo(lookup.parsed, addrData.parsed);
      devices.push(device);
    }
  }

  return {
    devices,
    intermediate: {
      browseRaw: browseResult.stdout,
      browseParsed: browseResults,
      lookups,
      addresses,
    },
  };
}

/**
 * Discovers AirPlay devices with detailed error reporting
 *
 * @param options - Discovery options
 * @returns Promise resolving to discovered devices, intermediate results, and any errors
 */
export async function discoverAirplayDevicesWithErrorReporting(
  options: DiscoveryOptions = {},
): Promise<DiscoveryResultWithErrors> {
  const {
    timeout = 5000,
    continueOnError = true,
    instanceNames = [],
  } = options;

  if (!isDnsSdAvailable()) {
    throw new Error("dns-sd is only available on macOS");
  }

  const dnsOptions: DnsSdOptions = { timeout };
  const errors: DiscoveryError[] = [];

  // Step 1: Browse for devices
  const browseResult = await browseAirplayDevices(dnsOptions);
  const browseResults = parseBrowseOutput(browseResult.stdout);

  // Filter instance names if specific ones were requested
  let targetInstanceNames: string[];
  if (instanceNames.length > 0) {
    targetInstanceNames = [...instanceNames];
  } else {
    const seen = new Set<string>();
    targetInstanceNames = [];
    for (const result of browseResults) {
      if (result.action === "add" && !seen.has(result.instanceName)) {
        seen.add(result.instanceName);
        targetInstanceNames.push(result.instanceName);
      }
    }
  }

  if (targetInstanceNames.length === 0) {
    return {
      devices: [],
      intermediate: {
        browseRaw: browseResult.stdout,
        browseParsed: browseResults,
        lookups: new Map(),
        addresses: new Map(),
      },
      errors: [],
    };
  }

  // Step 2: Resolve each device to get metadata and hostname
  const lookups = new Map<string, { raw: string; parsed: LookupResult }>();
  const addresses = new Map<
    string,
    { raw: string; parsed: readonly AddressResult[] }
  >();

  for (const instanceName of targetInstanceNames) {
    try {
      const lookupResult = await lookupDevice(instanceName, dnsOptions);
      const parsed = parseLookupOutput(lookupResult.stdout);
      lookups.set(instanceName, { raw: lookupResult.stdout, parsed });
    } catch (e) {
      errors.push({
        instanceName,
        stage: "lookup",
        error: e instanceof Error ? e.message : String(e),
      });
      if (!continueOnError) {
        break;
      }
    }
  }

  // Step 3: Get IP addresses for each successfully resolved device
  for (const [instanceName, lookup] of lookups) {
    try {
      const addrResult = await getHostAddresses(
        lookup.parsed.hostname,
        dnsOptions,
      );
      const parsed = parseGetAddrOutput(addrResult.stdout);
      addresses.set(instanceName, { raw: addrResult.stdout, parsed });
    } catch (e) {
      errors.push({
        instanceName,
        stage: "getaddr",
        error: e instanceof Error ? e.message : String(e),
      });
      if (!continueOnError) {
        break;
      }
    }
  }

  // Step 4: Combine results into device info
  const devices: AirPlayDevice[] = [];
  for (const [instanceName, lookup] of lookups) {
    const addrData = addresses.get(instanceName);
    if (addrData) {
      const device = combineDeviceInfo(lookup.parsed, addrData.parsed);
      devices.push(device);
    }
  }

  return {
    devices,
    intermediate: {
      browseRaw: browseResult.stdout,
      browseParsed: browseResults,
      lookups,
      addresses,
    },
    errors,
  };
}

/**
 * Gets metadata for a single device by instance name
 *
 * @param instanceName - The instance name from browse results
 * @param options - DNS lookup options
 * @returns Promise resolving to the device information
 * @throws {Error} If lookup fails
 */
export async function getDevice(
  instanceName: string,
  options: DnsSdOptions = {},
): Promise<AirPlayDevice> {
  if (!isDnsSdAvailable()) {
    throw new Error("dns-sd is only available on macOS");
  }

  // Lookup the device
  const lookupResult = await lookupDevice(instanceName, options);
  const parsed = parseLookupOutput(lookupResult.stdout);

  // Get addresses
  const addrResult = await getHostAddresses(parsed.hostname, options);
  const addrParsed = parseGetAddrOutput(addrResult.stdout);

  // Combine results
  return combineDeviceInfo(parsed, addrParsed);
}

// Re-export types for convenience
export type { DnsSdOptions, DnsSdResult } from "./caller";
export type {
  AddressResult,
  AirPlayDevice,
  BrowseResult,
  LookupResult,
  ParseError,
  TxtRecord,
} from "./parser";
