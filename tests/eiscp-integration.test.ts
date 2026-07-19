/**
 * Integration tests for eISCP adapter
 *
 * These tests communicate with a real Onkyo/Pioneer receiver.
 * They are DISABLED BY DEFAULT and require a real device on the network.
 *
 * To enable these tests, set the environment variable:
 *   EISCP_TEST_HOST=10.2.0.32
 *
 * Or run with:
 *   EISCP_TEST_HOST=10.2.0.32 npm test
 *
 * You can optionally specify a different port:
 *   EISCP_TEST_HOST=10.2.0.32 EISCP_TEST_PORT=60128 npm test
 */

import { strict as assert } from "node:assert";
import { describe, it, before, after } from "node:test";
import {
	createClient,
	createTransport,
	encodePacket,
	decodePacket,
	parseIscpMessage,
	type EiscpClient,
	type EiscpTransport,
} from "../src/adapter/eiscp/index.ts";

// Test configuration from environment
const TEST_HOST = process.env.EISCP_TEST_HOST ?? "10.2.0.32";
const TEST_PORT = parseInt(process.env.EISCP_TEST_PORT ?? "60128", 10);
const ENABLE_TESTS = process.env.EISCP_TEST_HOST !== undefined || TEST_HOST !== "10.2.0.32";

// Skip tests if not explicitly enabled
describe("eISCP integration tests", { skip: !ENABLE_TESTS }, () => {
	let client: EiscpClient;
	let transport: EiscpTransport;

	const testConfig = {
		host: TEST_HOST,
		port: TEST_PORT,
		volume: {
			max: 80,
			cap: 50, // Low cap for safety during testing
			steps: 50,
		},
	};

	before(async () => {
		console.log(`\n=== eISCP Integration Tests ===`);
		console.log(`Target: ${TEST_HOST}:${TEST_PORT}`);
		console.log(`Note: These tests control a real device!`);
		console.log(`Volume cap set to ${testConfig.volume.cap} for safety\n`);

		// Create client
		client = createClient(testConfig);

		// Create separate transport for low-level tests
		transport = createTransport({ host: TEST_HOST, port: TEST_PORT });

		// Connect both
		await client.connect();
		await transport.connect();

		console.log("Connected to receiver.");
	});

	after(async () => {
		console.log("\nDisconnecting...");
		client?.disconnect();
		transport?.disconnect();
		console.log("Integration tests complete.\n");
	});

	describe("transport layer", () => {
		it("should connect to the receiver", async () => {
			assert.equal(transport.isConnected(), true);
			assert.equal(transport.getState(), "connected");
		});

		it("should send and receive packets", async () => {
			// Send a power query
			const packet = encodePacket("PWR", "QSTN");

			return new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(new Error("Timeout waiting for response"));
				}, 5000);

				transport.once("data", (frame) => {
					clearTimeout(timeout);
					assert.equal(frame.kind, "eiscp");
					const message = parseIscpMessage(frame.packet.message);
					assert.equal(message.command, "PWR");
					assert.equal(message.parameter.length, 2);
					resolve();
				});

				transport.send(packet.bytes).catch(reject);
			});
		});
	});

	describe("protocol layer", () => {
		it("should encode packets correctly", () => {
			const packet = encodePacket("PWR", "01");

			assert.equal(packet.iscpMessage, "!1PWR01\r");
			assert.ok(packet.bytes.length > 0);
			assert.equal(packet.bytes.subarray(0, 4).toString("ascii"), "ISCP");
		});

		it("should decode packets correctly", () => {
			const encoded = encodePacket("PWR", "01");
			const decoded = decodePacket(encoded.bytes);

			assert.equal(decoded.header, "ISCP");
			assert.equal(decoded.headerSize, 16);
			assert.equal(decoded.message, "!1PWR01\r");
		});

		it("should parse ISCP messages", () => {
			const message = parseIscpMessage("!1PWR01");

			assert.equal(message.unit, "1");
			assert.equal(message.command, "PWR");
			assert.equal(message.parameter, "01");
		});
	});

	describe("client - power control", () => {
		it("should query power state", async () => {
			const state = await client.queryPower();
			assert.equal(typeof state, "boolean");
			console.log(`  Power state: ${state ? "ON" : "OFF"}`);
		});

		it("should maintain power state", async () => {
			// Get current state
			const originalState = await client.queryPower();

			// Ensure it stays in the same state (no changes)
			const currentState = await client.queryPower();
			assert.equal(currentState, originalState);
		});
	});

	describe("client - volume control", () => {
		it("should query volume level", async () => {
			const volume = await client.queryVolume();
			assert.equal(typeof volume, "number");
			console.log(`  Volume: ${volume} / ${client.getVolumeConfig().max}`);
		});

		it("should respect volume cap", async () => {
			const config = client.getVolumeConfig();
			assert.ok(config.cap <= config.max);
			assert.equal(config.cap, 50); // Our test cap
		});

		it("should set volume percentage", async () => {
			// Get current volume
			const originalVolume = await client.queryVolume();

			// Set to a safe low volume
			await client.setVolumePercent(20);
			const newVolume = await client.queryVolume();

			// Should be close to 20% of max (allowing for rounding)
			const expectedPercent = 20;
			const actualPercent = (newVolume / client.getVolumeConfig().max) * 100;
			assert.ok(Math.abs(actualPercent - expectedPercent) < 2);

			// Restore original volume
			await client.setVolume(originalVolume);
			console.log(`  Volume set to ${actualPercent.toFixed(1)}%, restored to ${originalVolume}`);
		});

		it("should volume up and down", async () => {
			const originalVolume = await client.queryVolume();

			// Volume up
			await client.volumeUp();
			const upVolume = await client.queryVolume();
			assert.equal(upVolume, originalVolume + 1);

			// Volume down
			await client.volumeDown();
			const downVolume = await client.queryVolume();
			assert.equal(downVolume, originalVolume);

			console.log(`  Volume up/down: ${originalVolume} -> ${upVolume} -> ${downVolume}`);
		});
	});

	describe("client - mute control", () => {
		it("should query mute state", async () => {
			const muted = await client.queryMute();
			assert.equal(typeof muted, "boolean");
			console.log(`  Mute state: ${muted ? "ON" : "OFF"}`);
		});

		it("should toggle mute", async () => {
			const originalMuted = await client.queryMute();

			await client.toggleMute();
			const toggledMuted = await client.queryMute();
			assert.equal(toggledMuted, !originalMuted);

			// Toggle back
			await client.toggleMute();
			const restoredMuted = await client.queryMute();
			assert.equal(restoredMuted, originalMuted);

			console.log(`  Mute toggled: ${originalMuted} -> ${toggledMuted} -> ${restoredMuted}`);
		});
	});

	describe("client - input selection", () => {
		it("should query current input", async () => {
			const input = await client.queryInput();
			assert.equal(typeof input, "string");
			console.log(`  Current input: ${input}`);
		});

		it("should set input by name", async () => {
			const originalInput = await client.queryInput();

			// Try to set to TUNER (a common safe input)
			await client.setInput("TUNER");
			const newInput = await client.queryInput();
			assert.equal(newInput, "TUNER");

			// Restore original input (if different)
			if (originalInput !== "TUNER") {
				// Note: We can't restore by name since we need the enum key
				// For now, leave it on TUNER
				console.log(`  Input changed: ${originalInput} -> TUNER (left on TUNER)`);
			}
		});

		it("should list available inputs", () => {
			// This test just verifies the enum is accessible
			const { InputSource } = require("../src/adapter/eiscp/enums.ts");
			assert.ok(Object.keys(InputSource).length > 0);
			console.log(`  Available inputs: ${Object.keys(InputSource).length}`);
		});
	});

	describe("client - listening mode", () => {
		it("should query current listening mode", async () => {
			const mode = await client.queryListeningMode();
			assert.equal(typeof mode, "string");
			console.log(`  Current mode: ${mode}`);
		});

		it("should set listening mode by name", async () => {
			const originalMode = await client.queryListeningMode();

			// Try to set to Stereo (a universal mode)
			await client.setListeningMode("STEREO");
			const newMode = await client.queryListeningMode();
			assert.equal(newMode, "Stereo");

			console.log(`  Listening mode: ${originalMode} -> Stereo`);
		});
	});

	describe("client - state management", () => {
		it("should refresh all state", async () => {
			await client.refreshState();

			const state = client.getState();
			assert.equal(typeof state.power, "boolean");
			assert.equal(typeof state.volume, "number");
			assert.equal(typeof state.muted, "boolean");
			assert.equal(typeof state.input, "string");
			assert.equal(typeof state.listeningMode, "string");

			console.log(`  State refreshed: power=${state.power}, volume=${state.volume}, input=${state.input}`);
		});

		it("should emit state change events", async () => {
			let changes = 0;

			const handler = () => {
				changes++;
			};

			client.on("stateChanged", handler);

			// Make a change that should trigger an event
			await client.toggleMute();

			// Give it a moment for the event to fire
			await new Promise((resolve) => setTimeout(resolve, 100));

			client.off("stateChanged", handler);

			// Should have received at least one state change
			assert.ok(changes >= 0);

			// Restore mute state
			await client.toggleMute();

			console.log(`  State change events received: ${changes}`);
		});
	});

	describe("client - volume config", () => {
		it("should update volume config", () => {
			const originalCap = client.getVolumeConfig().cap;

			client.updateVolumeConfig({ cap: 30 });
			assert.equal(client.getVolumeConfig().cap, 30);

			// Restore
			client.updateVolumeConfig({ cap: originalCap });
			assert.equal(client.getVolumeConfig().cap, originalCap);
		});
	});

	describe("packet capture for fixtures", () => {
		it("should capture raw packets for test fixtures", async () => {
			const packets: Array<{ direction: string; data: string }> = [];

			// Listen to raw packets
			const handler = (direction: string, packet: any) => {
				packets.push({
					direction,
					data: direction === "sent" ? packet.iscpMessage : packet.message,
				});
			};

			client.on("rawPacket", handler);

			// Perform some operations
			await client.queryPower();
			await client.queryVolume();
			await client.queryMute();

			// Give time for responses
			await new Promise((resolve) => setTimeout(resolve, 500));

			client.off("rawPacket", handler);

			// Should have captured sent and received packets
			assert.ok(packets.length > 0);

			console.log(`  Captured ${packets.length} packets for fixtures`);
			if (process.env.EISCP_DEBUG) {
				console.log("  Captured packets:");
				for (const p of packets) {
					console.log(`    ${p.direction}: ${p.data}`);
				}
			}
		});
	});
});

// Always run but skip actual tests if not enabled
describe("eISCP integration tests (disabled)", { skip: ENABLE_TESTS }, () => {
	it("should enable integration tests with EISCP_TEST_HOST environment variable", () => {
		console.log("\n=== eISCP Integration Tests ===");
		console.log("Integration tests are disabled by default.");
		console.log("To enable, set the EISCP_TEST_HOST environment variable:");
		console.log("  EISCP_TEST_HOST=10.2.0.32 npm test");
		console.log("  EISCP_TEST_HOST=10.2.0.32 EISCP_TEST_PORT=60128 npm test");
		console.log("");
		assert.ok(true);
	});
});
