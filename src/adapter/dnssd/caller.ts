import { spawn, ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { EventEmitter } from "node:events";

/**
 * Platform check - dns-sd is only available on macOS
 */
export function isDnsSdAvailable(): boolean {
	return platform() === "darwin";
}

/**
 * Result type for dns-sd command execution
 */
export interface DnsSdResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly timedOut: boolean;
	/** Set when the dns-sd process could not be spawned at all */
	readonly spawnError?: string;
}

/**
 * Configuration options for dns-sd command execution
 */
export interface DnsSdOptions {
	/**
	 * Command timeout in milliseconds
	 * @default 5000
	 */
	readonly timeout?: number;
	/**
	 * Additional arguments to pass to dns-sd
	 */
	readonly extraArgs?: readonly string[];
	/**
	 * Callback invoked when new stdout data arrives
	 * @param data - The raw stdout data received so far
	 */
	readonly onData?: (data: string) => void;
	/**
	 * Callback invoked when a complete line is received
	 * @param line - The complete line (without newline)
	 */
	readonly onLine?: (line: string) => void;
}

/**
 * Executes dns-sd browse command to discover AirPlay devices
 *
 * @param options - Configuration options
 * @returns Promise resolving to the command result
 * @throws {Error} If dns-sd is not available on this platform
 */
export async function browseAirplayDevices(
	options: DnsSdOptions = {},
): Promise<DnsSdResult> {
	if (!isDnsSdAvailable()) {
		throw new Error("dns-sd is only available on macOS");
	}

	// dns-sd -B _airplay._tcp local.
	// dns-sd -B has no timeout parameter; the trailing seconds argument below
	// is ignored by dns-sd. The actual timeout is enforced in executeDnsSd
	// (setTimeout + SIGTERM) — dns-sd -B runs until killed.
	const timeoutSeconds = Math.ceil((options.timeout ?? 5000) / 1000);

	const args = ["-B", "_airplay._tcp", "local.", String(timeoutSeconds)];
	if (options.extraArgs) {
		args.push(...options.extraArgs);
	}

	return executeDnsSd(args, options);
}

/**
 * Executes dns-sd lookup command to resolve device metadata and hostname
 *
 * @param instanceName - The instance name from browse results
 * @param options - Configuration options
 * @returns Promise resolving to the command result
 * @throws {Error} If dns-sd is not available on this platform
 */
export async function lookupDevice(
	instanceName: string,
	options: DnsSdOptions = {},
): Promise<DnsSdResult> {
	if (!isDnsSdAvailable()) {
		throw new Error("dns-sd is only available on macOS");
	}

	// dns-sd -L "instance name" _airplay._tcp local.
	const args = ["-L", instanceName, "_airplay._tcp", "local."];
	if (options.extraArgs) {
		args.push(...options.extraArgs);
	}

	return executeDnsSd(args, options);
}

/**
 * Executes dns-sd getaddrinfo command to resolve hostname to IP addresses
 *
 * @param hostname - The hostname from lookup results
 * @param options - Configuration options
 * @returns Promise resolving to the command result
 * @throws {Error} If dns-sd is not available on this platform
 */
export async function getHostAddresses(
	hostname: string,
	options: DnsSdOptions = {},
): Promise<DnsSdResult> {
	if (!isDnsSdAvailable()) {
		throw new Error("dns-sd is only available on macOS");
	}

	// dns-sd -G v4v6 hostname.local
	const args = ["-G", "v4v6", hostname];
	if (options.extraArgs) {
		args.push(...options.extraArgs);
	}

	return executeDnsSd(args, options);
}

/**
 * Executes a dns-sd command with timeout
 *
 * @param args - Command arguments
 * @param options - Execution options including timeout and callbacks
 * @returns Promise resolving to the command result
 */
async function executeDnsSd(
	args: string[],
	options: DnsSdOptions = {},
): Promise<DnsSdResult> {
	const { timeout = 5000, onData, onLine } = options;

	return new Promise((resolve) => {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let currentLine = "";

		let child: ChildProcess;
		let timedOut = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		// Set up timeout
		if (timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				child.kill("SIGTERM");
			}, timeout);
		}

		// Spawn the dns-sd process
		child = spawn("dns-sd", args, {
			env: { ...process.env, LC_ALL: "C" }, // Ensure consistent output format
		});

		// Process stdout line by line as it arrives
		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutChunks.push(chunk);

			// Convert chunk to string and process
			const text = chunk.toString("utf-8");
			currentLine += text;

			// Process complete lines
			const lines = currentLine.split("\n");
			// Keep the last (potentially incomplete) line in the buffer
			currentLine = lines.pop() ?? "";

			// Call onData with accumulated output so far
			if (onData) {
				onData(Buffer.concat(stdoutChunks as Uint8Array[]).toString("utf-8"));
			}

			// Call onLine for each complete line
			if (onLine) {
				for (const line of lines) {
					if (line.length > 0) {
						onLine(line);
					}
				}
			}
		});

		// Collect stderr
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrChunks.push(chunk);
		});

		// Handle process exit
		child.on("close", (exitCode, signal) => {
			if (timeoutHandle !== undefined) {
				clearTimeout(timeoutHandle);
			}

			// Process any remaining data in the line buffer
			if (currentLine.length > 0 && onLine) {
				onLine(currentLine);
			}

			resolve({
				stdout: Buffer.concat(stdoutChunks as Uint8Array[]).toString("utf-8"),
				stderr: Buffer.concat(stderrChunks as Uint8Array[]).toString("utf-8"),
				exitCode: timedOut ? null : exitCode,
				signal: timedOut ? null : signal,
				timedOut,
			});
		});

		// Handle spawn errors. Resolve (executeDnsSd never rejects), but mark
		// the result so callers can tell "dns-sd missing" from "no devices".
		child.on("error", (error) => {
			if (timeoutHandle !== undefined) {
				clearTimeout(timeoutHandle);
			}

			resolve({
				stdout: Buffer.concat(stdoutChunks as Uint8Array[]).toString("utf-8"),
				stderr: error.message,
				exitCode: null,
				signal: null,
				timedOut: false,
				spawnError: error.message,
			});
		});
	});
}
