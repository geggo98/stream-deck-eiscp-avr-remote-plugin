/**
 * eISCP Discovery Layer
 *
 * Implements broadcast discovery for Onkyo/Pioneer/Integra network receivers.
 * Uses UDP broadcast to send ECN (Extended Command for Network) query packets
 * and listens for responses.
 *
 * Discovery protocol:
 * 1. Send ECN query packet via UDP broadcast to port 60128
 * 2. Receivers respond with their model name, port, and identifier
 * 3. Multiple interfaces are supported for comprehensive discovery
 *
 * @example
 * ```ts
 * import { discoverEiscpDevices } from './discover';
 *
 * const devices = await discoverEiscpDevices({ timeout: 5000 });
 * for (const device of devices) {
 *   console.log(`Found ${device.modelName} at ${device.host}:${device.iscpPort}`);
 * }
 * ```
 */

import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { scopedLogger } from "../logging.ts";
import { encodePacket, decodePacket, parseIscpMessage, stripTerminators } from "./protocol.ts";
import type { EncodedPacket, EiscpPacket, IscpMessage } from "./protocol.ts";

const logger = scopedLogger("EiscpDiscovery");

/**
 * Default eISCP port for receivers
 */
export const EISCP_PORT = 60128;

/**
 * Discovery timeout in milliseconds (default)
 */
export const DEFAULT_DISCOVERY_TIMEOUT = 5000;

/**
 * Unit types for discovery queries
 */
export const DiscoveryUnitType = {
	/** Onkyo/Integra receivers */
	ONKYO: "1",
	/** Pioneer receivers */
	PIONEER: "p",
} as const;

export type DiscoveryUnitType = (typeof DiscoveryUnitType)[keyof typeof DiscoveryUnitType];

/**
 * Represents a discovered eISCP receiver
 */
export interface DiscoveredReceiver {
	/** Hostname or IP address */
	host: string;
	/** UDP source port of the discovery response (not the eISCP port; see iscpPort) */
	port: number;
	/** Model name (e.g., "VSX-S520D", "TX-NR609") */
	modelName: string;
	/** ISCP port */
	iscpPort: number;
	/** Area code (e.g., "DX") */
	areaCode: string;
	/** Unique identifier (12 characters max) */
	identifier: string;
	/** Unit type from response (usually "1" for receiver) */
	unitType: string;
	/** Raw ISCP message */
	rawMessage: string;
}

/**
 * Raw captured discovery data for test fixtures
 */
export interface DiscoveryCapture {
	/** Timestamp of capture */
	timestamp: string;
	/** Local interface address */
	interfaceAddress: string;
	/** Broadcast address */
	broadcastAddress: string;
	/** Sent discovery packet (hex string); only the first query packet is recorded */
	sentPacket: string;
	/** Received raw bytes (hex string) */
	receivedBytes: string;
	/** Parsed receiver info */
	receiver: DiscoveredReceiver;
}

/**
 * Options for eISCP discovery
 */
export interface EiscpDiscoveryOptions {
	/** Timeout in milliseconds (default: 5000) */
	timeout?: number;
	/** Specific local address to bind to (default: all interfaces) */
	bindAddress?: string;
	/** Specific broadcast address (default: calculated from interface) */
	broadcastAddress?: string;
	/** Unit types to query (default: both Onkyo and Pioneer) */
	unitTypes?: DiscoveryUnitType[];
	/** Capture raw data for test fixtures */
	capture?: boolean;
}

/**
 * A socket-level failure during discovery. A firewall block (EPERM,
 * EHOSTUNREACH) looks exactly like "no devices in the LAN" unless these are
 * surfaced — the macOS local-network permission being the prime suspect.
 */
export interface EiscpDiscoveryError {
	/** Local interface address the failing socket was bound to (or tried to bind to) */
	interfaceAddress: string;
	/** Error message */
	message: string;
	/** Node error code (e.g. "EPERM", "EHOSTUNREACH"), if available */
	code?: string;
}

/**
 * Streaming discovery options with callbacks
 */
export interface EiscpStreamingDiscoveryOptions extends EiscpDiscoveryOptions {
	/** Callback when a device is discovered */
	onDevice?: (device: DiscoveredReceiver) => void;
	/** Callback for raw capture data (if capture: true) */
	onCapture?: (capture: DiscoveryCapture) => void;
	/** Callback when a socket error occurs (bind, send, or async socket error) */
	onError?: (error: EiscpDiscoveryError) => void;
}

/**
 * Result of a streaming discovery operation
 */
export interface EiscpDiscoveryResult {
	/** All discovered devices */
	devices: DiscoveredReceiver[];
	/** Captured data (if capture: true) */
	captures: DiscoveryCapture[];
	/** Socket errors encountered; non-empty + no devices ⇒ discovery was likely blocked */
	errors: EiscpDiscoveryError[];
}

/**
 * Parse the ECN response from a receiver
 *
 * ECN response format: !1ECN<model>/<port>/<area><identifier> (3 segments,
 * identifier appended to the 2-char area code) or
 * !1ECN<model>/<port>/<area>/<identifier> (4 segments); both are handled.
 *
 * Example: !1ECNTX-NR609/60128/DX or !1ECNVSX-S520D/60128/DX0123456789AB
 *
 * @param message - Parsed ISCP message
 * @returns Parsed receiver info
 * @throws Error if format is invalid
 */
export function parseEcnResponse(message: IscpMessage): Omit<DiscoveredReceiver, "host" | "port"> {
	if (message.command !== "ECN") {
		throw new Error(`Not an ECN response: command is ${message.command}, expected ECN`);
	}

	// ECN parameter format: model/port/area_identifier
	// Area code is always 2 characters, identifier follows directly (optional, up to 12 chars)
	// Example: TX-NR609/60128/DX or TX-NR609/60128/DX0123456789AB
	const parts = message.parameter.split("/");
	if (parts.length < 3) {
		throw new Error(`Invalid ECN format: ${message.parameter} (expected model/port/area[identifier])`);
	}

	const modelName = parts[0]!;
	const iscpPortStr = parts[1]!;
	const areaAndIdentifier = parts[2]!;

	// Some devices send area and identifier as separate path segments.
	let areaCode = "";
	let identifier = "";
	if (parts.length >= 4 && areaAndIdentifier.length === 2) {
		areaCode = areaAndIdentifier;
		identifier = parts[3] ?? "";
	} else {
		// Area code is always 2 characters, identifier follows directly (optional).
		areaCode = areaAndIdentifier.substring(0, 2);
		identifier = areaAndIdentifier.substring(2);
	}
	identifier = stripTerminators(identifier);

	const iscpPort = Number.parseInt(iscpPortStr, 10);
	if (Number.isNaN(iscpPort)) {
		throw new Error(`Invalid ISCP port: ${iscpPortStr}`);
	}

	return {
		modelName,
		iscpPort,
		areaCode,
		identifier: identifier.substring(0, 12), // Max 12 characters
		unitType: message.unit,
		rawMessage: message.raw,
	};
}

/**
 * Create an ECN query packet for device discovery
 *
 * @param unitType - Unit type (default: "1" for Onkyo receivers)
 * @returns Encoded eISCP packet
 */
export function createEcnQueryPacket(unitType: string = DiscoveryUnitType.ONKYO): EncodedPacket {
	// ECNQSTN = ECN command with QSTN parameter (query)
	return encodePacket("ECN", "QSTN", unitType);
}

/**
 * Create a receiver info object from discovery data
 *
 * @param host - Remote host address
 * @param port - Remote port
 * @param message - Parsed ISCP message
 * @returns Complete receiver info
 */
export function createReceiverInfo(
	host: string,
	port: number,
	message: IscpMessage,
): DiscoveredReceiver {
	const ecnData = parseEcnResponse(message);
	return {
		host,
		port,
		...ecnData,
	};
}

/**
 * Parse an eISCP discovery response packet
 *
 * @param bytes - Raw received bytes
 * @param remoteAddress - Sender's address
 * @param remotePort - Sender's port
 * @returns Parsed receiver info or null if invalid
 */
export function parseDiscoveryResponse(
	bytes: Buffer,
	remoteAddress: string,
	remotePort: number,
): DiscoveredReceiver | null {
	try {
		const packet = decodePacket(bytes);
		const message = parseIscpMessage(packet.message);
		return createReceiverInfo(remoteAddress, remotePort, message);
	} catch {
		// Silently ignore invalid packets (could be other UDP traffic)
		return null;
	}
}

/**
 * Calculate broadcast address from IP address and netmask
 *
 * @param address - IPv4 address (e.g., "10.2.0.106")
 * @param netmask - IPv4 netmask (e.g., "255.255.255.0")
 * @returns Broadcast address
 */
function calculateBroadcastAddress(address: string, netmask: string): string {
	const addrParts = address.split(".").map(Number);
	const maskParts = netmask.split(".").map(Number);

	if (addrParts.length !== 4 || maskParts.length !== 4) {
		throw new Error(`Invalid IP address or netmask: ${address}/${netmask}`);
	}

	const broadcastParts: number[] = [];
	for (let i = 0; i < 4; i++) {
		const addrByte = addrParts[i]!;
		const maskByte = maskParts[i]!;
		// Broadcast = (IP & netmask) | (~netmask)
		broadcastParts.push((addrByte & maskByte) | (~maskByte & 0xff));
	}

	return broadcastParts.join(".");
}

/**
 * Get network interfaces for broadcast discovery
 *
 * Returns a list of interfaces with IPv4 addresses and broadcast addresses.
 *
 * @returns Array of interface info
 */
export function getBroadcastInterfaces(): Array<{
	address: string;
	netmask: string;
	broadcast?: string;
	family: string;
}> {
	const interfaces = networkInterfaces();
	const results: Array<{
		address: string;
		netmask: string;
		broadcast?: string;
		family: string;
	}> = [];

	for (const [name, infos] of Object.entries(interfaces)) {
		if (!infos) continue;
		for (const info of infos) {
			// Only IPv4 interfaces with broadcast capability
			if (info.family === "IPv4" && !info.internal) {
				// Node does not expose a broadcast address on interface entries,
				// so derive it from the address and netmask.
				const broadcast = calculateBroadcastAddress(info.address, info.netmask);

				results.push({
					address: info.address,
					netmask: info.netmask,
					broadcast,
					family: info.family,
				});
			}
		}
	}

	return results;
}

/**
 * Perform eISCP discovery with streaming results
 *
 * Sends ECN query packets via UDP broadcast and collects responses.
 * Devices are reported as they are discovered via the onDevice callback.
 *
 * @param options - Discovery options
 * @returns Discovery result with all devices and captures
 */
export async function discoverEiscpDevicesStreaming(
	options: EiscpStreamingDiscoveryOptions = {},
): Promise<EiscpDiscoveryResult> {
	const {
		timeout = DEFAULT_DISCOVERY_TIMEOUT,
		bindAddress,
		broadcastAddress,
		unitTypes = [DiscoveryUnitType.ONKYO, DiscoveryUnitType.PIONEER],
		capture = false,
		onDevice,
		onCapture,
		onError,
	} = options;

	const devices = new Map<string, DiscoveredReceiver>();
	const captures: DiscoveryCapture[] = [];
	const errors: EiscpDiscoveryError[] = [];
	const sockets: dgram.Socket[] = [];

	const recordError = (interfaceAddress: string, err: Error) => {
		const error: EiscpDiscoveryError = {
			interfaceAddress,
			message: err.message,
			code: (err as NodeJS.ErrnoException).code,
		};
		errors.push(error);
		logger.warn(`discovery socket error on ${interfaceAddress}: ${err.message}`);
		onError?.(error);
	};

	try {
		// Get interfaces for broadcast
		const interfaces = getBroadcastInterfaces();

		if (interfaces.length === 0) {
			throw new Error("No network interfaces available for broadcast discovery");
		}

		// Create discovery packets for each unit type
		const discoveryPackets = unitTypes.map((unitType) => ({
			unitType,
			packet: createEcnQueryPacket(unitType),
		}));

		// Create a socket for each interface. One failing interface must not
		// abort discovery on the remaining ones.
		for (const iface of interfaces) {
			const socket = dgram.createSocket("udp4");
			let bound = false;

			try {
				await new Promise<void>((resolve, reject) => {
					socket.on("error", (err) => {
						if (!bound) {
							reject(err);
							return;
						}
						// After bind the promise is settled; without this the
						// error would vanish into a no-op reject.
						recordError(iface.address, err);
					});

					socket.on("message", (msg: Buffer, rinfo: { address: string; port: number }) => {
						const receiver = parseDiscoveryResponse(msg, rinfo.address, rinfo.port);

						if (receiver) {
							// Dedupe on identifier + host: the same device answering on
							// several interfaces intentionally yields one entry per host.
							const key = `${receiver.identifier}-${receiver.host}`;

							if (!devices.has(key)) {
								devices.set(key, receiver);
								onDevice?.(receiver);
							}

							// Capture raw data if requested
							if (capture) {
								const captureData: DiscoveryCapture = {
									timestamp: new Date().toISOString(),
									interfaceAddress: iface.address,
									broadcastAddress: iface.broadcast || "N/A",
									sentPacket: discoveryPackets[0]!.packet.bytes.toString("hex"),
									receivedBytes: msg.toString("hex"),
									receiver,
								};
								captures.push(captureData);
								onCapture?.(captureData);
							}
						}
					});

					// Bind to specific interface if provided
					const bindAddr = bindAddress || iface.address;
					socket.bind({ port: 0, address: bindAddr }, () => {
						socket.setBroadcast(true);
						bound = true;
						resolve();
					});
				});
			} catch (err) {
				recordError(iface.address, err instanceof Error ? err : new Error(String(err)));
				try {
					socket.close();
				} catch {
					// Ignore close errors
				}
				continue;
			}

			sockets.push(socket);

			// Send discovery packets to broadcast address
			const broadcastAddr = broadcastAddress || iface.broadcast;

			if (broadcastAddr) {
				for (const { packet } of discoveryPackets) {
					socket.send(packet.bytes as Uint8Array<ArrayBufferLike>, EISCP_PORT, broadcastAddr, (err) => {
						// A firewall block (EPERM) surfaces here, not as an
						// exception — without this callback it is silent.
						if (err) {
							recordError(iface.address, err);
						}
					});
				}
			}
		}

		// Wait for responses
		await new Promise<void>((resolve) => {
			setTimeout(resolve, timeout);
		});

		return {
			devices: Array.from(devices.values()),
			captures,
			errors,
		};
	} finally {
		// Close all sockets
		for (const socket of sockets) {
			try {
				socket.close();
			} catch {
				// Ignore close errors
			}
		}
	}
}

/**
 * Perform eISCP discovery
 *
 * Simple wrapper that returns all discovered devices after timeout.
 *
 * @param options - Discovery options
 * @returns Array of discovered receivers
 */
export async function discoverEiscpDevices(options: EiscpDiscoveryOptions = {}): Promise<DiscoveredReceiver[]> {
	const result = await discoverEiscpDevicesStreaming(options);
	return result.devices;
}

/**
 * Dump discovery request and response as hex strings
 *
 * Useful for capturing test fixtures.
 *
 * @returns Object with hex strings of discovery packets
 */
export function dumpDiscoveryPackets(): {
	onkyoQuery: string;
	pioneerQuery: string;
	header: {
		magic: string;
		headerSize: string;
		dataSize: string;
		version: string;
	};
} {
	const onkyoPacket = createEcnQueryPacket(DiscoveryUnitType.ONKYO);
	const pioneerPacket = createEcnQueryPacket(DiscoveryUnitType.PIONEER);

	const bytes = onkyoPacket.bytes;

	return {
		onkyoQuery: bytes.toString("hex"),
		pioneerQuery: pioneerPacket.bytes.toString("hex"),
		header: {
			magic: bytes.subarray(0, 4).toString("hex"),
			headerSize: bytes.subarray(4, 8).toString("hex"),
			dataSize: bytes.subarray(8, 12).toString("hex"),
			version: bytes.subarray(12, 16).toString("hex"),
		},
	};
}

/**
 * Format receiver info for display
 *
 * @param receiver - Discovered receiver
 * @returns Formatted string
 */
export function formatReceiverInfo(receiver: DiscoveredReceiver): string {
	const id = receiver.identifier ? ` [${receiver.identifier}]` : "";
	return `${receiver.modelName}${id}    ${receiver.host}:${receiver.iscpPort}    ${receiver.identifier}`;
}

/**
 * Format receiver info as JSON object
 *
 * @param receiver - Discovered receiver
 * @returns JSON-friendly object
 */
export function receiverToJson(receiver: DiscoveredReceiver): Record<string, unknown> {
	return {
		model: receiver.modelName,
		host: receiver.host,
		port: receiver.iscpPort,
		area: receiver.areaCode,
		identifier: receiver.identifier,
	};
}
