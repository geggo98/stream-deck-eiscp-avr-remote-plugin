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
} from "./client.ts";
