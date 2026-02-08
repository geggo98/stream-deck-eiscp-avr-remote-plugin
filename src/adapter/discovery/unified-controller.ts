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
 * import { discoverEiscpDevicesStreaming } from './adapter/discovery/unified-controller.js';
 *
 * await discoverEiscpDevicesStreaming({
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
} from "../dnssd/controller.js";
import {
	discoverEiscpDevicesStreaming,
	type DiscoveredReceiver,
	DiscoveryUnitType,
} from "../eiscp/discover.js";
import {
	scanNetworkStreaming,
	type ScannedDevice,
} from "../eiscp/network-scanner.js";
import { createClient, type ReceiverState } from "../eiscp/client.js";

/**
 * eISCP port number
 */
const EISCP_PORT = 60128;

/**
 * Source of device discovery
 */
export type DeviceSource = "airplay" | "eiscp-broadcast" | "eiscp-scan";

/**
 * Discovered device (before eISCP connection verification)
 */
export interface DiscoveredDevice {
	/** Unique device identifier */
	id: string;
	/** All IP addresses associated with this device */
	ips: string[];
	/** Discovery source */
	source: DeviceSource;
	/** Source-specific metadata */
	metadata: DeviceMetadata;
}

/**
 * Device metadata from discovery
 */
export interface DeviceMetadata {
	/** From AirPlay */
	airplay?: {
		instanceName: string;
		hostname: string;
		txtRecords: Map<string, string>;
	};
	/** From eISCP broadcast */
	eiscpBroadcast?: {
		modelName: string;
		iscpPort: number;
		areaCode: string;
		identifier: string;
		unitType: string;
		rawMessage: string;
	};
	/** From eISCP scan */
	eiscpScan?: {
		timeout: number;
	};
}

/**
 * Result of a successful eISCP connection
 */
export interface EiscpConnectResult {
	/** Device ID */
	deviceId: string;
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
	deviceId: string;
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

	// Tracking maps
	const ipToDevice = new Map<string, DiscoveredDevice>();
	const deviceIdToIps = new Map<string, string[]>();
	const pendingChecks = new Map<string, Promise<EiscpConnectResult | null>>();
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
	 * Generate a unique device ID
	 */
	function generateDeviceId(device: DiscoveredDevice): string {
		// For eISCP broadcast, use the identifier
		if (device.metadata.eiscpBroadcast?.identifier) {
			return `eiscp-${device.metadata.eiscpBroadcast.identifier}`;
		}
		// For AirPlay, use hostname
		if (device.metadata.airplay?.hostname) {
			return `airplay-${device.metadata.airplay.hostname}`;
		}
		// For scan, use IP:port
		return `${device.source}-${device.ips[0]}:${EISCP_PORT}`;
	}

	/**
	 * Add a discovered device to tracking
	 */
	function addDiscoveredDevice(device: DiscoveredDevice): void {
		const deviceId = generateDeviceId(device);

		// Track IPs for this device
		const existingIps = deviceIdToIps.get(deviceId) ?? [];
		const newIps = [...new Set([...existingIps, ...device.ips])];
		deviceIdToIps.set(deviceId, newIps);

		// Update IP to device mapping
		for (const ip of device.ips) {
			if (!ipToDevice.has(ip)) {
				ipToDevice.set(ip, { ...device, ips: newIps });
			}
		}

		// Notify callback
		options.onDiscovery?.(device);

		// Start eISCP connection check if not already pending
		if (!pendingChecks.has(deviceId)) {
			const checkPromise = checkDeviceViaEiscp(deviceId);
			pendingChecks.set(deviceId, checkPromise);

			checkPromise.then((result) => {
				if (result) {
					connectedDevices.push(result);
					options.onConnect?.(result);
				}
			});
		}
	}

	/**
	 * Check a device by trying its IPs sequentially via eISCP
	 */
	async function checkDeviceViaEiscp(deviceId: string): Promise<EiscpConnectResult | null> {
		const ips = deviceIdToIps.get(deviceId);
		if (!ips || ips.length === 0) {
			// No IPs, report failure
			const device = ipToDevice.get(Array.from(ipToDevice.keys())[0]!);
			if (device) {
				const errorObj = { message: "No IPs found for device" };
				failedDevices.push({
					deviceId,
					ip: "unknown",
					source: device.source,
					error: errorObj,
				});
				options.onError?.({
					deviceId,
					ip: "unknown",
					source: device.source,
					error: errorObj,
				});
			}
			return null;
		}

		// Try each IP sequentially until one works
		for (const ip of ips) {
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
				const result = await checkEiscpAtIp(deviceId, ip);
				if (result) {
					releaseConnection();
					return result;
				}
			} finally {
				releaseConnection();
			}
		}

		// All IPs failed
		const device = ipToDevice.get(ips[0]!);
		if (device) {
			const errorObj = { message: `All ${ips.length} IPs failed eISCP connection` };
			// Only report IPv4 addresses as failed (skip IPv6)
			const ipv4Ips = ips.filter((ip) => !ip.includes(":"));
			for (const ip of ipv4Ips) {
				failedDevices.push({
					deviceId,
					ip,
					source: device.source,
					error: errorObj,
				});
			}
			if (ipv4Ips.length > 0) {
				options.onError?.({
					deviceId,
					ip: ipv4Ips[0]!,
					source: device.source,
					error: errorObj,
				});
			}
		}
		return null;
	}

	/**
	 * Check eISCP connection at a specific IP
	 */
	async function checkEiscpAtIp(
		deviceId: string,
		ip: string,
	): Promise<EiscpConnectResult | null> {
		const device = ipToDevice.get(ip);
		if (!device) {
			return null;
		}

		try {
			const client = createClient({
				host: ip,
				port: EISCP_PORT,
				autoQuery: false,
			});

			// Wrap connection attempt in a promise that handles error events
			const connectPromise = new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					client.off("error", onError);
					client.disconnect();
					reject(new Error("Connection timeout"));
				}, 5000);

				const onError = (err: Error) => {
					clearTimeout(timeout);
					client.off("error", onError);
					client.disconnect();
					reject(err);
				};

				client.once("error", onError);

				client.connect()
					.then(() => {
						clearTimeout(timeout);
						client.off("error", onError);
						resolve();
					})
					.catch((err) => {
						clearTimeout(timeout);
						client.off("error", onError);
						client.disconnect();
						reject(err);
					});
			});

			try {
				await connectPromise;
				await client.refreshState();
				const state = client.getState();

				return {
					deviceId,
					source: device.source,
					connectedIp: ip,
					deviceInfo: state,
					metadata: device.metadata,
				};
			} catch (error) {
				// Connection failed, return null
				return null;
			} finally {
				client.disconnect();
			}
		} catch {
			// Exception, return null
			return null;
		}
	}

	// Run all discovery methods in parallel
	const discoveryPromises: Promise<void>[] = [];

	// 1. AirPlay discovery (macOS only) - discovers IPs to try eISCP on
	const airplayPromise = discoverAirplayDevicesStreaming({
		timeout,
		continueOnError: true,
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
		// Ignore errors
	}).catch(() => {}); // Silently ignore if not on macOS

	discoveryPromises.push(airplayPromise);

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
