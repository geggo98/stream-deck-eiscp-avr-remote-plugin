/**
 * Unified eISCP Device Discovery Controller
 *
 * This module provides a unified interface for discovering eISCP-compatible devices
 * using multiple methods:
 * - DNS-SD (AirPlay devices on macOS) - discovers IPs to try eISCP on
 * - eISCP broadcast discovery (Onkyo/Pioneer receivers)
 * - eISCP network scanning (TCP port scanning)
 *
 * ALL devices are verified via eISCP connection. Only devices that successfully
 * connect via eISCP are returned.
 *
 * @example
 * ```ts
 * import { discoverAllDevicesStreaming } from './adapter/discovery/unified-controller.js';
 *
 * await discoverAllDevicesStreaming({
 *   concurrency: 4,
 *   onDiscovery: (device) => console.log(`Found: ${device.id}`),
 *   onConnect: (result) => console.log(`Connected: ${result.connectedIp}`),
 *   onError: (error) => console.error(`Failed: ${error.deviceId}`),
 * });
 * ```
 */

import {
	discoverAirplayDevicesStreaming,
	type AirPlayDevice,
} from "../dnssd/controller.ts";
import { isDnsSdAvailable } from "../dnssd/caller.ts";
import {
	discoverEiscpDevicesStreaming,
	type DiscoveredReceiver,
	DiscoveryUnitType,
} from "../eiscp/discover.ts";
import {
	scanNetworkStreaming,
	type ScannedDevice,
} from "../eiscp/network-scanner.ts";
import { createClient, type ReceiverState } from "../eiscp/client.ts";
import {
	DeviceTracker,
	primarySource,
	snapshotTracked,
	type DeviceId,
	type DeviceMetadata,
	type DeviceSource,
	type DeviceUpdate,
	type DiscoveredDevice,
} from "./device-tracker.ts";

// The device tracking/merge types live with the DeviceTracker; re-exported
// here so existing importers (index.ts, scripts) keep working unchanged.
export type {
	DeviceSource,
	DeviceId,
	DiscoveredDevice,
	TrackedDevice,
	DeviceUpdateType,
	DeviceUpdate,
	DeviceMetadata,
} from "./device-tracker.ts";

/**
 * eISCP port number
 */
const EISCP_PORT = 60128;

/**
 * Result of a successful eISCP connection
 */
export interface EiscpConnectResult {
	/** Device ID */
	deviceId: DeviceId;
	/** Discovery source */
	source: DeviceSource;
	/** IP that successfully connected via eISCP */
	connectedIp: string;
	/** Device state from eISCP connection */
	deviceInfo: ReceiverState;
	/** Source metadata */
	metadata: DeviceMetadata;
}

/**
 * Error during eISCP connection attempt
 */
export interface EiscpConnectError {
	deviceId: DeviceId;
	ip: string;
	source: DeviceSource;
	error: { message: string; code?: string };
}

/**
 * Options for unified eISCP device discovery
 */
export interface UnifiedDiscoveryOptions {
	/** Max parallel connection attempts (default: 4) */
	concurrency?: number;
	/** Discovery timeout in milliseconds (default: 10000) */
	timeout?: number;
	/** Whether to include eISCP network scanning (default: false) */
	includeNetworkScan?: boolean;
	/** Specific subnets to scan (for network scanning) */
	subnets?: string[];
	/** Callback when a device candidate is discovered */
	onDiscovery?: (device: DiscoveredDevice) => void;
	/** Callback when eISCP connection succeeds */
	onConnect?: (result: EiscpConnectResult) => void;
	/** Callback when eISCP connection fails */
	onError?: (error: EiscpConnectError) => void;
	/** Progress callback for network scanning */
	onScanProgress?: (progress: ScanProgress) => void;
	/** Callback when device state is updated (new IPs, metadata, etc.) */
	onUpdate?: (update: DeviceUpdate) => void;
}

/**
 * Scan progress information
 */
export interface ScanProgress {
	scanned: number;
	total: number;
	percent: number;
	found: number;
	currentIp?: string;
}

/**
 * Result of unified eISCP device discovery
 */
export interface UnifiedDiscoveryResult {
	/** Devices that successfully connected via eISCP */
	connectedDevices: EiscpConnectResult[];
	/** Devices that failed eISCP connection */
	failedDevices: EiscpConnectError[];
	/** Total discovery time in milliseconds */
	duration: number;
}

/**
 * Discover all eISCP-compatible devices using all available methods
 *
 * This runs all discovery methods in parallel, attempts eISCP connection to
 * all discovered IPs, and returns only devices that successfully connect via eISCP.
 *
 * @param options - Discovery options
 * @returns Discovery result with connected and failed devices
 */
export async function discoverAllDevicesStreaming(
	options: UnifiedDiscoveryOptions = {},
): Promise<UnifiedDiscoveryResult> {
	const startTime = Date.now();

	// Default options
	const concurrency = options.concurrency ?? 4;
	const timeout = options.timeout ?? 10000;
	const includeNetworkScan = options.includeNetworkScan ?? false;

	// Merges duplicate sightings from the parallel discovery methods into one
	// device each and emits the incremental updates to the caller.
	const tracker = new DeviceTracker(options.onUpdate);

	// Pending eISCP connection checks by numeric device ID
	const pendingChecks = new Map<number, Promise<EiscpConnectResult | null>>();

	// IPs that have been checked for eISCP connection
	const checkedIps = new Set<string>();

	// Results
	const connectedDevices: EiscpConnectResult[] = [];
	const failedDevices: EiscpConnectError[] = [];

	// Semaphore for connection limiting
	let activeConnections = 0;
	const connectionQueue: Array<() => void> = [];

	/**
	 * Acquire a connection slot
	 */
	function acquireConnection(): Promise<void> {
		if (activeConnections < concurrency) {
			activeConnections++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			connectionQueue.push(resolve);
		});
	}

	/**
	 * Release a connection slot
	 */
	function releaseConnection(): void {
		activeConnections--;
		const next = connectionQueue.shift();
		if (next) {
			activeConnections++;
			next();
		}
	}

	/**
	 * Add a discovered device to tracking
	 */
	function addDiscoveredDevice(device: DiscoveredDevice): void {
		const { deviceId: numericDeviceId } = tracker.addDiscoveredDevice(device);

		// Notify legacy callback
		options.onDiscovery?.(device);

		// Start eISCP connection check if not already pending
		if (!pendingChecks.has(numericDeviceId)) {
			const checkPromise = checkDeviceViaEiscp(numericDeviceId);
			pendingChecks.set(numericDeviceId, checkPromise);

			checkPromise
				.then((result) => {
					if (result) {
						connectedDevices.push(result);
						options.onConnect?.(result);
					}
				})
				.catch((err: unknown) => {
					// checkDeviceViaEiscp reports failures itself and resolves null;
					// this guards future refactors from creating an unhandled rejection.
					console.error(`eISCP check for device ${numericDeviceId} rejected unexpectedly: ${err}`);
				});
		}
	}

	/**
	 * Check a device by trying its IPs sequentially via eISCP
	 */
	async function checkDeviceViaEiscp(numericDeviceId: number): Promise<EiscpConnectResult | null> {
		const tracked = tracker.get(numericDeviceId);
		if (!tracked || tracked.ips.length === 0) {
			// No IPs, report failure
			const errorObj = { message: "No IPs found for device" };
			failedDevices.push({
				deviceId: numericDeviceId,
				ip: "unknown",
				source: primarySource(tracked),
				error: errorObj,
			});
			options.onError?.({
				deviceId: numericDeviceId,
				ip: "unknown",
				source: primarySource(tracked),
				error: errorObj,
			});
			return null;
		}

		// Try each IP sequentially until one works, keeping the real reason
		// each one failed (a firewall EHOSTUNREACH must not be reported as the
		// generic "all IPs failed").
		const ipErrors = new Map<string, { message: string; code?: string }>();
		for (const ip of tracked.ips) {
			// Skip IPv6 addresses for eISCP (most receivers don't support it)
			if (ip.includes(":")) {
				continue;
			}

			if (checkedIps.has(ip)) {
				continue; // Already checked
			}
			checkedIps.add(ip);

			await acquireConnection();
			try {
				const outcome = await checkEiscpAtIp(numericDeviceId, ip);
				if (outcome.ok) {
					return outcome.result;
				}
				ipErrors.set(ip, outcome.error);
			} finally {
				releaseConnection();
			}
		}

		// All IPs failed
		const fallbackError = { message: `All ${tracked.ips.length} IPs failed eISCP connection` };
		// Only report IPv4 addresses as failed (skip IPv6)
		const ipv4Ips = tracked.ips.filter((ip) => !ip.includes(":"));
		for (const ip of ipv4Ips) {
			failedDevices.push({
				deviceId: numericDeviceId,
				ip,
				source: primarySource(tracked),
				error: ipErrors.get(ip) ?? fallbackError,
			});
		}
		if (ipv4Ips.length > 0) {
			options.onError?.({
				deviceId: numericDeviceId,
				ip: ipv4Ips[0]!,
				source: primarySource(tracked),
				error: ipErrors.get(ipv4Ips[0]!) ?? fallbackError,
			});
		}
		return null;
	}

	/**
	 * Check eISCP connection at a specific IP; on failure the real error is
	 * returned so callers can report it instead of a generic message.
	 */
	async function checkEiscpAtIp(
		numericDeviceId: number,
		ip: string,
	): Promise<
		{ ok: true; result: EiscpConnectResult } | { ok: false; error: { message: string; code?: string } }
	> {
		const tracked = tracker.get(numericDeviceId);
		if (!tracked) {
			return { ok: false, error: { message: "Device is no longer tracked" } };
		}

		const client = createClient({
			host: ip,
			port: EISCP_PORT,
			autoQuery: false,
		});

		// Keep an error listener attached for the client's entire lifetime.
		// A transport error during refreshState (plausible for port-60128
		// devices that are not receivers) would otherwise crash the process:
		// connect() delivers its failure via the promise, so this listener
		// only has to swallow the duplicate/late event notifications.
		const onClientError = () => {};
		client.on("error", onClientError);

		try {
			const connectPromise = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					client.disconnect();
					reject(new Error("Connection timeout"));
				}, 5000);

				client.connect()
					.then(() => {
						clearTimeout(timeout);
						resolve();
					})
					.catch((err: unknown) => {
						clearTimeout(timeout);
						client.disconnect();
						reject(err);
					});
			});

			await connectPromise;
			await client.refreshState();
			const state = client.getState();

			// Emit eiscp-connected update
			options.onUpdate?.({
				deviceId: numericDeviceId,
				type: "eiscp-connected",
				changes: {
					source: primarySource(tracked),
				},
				currentState: snapshotTracked(tracked),
			});

			return {
				ok: true,
				result: {
					deviceId: numericDeviceId,
					source: primarySource(tracked),
					connectedIp: ip,
					deviceInfo: state,
					metadata: tracked.metadata,
				},
			};
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			return {
				ok: false,
				error: { message: err.message, code: (err as NodeJS.ErrnoException).code },
			};
		} finally {
			client.disconnect();
			client.off("error", onClientError);
		}
	}

	// Run all discovery methods in parallel
	const discoveryPromises: Promise<unknown>[] = [];

	// 1. AirPlay discovery (macOS only) - discovers IPs to try eISCP on.
	// Gate on platform support instead of swallowing every rejection: an
	// unexpected failure on macOS should be visible, not look like "no devices".
	if (isDnsSdAvailable()) {
		const airplayPromise = discoverAirplayDevicesStreaming({
			timeout,
			continueOnError: true,
			// continueOnError collects per-device/browse failures into the
			// RESULT (no rejection), so without this callback they would
			// vanish — the .catch below only sees unexpected rejections.
			onError: (error) => {
				console.error(`AirPlay discovery error (${error.stage}${error.instanceName ? ` ${error.instanceName}` : ""}): ${error.error}`);
			},
			onDevice: (airplayDevice: AirPlayDevice) => {
				const allIps = [...airplayDevice.ipv4Addresses, ...airplayDevice.ipv6Addresses];
				const device: DiscoveredDevice = {
					id: `airplay-${airplayDevice.hostname}`,
					ips: allIps,
					source: "airplay",
					metadata: {
						airplay: {
							instanceName: airplayDevice.instanceName,
							hostname: airplayDevice.hostname,
							txtRecords: new Map(airplayDevice.txtRecords),
						},
					},
				};
				addDiscoveredDevice(device);
			},
		}).catch((err: unknown) => {
			console.error(`AirPlay discovery failed unexpectedly: ${err}`);
		});

		discoveryPromises.push(airplayPromise);
	}

	// 2. eISCP broadcast discovery
	const eiscpPromise = discoverEiscpDevicesStreaming({
		timeout,
		unitTypes: [DiscoveryUnitType.ONKYO, DiscoveryUnitType.PIONEER],
		onDevice: (eiscpDevice: DiscoveredReceiver) => {
			const device: DiscoveredDevice = {
				id: `eiscp-${eiscpDevice.identifier}`,
				ips: [eiscpDevice.host],
				source: "eiscp-broadcast",
				metadata: {
					eiscpBroadcast: {
						modelName: eiscpDevice.modelName,
						iscpPort: eiscpDevice.iscpPort,
						areaCode: eiscpDevice.areaCode,
						identifier: eiscpDevice.identifier,
						unitType: eiscpDevice.unitType,
						rawMessage: eiscpDevice.rawMessage,
					},
				},
			};
			addDiscoveredDevice(device);
		},
	});

	discoveryPromises.push(eiscpPromise);

	// 3. eISCP network scanning (optional)
	if (includeNetworkScan) {
		const scanPromise = scanNetworkStreaming({
			timeout: 200,
			concurrency: 128,
			localSubnetsOnly: options.subnets === undefined,
			subnets: options.subnets,
			onProgress: (progress) => {
				options.onScanProgress?.({
					scanned: progress.scanned,
					total: progress.total,
					percent: progress.percent,
					found: progress.found,
					currentIp: progress.currentIp,
				});
			},
			onDevice: (scannedDevice: ScannedDevice) => {
				const device: DiscoveredDevice = {
					id: `eiscp-scan-${scannedDevice.host}:${scannedDevice.port}`,
					ips: [scannedDevice.host],
					source: "eiscp-scan",
					metadata: {
						eiscpScan: {
							timeout: scannedDevice.timeout,
						},
					},
				};
				addDiscoveredDevice(device);
			},
		});

		discoveryPromises.push(scanPromise);
	}

	// Wait for all discovery methods to complete
	await Promise.all(discoveryPromises);

	// Wait for all pending connection checks
	await Promise.all(pendingChecks.values());

	return {
		connectedDevices,
		failedDevices,
		duration: Date.now() - startTime,
	};
}

/**
 * Discover all eISCP devices (non-streaming)
 *
 * Convenience method that returns results without callbacks.
 *
 * @param options - Discovery options
 * @returns Discovery result
 */
export async function discoverAllDevices(
	options: Omit<UnifiedDiscoveryOptions, "onDiscovery" | "onConnect" | "onError" | "onScanProgress"> = {},
): Promise<UnifiedDiscoveryResult> {
	return discoverAllDevicesStreaming(options);
}
