#!/usr/bin/env -S tsx
/**
 * eISCP network scanner script
 *
 * This script scans private IP ranges for eISCP devices using TCP port checking.
 * It only checks if port 60128 is open, not if the device actually speaks eISCP.
 *
 * Usage:
 *   tsx scripts/scan-eiscp-network.ts [options]
 *
 * Options:
 *   --port <port>        Port to check (default: 60128)
 *   --timeout <ms>       Connection timeout per IP in milliseconds (default: 200)
 *   --concurrency <n>    Max parallel connections (default: 128)
 *   --subnets <nets>     Comma-separated /24 subnets to scan (e.g., 10.2.0,192.168.1)
 *   --all-subnets        Scan all private subnets (not just local ones)
 *   --verbose            Show progress for each IP scanned
 *   --json               Output as JSON
 *   --help               Show this help message
 */

import {
	scanNetworkStreaming,
	PrivateIpRange,
	getLocalSubnets,
	getSubnetsForRange,
	generateIpsForSubnet,
	checkPort,
	formatScannedDevice,
	scannedDeviceToJson,
	type ScanOptions,
	type ScanProgress,
	type ScannedDevice,
} from "../src/adapter/eiscp/network-scanner.js";

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): ScanOptions & {
	verbose: boolean;
	json: boolean;
	allSubnets: boolean;
	subnets?: string[];
} {
	const options: ScanOptions & {
		verbose: boolean;
		json: boolean;
		allSubnets: boolean;
		subnets?: string[];
	} = {
		port: 60128,
		timeout: 200,
		concurrency: 128,
		localSubnetsOnly: true,
		verbose: false,
		json: false,
		allSubnets: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		switch (arg) {
			case "--port":
				options.port = Number.parseInt(args[++i]!, 10);
				break;
			case "--timeout":
				options.timeout = Number.parseInt(args[++i]!, 10);
				break;
			case "--concurrency":
				options.concurrency = Number.parseInt(args[++i]!, 10);
				break;
			case "--subnets":
				options.subnets = args[++i]!.split(",").map((s) => s.trim());
				break;
			case "--all-subnets":
				options.allSubnets = true;
				break;
			case "--verbose":
				options.verbose = true;
				break;
			case "--json":
				options.json = true;
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
eISCP Network Scanner

Scans private IP ranges for eISCP devices by checking if port 60128 is open.
Only scans /24 subnets. By default, only scans subnets the local machine is on.

Usage:
  tsx scripts/scan-eiscp-network.ts [options]

Options:
  --port <port>        Port to check (default: 60128)
  --timeout <ms>       Connection timeout per IP in ms (default: 200)
  --concurrency <n>    Max parallel connections (default: 128)
  --subnets <nets>     Specific /24 subnets to scan (e.g., "10.2.0,192.168.1")
  --all-subnets        Scan all private subnets (not just local ones)
  --verbose            Show progress for each IP scanned
  --json               Output as JSON
  --help, -h           Show this help message

Examples:
  # Scan local subnets with default settings
  tsx scripts/scan-eiscp-network.ts

  # Scan specific subnets
  tsx scripts/scan-eiscp-network.ts --subnets "10.2.0,192.168.1"

  # Scan all private subnets (WARNING: this can take a long time!)
  tsx scripts/scan-eiscp-network.ts --all-subnets

  # Fast scan with lower timeout and higher concurrency
  tsx scripts/scan-eiscp-network.ts --timeout 100 --concurrency 256

Private IP Ranges:
  Class A:  10.0.0.0/8      (10.0.0.0 - 10.255.255.255)
  Class B:  172.16.0.0/12   (172.16.0.0 - 172.31.255.255)
  Class C:  192.168.0.0/16  (192.168.0.0 - 192.168.255.255)
`);
}

/**
 * Format progress bar
 */
function formatProgressBar(progress: ScanProgress, verbose: boolean): string {
	const barLength = 40;
	const filled = Math.round((progress.scanned / progress.total) * barLength);
	const empty = barLength - filled;

	const bar = "█".repeat(filled) + "░".repeat(empty);
	const percent = progress.percent.toString().padStart(3, " ");
	const scanned = progress.scanned.toString().padStart(6, " ");
	const total = progress.total.toString().padStart(6, " ");
	const found = progress.found.toString().padStart(3, " ");

	let output = `\r[${bar}] ${percent}% | ${scanned}/${total} | Found: ${found}`;

	if (verbose && progress.currentIp) {
		output += ` | ${progress.currentIp}`;
	}

	return output;
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));

	// Override localSubnetsOnly if allSubnets is set
	if (options.allSubnets) {
		options.localSubnetsOnly = false;
	}

	// Override localSubnetsOnly if specific subnets are provided
	if (options.subnets && options.subnets.length > 0) {
		options.localSubnetsOnly = false;
	}

	// Show what will be scanned
	console.log("\n🔍 eISCP Network Scanner");
	console.log(`   Port: ${options.port}`);
	console.log(`   Timeout: ${options.timeout}ms per IP`);
	console.log(`   Concurrency: ${options.concurrency}`);

	if (options.subnets && options.subnets.length > 0) {
		console.log(`   Subnets: ${options.subnets.join(", ")}`);
	} else if (options.allSubnets) {
		const classACount = getSubnetsForRange("CLASS_A").length;
		const classBCount = getSubnetsForRange("CLASS_B").length;
		const classCCount = getSubnetsForRange("CLASS_C").length;
		console.log(`   Subnets: All (${classACount + classBCount + classCCount} total)`);
	} else {
		const localSubnets = getLocalSubnets();
		if (localSubnets.length === 0) {
			console.error("\nError: No local subnets found. Are you connected to a network?");
			process.exit(1);
		}
		console.log(`   Subnets: Local (${localSubnets.length} found)`);
		for (const subnet of localSubnets) {
			console.log(`     - ${subnet.network}.0/24 (${subnet.range})`);
		}
	}

	// Count total IPs
	let totalIps = 0;
	if (options.subnets && options.subnets.length > 0) {
		for (const subnet of options.subnets) {
			totalIps += 254; // .1 to .254
		}
	} else if (options.allSubnets) {
		// Class A: 256 * 256 subnets * 254 IPs = 16,777,216 IPs (way too many!)
		// Class B: 16 * 256 subnets * 254 IPs = 1,048,576 IPs
		// Class C: 256 subnets * 254 IPs = 65,024 IPs
		totalIps =
			256 * 256 * 254 +
			16 * 256 * 254 +
			256 * 254;
		console.warn("\n⚠️  WARNING: Scanning all private subnets will scan ~17.8 million IPs!");
		console.warn("    This could take hours or days depending on your timeout settings.");
		console.warn("    Consider using --subnets to scan specific networks instead.\n");

		// Ask for confirmation
		const readline = await import("node:readline");
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		const answer = await new Promise<string>((resolve) => {
			rl.question("Continue? (yes/no): ", resolve);
		});
		rl.close();

		if (answer.toLowerCase() !== "yes") {
			console.log("Aborted.");
			process.exit(0);
		}
	} else {
		const localSubnets = getLocalSubnets();
		for (const subnet of localSubnets) {
			totalIps += 254;
		}
	}

	console.log(`   Total IPs to scan: ${totalIps}`);
	console.log(
		`   Estimated time: ~${Math.ceil(((totalIps / (options.concurrency ?? 128)) * (options.timeout ?? 200)) / 1000)}s`,
	);

	console.log("\nScanning...\n");

	// Track last progress for verbose output
	let lastOutput = "";
	const devices: ScannedDevice[] = [];

	// Run scan with streaming
	const result = await scanNetworkStreaming({
		...options,
		onProgress: (progress) => {
			const output = formatProgressBar(progress, options.verbose);

			// Only clear line if output has changed (reduces flicker)
			if (output !== lastOutput) {
				process.stdout.write(output);
				lastOutput = output;
			}
		},
		onDevice: (device) => {
			devices.push(device);
			// Print newline so progress bar continues on next line
			process.stdout.write("\n");
			process.stdout.write(`  ✅ Found: ${formatScannedDevice(device)}\n`);
		},
	});

	// Final newline after progress bar
	process.stdout.write("\n\n");

	// Show results
	console.log("📊 Scan Results:");
	console.log(`   IPs scanned: ${result.totalScanned}/${result.totalIps}`);
	console.log(`   Devices found: ${result.devices.length}`);
	console.log(`   Duration: ${result.duration}ms`);
	console.log(`   Avg time per IP: ${(result.duration / result.totalScanned).toFixed(2)}ms`);

	if (result.devices.length > 0) {
		console.log("\n📺 Devices:");
		for (const device of result.devices) {
			console.log(`   ${formatScannedDevice(device)}`);
		}
	}

	// Output JSON if requested
	if (options.json) {
		console.log("\n" + JSON.stringify({
			devices: result.devices.map(scannedDeviceToJson),
			totalScanned: result.totalScanned,
			totalIps: result.totalIps,
			duration: result.duration,
		}, null, 2));
	}
}

main().catch((error) => {
	console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
