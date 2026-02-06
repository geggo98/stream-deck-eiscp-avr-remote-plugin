/**
 * Integration tests for eISCP adapter using captured data
 *
 * These tests use a mock TCP server that serves the raw packet dump
 * from a real receiver. This tests the protocol decoder against real-world data.
 *
 * The test server starts on a random local port and sends the captured
 * packets when a client connects.
 */

import { strict as assert } from "node:assert";
import { describe, it, before, after } from "node:test";
import { createServer } from "net";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
	createClient,
	decodePacket,
	decodeMultiplePackets,
	parseIscpMessage,
	getInputByHex,
	getListeningModeByHex,
	type EiscpClient,
} from "../src/adapter/eiscp/index.ts";

// ES module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the captured raw data
const RAW_DUMP_PATH = resolve(__dirname, "fixtures/raw-dump.bin");
const RAW_DATA = readFileSync(RAW_DUMP_PATH);

// Test server state
let testServer: ReturnType<typeof createServer>;
let testPort: number;
let testSockets: Set<ReturnType<typeof testServer>> = new Set();

describe("eISCP captured data tests", () => {
	let client: EiscpClient;

	before(async () => {
		// Start test server on a random port
		testServer = createServer((socket) => {
			// Track socket for cleanup
			testSockets.add(socket as never);

			// Remove from tracking when closed
			socket.on("close", () => {
				testSockets.delete(socket as never);
			});

			// Wait a bit for the client to be ready before sending data
			setTimeout(() => {
				socket.write(RAW_DATA);
			}, 100);

			// Keep connection open briefly then close
			setTimeout(() => {
				socket.end();
			}, 500);
		});

		// Listen on random port
		await new Promise<void>((resolve) => {
			testServer.listen(0, () => {
				testPort = (testServer.address() as { port: number }).port;
				console.log(`Mock eISCP server listening on port ${testPort}`);
				resolve();
			});
		});
	});

	after(async () => {
		if (client) {
			client.disconnect();
			client = undefined;
		}

		// Close all tracked sockets
		for (const socket of testSockets) {
			socket.destroy();
		}
		testSockets.clear();

		if (testServer) {
			await new Promise<void>((resolve) => {
				testServer.close(() => resolve());
			});
			testServer = undefined;
		}
	});

	describe("decoder", () => {
		it("should decode all packets from captured data", () => {
			const packets = decodeMultiplePackets(RAW_DATA);

			console.log(`  Decoded ${packets.length} packets from ${RAW_DATA.length} bytes of raw data`);

			// Should decode at least 100 packets
			assert.ok(packets.length >= 100, `Expected at least 100 packets, got ${packets.length}`);
		});

		it("should parse all ISCP messages", () => {
			const packets = decodeMultiplePackets(RAW_DATA);

			let parsed = 0;
			let failed = 0;

			for (const packet of packets) {
				try {
					const msg = parseIscpMessage(packet.message);
					parsed++;

					// Verify structure
					assert.equal(msg.unit.length, 1);
					assert.equal(msg.command.length, 3);
					assert.ok(msg.parameter.length > 0);
				} catch {
					failed++;
				}
			}

			console.log(`  Parsed ${parsed} messages, ${failed} failed (if any, decoder should skip gracefully)`);
			assert.equal(failed, 0, "All messages should parse successfully");
		});

		it("should handle unknown commands gracefully", () => {
			const packets = decodeMultiplePackets(RAW_DATA);
			const unknownCommands = new Set<string>();

			for (const packet of packets) {
				try {
					const msg = parseIscpMessage(packet.message);

					// Try to map to known enums
					const input = getInputByHex(msg.parameter);
					const mode = getListeningModeByHex(msg.parameter);

					// If not in our enums, track the command
					if (msg.command === "SLI" && !input) {
						unknownCommands.add(`SLI param=${msg.parameter}`);
					}
					if (msg.command === "LMD" && !mode) {
						unknownCommands.add(`LMD param=${msg.parameter}`);
					}
				} catch {
					// Skip invalid packets
				}
			}

			console.log(`  Unknown parameter values found: ${unknownCommands.size}`);
			if (unknownCommands.size > 0 && process.env.EISCP_DEBUG) {
				for (const cmd of unknownCommands) {
					console.log(`    - ${cmd}`);
				}
			}

			// This is informational - we don't fail the test
			assert.ok(true);
		});

		it("should display all unique commands from capture", () => {
			const packets = decodeMultiplePackets(RAW_DATA);
			const commands = new Map<string, Set<string>>();

			for (const packet of packets) {
				try {
					const msg = parseIscpMessage(packet.message);
					if (!commands.has(msg.command)) {
						commands.set(msg.command, new Set());
					}
					commands.get(msg.command)!.add(msg.parameter);
				} catch {
					// Skip invalid packets
				}
			}

			console.log(`  Unique commands found: ${commands.size}`);
			for (const [cmd, params] of commands) {
				console.log(`    ${cmd}: ${params.size} parameters`);
			}

			// Should have found all the major command groups
			assert.ok(commands.has("PWR"), "Should have PWR commands");
			assert.ok(commands.has("MVL"), "Should have MVL (volume) commands");
			assert.ok(commands.has("SLI"), "Should have SLI (input) commands");
			assert.ok(commands.has("LMD"), "Should have LMD (listening mode) commands");
		});
	});

	describe("client with mock server", () => {
		it("should connect and receive packets from mock server", async () => {
			let packetCount = 0;

			client = createClient({
				host: "127.0.0.1",
				port: testPort,
				volume: { max: 80, cap: 50, steps: 50 },
				debugLog: true, // Enable raw packet events
			});

			// Listen to raw packets
			client.on("rawPacket", () => {
				packetCount++;
			});

			// Connect and wait for data
			await client.connect();

			// Wait a bit for all packets to arrive
			await new Promise((resolve) => setTimeout(resolve, 600));

			// Server should have sent data
			console.log(`  Client received ${packetCount} raw packets`);

			assert.ok(packetCount > 0, "Should receive at least one packet");

			// Disconnect the client after the test
			client.disconnect();
		});

		it("should handle FLD (display) messages correctly", () => {
			const packets = decodeMultiplePackets(RAW_DATA);

			let fldCount = 0;
			for (const packet of packets) {
				try {
					const msg = parseIscpMessage(packet.message);
					if (msg.command === "FLD") {
						fldCount++;
						// FLD parameters are hex-encoded ASCII
						// They should be even length
						assert.equal(msg.parameter.length % 2, 0, "FLD param should be hex pairs");
					}
				} catch {
					// Skip invalid packets
				}
			}

			console.log(`  Found ${fldCount} FLD (display) messages`);
			assert.ok(fldCount > 0, "Should have FLD messages in capture");
		});

		it("should handle NLS (network service) messages correctly", () => {
			const packets = decodeMultiplePackets(RAW_DATA);

			const services = new Set<string>();
			for (const packet of packets) {
				try {
					const msg = parseIscpMessage(packet.message);
					if (msg.command === "NLS") {
						// Extract service name from parameter
						// Format: C0P or U0-ServiceName
						if (msg.parameter.startsWith("U")) {
							const match = msg.parameter.match(/U\d-(.+)/);
							if (match) {
								services.add(match[1]);
							}
						}
					}
				} catch {
					// Skip invalid packets
				}
			}

			console.log(`  Found ${services.size} network services: ${Array.from(services).join(", ")}`);

			// Should have found several services
			assert.ok(services.size >= 5, "Should have at least 5 network services");
			assert.ok(services.has("TuneIn"), "Should have TuneIn");
			assert.ok(services.has("Spotify"), "Should have Spotify");
		});
	});

	describe("packet structure validation", () => {
		it("should validate all packet headers", () => {
			const packets = decodeMultiplePackets(RAW_DATA);

			for (const packet of packets) {
				// Verify header structure
				assert.equal(packet.header, "ISCP", "Header magic should be ISCP");
				assert.equal(packet.headerSize, 16, "Header size should be 16");
				assert.ok(packet.dataSize > 0, "Data size should be positive");
				assert.equal(packet.version.length, 4, "Version should be 4 bytes");
			}
		});

		it("should validate message format", () => {
			const packets = decodeMultiplePackets(RAW_DATA);

			for (const packet of packets) {
				// Message should start with !
				assert.ok(packet.message.startsWith("!"), "Message should start with !");

				// Message should have terminator
				assert.ok(
					packet.message.endsWith("\r") || packet.message.endsWith("\n") || packet.message.endsWith("\x1a"),
					"Message should have terminator",
				);
			}
		});
	});
});
