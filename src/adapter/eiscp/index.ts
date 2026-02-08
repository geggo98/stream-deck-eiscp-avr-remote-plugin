/**
 * eISCP (Ethernet Integra Serial Control Protocol) Adapter
 *
 * This module provides a TypeScript implementation of the eISCP protocol
 * for controlling Onkyo/Pioneer/Integra network receivers over TCP/IP.
 *
 * @example
 * ```ts
 * import { createClient } from './adapter/eiscp';
 *
 * const client = createClient({
 *   host: '10.2.0.32',
 *   port: 60128,
 *   volume: { max: 80, cap: 60, steps: 60 }
 * });
 *
 * await client.connect();
 * await client.powerOn();
 * await client.setVolumePercent(50);
 * await client.setInput('BLURAY_DVD');
 * ```
 */

// Enums and constants
export {
	PowerState,
	MuteState,
	InputSource,
	ListeningMode,
	IscpCommand,
	NetworkService,
	UnitType,
	Terminator,
	PacketHeader,
	type PowerState as PowerStateType,
	type MuteState as MuteStateType,
	type InputSourceKey,
	type InputSourceValue,
	type ListeningModeKey,
	type ListeningModeValue,
	type IscpCommand,
	type NetworkServiceKey,
	type NetworkServiceValue,
	type UnitType as UnitTypeType,
	type Terminator as TerminatorType,
} from "./enums.ts";

export {
	getInputByHex,
	getInputByDecimal,
	getListeningModeByHex,
	getListeningModeByDecimal,
	getNetworkServiceByKey,
} from "./enums.ts";

// Protocol layer (encoding/decoding)
export {
	encodePacket,
	decodePacket,
	parseIscpMessage,
	createQuery,
	parseQueryResponse,
	isQuery,
	stripTerminators,
	buildIscpMessage,
	decodeMultiplePackets,
	type EiscpPacket,
	type IscpMessage,
	type EncodedPacket,
	type EncodingOptions,
} from "./protocol.ts";

// Transport layer (network)
export {
	EiscpTransport,
	ConnectionState,
	createTransport,
	type EiscpTransportOptions,
	type EiscpTransportEvents,
} from "./transport.ts";

// Client (high-level API)
export {
	EiscpClient,
	createClient,
	type ReceiverState,
	type VolumeConfig,
	type EiscpClientOptions,
	type EiscpClientEvents,
	type DecodedMessage,
	type PowerMessage,
	type VolumeMessage,
	type MuteMessage,
	type InputMessage,
	type ListeningModeMessage,
	type AudioEqMessage,
	type DisplayFieldMessage,
	type NetworkServiceMessage,
	type NetworkTrackMessage,
	type UnknownMessage,
} from "./client.ts";

// Discovery (broadcast device discovery)
export {
	EISCP_PORT,
	DEFAULT_DISCOVERY_TIMEOUT,
	DiscoveryUnitType,
	discoverEiscpDevices,
	discoverEiscpDevicesStreaming,
	createEcnQueryPacket,
	parseEcnResponse,
	parseDiscoveryResponse,
	createReceiverInfo,
	getBroadcastInterfaces,
	dumpDiscoveryPackets,
	formatReceiverInfo,
	receiverToJson,
	type DiscoveredReceiver,
	type DiscoveryCapture,
	type DiscoveryOptions,
	type StreamingDiscoveryOptions,
	type DiscoveryResult,
} from "./discover.ts";

// Network Scanner (TCP port scanning)
export {
	PrivateIpRange,
	scanNetwork,
	scanNetworkStreaming,
	getLocalSubnets,
	getSubnetsForRange,
	generateIpsForSubnet,
	checkPort,
	formatScannedDevice,
	scannedDeviceToJson,
	type Subnet,
	type ScannedDevice,
	type ScanProgress,
	type ScanOptions,
	type StreamingScanOptions,
	type ScanResult,
} from "./network-scanner.ts";
