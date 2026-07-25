/**
 * Unit tests for eISCP discovery layer
 *
 * These tests use mock fixtures and don't require a real device.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, mock } from "node:test";
import {
	createEcnQueryPacket,
	parseEcnResponse,
	parseDiscoveryResponse,
	createReceiverInfo,
	formatReceiverInfo,
	receiverToJson,
	dumpDiscoveryPackets,
	DiscoveryUnitType,
	EISCP_PORT,
	DEFAULT_DISCOVERY_TIMEOUT,
	type DiscoveredReceiver,
} from "../src/adapter/eiscp/discover.ts";
import { parseIscpMessage } from "../src/adapter/eiscp/protocol.ts";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("eISCP discovery layer", () => {
	describe("createEcnQueryPacket", () => {
		it("should create Onkyo ECN query packet", () => {
			const packet = createEcnQueryPacket(DiscoveryUnitType.ONKYO);
			assert.equal(packet.iscpMessage, "!1ECNQSTN\r");
		});

		it("should create Pioneer ECN query packet", () => {
			const packet = createEcnQueryPacket(DiscoveryUnitType.PIONEER);
			assert.equal(packet.iscpMessage, "!pECNQSTN\r");
		});

		it("should have correct packet structure for Onkyo", () => {
			const packet = createEcnQueryPacket(DiscoveryUnitType.ONKYO);
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

		it("should have correct packet structure for Pioneer", () => {
			const packet = createEcnQueryPacket(DiscoveryUnitType.PIONEER);
			const bytes = packet.bytes;

			// Check header
			assert.equal(bytes.subarray(0, 4).toString("ascii"), "ISCP");
			assert.equal(bytes.readUInt32BE(4), 16); // Header size

			// Check data size is correct
			const dataSize = bytes.readUInt32BE(8);
			assert.equal(dataSize, packet.iscpMessage.length);
		});
	});

	describe("parseEcnResponse", () => {
		it("should parse VSX-S520D response", () => {
			// ECN response: !1ECNVSX-S520D/60128/DX
			const message = parseIscpMessage("!1ECNVSX-S520D/60128/DX");
			const result = parseEcnResponse(message);

			assert.equal(result.modelName, "VSX-S520D");
			assert.equal(result.iscpPort, 60128);
			assert.equal(result.areaCode, "DX");
			assert.equal(result.identifier, "");
			assert.equal(result.unitType, "1");
		});

		it("should parse TX-NR609 response with identifier", () => {
			// ECN response with identifier: !1ECNTX-NR609/60128/DX0123456789AB
			const message = parseIscpMessage("!1ECNTX-NR609/60128/DX0123456789AB");
			const result = parseEcnResponse(message);

			assert.equal(result.modelName, "TX-NR609");
			assert.equal(result.iscpPort, 60128);
			assert.equal(result.areaCode, "DX");
			assert.equal(result.identifier, "0123456789AB");
			assert.equal(result.unitType, "1");
		});

		it("should parse area and identifier separated by slashes", () => {
			const message = parseIscpMessage("!1ECNVSX-S520D/60128/XX/0009B0F0EE61\x19");
			const result = parseEcnResponse(message);

			assert.equal(result.areaCode, "XX");
			assert.equal(result.identifier, "0009B0F0EE61");
		});

		it("should truncate identifier to 12 characters", () => {
			const message = parseIscpMessage("!1ECNTX-NR609/60128/DX0123456789ABCDEF");
			const result = parseEcnResponse(message);

			assert.equal(result.identifier.length, 12);
			assert.equal(result.identifier, "0123456789AB");
		});

		it("should throw on non-ECN command", () => {
			const message = parseIscpMessage("!1PWR01");
			assert.throws(() => parseEcnResponse(message));
		});

		it("should throw on invalid ECN format", () => {
			const message = parseIscpMessage("!1ECNInvalidFormat");
			assert.throws(() => parseEcnResponse(message));
		});

		it("should throw on invalid port number", () => {
			const message = parseIscpMessage("!1ECNModel/ABC/DX");
			assert.throws(() => parseEcnResponse(message));
		});

		it("rejects ports outside the valid range", () => {
			// parseInt happily yields these; they must not reach device metadata.
			for (const port of ["0", "-5", "99999999", "65536"]) {
				assert.throws(
					() => parseEcnResponse(parseIscpMessage(`!1ECNModel/${port}/DX`)),
					/ISCP port/,
					`port ${port} should be rejected`,
				);
			}
		});

		it("accepts a trailing-garbage port only when the parsed value is in range", () => {
			// parseInt stops at the first non-digit, so this is 60128 — in range,
			// and accepting it keeps us lenient toward padded real-world responses.
			const result = parseEcnResponse(parseIscpMessage("!1ECNModel/60128junk/DX"));
			assert.equal(result.iscpPort, 60128);
		});

		it("caps an over-long model name", () => {
			const long = "M".repeat(500);
			const result = parseEcnResponse(parseIscpMessage(`!1ECN${long}/60128/DX`));
			assert.equal(result.modelName.length, 64);
		});

		it("strips control characters and NUL padding from text fields", () => {
			// Real devices pad the datagram with NULs; a VSX-S520D sends 255 bytes
			// of which ~219 are NUL. ASCII decoding preserves them, so the fields
			// must be sanitised rather than the response rejected.
			const message = parseIscpMessage("!1ECNVSX\x07-520D/60128/XX/0009B0\x00F0EE61\x00\x00\x00");
			const result = parseEcnResponse(message);

			assert.equal(result.modelName, "VSX-520D");
			assert.equal(result.identifier, "0009B0F0EE61");
			assert.ok(
				!/[\x00-\x1f\x7f]/.test(result.modelName + result.identifier + result.areaCode),
				"no control characters may survive",
			);
		});
	});

	describe("parseDiscoveryResponse", () => {
		it("should parse valid discovery response", () => {
			const responseBytes = Buffer.from(
				"ISCP\x00\x00\x00\x10\x00\x00\x00\x18\x01\x00\x00\x00!1ECNVSX-S520D/60128/DX\r",
				"latin1",
			);

			const result = parseDiscoveryResponse(responseBytes, "10.2.0.32", 60128);

			assert.ok(result);
			assert.equal(result!.modelName, "VSX-S520D");
			assert.equal(result!.host, "10.2.0.32");
			assert.equal(result!.port, 60128);
			assert.equal(result!.iscpPort, 60128);
		});

		it("should return null for invalid packet", () => {
			const invalidBytes = Buffer.from("INVALID_PACKET_DATA");
			const result = parseDiscoveryResponse(invalidBytes, "10.2.0.32", 60128);

			assert.equal(result, null);
		});

		it("should return null for non-ECN packet", () => {
			const powerPacket = Buffer.from(
				"ISCP\x00\x00\x00\x10\x00\x00\x00\x08\x01\x00\x00\x00!1PWR01\r",
				"latin1",
			);
			const result = parseDiscoveryResponse(powerPacket, "10.2.0.32", 60128);

			assert.equal(result, null);
		});

		it("should parse fixture capture response", () => {
			const fixturePath = path.join(fixturesDir, "eiscp-discovery-result.json");
			const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
				captures: Array<{ receivedBytes: string; receiver: DiscoveredReceiver }>;
			};

			const capture = fixture.captures[0];
			assert.ok(capture);

			const responseBytes = Buffer.from(capture.receivedBytes, "hex");
			const result = parseDiscoveryResponse(responseBytes, capture.receiver.host, capture.receiver.port);

			assert.ok(result);
			assert.equal(result!.modelName, "VSX-S520D");
			assert.equal(result!.host, capture.receiver.host);
			assert.equal(result!.port, capture.receiver.port);
			assert.equal(result!.areaCode, "XX");
			assert.equal(result!.identifier, "0009B0F0EE61");
		});
	});

	describe("createReceiverInfo", () => {
		it("should create complete receiver info", () => {
			const message = parseIscpMessage("!1ECNVSX-S520D/60128/DX0123456789AB");
			const result = createReceiverInfo("10.2.0.32", 60128, message);

			assert.equal(result.host, "10.2.0.32");
			assert.equal(result.port, 60128);
			assert.equal(result.modelName, "VSX-S520D");
			assert.equal(result.iscpPort, 60128);
			assert.equal(result.areaCode, "DX");
			assert.equal(result.identifier, "0123456789AB");
			assert.equal(result.unitType, "1");
		});
	});

	describe("formatReceiverInfo", () => {
		it("should format receiver info with identifier", () => {
			const receiver: DiscoveredReceiver = {
				host: "10.2.0.32",
				port: 60128,
				modelName: "VSX-S520D",
				iscpPort: 60128,
				areaCode: "DX",
				identifier: "0123456789AB",
				unitType: "1",
				rawMessage: "!1ECNVSX-S520D/60128/DX0123456789AB",
			};

			const formatted = formatReceiverInfo(receiver);
			assert.equal(
				formatted,
				"VSX-S520D [0123456789AB]    10.2.0.32:60128    0123456789AB",
			);
		});

		it("should format receiver info without identifier", () => {
			const receiver: DiscoveredReceiver = {
				host: "10.2.0.32",
				port: 60128,
				modelName: "VSX-S520D",
				iscpPort: 60128,
				areaCode: "DX",
				identifier: "",
				unitType: "1",
				rawMessage: "!1ECNVSX-S520D/60128/DX",
			};

			const formatted = formatReceiverInfo(receiver);
			assert.equal(formatted, "VSX-S520D    10.2.0.32:60128    ");
		});
	});

	describe("receiverToJson", () => {
		it("should convert receiver to JSON object", () => {
			const receiver: DiscoveredReceiver = {
				host: "10.2.0.32",
				port: 60128,
				modelName: "VSX-S520D",
				iscpPort: 60128,
				areaCode: "DX",
				identifier: "0123456789AB",
				unitType: "1",
				rawMessage: "!1ECNVSX-S520D/60128/DX0123456789AB",
			};

			const json = receiverToJson(receiver);

			assert.equal(json.model, "VSX-S520D");
			assert.equal(json.host, "10.2.0.32");
			assert.equal(json.port, 60128);
			assert.equal(json.area, "DX");
			assert.equal(json.identifier, "0123456789AB");
		});
	});

	describe("dumpDiscoveryPackets", () => {
		it("should dump Onkyo discovery packet", () => {
			const packets = dumpDiscoveryPackets();

			assert.ok(packets.onkyoQuery);
			assert.ok(packets.pioneerQuery);
			assert.ok(packets.header);

			// Check header structure
			assert.equal(packets.header.magic, "49534350"); // "ISCP" in hex
			assert.equal(packets.header.headerSize, "00000010"); // 16 in hex
			assert.equal(packets.header.version, "01000000"); // Version bytes
		});

		it("should have different packets for Onkyo and Pioneer", () => {
			const packets = dumpDiscoveryPackets();

			// The packets should differ (unit type '1' vs 'p')
			assert.notEqual(packets.onkyoQuery, packets.pioneerQuery);
		});
	});

	describe("constants", () => {
		it("should have correct EISCP port", () => {
			assert.equal(EISCP_PORT, 60128);
		});

		it("should have reasonable default timeout", () => {
			assert.ok(DEFAULT_DISCOVERY_TIMEOUT > 0);
			assert.equal(DEFAULT_DISCOVERY_TIMEOUT, 5000);
		});
	});

	describe("DiscoveryUnitType", () => {
		it("should have ONKYO type", () => {
			assert.equal(DiscoveryUnitType.ONKYO, "1");
		});

		it("should have PIONEER type", () => {
			assert.equal(DiscoveryUnitType.PIONEER, "p");
		});

		it("should be const object with string values", () => {
			assert.equal(typeof DiscoveryUnitType.ONKYO, "string");
			assert.equal(typeof DiscoveryUnitType.PIONEER, "string");
		});
	});
});
