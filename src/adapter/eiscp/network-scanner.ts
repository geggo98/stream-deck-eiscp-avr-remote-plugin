/**
 * eISCP Network Scanner
 *
 * Scans local /24 subnets for eISCP devices using TCP port checking.
 * Only checks if the eISCP port (60128) is open, not if the device
 * actually speaks eISCP protocol.
 *
 * Features:
 * - Scans /24 subnets, restricted to the RFC 1918 ranges (10/8, 172.16/12,
 *   192.168/16). Caller-supplied prefixes are validated for shape as well as
 *   range, because they are interpolated into connect targets.
 * - Only scans the /24 the local machine is actually on
 * - Parallel connection checking with configurable concurrency limit
 * - No external dependencies (uses Node.js built-in net module)
 *
 * @example
 * ```ts
 * import { scanNetwork, PrivateIpRange } from './network-scanner';
 *
 * const result = await scanNetwork({
 *   concurrency: 128,
 *   port: 60128,
 *   onProgress: (progress) => console.log(progress)
 * });
 *
 * console.log(`Found ${result.devices.length} devices`);
 * for (const device of result.devices) {
 *   console.log(`  ${device.host}:${device.port}`);
 * }
 * ```
 */

import net from "node:net";
import { networkInterfaces } from "node:os";
import { EISCP_PORT } from "./discover.ts";

/**
 * Private IP range definitions
 */
export const PrivateIpRange = {
	/** Class A: 10.0.0.0/8 */
	CLASS_A: { start: "10.0.0.0", end: "10.255.255.255", prefix: 8 } as const,
	/** Class B: 172.16.0.0/12 */
	CLASS_B: { start: "172.16.0.0", end: "172.31.255.255", prefix: 12 } as const,
	/** Class C: 192.168.0.0/16 */
	CLASS_C: { start: "192.168.0.0", end: "192.168.255.255", prefix: 16 } as const,
} as const;

/**
 * Represents a /24 subnet to scan
 */
export interface Subnet {
	/** Network address (e.g., "10.2.0") */
	network: string;
	/** Subnet mask (always "255.255.255.0" for /24) */
	netmask: string;
	/** Private range this subnet belongs to */
	range: keyof typeof PrivateIpRange;
}

/**
 * Represents a device with an open port
 */
export interface ScannedDevice {
	/** IP address */
	host: string;
	/** Port that was open */
	port: number;
	/** Connection timeout in ms */
	timeout: number;
}

/**
 * Scan progress information
 */
export interface ScanProgress {
	/** Total IPs to scan */
	total: number;
	/** Currently scanned */
	scanned: number;
	/** Devices found so far */
	found: number;
	/** Current IP being scanned */
	currentIp?: string;
	/** Percentage complete */
	percent: number;
}

/**
 * Scan options
 */
export interface ScanOptions {
	/** Port to check (default: 60128) */
	port?: number;
	/** Connection timeout per IP in ms (default: 200) */
	timeout?: number;
	/** Max parallel connections (default: 128) */
	concurrency?: number;
	/** Only scan subnets local machine is on (default: true) */
	localSubnetsOnly?: boolean;
	/** Specific subnets to scan (overrides auto-detection) */
	subnets?: string[];
	/** Progress callback */
	onProgress?: (progress: ScanProgress) => void;
	/** Callback when device is found */
	onDevice?: (device: ScannedDevice) => void;
}

/**
 * Scan result
 */
export interface ScanResult {
	/** Devices with open ports */
	devices: ScannedDevice[];
	/** Total IPs scanned */
	totalScanned: number;
	/** Total IPs in scan range */
	totalIps: number;
	/** Scan duration in ms */
	duration: number;
}

/**
 * Convert IP address to integer
 */
export function ipToInt(ip: string): number {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4) {
		throw new Error(`Invalid IP address: ${ip}`);
	}
	for (const part of parts) {
		if (Number.isNaN(part) || part < 0 || part > 255) {
			throw new Error(`Invalid IP address: ${ip}`);
		}
	}
	return (
		((parts[0]! << 24) |
		(parts[1]! << 16) |
		(parts[2]! << 8) |
		parts[3]!) >>>
		0
	);
}

/**
 * Convert integer to IP address
 */
export function intToIp(int: number): string {
	return `${(int >>> 24) & 0xff}.${(int >>> 16) & 0xff}.${(int >>> 8) & 0xff}.${int & 0xff}`;
}

/**
 * Check if an IP is in a private range
 */
export function isPrivateIp(ip: string): boolean {
	const int = ipToInt(ip);

	// Class A: 10.0.0.0/8
	const classAStart = ipToInt("10.0.0.0");
	const classAEnd = ipToInt("10.255.255.255");
	if (int >= classAStart && int <= classAEnd) {
		return true;
	}

	// Class B: 172.16.0.0/12
	const classBStart = ipToInt("172.16.0.0");
	const classBEnd = ipToInt("172.31.255.255");
	if (int >= classBStart && int <= classBEnd) {
		return true;
	}

	// Class C: 192.168.0.0/16
	const classCStart = ipToInt("192.168.0.0");
	const classCEnd = ipToInt("192.168.255.255");
	if (int >= classCStart && int <= classCEnd) {
		return true;
	}

	return false;
}

/**
 * Which RFC 1918 range an address falls in, or undefined when it is not private.
 *
 * Shares `isPrivateIp`'s bounds rather than re-deriving them from the first
 * octet, which is how public space used to slip through.
 */
export function privateRangeForIp(ip: string): keyof typeof PrivateIpRange | undefined {
	if (!isPrivateIp(ip)) return undefined;
	const int = ipToInt(ip);
	for (const range of ["CLASS_A", "CLASS_B", "CLASS_C"] as const) {
		const { start, end } = PrivateIpRange[range];
		if (int >= ipToInt(start) && int <= ipToInt(end)) return range;
	}
	return undefined;
}

/**
 * Validate a caller-supplied `<a>.<b>.<c>` /24 subnet prefix.
 *
 * `generateIpsForSubnet` interpolates this raw into `${network}.${i}`, so an
 * unvalidated string reached `net.Socket.connect` as a host: a four-octet input
 * became "10.0.0.5.1" and a name-like input ("192.attacker.example") became 254
 * DNS lookups, both outside anything the caller could reasonably have meant.
 *
 * @returns The matching private range.
 * @throws Error when the prefix is malformed or not inside RFC 1918.
 */
export function validateSubnetPrefix(network: string): keyof typeof PrivateIpRange {
	const octets = network.split(".");
	if (octets.length !== 3) {
		throw new Error(`Invalid subnet ${JSON.stringify(network)}: expected three octets, e.g. "192.168.1"`);
	}
	for (const octet of octets) {
		if (!/^\d{1,3}$/.test(octet) || Number(octet) > 255) {
			throw new Error(`Invalid subnet ${JSON.stringify(network)}: ${JSON.stringify(octet)} is not an octet`);
		}
	}
	const range = privateRangeForIp(`${network}.1`);
	if (!range) {
		throw new Error(`Not a private IP subnet: ${network}`);
	}
	return range;
}

/**
 * Get all /24 subnets the local machine is on
 */
export function getLocalSubnets(): Subnet[] {
	const interfaces = networkInterfaces();
	const subnets = new Map<string, Subnet>();

	for (const [, infos] of Object.entries(interfaces)) {
		if (!infos) continue;
		for (const info of infos) {
			if (info.family === "IPv4" && !info.internal) {
				const ip = info.address;

				// Gate on the real RFC 1918 ranges. This used to compare only the first
				// octet, which accepted 172.0-172.15 / 172.32-172.255 and
				// 192.0-192.167 / 192.169-192.255 — public address space, including
				// TEST-NET-1 (192.0.2.0/24) — as "private". The netmask feeding this is
				// DHCP-supplied, i.e. attacker-influenced on a hostile network.
				if (!isPrivateIp(ip)) continue;

				const range = privateRangeForIp(ip);
				if (!range) continue;

				// The host's own /24, not the network base. Masking with the interface
				// netmask first (`ipInt & maskInt & 0xffffff00`) produced the *network*
				// /24 for any prefix shorter than /24: a /16 host at 172.20.5.7 yielded
				// 172.20.0.x, scanning a subnet the machine is not on while missing its
				// own.
				const networkParts = ip.split(".").slice(0, 3).join(".");

				subnets.set(networkParts, {
					network: networkParts,
					netmask: "255.255.255.0",
					range,
				});
			}
		}
	}

	return Array.from(subnets.values());
}

/**
 * Get all /24 subnets for a given range
 */
export function getSubnetsForRange(range: keyof typeof PrivateIpRange): Subnet[] {
	const rangeConfig = PrivateIpRange[range];
	const startInt = ipToInt(rangeConfig.start);
	const endInt = ipToInt(rangeConfig.end);
	const subnets: Subnet[] = [];

	// Iterate through /24 subnets
	for (let netInt = startInt; netInt <= endInt; netInt += 0x100) {
		const ip = intToIp(netInt);
		const parts = ip.split(".").slice(0, 3).join(".");

		subnets.push({
			network: parts,
			netmask: "255.255.255.0",
			range,
		});
	}

	return subnets;
}

/**
 * Generate all IP addresses for a subnet
 */
export function generateIpsForSubnet(subnet: Subnet): string[] {
	const ips: string[] = [];
	const { network } = subnet;

	// Generate all host IPs, <network>.1 through <network>.254
	for (let i = 1; i < 255; i++) {
		ips.push(`${network}.${i}`);
	}

	return ips;
}

/**
 * Check if a port is open on a host
 */
export async function checkPort(
	host: string,
	port: number,
	timeout: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = new net.Socket();

		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, timeout);

		socket
			.once("connect", () => {
				clearTimeout(timer);
				socket.destroy();
				resolve(true);
			})
			.once("error", () => {
				clearTimeout(timer);
				socket.destroy();
				resolve(false);
			})
			.setTimeout(timeout, () => {
				clearTimeout(timer);
				socket.destroy();
				resolve(false);
			});

		socket.connect(port, host);
	});
}

/**
 * Parallel limiter for controlling concurrent async operations
 */
class ParallelLimiter {
	private concurrency: number;
	private running = 0;
	private queue: Array<() => void> = [];

	constructor(concurrency: number) {
		this.concurrency = concurrency;
	}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		while (this.running >= this.concurrency) {
			await new Promise<void>((resolve) => this.queue.push(resolve));
		}

		this.running++;
		try {
			return await fn();
		} finally {
			this.running--;
			const next = this.queue.shift();
			if (next) {
				next();
			}
		}
	}
}

/**
 * Scan network for devices with open port
 */
export async function scanNetwork(options: ScanOptions = {}): Promise<ScanResult> {
	const {
		port = EISCP_PORT,
		timeout = 200,
		concurrency = 128,
		localSubnetsOnly = true,
		subnets: specifiedSubnets,
		onProgress,
		onDevice,
	} = options;

	const startTime = Date.now();

	// Determine which subnets to scan
	let subnetsToScan: Subnet[];

	if (specifiedSubnets && specifiedSubnets.length > 0) {
		// Use specified subnets
		subnetsToScan = specifiedSubnets.map((network) => ({
			network,
			netmask: "255.255.255.0",
			// Validates the shape as well as the range: the prefix is interpolated
			// raw into `${network}.${i}`, so a four-octet or name-like input used to
			// become a connect target (or 254 DNS lookups) of its own.
			range: validateSubnetPrefix(network),
		}));
	} else if (localSubnetsOnly) {
		// Only scan local subnets
		subnetsToScan = getLocalSubnets();
	} else {
		// Scan all private subnets
		subnetsToScan = [
			...getSubnetsForRange("CLASS_A"),
			...getSubnetsForRange("CLASS_B"),
			...getSubnetsForRange("CLASS_C"),
		];
	}

	// Generate all IPs to scan
	const allIps: string[] = [];
	for (const subnet of subnetsToScan) {
		allIps.push(...generateIpsForSubnet(subnet));
	}

	const totalIps = allIps.length;
	const devices: ScannedDevice[] = [];
	let scanned = 0;

	const limiter = new ParallelLimiter(concurrency);

	// Scan IPs in parallel with limit
	const results = await Promise.all(
		allIps.map((ip) =>
			limiter.run(async () => {
				const isOpen = await checkPort(ip, port, timeout);

				scanned++;

				if (isOpen) {
					const device: ScannedDevice = {
						host: ip,
						port,
						timeout,
					};
					devices.push(device);
					onDevice?.(device);
				}

				onProgress?.({
					total: totalIps,
					scanned,
					found: devices.length,
					currentIp: ip,
					percent: Math.round((scanned / totalIps) * 100),
				});

				return isOpen;
			}),
		),
	);

	return {
		devices,
		totalScanned: scanned,
		totalIps,
		duration: Date.now() - startTime,
	};
}

/**
 * Streaming scan with callbacks
 */
export interface StreamingScanOptions extends ScanOptions {
	/** Callback when a device is found */
	onDevice?: (device: ScannedDevice) => void;
	/** Callback for progress updates */
	onProgress?: (progress: ScanProgress) => void;
}

/**
 * Scan with streaming results (same as scanNetwork, just alias for API consistency)
 */
export async function scanNetworkStreaming(
	options: StreamingScanOptions = {},
): Promise<ScanResult> {
	return scanNetwork(options);
}

/**
 * Format scanned device for display
 */
export function formatScannedDevice(device: ScannedDevice): string {
	return `${device.host}:${device.port} (timeout: ${device.timeout}ms)`;
}

/**
 * Format device as JSON object
 */
export function scannedDeviceToJson(device: ScannedDevice): Record<string, unknown> {
	return {
		host: device.host,
		port: device.port,
		timeout: device.timeout,
	};
}
