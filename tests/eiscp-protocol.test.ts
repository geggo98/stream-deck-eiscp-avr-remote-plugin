/**
 * Unit tests for eISCP protocol layer
 *
 * These tests use mock fixtures and don't require a real device.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	encodePacket,
	decodePacket,
	parseIscpMessage,
	createQuery,
	decodeMultiplePackets,
	stripTerminators,
	buildIscpMessage,
	isQuery,
	parseQueryResponse,
} from "../src/adapter/eiscp/protocol.ts";
import {
	InputSource,
	ListeningMode,
	getInputByHex,
	getInputByDecimal,
	getListeningModeByHex,
	getListeningModeByDecimal,
} from "../src/adapter/eiscp/enums.ts";

describe("eISCP protocol layer", () => {
	describe("encodePacket", () => {
		it("should encode a power on command", () => {
			const packet = encodePacket("PWR", "01");
			assert.equal(packet.iscpMessage, "!1PWR01\r");
			assert.ok(packet.bytes.length > 0);
		});

		it("should encode a power off command", () => {
			const packet = encodePacket("PWR", "00");
			assert.equal(packet.iscpMessage, "!1PWR00\r");
		});

		it("should encode a volume command", () => {
			const packet = encodePacket("MVL", "28");
			assert.equal(packet.iscpMessage, "!1MVL28\r");
		});

		it("should encode with custom terminator", () => {
			const packet = encodePacket("PWR", "01", "1", { terminator: "\x0A" });
			assert.equal(packet.iscpMessage, "!1PWR01\n");
		});

		it("should have correct packet structure", () => {
			const packet = encodePacket("PWR", "01");
			const bytes = packet.bytes;

			// Check header
			assert.equal(bytes.subarray(0, 4).toString("ascii"), "ISCP");
			assert.equal(bytes.readUInt32BE(4), 16); // Header size

			// Check data size is correct
			const dataSize = bytes.readUInt32BE(8);
			assert.equal(dataSize, packet.iscpMessage.length);

			// Check ISCP message is after header
			assert.equal(bytes.subarray(16, 16 + dataSize).toString("ascii"), packet.iscpMessage);
		});
	});

	describe("decodePacket", () => {
		it("should decode a self-encoded power on packet", () => {
			const encoded = encodePacket("PWR", "01");
			const packet = decodePacket(encoded.bytes);

			assert.equal(packet.header, "ISCP");
			assert.equal(packet.headerSize, 16);
			assert.equal(packet.message, "!1PWR01\r");
		});

		it("should decode a self-encoded volume packet", () => {
			const encoded = encodePacket("MVL", "28");
			const packet = decodePacket(encoded.bytes);

			assert.equal(packet.message, "!1MVL28\r");
		});

		it("should throw on invalid header", () => {
			const buffer = Buffer.from("INVALID_HEADER_DATA");
			assert.throws(() => decodePacket(buffer));
		});

		it("should throw on packet too short", () => {
			const buffer = Buffer.from("ISCP"); // Only header magic
			assert.throws(() => decodePacket(buffer));
		});

		it("should decode and encode round-trip", () => {
			const commands = [
				["PWR", "01"],
				["PWR", "00"],
				["MVL", "28"],
				["AMT", "TG"],
				["SLI", "10"],
			] as const;

			for (const [cmd, param] of commands) {
				const encoded = encodePacket(cmd, param);
				const decoded = decodePacket(encoded.bytes);
				assert.equal(decoded.message, encoded.iscpMessage);
			}
		});
	});

	describe("parseIscpMessage", () => {
		it("should parse power on message", () => {
			const message = parseIscpMessage("!1PWR01");
			assert.equal(message.unit, "1");
			assert.equal(message.command, "PWR");
			assert.equal(message.parameter, "01");
		});

		it("should parse volume message", () => {
			const message = parseIscpMessage("!1MVL28");
			assert.equal(message.unit, "1");
			assert.equal(message.command, "MVL");
			assert.equal(message.parameter, "28");
		});

		it("should parse message with terminator", () => {
			const message = parseIscpMessage("!1PWR01\r");
			assert.equal(message.command, "PWR");
			assert.equal(message.parameter, "01");
		});

		it("should throw on invalid message format", () => {
			assert.throws(() => parseIscpMessage("INVALID"));
			assert.throws(() => parseIscpMessage("PWR01")); // Missing ! and unit
		});

		it("should throw on message too short", () => {
			assert.throws(() => parseIscpMessage("!1PW"));
		});
	});

	describe("createQuery", () => {
		it("should create a power query", () => {
			const packet = createQuery("PWR");
			assert.equal(packet.iscpMessage, "!1PWRQSTN\r");
		});

		it("should create a volume query", () => {
			const packet = createQuery("MVL");
			assert.equal(packet.iscpMessage, "!1MVLQSTN\r");
		});
	});

	describe("isQuery", () => {
		it("should return true for query messages", () => {
			assert.equal(isQuery("!1PWRQSTN"), true);
			assert.equal(isQuery("!1MVLQSTN\r"), true);
		});

		it("should return false for non-query messages", () => {
			assert.equal(isQuery("!1PWR01"), false);
			assert.equal(isQuery("!1MVL28\r"), false);
		});
	});

	describe("stripTerminators", () => {
		it("should strip CR terminator", () => {
			assert.equal(stripTerminators("!1PWR01\r"), "!1PWR01");
		});

		it("should strip LF terminator", () => {
			assert.equal(stripTerminators("!1PWR01\n"), "!1PWR01");
		});

		it("should strip EOF terminator", () => {
			assert.equal(stripTerminators("!1PWR01\x1A"), "!1PWR01");
		});

		it("should strip multiple terminators", () => {
			assert.equal(stripTerminators("!1PWR01\r\n"), "!1PWR01");
		});

		it("should leave message without terminators unchanged", () => {
			assert.equal(stripTerminators("!1PWR01"), "!1PWR01");
		});
	});

	describe("buildIscpMessage", () => {
		it("should build message with defaults", () => {
			const message = buildIscpMessage("PWR", "01");
			assert.equal(message, "!1PWR01");
		});

		it("should build message with custom unit", () => {
			const message = buildIscpMessage("PWR", "01", "2");
			assert.equal(message, "!2PWR01");
		});
	});

	describe("parseQueryResponse", () => {
		it("should parse parameter from response packet", () => {
			const encoded = encodePacket("PWR", "01");
			const decoded = decodePacket(encoded.bytes);
			const message = parseIscpMessage(decoded.message);
			assert.equal(message.parameter, "01");
		});
	});

	describe("decodeMultiplePackets", () => {
		it("should decode multiple self-encoded packets from buffer", () => {
			const packet1 = encodePacket("AMT", "01");
			const packet2 = encodePacket("MVL", "28");
			const buffer = Buffer.concat([packet1.bytes, packet2.bytes]);
			const packets = decodeMultiplePackets(buffer);

			assert.equal(packets.length, 2);
			assert.equal(packets[0]!.message, "!1AMT01\r");
			assert.equal(packets[1]!.message, "!1MVL28\r");
		});

		it("should handle single packet", () => {
			const encoded = encodePacket("PWR", "01");
			const packets = decodeMultiplePackets(encoded.bytes);

			assert.equal(packets.length, 1);
			assert.equal(packets[0]!.message, "!1PWR01\r");
		});

		it("should return empty array for empty buffer", () => {
			const packets = decodeMultiplePackets(Buffer.alloc(0));
			assert.equal(packets.length, 0);
		});
	});
});

describe("eISCP enums", () => {
	describe("InputSource", () => {
		it("should have BLURAY_DVD input", () => {
			assert.equal(InputSource.BLURAY_DVD.decimal, 16);
			assert.equal(InputSource.BLURAY_DVD.hex, "10");
			assert.equal(InputSource.BLURAY_DVD.name, "BLURAY/DVD");
		});

		it("should have NETWORK input", () => {
			assert.equal(InputSource.NETWORK.decimal, 43);
			assert.equal(InputSource.NETWORK.hex, "2B");
			assert.equal(InputSource.NETWORK.name, "NETWORK");
		});

		it("should have AIRPLAY input", () => {
			assert.equal(InputSource.AIRPLAY.decimal, 45);
			assert.equal(InputSource.AIRPLAY.hex, "2D");
			assert.equal(InputSource.AIRPLAY.name, "AIRPLAY");
		});

		it("should get input by hex", () => {
			const input = getInputByHex("10");
			assert.equal(input?.name, "BLURAY/DVD");
		});

		it("should get input by decimal", () => {
			const input = getInputByDecimal(43);
			assert.equal(input?.name, "NETWORK");
		});

		it("should return undefined for unknown hex", () => {
			const input = getInputByHex("FF");
			assert.equal(input, undefined);
		});

		it("should return undefined for unknown decimal", () => {
			const input = getInputByDecimal(999);
			assert.equal(input, undefined);
		});

		it("should be case insensitive for hex lookup", () => {
			const input1 = getInputByHex("10");
			const input2 = getInputByHex("10");
			const input3 = getInputByHex("10");
			assert.equal(input1?.hex, input2?.hex);
			assert.equal(input2?.hex, input3?.hex);
		});
	});

	describe("ListeningMode", () => {
		it("should have STEREO mode", () => {
			assert.equal(ListeningMode.STEREO.decimal, 0);
			assert.equal(ListeningMode.STEREO.hex, "00");
			assert.equal(ListeningMode.STEREO.name, "Stereo");
		});

		it("should have DIRECT mode", () => {
			assert.equal(ListeningMode.DIRECT.decimal, 1);
			assert.equal(ListeningMode.DIRECT.hex, "01");
			assert.equal(ListeningMode.DIRECT.name, "Direct");
		});

		it("should have THX_CINEMA mode", () => {
			assert.equal(ListeningMode.THX_CINEMA.decimal, 66);
			assert.equal(ListeningMode.THX_CINEMA.hex, "42");
			assert.equal(ListeningMode.THX_CINEMA.name, "THX Cinema");
		});

		it("should get mode by hex", () => {
			const mode = getListeningModeByHex("00");
			assert.equal(mode?.name, "Stereo");
		});

		it("should get mode by decimal", () => {
			const mode = getListeningModeByDecimal(1);
			assert.equal(mode?.name, "Direct");
		});

		it("should return undefined for unknown hex", () => {
			const mode = getListeningModeByHex("FF");
			assert.equal(mode, undefined);
		});

		it("should return undefined for unknown decimal", () => {
			const mode = getListeningModeByDecimal(999);
			assert.equal(mode, undefined);
		});
	});
});
