#!/usr/bin/env -S tsx
/**
 * eISCP CLI Tool
 *
 * Command-line interface for controlling Onkyo/Pioneer receivers via eISCP protocol.
 *
 * Usage:
 *   tsx scripts/eiscp-cli.ts <command> [options]
 *
 * Commands:
 *   state              Show current receiver state
 *   power <on|off>     Set power state
 *   volume <0-100>     Set volume percentage
 *   volume-up          Increase volume
 *   volume-down        Decrease volume
 *   mute <on|off|toggle> Set mute state
 *   input <name>       Set input source
 *   mode <name>        Set listening mode
 *   dump               Dump all raw packets (for test fixtures)
 *   listen             Listen and decode all packets from receiver
 *   query-all          Query and display all state
 *   list-inputs        List available input sources
 *   list-modes         List available listening modes
 *
 * Options:
 *   --host <address>   Receiver IP address (default: 10.2.0.32)
 *   --port <port>      Receiver port (default: 60128)
 *   --json             Output JSON format
 *   --raw              Show raw packet data
 */

import { createClient, type DecodedMessage } from "../src/adapter/eiscp/index.js";
import { InputSource, ListeningMode } from "../src/adapter/eiscp/enums.js";

// Default configuration
const DEFAULT_HOST = "10.2.0.32";
const DEFAULT_PORT = 60128;

interface Options {
	host: string;
	port: number;
	json: boolean;
	raw: boolean;
	command: string;
	commandArgs: string[];
}

// Parsed command line arguments
let args = process.argv.slice(2);
let options: Options = {
	host: DEFAULT_HOST,
	port: DEFAULT_PORT,
	json: false,
	raw: false,
	command: "",
	commandArgs: [],
};

// Parse arguments
while (args.length > 0) {
	const arg = args.shift()!;

	if (arg === "--host" && args.length > 0) {
		options.host = args.shift()!;
	} else if (arg === "--port" && args.length > 0) {
		options.port = Number.parseInt(args.shift()!, 10);
	} else if (arg === "--json") {
		options.json = true;
	} else if (arg === "--raw") {
		options.raw = true;
	} else if (!arg.startsWith("-") && options.command === "") {
		options.command = arg;
		// Remaining args are command arguments
		options.commandArgs = args;
		args = []; // Consume all remaining args
	}
}

// Logging utilities
function log(message: string): void {
	if (!options.json) {
		console.log(message);
	}
}

function logJson(obj: unknown): void {
	console.log(JSON.stringify(obj, null, 2));
}

function error(message: string): never {
	console.error(`Error: ${message}`);
	process.exit(1);
}

/**
 * Format a decoded message for display
 */
function formatMessage(msg: DecodedMessage, raw: boolean, json: boolean): string {
	if (json) {
		return JSON.stringify(msg, null, 2);
	}

	const timestamp = new Date().toISOString();
	let output = `[${timestamp}] ${msg.command}`;

	switch (msg.type) {
		case "power":
			output += ` | Power: ${msg.on ? "ON" : "OFF"}`;
			break;
		case "volume":
			output += ` | Volume: ${msg.level}${msg.percent !== undefined ? ` (${msg.percent.toFixed(1)}%)` : ""}`;
			break;
		case "mute":
			output += ` | Mute: ${msg.muted ? "ON" : "OFF"}`;
			break;
		case "input":
			if (msg.input) {
				output += ` | Input: ${msg.input.name} (0x${msg.input.hex}, ${msg.input.decimal})`;
			} else {
				output += ` | Input: Unknown (0x${msg.parameter})`;
			}
			break;
		case "listeningMode":
			if (msg.mode) {
				output += ` | Mode: ${msg.mode.name} (0x${msg.mode.hex}, ${msg.mode.decimal})`;
			} else {
				output += ` | Mode: Unknown (0x${msg.parameter})`;
			}
			break;
		case "audioEq":
			output += ` | Audio EQ: 0x${msg.parameter}`;
			break;
		case "displayField":
			if (msg.text) {
				output += ` | Display: "${msg.text}"`;
			} else {
				output += ` | Display: <hex decode failed>`;
			}
			if (raw) {
				output += ` | Raw param: 0x${msg.parameter}`;
			}
			break;
		case "networkService":
			if (msg.service) {
				output += ` | Net Service: ${msg.service.name} (key: ${msg.service.key})`;
			} else {
				output += ` | Net Service: ${msg.subCommand}${msg.parameter.slice(1)}`;
			}
			break;
		case "networkTrack":
			output += ` | Net Track: 0x${msg.parameter}`;
			break;
		case "unknown":
			output += ` | Unknown: ${msg.raw}`;
			if (raw) {
				output += ` | Command: ${msg.command} | Param: 0x${msg.parameter}`;
			}
			break;
	}

	if (raw && msg.type !== "displayField" && msg.type !== "unknown") {
		output += ` | Raw: ${msg.raw}`;
	}

	return output;
}

// Display help
function showHelp(): void {
	console.log(`
eISCP CLI Tool - Control Onkyo/Pioneer receivers

Usage: tsx scripts/eiscp-cli.ts <command> [options]

Commands:
  state                  Show current receiver state
  power <on|off>         Set power state
  volume <0-100>         Set volume percentage
  volume-up              Increase volume
  volume-down            Decrease volume
  mute <on|off|toggle>   Set mute state
  input <name>           Set input source
  mode <name>            Set listening mode
  dump                   Dump all raw packets (for test fixtures)
  listen                 Listen and decode all packets from receiver
  query-all              Query and display all state
  list-inputs            List available input sources
  list-modes             List available listening modes
  help                   Show this help message

Options:
  --host <address>       Receiver IP address (default: ${DEFAULT_HOST})
  --port <port>          Receiver port (default: ${DEFAULT_PORT})
  --json                 Output JSON format
  --raw                  Show raw packet data

Examples:
  tsx scripts/eiscp-cli.ts state
  tsx scripts/eiscp-cli.ts power on
  tsx scripts/eiscp-cli.ts volume 50
  tsx scripts/eiscp-cli.ts input BLURAY_DVD
  tsx scripts/eiscp-cli.ts --host 192.168.1.100 state
  tsx scripts/eiscp-cli.ts dump
  tsx scripts/eiscp-cli.ts listen
`);
}

// Main execution
async function main(): Promise<void> {
	if (!options.command || options.command === "help") {
		showHelp();
		process.exit(options.command === "help" ? 0 : 1);
	}

	// Create client
	const client = createClient({
		host: options.host,
		port: options.port,
		debugLog: options.raw,
	});

	// Packet dump mode
	if (options.command === "dump") {
		log(`Connecting to ${options.host}:${options.port}...`);
		log("Dumping raw packets. Press Ctrl+C to stop.");

		client.on("rawPacket", (direction, packet) => {
			const timestamp = new Date().toISOString();
			// Sent packets are EncodedPacket, received ones EiscpPacket.
			if (direction === "sent" && "iscpMessage" in packet) {
				console.log(`[${timestamp}] SENT: ${packet.iscpMessage}`);
				if (options.raw) {
					console.log(`  Raw: ${packet.bytes.toString("hex")}`);
				}
			} else if ("header" in packet) {
				console.log(`[${timestamp}] RECV: ${packet.message}`);
				if (options.raw) {
					console.log(`  Header: ${packet.header}`);
					console.log(`  Data size: ${packet.dataSize}`);
					console.log(`  Version: ${packet.version.toString("hex")}`);
				}
			}
		});

		client.on("error", (err) => {
			console.error(`[ERROR] ${err.message}`);
		});

		await client.connect();

		// Keep running until interrupted
		process.on("SIGINT", () => {
			log("\nDisconnecting...");
			client.disconnect();
			process.exit(0);
		});

		return;
	}

	// Listen mode - decode and display all packets
	if (options.command === "listen") {
		log(`Connecting to ${options.host}:${options.port}...`);
		log("Listening for decoded packets. Press Ctrl+C to stop.");

		client.on("message", (msg) => {
			if (options.json) {
				console.log(formatMessage(msg, false, true));
			} else {
				console.log(formatMessage(msg, options.raw, false));
			}
		});

		client.on("error", (err) => {
			console.error(`[ERROR] ${err.message}`);
		});

		await client.connect();

		// Keep running until interrupted
		process.on("SIGINT", () => {
			log("\nDisconnecting...");
			client.disconnect();
			process.exit(0);
		});

		return;
	}

	// Connect for other commands
	try {
		log(`Connecting to ${options.host}:${options.port}...`);
		await client.connect();
		log("Connected.");

		// Execute command
		await executeCommand(client, options.command, options.commandArgs);

		// Disconnect
		client.disconnect();
	} catch (err) {
		error(err instanceof Error ? err.message : String(err));
	}
}

// Execute command
async function executeCommand(
	client: ReturnType<typeof createClient>,
	command: string,
	args: string[],
): Promise<void> {
	switch (command) {
		case "state": {
			await client.refreshState();
			const state = client.getState();
			if (options.json) {
				logJson({
					power: state.power,
					volume: state.volume,
					volumePercent: client.getVolumePercent(),
					muted: state.muted,
					input: state.input,
					listeningMode: state.listeningMode,
				});
			} else {
				console.log("\nReceiver State:");
				console.log(`  Power: ${state.power ? "ON" : "OFF"}`);
				console.log(
					`  Volume: ${state.volume} / ${client.getVolumeConfig().max} (${client.getVolumePercent().toFixed(1)}%)`,
				);
				console.log(`  Mute: ${state.muted ? "ON" : "OFF"}`);
				console.log(`  Input: ${state.input || "(unknown)"}`);
				console.log(`  Listening Mode: ${state.listeningMode || "(unknown)"}`);
				console.log("");
			}
			break;
		}

		case "query-all": {
			log("Querying receiver state...");
			await client.refreshState();
			// Show state (re-use state command logic)
			await executeCommand(client, "state", []);
			break;
		}

		case "power": {
			const arg = args[0]?.toLowerCase();
			if (arg !== "on" && arg !== "off") {
				error("Power command requires 'on' or 'off' argument");
			}
			log(`Setting power ${arg}...`);
			await client.setPower(arg === "on");
			log(`Power turned ${arg}.`);
			break;
		}

		case "volume": {
			const percent = Number.parseFloat(args[0]!);
			if (Number.isNaN(percent) || percent < 0 || percent > 100) {
				error("Volume command requires a percentage between 0 and 100");
			}
			log(`Setting volume to ${percent}%...`);
			await client.setVolumePercent(percent);
			log(`Volume set to ${percent}%.`);
			break;
		}

		case "volume-up": {
			log("Increasing volume...");
			await client.volumeUp();
			const state = client.getState();
			log(`Volume: ${state.volume} (${client.getVolumePercent().toFixed(1)}%)`);
			break;
		}

		case "volume-down": {
			log("Decreasing volume...");
			await client.volumeDown();
			const state = client.getState();
			log(`Volume: ${state.volume} (${client.getVolumePercent().toFixed(1)}%)`);
			break;
		}

		case "mute": {
			const arg = args[0]?.toLowerCase();
			if (arg === "toggle") {
				log("Toggling mute...");
				await client.toggleMute();
			} else if (arg === "on") {
				log("Muting...");
				await client.mute();
			} else if (arg === "off") {
				log("Unmuting...");
				await client.unmute();
			} else {
				error("Mute command requires 'on', 'off', or 'toggle' argument");
			}
			log(`Mute ${arg === "toggle" ? "toggled" : arg}.`);
			break;
		}

		case "input": {
			const inputName = args[0];
			if (!inputName) {
				error("Input command requires an input name");
			}
			log(`Setting input to ${inputName}...`);
			// setInput validates the name at runtime and throws on unknown keys.
			await client.setInput(inputName as keyof typeof InputSource);
			log(`Input set to ${inputName}.`);
			break;
		}

		case "mode": {
			const modeName = args[0];
			if (!modeName) {
				error("Mode command requires a mode name");
			}
			log(`Setting listening mode to ${modeName}...`);
			// setListeningMode validates the name at runtime and throws on unknown keys.
			await client.setListeningMode(modeName as keyof typeof ListeningMode);
			log(`Listening mode set to ${modeName}.`);
			break;
		}

		case "list-inputs": {
			console.log("\nAvailable Input Sources:");
			for (const [key, value] of Object.entries(InputSource)) {
				console.log(`  ${key.padEnd(20)} (0x${value.hex}, ${value.decimal}) - ${value.name}`);
			}
			console.log("");
			break;
		}

		case "list-modes": {
			console.log("\nAvailable Listening Modes:");
			for (const [key, value] of Object.entries(ListeningMode)) {
				console.log(
					`  ${key.padEnd(25)} (0x${value.hex}, ${value.decimal}) - ${value.name}`,
				);
			}
			console.log("");
			break;
		}

		default:
			error(`Unknown command: ${command}`);
	}
}

// Run
main().catch((err) => {
	error(err instanceof Error ? err.message : String(err));
});
