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
	InputSource,
	ListeningMode,
	type EiscpClient,
	type EiscpTransport,
} from "../src/adapter/eiscp/index.ts";
import { getValueName } from "../src/adapter/eiscp/command-registry.ts";

// Test configuration from environment. Hardware tests only run when a
// receiver host is explicitly provided.
const TEST_HOST = process.env.EISCP_TEST_HOST ?? "10.2.0.32";
const TEST_PORT = parseInt(process.env.EISCP_TEST_PORT ?? "60128", 10);
const ENABLE_TESTS = process.env.EISCP_TEST_HOST !== undefined;

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

	// Snapshot of the receiver state before the run; everything (power,
	// volume, input, mute, listening mode) is restored afterwards.
	let savedState: ReturnType<EiscpClient["getState"]> | undefined;
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	/**
	 * Poll a query until the predicate holds (or time runs out) and return the
	 * last value. The receiver's state events lag a set command by ~1.5 s, so
	 * querying immediately after a send races and yields the OLD value (the
	 * false-negative pattern CLAUDE.md warns about).
	 */
	async function eventually<T>(
		query: () => Promise<T>,
		want: (value: T) => boolean,
		timeoutMs = 4000,
	): Promise<T> {
		const start = Date.now();
		let last = await query();
		while (!want(last) && Date.now() - start < timeoutMs) {
			await sleep(250);
			last = await query();
		}
		return last;
	}

	before(async () => {
		console.log(`\n=== eISCP Integration Tests ===`);
		console.log(`Target: ${TEST_HOST}:${TEST_PORT}`);
		console.log(`Note: These tests control a real device!`);
		console.log(`Volume cap set to ${testConfig.volume.cap} for safety\n`);

		// Create client
		client = createClient(testConfig);

		// Create separate transport for low-level tests. NOTE: the receiver
		// keeps only one eISCP connection alive (a second connect makes it
		// drop the first), so client and transport must never be connected
		// at the same time — see the transport suite's before/after.
		transport = createTransport({ host: TEST_HOST, port: TEST_PORT });

		await client.connect();
		console.log("Connected to receiver.");

		savedState = client.getState();
		console.log(`Saved state: power=${savedState.power} volume=${savedState.volume} input=${savedState.rawInput}`);

		// The write tests need the receiver awake; in network standby it
		// ignores set commands.
		if (!savedState.power) {
			console.log("Receiver is in standby — powering on for the test run.");
			await client.powerOn();
			await sleep(4000); // the unit needs a moment before it accepts commands
			await client.refreshState();
		}
	});

	after(async () => {
		// Restore the receiver exactly as we found it.
		if (savedState && client?.isConnected()) {
			console.log("\nRestoring receiver state...");
			try {
				if (savedState.rawInput) await client.setInputByHex(savedState.rawInput);
				await client.setVolume(savedState.volume);
				await client.setMute(savedState.muted);
				if (savedState.rawListeningMode) await client.setListeningModeByHex(savedState.rawListeningMode);
				await sleep(1000);
				if (!savedState.power) await client.powerOff();
			} catch (err) {
				console.error(`Failed to restore receiver state: ${err}`);
			}
		}
		console.log("\nDisconnecting...");
		client?.disconnect();
		transport?.disconnect();
		console.log("Integration tests complete.\n");
	});

	describe("transport layer", () => {
		// One connection at a time (see the outer before note).
		before(async () => {
			client.disconnect();
			await transport.connect();
		});
		after(async () => {
			transport.disconnect();
			await client.connect();
		});

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

			// Set to a safe low volume (20% of the cap)
			const expectedLevel = Math.round((20 / 100) * client.getVolumeConfig().cap);
			await client.setVolumePercent(20);
			const newVolume = await eventually(
				() => client.queryVolume(),
				(v) => v === expectedLevel,
			);
			assert.equal(newVolume, expectedLevel);

			// Restore original volume
			await client.setVolume(originalVolume);
			await eventually(() => client.queryVolume(), (v) => v === originalVolume);
			console.log(`  Volume set to ${newVolume}, restored to ${originalVolume}`);
		});

		it("should volume up and down", async () => {
			const originalVolume = await client.queryVolume();

			// Volume up
			await client.volumeUp();
			const upVolume = await eventually(
				() => client.queryVolume(),
				(v) => v === originalVolume + 1,
			);
			assert.equal(upVolume, originalVolume + 1);

			// Volume down
			await client.volumeDown();
			const downVolume = await eventually(() => client.queryVolume(), (v) => v === originalVolume);
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
			const toggledMuted = await eventually(() => client.queryMute(), (m) => m === !originalMuted);
			assert.equal(toggledMuted, !originalMuted);

			// Toggle back
			await client.toggleMute();
			const restoredMuted = await eventually(() => client.queryMute(), (m) => m === originalMuted);
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

			// Selecting TUNER (26) makes the VSX-S520D switch to its tuner but
			// REPORT the active band instead (FM = 24 / AM = 25) — verified
			// against the live unit. Accept any of the three labels.
			const acceptable = new Set(
				[InputSource.TUNER.hex, InputSource.FM.hex, InputSource.AM.hex].map(
					(hex) => getValueName("SLI", hex) ?? hex,
				),
			);
			await client.setInput("TUNER");
			const newInput = await eventually(() => client.queryInput(), (v) => acceptable.has(v));
			assert.ok(acceptable.has(newInput), `expected tuner/fm/am, got ${newInput}`);

			// The suite's outer after() restores the original input.
			console.log(`  Input changed: ${originalInput} -> ${newInput}`);
		});

		it("should list available inputs", () => {
			// This test just verifies the enum is accessible
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
			const stereoLabel = getValueName("LMD", ListeningMode.STEREO.hex);
			assert.ok(stereoLabel, "registry should know the STEREO mode");

			// Try to set to Stereo (a universal mode)
			await client.setListeningMode("STEREO");
			const newMode = await eventually(() => client.queryListeningMode(), (v) => v === stereoLabel);
			assert.equal(newMode, stereoLabel);

			console.log(`  Listening mode: ${originalMode} -> ${newMode}`);
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

			// Make a change that should trigger an event, then wait for the
			// receiver's lagging state broadcast to arrive.
			await client.toggleMute();
			await eventually(
				async () => changes,
				(n) => n >= 1,
			);

			client.off("stateChanged", handler);
			assert.ok(changes >= 1, `expected at least one stateChanged event, got ${changes}`);

			// Restore mute state
			await client.toggleMute();
			await eventually(() => client.queryMute(), (m) => typeof m === "boolean");

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
		it("should capture raw messages for test fixtures", async () => {
			const packets: Array<{ direction: string; data: string }> = [];

			// rawPacket events are gated behind debugLog, so capture the raw
			// ISCP strings from the always-on message events instead.
			const handler = (message: { raw: string }) => {
				packets.push({ direction: "received", data: message.raw });
			};

			client.on("message", handler);

			// Perform some operations
			await client.queryPower();
			await client.queryVolume();
			await client.queryMute();

			// Give time for responses
			await new Promise((resolve) => setTimeout(resolve, 500));

			client.off("message", handler);

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
