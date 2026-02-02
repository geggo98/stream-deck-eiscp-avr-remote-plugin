/**
 * Integration tests for eISCP listen mode using captured data
 *
 * These tests use a mock TCP server that serves the raw packet dump
 * from a real receiver. This tests the message decoder and listen mode.
 */

import { strict as assert } from "node:assert";
import { describe, it, before, after } from "node:test";
import { createServer } from "net";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import {
	createClient,
	type DecodedMessage,
	type PowerMessage,
	type VolumeMessage,
	type MuteMessage,
	type InputMessage,
	type ListeningModeMessage,
	type DisplayFieldMessage,
	type NetworkServiceMessage,
	type UnknownMessage,
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

describe("eISCP listen mode tests", () => {
	let client: ReturnType<typeof createClient>;
	const receivedMessages: DecodedMessage[] = [];

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

	describe("message event", () => {
		it("should receive and decode all messages", async () => {
			receivedMessages.length = 0; // Clear array

			client = createClient({
				host: "127.0.0.1",
				port: testPort,
				volume: { max: 80, cap: 50, steps: 50 },
			});

			// Listen to message events
			client.on("message", (msg) => {
				receivedMessages.push(msg);
			});

			// Connect and wait for data
			await client.connect();

			// Wait a bit for all packets to arrive
			await new Promise((resolve) => setTimeout(resolve, 600));

			console.log(`  Client received ${receivedMessages.length} decoded messages`);

			// Should have received at least 100 messages
			assert.ok(receivedMessages.length >= 100, `Expected at least 100 messages, got ${receivedMessages.length}`);

			// Disconnect the client after the test
			client.disconnect();
		});

		it("should decode power messages correctly", () => {
			const powerMessages = receivedMessages.filter((m): m is PowerMessage => m.type === "power");

			console.log(`  Found ${powerMessages.length} power messages`);

			assert.ok(powerMessages.length > 0, "Should have power messages");

			// Check structure
			for (const msg of powerMessages) {
				assert.equal(msg.type, "power");
				assert.equal(msg.command, "PWR");
				assert.equal(typeof msg.on, "boolean");
				assert.equal(typeof msg.parameter, "string");
				assert.ok(msg.raw.startsWith("!1PWR"));
			}
		});

		it("should decode volume messages correctly", () => {
			const volumeMessages = receivedMessages.filter((m): m is VolumeMessage => m.type === "volume");

			console.log(`  Found ${volumeMessages.length} volume messages`);

			assert.ok(volumeMessages.length > 0, "Should have volume messages");

			// Check structure
			for (const msg of volumeMessages) {
				assert.equal(msg.type, "volume");
				assert.equal(msg.command, "MVL");
				assert.equal(typeof msg.level, "number");
				assert.ok(msg.level >= 0 && msg.level <= 255);
				assert.equal(typeof msg.percent, "number");
			}
		});

		it("should decode mute messages correctly", () => {
			const muteMessages = receivedMessages.filter((m): m is MuteMessage => m.type === "mute");

			console.log(`  Found ${muteMessages.length} mute messages`);

			assert.ok(muteMessages.length > 0, "Should have mute messages");

			// Check structure
			for (const msg of muteMessages) {
				assert.equal(msg.type, "mute");
				assert.equal(msg.command, "AMT");
				assert.equal(typeof msg.muted, "boolean");
			}
		});

		it("should decode input messages correctly", () => {
			const inputMessages = receivedMessages.filter((m): m is InputMessage => m.type === "input");

			console.log(`  Found ${inputMessages.length} input messages`);

			assert.ok(inputMessages.length > 0, "Should have input messages");

			// Check structure
			for (const msg of inputMessages) {
				assert.equal(msg.type, "input");
				assert.equal(msg.command, "SLI");
				assert.equal(typeof msg.parameter, "string");

				// Some inputs may be unknown
				if (msg.input) {
					assert.equal(typeof msg.input.name, "string");
					assert.equal(typeof msg.input.hex, "string");
					assert.equal(typeof msg.input.decimal, "number");
				}
			}

			// Check for known inputs
			const knownInputs = inputMessages.filter((m) => m.input !== undefined);
			console.log(`  Known inputs: ${knownInputs.map((i) => i.input?.name).join(", ")}`);
		});

		it("should decode listening mode messages correctly", () => {
			const modeMessages = receivedMessages.filter((m): m is ListeningModeMessage => m.type === "listeningMode");

			console.log(`  Found ${modeMessages.length} listening mode messages`);

			assert.ok(modeMessages.length > 0, "Should have listening mode messages");

			// Check structure
			for (const msg of modeMessages) {
				assert.equal(msg.type, "listeningMode");
				assert.equal(msg.command, "LMD");
				assert.equal(typeof msg.parameter, "string");

				// Some modes may be unknown
				if (msg.mode) {
					assert.equal(typeof msg.mode.name, "string");
					assert.equal(typeof msg.mode.hex, "string");
					assert.equal(typeof msg.mode.decimal, "number");
				}
			}

			// Check for known modes
			const knownModes = modeMessages.filter((m) => m.mode !== undefined);
			console.log(`  Known modes: ${knownModes.map((m) => m.mode?.name).join(", ")}`);
		});

		it("should decode display field (FLD) messages correctly", () => {
			const fldMessages = receivedMessages.filter((m): m is DisplayFieldMessage => m.type === "displayField");

			console.log(`  Found ${fldMessages.length} display field messages`);

			assert.ok(fldMessages.length > 0, "Should have display field messages");

			// Check structure
			for (const msg of fldMessages) {
				assert.equal(msg.type, "displayField");
				assert.equal(msg.command, "FLD");
				assert.equal(typeof msg.parameter, "string");
			}

			// Check for successfully decoded text
			const withText = fldMessages.filter((m) => m.text !== undefined);
			console.log(`  Display fields with decoded text: ${withText.length}`);

			assert.ok(withText.length > 0, "Should have some display fields with decoded text");

			// Check some specific display texts
			const displayTexts = withText.map((m) => m.text);
			console.log(`  Sample display texts: "${displayTexts.slice(0, 5).join('", "')}"`);
		});

		it("should decode network service (NLS) messages correctly", () => {
			const nlsMessages = receivedMessages.filter((m): m is NetworkServiceMessage => m.type === "networkService");

			console.log(`  Found ${nlsMessages.length} network service messages`);

			assert.ok(nlsMessages.length > 0, "Should have network service messages");

			// Check structure
			for (const msg of nlsMessages) {
				assert.equal(msg.type, "networkService");
				assert.equal(msg.command, "NLS");
				assert.equal(typeof msg.parameter, "string");
				assert.ok(msg.subCommand === "C" || msg.subCommand === "U");
			}

			// Check for services with names
			const withService = nlsMessages.filter((m) => m.service !== undefined);
			console.log(`  Network services with names: ${withService.length}`);

			assert.ok(withService.length > 0, "Should have some network services with names");

			// Check some specific service names
			const serviceNames = withService.map((m) => m.service?.name);
			console.log(`  Service names: ${serviceNames.join(", ")}`);
		});

		it("should handle unknown messages gracefully", () => {
			const unknownMessages = receivedMessages.filter((m): m is UnknownMessage => m.type === "unknown");

			console.log(`  Found ${unknownMessages.length} unknown messages`);

			// Check structure of unknown messages
			for (const msg of unknownMessages) {
				assert.equal(msg.type, "unknown");
				assert.equal(typeof msg.command, "string");
				assert.equal(typeof msg.parameter, "string");
				assert.equal(typeof msg.raw, "string");
			}

			// Log some unknown commands for info
			const unknownCommands = [...new Set(unknownMessages.map((m) => m.command))];
			if (unknownCommands.length > 0) {
				console.log(`  Unknown command types: ${unknownCommands.join(", ")}`);
			}
		});

		it("should have correct message type distribution", () => {
			const typeCounts = new Map<string, number>();

			for (const msg of receivedMessages) {
				const count = typeCounts.get(msg.type) ?? 0;
				typeCounts.set(msg.type, count + 1);
			}

			console.log(`  Message type distribution:`);
			for (const [type, count] of typeCounts) {
				console.log(`    ${type}: ${count}`);
			}

			// Should have at least these types
			assert.ok(typeCounts.has("power"), "Should have power messages");
			assert.ok(typeCounts.has("volume"), "Should have volume messages");
			assert.ok(typeCounts.has("input"), "Should have input messages");
			assert.ok(typeCounts.has("listeningMode"), "Should have listening mode messages");
			assert.ok(typeCounts.has("displayField"), "Should have display field messages");
			assert.ok(typeCounts.has("networkService"), "Should have network service messages");
		});
	});
});
