#!/usr/bin/env -S tsx
/**
 * AirPlay device discovery script
 *
 * This script discovers AirPlay devices on the local network using macOS's dns-sd.
 * It can run in different modes for testing and fixture generation.
 *
 * Usage:
 *   tsx scripts/discover-airplay.ts [options]
 *
 * Options:
 *   --mode <mode>        Discovery mode: full, browse-only, lookup, getaddr (default: full)
 *   --timeout <ms>       Timeout for each dns-sd command in milliseconds (default: 5000)
 *   --instance <name>    Specific instance name to lookup (for lookup/getaddr modes)
 *   --raw                Output raw dns-sd responses
 *   --json               Output as JSON
 *   --fixtures           Save fixtures to tests/fixtures directory
 *   --help               Show this help message
 */

import { discoverAirplayDevices, discoverAirplayDevicesWithErrorReporting, discoverAirplayDevicesStreaming } from '../src/adapter/dnssd/controller.js';
import { browseAirplayDevices, lookupDevice, getHostAddresses, isDnsSdAvailable } from '../src/adapter/dnssd/caller.js';
import { parseBrowseOutput, parseLookupOutput, parseGetAddrOutput } from '../src/adapter/dnssd/parser.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Parse command line arguments
 */
function parseArgs(args: string[]): {
	mode: string;
	timeout: number;
	instance: string | null;
	raw: boolean;
	json: boolean;
	fixtures: boolean;
} {
	const options = {
		mode: 'full',
		timeout: 1000,
		instance: null as string | null,
		raw: false,
		json: false,
		fixtures: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		switch (arg) {
			case '--mode':
				options.mode = args[++i]!;
				break;
			case '--timeout':
				options.timeout = Number.parseInt(args[++i]!, 10);
				break;
			case '--instance':
				options.instance = args[++i]!;
				break;
			case '--raw':
				options.raw = true;
				break;
			case '--json':
				options.json = true;
				break;
			case '--fixtures':
				options.fixtures = true;
				break;
			case '--help':
			case '-h':
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
AirPlay Device Discovery Script

Usage:
  tsx scripts/discover-airplay.ts [options]

Options:
  --mode <mode>        Discovery mode:
                       - full: Complete discovery (browse + lookup + getaddr)
                       - browse-only: Only browse for devices
                       - lookup: Lookup specific device (requires --instance)
                       - getaddr: Get addresses for specific hostname (requires --instance)
  --timeout <ms>       Timeout for each dns-sd command in milliseconds (default: 5000)
  --instance <name>    Instance name for lookup/getaddr modes
  --raw                Output raw dns-sd responses
  --json               Output as JSON
  --fixtures           Save fixtures to tests/fixtures directory
  --help, -h           Show this help message

Examples:
  # Discover all AirPlay devices
  tsx scripts/discover-airplay.ts

  # Browse only, with raw output
  tsx scripts/discover-airplay.ts --mode browse-only --raw

  # Lookup specific device
  tsx scripts/discover-airplay.ts --mode lookup --instance "Living Room TV"

  # Save fixtures for testing
  tsx scripts/discover-airplay.ts --fixtures --json
`);
}

/**
 * Save fixture data
 */
function saveFixture(name: string, data: unknown): void {
	const fixturesDir = join(__dirname, '..', 'tests', 'fixtures');
	if (!existsSync(fixturesDir)) {
		mkdirSync(fixturesDir, { recursive: true });
	}

	const fixturePath = join(fixturesDir, `${name}.json`);
	writeFileSync(fixturePath, JSON.stringify(data, null, 2), 'utf-8');
	console.error(`\nFixture saved: ${fixturePath}`);
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
 * Main entry point
 */
async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));

	// Check if dns-sd is available
	if (!isDnsSdAvailable()) {
		console.error('Error: dns-sd is only available on macOS');
		process.exit(1);
	}

	try {
		switch (options.mode) {
			case 'browse-only': {
				const result = await browseAirplayDevices({ timeout: options.timeout });

				if (options.raw) {
					console.log('=== RAW BROWSE OUTPUT ===');
					console.log(result.stdout);
					if (result.stderr) {
						console.log('=== STDERR ===');
						console.log(result.stderr);
					}
				}

				const parsed = parseBrowseOutput(result.stdout);
				console.log(`\nFound ${parsed.length} browse results:`);

				for (const item of parsed) {
					console.log(`  - ${item.action === 'add' ? '+' : '-'} ${item.instanceName} (${item.interface})`);
				}

				if (options.fixtures) {
					saveFixture('browse-result', {
						raw: result.stdout,
						stderr: result.stderr,
						parsed,
					});
				}
				break;
			}

			case 'lookup': {
				if (!options.instance) {
					console.error('Error: --instance is required for lookup mode');
					process.exit(1);
				}

				const result = await lookupDevice(options.instance, { timeout: options.timeout });

				if (options.raw) {
					console.log('=== RAW LOOKUP OUTPUT ===');
					console.log(result.stdout);
					if (result.stderr) {
						console.log('=== STDERR ===');
						console.log(result.stderr);
					}
				}

				const parsed = parseLookupOutput(result.stdout);
				console.log(`\nDevice: ${parsed.instanceName}`);
				console.log(`  Hostname: ${parsed.hostname}`);
				console.log(`  Port: ${parsed.port}`);
				console.log(`  TXT Records:`);
				for (const record of parsed.txtRecords) {
					console.log(`    ${record.key} = ${record.value}`);
				}

				if (options.fixtures) {
					saveFixture('lookup-result', {
						instanceName: options.instance,
						raw: result.stdout,
						stderr: result.stderr,
						parsed,
					});
				}
				break;
			}

			case 'getaddr': {
				if (!options.instance) {
					console.error('Error: --instance is required for getaddr mode');
					process.exit(1);
				}

				const result = await getHostAddresses(options.instance, { timeout: options.timeout });

				if (options.raw) {
					console.log('=== RAW GETADDR OUTPUT ===');
					console.log(result.stdout);
					if (result.stderr) {
						console.log('=== STDERR ===');
						console.log(result.stderr);
					}
				}

				const parsed = parseGetAddrOutput(result.stdout);
				console.log(`\nAddresses for ${options.instance}:`);
				for (const addr of parsed) {
					console.log(`  ${addr.addressType}: ${addr.address}`);
				}

				if (options.fixtures) {
					saveFixture('getaddr-result', {
						hostname: options.instance,
						raw: result.stdout,
						stderr: result.stderr,
						parsed,
					});
				}
				break;
			}

			case 'full': {
				let deviceCount = 0;
				let errorCount = 0;

				console.log('\n🔍 Discovering AirPlay devices (streaming results)...\n');

				const result = await discoverAirplayDevicesStreaming({
					timeout: options.timeout,
					continueOnError: true,
					onBrowseResult: (browseResult) => {
						console.log(`  → Found: ${browseResult.instanceName} (interface: ${browseResult.interface})`);
					},
					onDevice: (device) => {
						deviceCount++;
						console.log(`\n✅ Resolved device ${deviceCount}: ${device.instanceName}`);
						console.log(`   Hostname: ${device.hostname}`);
						console.log(`   Port: ${device.port}`);
						if (device.ipv4Addresses.length > 0) {
							console.log(`   IPv4: ${device.ipv4Addresses.join(', ')}`);
						}
						if (device.ipv6Addresses.length > 0) {
							console.log(`   IPv6: ${device.ipv6Addresses.join(', ')}`);
						}
						if (device.txtRecords.size > 0) {
							// Show a few key metadata items
							const model = device.txtRecords.get('model');
							const manufacturer = device.txtRecords.get('manufacturer');
							if (model || manufacturer) {
								console.log(`   Info: ${manufacturer ?? ''} ${model ?? ''}`.trim());
							}
						}
					},
					onError: (error) => {
						errorCount++;
						console.log(`\n⚠️  Error: ${error.instanceName} (${error.stage}): ${error.error}`);
					},
				});

				console.log(`\n\n📊 Summary:`);
				console.log(`   Total devices found: ${result.devices.length}`);
				if (result.errors.length > 0) {
					console.log(`   Total errors: ${result.errors.length}`);
				}

				// Show detailed device info if --raw is specified
				if (options.raw && result.devices.length > 0) {
					console.log('\n=== DETAILED DEVICE INFO ===\n');
					for (const device of result.devices) {
						console.log(`📺 ${device.instanceName}`);
						console.log(`   Hostname: ${device.hostname}`);
						console.log(`   Port: ${device.port}`);
						if (device.ipv4Addresses.length > 0) {
							console.log(`   IPv4: ${device.ipv4Addresses.join(', ')}`);
						}
						if (device.ipv6Addresses.length > 0) {
							console.log(`   IPv6: ${device.ipv6Addresses.join(', ')}`);
						}
						if (device.txtRecords.size > 0) {
							console.log(`   Metadata:`);
							for (const [key, value] of device.txtRecords) {
								console.log(`     ${key} = ${value}`);
							}
						}
						console.log('');
					}

					// Show raw intermediate results
					console.log('\n=== RAW INTERMEDIATE RESULTS ===\n');
					console.log('--- Browse Raw ---');
					console.log(result.intermediate.browseRaw);
					console.log('\n--- Lookups ---');
					for (const [name, data] of result.intermediate.lookups) {
						console.log(`\n${name}:`);
						console.log(data.raw);
					}
					console.log('\n--- Addresses ---');
					for (const [name, data] of result.intermediate.addresses) {
						console.log(`\n${name}:`);
						console.log(data.raw);
					}
				}

				if (options.fixtures) {
					saveFixture('discovery-result', {
						devices: result.devices,
						errors: result.errors,
						intermediate: {
							browseRaw: result.intermediate.browseRaw,
							browseParsed: result.intermediate.browseParsed,
							lookups: Array.from(result.intermediate.lookups.entries()),
							addresses: Array.from(result.intermediate.addresses.entries()),
						},
					});
				}

				if (options.json) {
					outputData(result, options);
				}
				break;
			}

			default:
				console.error(`Unknown mode: ${options.mode}`);
				console.error('Valid modes: full, browse-only, lookup, getaddr');
				process.exit(1);
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		if (options.fixtures) {
			// Save error as fixture for testing failure modes
			saveFixture('error-' + options.mode, {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		}
		process.exit(1);
	}
}

main();
