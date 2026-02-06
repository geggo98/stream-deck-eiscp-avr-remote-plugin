/**
 * eISCP Protocol Layer
 *
 * Handles encoding and decoding of eISCP packets.
 * This layer is independent of network transport and can be tested without a real device.
 *
 * Packet structure:
 * - ISCP header (4 bytes): "ISCP"
 * - Header size (4 bytes): 0x00000010 (16)
 * - Data size (4 bytes): ISCP message length (big-endian)
 * - Version (4 bytes): 0x01000000
 * - ISCP message (variable): !1CCCPP...
 * - Terminator (1 byte): 0x0D (CR)
 */

import { PacketHeader, Terminator, type Terminator as TerminatorType } from "./enums.ts";

/**
 * Represents a parsed eISCP packet
 */
export interface EiscpPacket {
	header: string;
	headerSize: number;
	dataSize: number;
	version: Buffer;
	message: string;
	rawMessage: Buffer; // Raw ISCP message bytes (without terminator)
}

/**
 * Represents a parsed ISCP message
 */
export interface IscpMessage {
	unit: string;
	command: string;
	parameter: string;
	raw: string; // Full message including ! prefix
}

/**
 * Represents an encoded eISCP packet ready to send
 */
export interface EncodedPacket {
	bytes: Buffer;
	iscpMessage: string;
}

/**
 * Configuration for packet encoding
 */
export interface EncodingOptions {
	terminator?: TerminatorType;
}

/**
 * Default encoding options
 */
const DEFAULT_ENCODING_OPTIONS: EncodingOptions = {
	terminator: PacketHeader.DEFAULT_TERMINATOR as TerminatorType,
};

/**
 * Encode an ISCP message into an eISCP packet
 *
 * @param command - 3-character ISCP command (e.g., "PWR")
 * @param parameter - Parameter value (e.g., "01", "QSTN")
 * @param unit - Unit type (default: "1" for receiver)
 * @param options - Encoding options
 * @returns Encoded packet with bytes and ISCP message
 */
export function encodePacket(
	command: string,
	parameter: string,
	unit: string = "1",
	options: EncodingOptions = DEFAULT_ENCODING_OPTIONS,
): EncodedPacket {
	const terminator = options.terminator ?? PacketHeader.DEFAULT_TERMINATOR;

	// Build ISCP message: !1CCCPP<terminator>
	const iscpMessage = `!${unit}${command}${parameter}${terminator}`;
	const iscpMessageBuffer = Buffer.from(iscpMessage, "ascii");

	// Build eISCP header (16 bytes)
	const header = Buffer.alloc(PacketHeader.HEADER_SIZE);

	// Magic: ISCP (4 bytes)
	header.write(PacketHeader.MAGIC, 0, "ascii");

	// Header size: 16 (4 bytes, big-endian)
	header.writeUInt32BE(PacketHeader.HEADER_SIZE, 4);

	// Data size: message length (4 bytes, big-endian)
	header.writeUInt32BE(iscpMessageBuffer.length, 8);

	// Version: 0x01 followed by reserved bytes
	const versionBuffer = Buffer.from(PacketHeader.VERSION, "latin1");
	versionBuffer.copy(header, 12);

	// Combine header and message
	const packet = Buffer.concat([header, iscpMessageBuffer]);

	return {
		bytes: packet,
		iscpMessage,
	};
}

/**
 * Decode an eISCP packet buffer
 *
 * @param buffer - Raw packet buffer
 * @returns Parsed eISCP packet
 * @throws Error if packet is invalid
 */
export function decodePacket(buffer: Buffer): EiscpPacket {
	if (buffer.length < PacketHeader.HEADER_SIZE) {
		throw new Error(
			`Packet too short: ${buffer.length} bytes (minimum ${PacketHeader.HEADER_SIZE})`,
		);
	}

	// Parse header
	const header = buffer.subarray(0, 4).toString("ascii");
	if (header !== PacketHeader.MAGIC) {
		throw new Error(`Invalid packet header: ${header} (expected ${PacketHeader.MAGIC})`);
	}

	const headerSize = buffer.readUInt32BE(4);
	if (headerSize !== PacketHeader.HEADER_SIZE) {
		throw new Error(`Unexpected header size: ${headerSize} (expected ${PacketHeader.HEADER_SIZE})`);
	}

	const dataSize = buffer.readUInt32BE(8);
	const version = buffer.subarray(12, 16);

	// Validate buffer size
	if (buffer.length < PacketHeader.HEADER_SIZE + dataSize) {
		throw new Error(
			`Buffer too short for data size: ${buffer.length} bytes (need ${PacketHeader.HEADER_SIZE + dataSize})`,
		);
	}

	// Extract message (excluding terminator for parsing)
	const rawMessage = buffer.subarray(PacketHeader.HEADER_SIZE, PacketHeader.HEADER_SIZE + dataSize);
	const message = rawMessage.toString("ascii");

	return {
		header,
		headerSize,
		dataSize,
		version,
		message,
		rawMessage,
	};
}

/**
 * Parse an ISCP message into components
 *
 * @param message - ISCP message (e.g., "!1PWR01")
 * @returns Parsed ISCP message
 * @throws Error if message format is invalid
 */
export function parseIscpMessage(message: string): IscpMessage {
	const trimmed = stripTerminators(message.trim());

	if (trimmed.length < 5) {
		throw new Error(`ISCP message too short: ${trimmed}`);
	}

	if (!trimmed.startsWith("!")) {
		throw new Error(`ISCP message must start with '!': ${trimmed}`);
	}

	const unit = trimmed.charAt(1);
	const command = trimmed.substring(2, 5);
	const parameter = trimmed.substring(5);

	if (command.length !== 3) {
		throw new Error(`ISCP command must be 3 characters: ${command}`);
	}

	return {
		unit,
		command,
		parameter,
		raw: trimmed,
	};
}

/**
 * Create a query command for a given ISCP command
 *
 * @param command - 3-character ISCP command (e.g., "PWR")
 * @param unit - Unit type (default: "1")
 * @returns Encoded query packet
 */
export function createQuery(command: string, unit: string = "1"): EncodedPacket {
	return encodePacket(command, "QSTN", unit);
}

/**
 * Parse a response from a query
 *
 * @param packet - eISCP packet from decodePacket()
 * @returns Parameter value from response
 */
export function parseQueryResponse(packet: EiscpPacket): string {
	const message = parseIscpMessage(packet.message);
	return message.parameter;
}

/**
 * Check if a message is a query request (ends with "QSTN")
 *
 * @param message - ISCP message to check
 * @returns true if message is a query
 */
export function isQuery(message: string): boolean {
	// Strip terminators before checking
	const trimmed = stripTerminators(message);
	return trimmed.endsWith("QSTN");
}

/**
 * Strip terminators from a message
 *
 * @param message - Message that may contain terminators
 * @returns Message without terminators
 */
export function stripTerminators(message: string): string {
	return message.replace(/[\x0D\x0A\x1A\x19]+$/g, "");
}

/**
 * Build an ISCP message string without encoding to eISCP packet
 *
 * @param command - 3-character ISCP command
 * @param parameter - Parameter value
 * @param unit - Unit type (default: "1")
 * @returns ISCP message string
 */
export function buildIscpMessage(
	command: string,
	parameter: string,
	unit: string = "1",
): string {
	return `!${unit}${command}${parameter}`;
}

/**
 * Decode a buffer that may contain multiple packets
 *
 * Some responses may contain multiple packets concatenated.
 *
 * @param buffer - Buffer that may contain one or more packets
 * @returns Array of decoded packets
 */
export function decodeMultiplePackets(buffer: Buffer): EiscpPacket[] {
	const packets: EiscpPacket[] = [];
	let offset = 0;

	while (offset < buffer.length) {
		// Need at least header size to read data size
		if (offset + PacketHeader.HEADER_SIZE > buffer.length) {
			break;
		}

		// Validate header magic
		const header = buffer.subarray(offset, offset + 4).toString("ascii");
		if (header !== PacketHeader.MAGIC) {
			throw new Error(`Invalid packet header at offset ${offset}: ${header}`);
		}

		const dataSize = buffer.readUInt32BE(offset + 8);
		const packetSize = PacketHeader.HEADER_SIZE + dataSize;

		// Check if we have the full packet
		if (offset + packetSize > buffer.length) {
			break;
		}

		const packetBuffer = buffer.subarray(offset, offset + packetSize);
		packets.push(decodePacket(packetBuffer));

		offset += packetSize;
	}

	return packets;
}
