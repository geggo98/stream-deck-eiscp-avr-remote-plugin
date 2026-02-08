#!/usr/bin/env -S tsx
/**
 * Unified eISCP device discovery script
 *
 * This script discovers eISCP-compatible devices using all available methods:
 * - DNS-SD (AirPlay devices on macOS) - discovers IPs to try eISCP on
 * - eISCP broadcast discovery (Onkyo/Pioneer receivers)
 * - eISCP network scanning (TCP port scanning, optional)
 *
 * ALL devices are verified via eISCP connection. Only devices that successfully
 * connect via eISCP are returned.
 *
 * Usage:
 *   tsx scripts/discover-all.ts [options]
 *
 * Options:
 *   --timeout <ms>       Discovery timeout in milliseconds (default: 10000)
 *   --concurrency <n>    Max parallel connection attempts (default: 4)
 *   --scan-network       Enable eISCP network scanning (can be slow)
 *   --subnets <nets>     Comma-separated /24 subnets to scan (requires --scan-network)
 *   --json               Output as JSON
 *   --help               Show this help message
 */

import {
	discoverAllDevicesStreaming,
	type UnifiedDiscoveryOptions,
	type EiscpConnectResult,
	type DiscoveredDevice,
} from "../src/adapter/discovery/index.js";

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): UnifiedDiscoveryOptions & {
	json: boolean;
	showHelp: boolean;
} {
	const options: UnifiedDiscoveryOptions & {
		json: boolean;
		showHelp: boolean;
	} = {
		timeout: 10000,
		concurrency: 4,
		includeNetworkScan: false,
		json: false,
		showHelp: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		switch (arg) {
			case "--timeout":
				options.timeout = Number.parseInt(args[++i]!, 10);
				break;
			case "--concurrency":
				options.concurrency = Number.parseInt(args[++i]!, 10);
				break;
			case "--scan-network":
				options.includeNetworkScan = true;
				break;
			case "--subnets":
				options.subnets = args[++i]!.split(",").map((s) => s.trim());
				// Enable network scan if subnets are specified
				options.includeNetworkScan = true;
				break;
			case "--json":
				options.json = true;
				break;
			case "--help":
			case "-h":
				options.showHelp = true;
				break;
			default:
				console.error(`Unknown option: ${arg}`);
				options.showHelp = true;
		}
	}

	return options;
}

/**
 * Print help message
 */
function printHelp(): void {
	console.log(`
Unified eISCP Device Discovery Script

Discovers eISCP-compatible devices using all available methods:
- DNS-SD (AirPlay devices on macOS) - discovers IPs to try eISCP on
- eISCP broadcast discovery (Onkyo/Pioneer receivers)
- eISCP network scanning (TCP port scanning, optional with --scan-network)

ALL devices are verified via eISCP connection. Only devices that successfully
connect via eISCP are returned.

Usage:
  tsx scripts/discover-all.ts [options]

Options:
  --timeout <ms>       Discovery timeout in milliseconds (default: 10000)
  --concurrency <n>    Max parallel connection attempts (default: 4)
  --scan-network       Enable eISCP network scanning (can be slow)
  --subnets <nets>     Specific /24 subnets to scan (e.g., "10.2.0,192.168.1")
  --json               Output as JSON
  --help, -h           Show this help message

Examples:
  # Discover all eISCP devices with default settings
  tsx scripts/discover-all.ts

  # Discover with network scanning
  tsx scripts/discover-all.ts --scan-network

  # Scan specific subnets with higher concurrency
  tsx scripts/discover-all.ts --scan-network --subnets "10.2.0,192.168.1" --concurrency 8

  # Output as JSON
  tsx scripts/discover-all.ts --json

Notes:
  - Only devices that successfully connect via eISCP are returned
  - AirPlay discovery only works on macOS (used to find IPs to try eISCP on)
  - Network scanning can take several minutes depending on subnet size
  - Each IP is only checked once across all discovery methods
  - Devices with multiple IPs are checked sequentially until one succeeds
  - IPv6 addresses are skipped (most receivers don't support eISCP over IPv6)
`);
}

/**
 * Format device info for display
 */
function formatDeviceInfo(result: EiscpConnectResult): string {
	const { deviceId, source, connectedIp, deviceInfo, metadata } = result;

	let output = `✅ ${deviceId}`;

	// Add source indicator
	const sourceIcon =
		source === "airplay" ? "📱" :
		source === "eiscp-broadcast" ? "📺" :
		"🔍";
	output += ` ${sourceIcon}`;

	// Add IP
	output += ` @ ${connectedIp}`;

	// Add metadata
	if (metadata.airplay?.instanceName) {
		output += ` (${metadata.airplay.instanceName})`;
	}
	if (metadata.eiscpBroadcast?.modelName) {
		output += ` (${metadata.eiscpBroadcast.modelName})`;
	}

	// Add device info
	const stateStr = [];
	if (deviceInfo.power) stateStr.push("power=on");
	if (deviceInfo.muted) stateStr.push("muted");
	if (deviceInfo.input) stateStr.push(`input=${deviceInfo.input}`);
	if (stateStr.length > 0) {
		output += ` [${stateStr.join(", ")}]`;
	}

	return output;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));

	if (options.showHelp) {
		printHelp();
		process.exit(0);
	}

	console.log("\n🔍 Unified eISCP Device Discovery");
	console.log(`   Timeout: ${options.timeout}ms`);
	console.log(`   Concurrency: ${options.concurrency}`);
	console.log(`   Methods: DNS-SD (for IPs), eISCP Broadcast`);
	if (options.includeNetworkScan) {
		console.log(`   Network Scan: Enabled`);
		if (options.subnets) {
			console.log(`   Subnets: ${options.subnets.join(", ")}`);
		}
	}
	console.log(`   Only devices with successful eISCP connection are returned`);
	console.log("");

	const startTime = Date.now();
	let candidateCount = 0;
	let connectedCount = 0;
	let errorCount = 0;

	const result = await discoverAllDevicesStreaming({
		...options,
		onDiscovery: (device: DiscoveredDevice) => {
			candidateCount++;
			const source =
				device.source === "airplay" ? "AirPlay" :
				device.source === "eiscp-broadcast" ? "eISCP" :
				"Scan";
			process.stdout.write(`\r  → Found candidate: ${device.id} (${source}) [${device.ips.length} IP(s)]   \n`);
		},
		onConnect: (connectResult: EiscpConnectResult) => {
			connectedCount++;
			process.stdout.write(`\n${formatDeviceInfo(connectResult)}\n`);
		},
		onError: (error) => {
			errorCount++;
			if (!options.json) {
				process.stdout.write(`\r  ⚠️  Failed: ${error.deviceId} @ ${error.ip}: ${error.error.message}   \n`);
			}
		},
		onScanProgress: (progress) => {
			if (options.includeNetworkScan) {
				const barLength = 30;
				const filled = Math.round((progress.scanned / progress.total) * barLength);
				const empty = barLength - filled;
				const bar = "█".repeat(filled) + "░".repeat(empty);
				process.stdout.write(
					`\r  Scan: [${bar}] ${progress.percent}% | ${progress.scanned}/${progress.total} | Found: ${progress.found}   `
				);
			}
		},
	});

	const duration = Date.now() - startTime;

	// Clear any scan progress line
	if (options.includeNetworkScan) {
		process.stdout.write("\r" + " ".repeat(100) + "\r");
	}

	console.log("\n\n📊 Summary:");
	console.log(`   Discovery time: ${duration}ms`);
	console.log(`   Candidates found: ${candidateCount}`);
	console.log(`   Connected via eISCP: ${connectedCount}`);
	console.log(`   Failed eISCP connection: ${errorCount}`);
	console.log(`   Check time: ${result.duration}ms`);

	if (result.connectedDevices.length > 0 && !options.json) {
		console.log("\n✅ Connected Devices (eISCP):");
		for (const device of result.connectedDevices) {
			console.log(`   ${formatDeviceInfo(device)}`);
		}
	}

	if (result.failedDevices.length > 0 && !options.json) {
		console.log("\n❌ Failed Devices:");
		const failedByDevice = new Map<string, string[]>();
		for (const error of result.failedDevices) {
			const errors = failedByDevice.get(error.deviceId) ?? [];
			errors.push(error.ip);
			failedByDevice.set(error.deviceId, errors);
		}
		for (const [deviceId, ips] of failedByDevice) {
			console.log(`   ${deviceId}: ${ips.join(", ")}`);
		}
	}

	if (options.json) {
		console.log("\n" + JSON.stringify({
			summary: {
				discoveryTime: duration,
				candidatesFound: candidateCount,
				connected: connectedCount,
				failed: errorCount,
				checkTime: result.duration,
			},
			connectedDevices: result.connectedDevices.map((r) => ({
				deviceId: r.deviceId,
				connectedIp: r.connectedIp,
				source: r.source,
				metadata: {
					airplay: r.metadata.airplay ?
						{
							instanceName: r.metadata.airplay.instanceName,
							hostname: r.metadata.airplay.hostname,
							txtRecords: Array.from(r.metadata.airplay.txtRecords.entries()),
						} :
						undefined,
					eiscpBroadcast: r.metadata.eiscpBroadcast,
					eiscpScan: r.metadata.eiscpScan,
				},
				deviceInfo: r.deviceInfo,
			})),
			failedDevices: result.failedDevices,
		}, null, 2));
	}
}

main().catch((error) => {
	console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
