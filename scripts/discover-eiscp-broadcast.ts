#!/usr/bin/env -S tsx
/**
 * eISCP device discovery script
 *
 * This script discovers Onkyo/Pioneer/Integra network receivers on the local network
 * using UDP broadcast discovery. It can run in different modes for testing and fixture generation.
 *
 * Usage:
 *   tsx scripts/discover-eiscp.ts [options]
 *
 * Options:
 *   --timeout <ms>       Discovery timeout in milliseconds (default: 5000)
 *   --unit-type <type>   Unit type to query: onkyo, pioneer, both (default: both)
 *   --raw                Output raw packet dumps
 *   --json               Output as JSON
 *   --fixtures           Save fixtures to tests/fixtures directory
 *   --capture            Capture raw request/response packets
 *   --help               Show this help message
 */

import {
	discoverEiscpDevices,
	discoverEiscpDevicesStreaming,
	DiscoveryUnitType,
	createEcnQueryPacket,
	dumpDiscoveryPackets,
	formatReceiverInfo,
	receiverToJson,
	type DiscoveredReceiver,
	type DiscoveryCapture,
} from "../src/adapter/eiscp/discover.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): {
	timeout: number;
	unitTypes: DiscoveryUnitType[];
	raw: boolean;
	json: boolean;
	fixtures: boolean;
	capture: boolean;
} {
	const options = {
		timeout: 5000,
		unitTypes: [DiscoveryUnitType.ONKYO, DiscoveryUnitType.PIONEER] as DiscoveryUnitType[],
		raw: false,
		json: false,
		fixtures: false,
		capture: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		switch (arg) {
			case "--timeout":
				options.timeout = Number.parseInt(args[++i]!, 10);
				break;
			case "--unit-type":
				const type = args[++i]!;
				if (type === "onkyo") {
					options.unitTypes = [DiscoveryUnitType.ONKYO];
				} else if (type === "pioneer") {
					options.unitTypes = [DiscoveryUnitType.PIONEER];
				} else if (type === "both") {
					options.unitTypes = [DiscoveryUnitType.ONKYO, DiscoveryUnitType.PIONEER];
				} else {
					console.error(`Unknown unit type: ${type}`);
					console.error('Valid unit types: onkyo, pioneer, both');
					process.exit(1);
				}
				break;
			case "--raw":
				options.raw = true;
				break;
			case "--json":
				options.json = true;
				break;
			case "--fixtures":
				options.fixtures = true;
				break;
			case "--capture":
				options.capture = true;
				break;
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
			default:
				console.error(`Unknown option: ${arg}`);
				printHelp();
				process.exit(1);
		}
	}

	return options;
}

/**
 * Print help message
 */
function printHelp(): void {
	console.log(`
eISCP Device Discovery Script

Usage:
  tsx scripts/discover-eiscp.ts [options]

Options:
  --timeout <ms>       Discovery timeout in milliseconds (default: 5000)
  --unit-type <type>   Unit type to query:
                       - onkyo: Query Onkyo/Integra receivers (unit type '1')
                       - pioneer: Query Pioneer receivers (unit type 'p')
                       - both: Query both types (default)
  --raw                Output raw packet dumps
  --json               Output as JSON
  --fixtures           Save fixtures to tests/fixtures directory
  --capture            Capture raw request/response packets
  --help, -h           Show this help message

Examples:
  # Discover all receivers
  tsx scripts/discover-eiscp.ts

  # Discover with raw packet dump
  tsx scripts/discover-eiscp.ts --raw --timeout 10000

  # Save fixtures for testing
  tsx scripts/discover-eiscp.ts --fixtures --capture --json

  # Query only Pioneer receivers
  tsx scripts/discover-eiscp.ts --unit-type pioneer
`);
}

/**
 * Save fixture data
 */
function saveFixture(name: string, data: unknown): void {
	const fixturesDir = join(__dirname, "..", "tests", "fixtures");
	if (!existsSync(fixturesDir)) {
		mkdirSync(fixturesDir, { recursive: true });
	}

	const fixturePath = join(fixturesDir, `${name}.json`);
	writeFileSync(fixturePath, JSON.stringify(data, null, 2), "utf-8");
	console.error(`\nFixture saved: ${fixturePath}`);
}

/**
 * Save raw binary fixture
 */
function saveRawFixture(name: string, data: Buffer): void {
	const fixturesDir = join(__dirname, "..", "tests", "fixtures");
	if (!existsSync(fixturesDir)) {
		mkdirSync(fixturesDir, { recursive: true });
	}

	const fixturePath = join(fixturesDir, `${name}.bin`);
	writeFileSync(fixturePath, data, "utf-8");
	console.error(`Raw fixture saved: ${fixturePath}`);
}

/**
 * Format buffer as hex dump
 */
function hexDump(buffer: Buffer, maxLength: number = 256): string {
	const length = Math.min(buffer.length, maxLength);
	let output = "";
	for (let i = 0; i < length; i += 16) {
		const hex = buffer.subarray(i, i + 16).toString("hex").match(/.{2}/g)?.join(" ") ?? "";
		const ascii = buffer
			.subarray(i, i + 16)
			.toString("ascii")
			.replace(/[^\x20-\x7E]/g, ".");
		output += `${i.toString(16).padStart(4, "0")}: ${hex.padEnd(48)}  ${ascii}\n`;
	}
	if (buffer.length > maxLength) {
		output += `... (${buffer.length - maxLength} more bytes)\n`;
	}
	return output;
}

/**
 * Output data based on format options
 */
function outputData(data: unknown, options: { json: boolean }): void {
	if (options.json) {
		console.log(JSON.stringify(data, null, 2));
	} else {
		console.log(data);
	}
}

/**
 * Dump discovery packet information
 */
function dumpPacketInfo(): void {
	const packets = dumpDiscoveryPackets();

	console.log("\n=== DISCOVERY PACKETS ===\n");

	console.log("Onkyo Query Packet:");
	console.log(`  Hex: ${packets.onkyoQuery}`);
	console.log(`  Header:`);
	console.log(`    Magic: ${packets.header.magic} (ISCP)`);
	console.log(`    Header Size: ${packets.header.headerSize} (16 = 0x10)`);
	console.log(`    Data Size: ${packets.header.dataSize} (12 = 0x0C, length of "!1ECNQSTN\\r")`);
	console.log(`    Version: ${packets.header.version}`);

	console.log("\nPioneer Query Packet:");
	console.log(`  Hex: ${packets.pioneerQuery}`);

	console.log("\nPacket Structure:");
	console.log("  Bytes 0-3:   Magic 'ISCP'");
	console.log("  Bytes 4-7:   Header size (16)");
	console.log("  Bytes 8-11:  Data size (ISCP message length)");
	console.log("  Bytes 12-15: Version (0x01 00 00 00)");
	console.log("  Bytes 16+:   ISCP message (e.g., '!1ECNQSTN\\r')");
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));

	console.log(`\n🔍 Discovering eISCP receivers (timeout: ${options.timeout}ms)...\n`);
	console.log(`Unit types: ${options.unitTypes.join(", ")}`);

	// Show packet dump if --raw is specified
	if (options.raw) {
		dumpPacketInfo();
	}

	// Capture data for fixtures
	const captures: DiscoveryCapture[] = [];
	const devices: DiscoveredReceiver[] = [];

	// Run discovery with streaming
	const result = await discoverEiscpDevicesStreaming({
		timeout: options.timeout,
		unitTypes: options.unitTypes,
		capture: options.capture,
		onDevice: (device) => {
			devices.push(device);
			const formatted = formatReceiverInfo(device);
			console.log(`  → ${formatted}`);
		},
		onCapture: (capture) => {
			captures.push(capture);
			if (options.raw) {
				console.log(`\n  📦 Capture from ${capture.interfaceAddress}:`);
				console.log(`     Broadcast: ${capture.broadcastAddress}`);
				console.log(`     Sent: ${capture.sentPacket}`);
				console.log(`     Received: ${capture.receivedBytes}`);
			}
		},
	});

	// Summary
	console.log(`\n\n📊 Summary:`);
	console.log(`   Total devices found: ${result.devices.length}`);

	if (options.raw && result.devices.length > 0) {
		console.log("\n=== DETAILED DEVICE INFO ===\n");
		for (const device of result.devices) {
			console.log(`📺 ${device.modelName}`);
			console.log(`   Host: ${device.host}`);
			console.log(`   ISCP Port: ${device.iscpPort}`);
			console.log(`   Area Code: ${device.areaCode}`);
			console.log(`   Identifier: ${device.identifier}`);
			console.log(`   Unit Type: ${device.unitType}`);
			console.log(`   Raw ISCP Message: ${device.rawMessage}`);
			console.log("");
		}
	}

	if (options.capture && result.captures.length > 0) {
		console.log("\n=== CAPTURED DATA ===\n");
		console.log(`Total captures: ${result.captures.length}`);
		for (const capture of result.captures) {
			console.log(`\n[${capture.timestamp}] ${capture.receiver.modelName}`);
			console.log(`  Interface: ${capture.interfaceAddress}`);
			console.log(`  Broadcast: ${capture.broadcastAddress}`);
			console.log(`  Sent (hex): ${capture.sentPacket}`);
			console.log(`  Received (hex): ${capture.receivedBytes}`);

			// Show hex dump of received data
			const receivedBytes = Buffer.from(capture.receivedBytes, "hex");
			console.log(`  Received dump:`);
			console.log(hexDump(receivedBytes));
		}
	}

	if (options.fixtures) {
		// Save discovery results as fixture
		const fixtureData = {
			timestamp: new Date().toISOString(),
			devices: result.devices,
			captures: result.captures,
			options: {
				timeout: options.timeout,
				unitTypes: options.unitTypes,
			},
		};
		saveFixture("eiscp-discovery-result", fixtureData);

		// Save raw captures
		for (let i = 0; i < result.captures.length; i++) {
			const capture = result.captures[i]!;
			const receivedBytes = Buffer.from(capture.receivedBytes, "hex");
			saveRawFixture(`eiscp-discovery-capture-${i}`, receivedBytes);

			// Also save the sent packet
			const sentBytes = Buffer.from(capture.sentPacket, "hex");
			saveRawFixture(
				`eiscp-discovery-query-${capture.receiver.unitType === "p" ? "pioneer" : "onkyo"}`,
				sentBytes,
			);
		}
	}

	if (options.json) {
		outputData({ devices: result.devices, captures: result.captures }, options);
	}
}

main().catch((error) => {
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	if (process.argv.includes("--fixtures")) {
		saveFixture("eiscp-discovery-error", {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}
	process.exit(1);
});
