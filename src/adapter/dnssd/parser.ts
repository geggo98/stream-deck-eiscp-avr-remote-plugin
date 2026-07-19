/**
 * Types representing parsed DNS-SD output
 */

/**
 * Parsed result from browsing for AirPlay devices
 */
export interface BrowseResult {
	readonly timestamp: number;
	readonly action: "add" | "remove";
	readonly interface: string;
	readonly domain: string;
	readonly serviceType: string;
	readonly instanceName: string;
}

/**
 * Parsed TXT record from lookup result
 */
export interface TxtRecord {
	readonly key: string;
	readonly value: string;
}

/**
 * Parsed result from looking up a device
 */
export interface LookupResult {
	readonly instanceName: string;
	readonly serviceType: string;
	readonly domain: string;
	readonly hostname: string;
	readonly port: number;
	readonly txtRecords: readonly TxtRecord[];
}

/**
 * IP address type
 */
export type AddressType = "ipv4" | "ipv6";

/**
 * Parsed IP address result
 */
export interface AddressResult {
	readonly hostname: string;
	readonly addressType: AddressType;
	readonly address: string;
}

/**
 * All information about a discovered AirPlay device
 */
export interface AirPlayDevice {
	readonly instanceName: string;
	readonly hostname: string;
	readonly ipv4Addresses: readonly string[];
	readonly ipv6Addresses: readonly string[];
	readonly port: number;
	readonly txtRecords: ReadonlyMap<string, string>;
}

/**
 * Error thrown when parsing fails
 */
export class ParseError extends Error {
	declare public readonly rawOutput: string;

	constructor(message: string, rawOutput: string) {
		super(message);
		this.name = "ParseError";
		this.rawOutput = rawOutput;
	}
}

/**
 * Parses the output of `dns-sd -B _airplay._tcp`
 *
 * Input format:
 * ```
 * TIMESTAMP   A/R  IF  Domain  Service Type  Instance Name
 * 1234567890  Add   3   local.  _airplay._tcp  Living Room TV
 * ```
 *
 * @param output - The stdout from dns-sd browse command
 * @returns Array of parsed browse results
 */
export function parseBrowseOutput(output: string): BrowseResult[] {
	const results: BrowseResult[] = [];
	const lines = output.split("\n").filter((line) => line.trim() !== "");

	for (const line of lines) {
		// Skip header lines that start with "Browsing for", "DATE:", "STARTING", or contain "Timestamp"
		if (
			line.includes("Browsing for") ||
			line.includes("browsing for") ||
			line.includes("DATE:") ||
			line.includes("STARTING") ||
			line.includes("Timestamp") ||
			line.includes("Instance Name")
		) {
			continue;
		}

		// Skip stop signal lines (e.g., " ^C" or "Stop")
		if (line.includes("Stop") || /^\s*\^C/.test(line)) {
			continue;
		}

		// Parse the browse result line
		// Format: HH:MM:SS.mmm A/R Flags if Domain ServiceType InstanceName
		// The timestamp includes colons (HH:MM:SS.mmm format)
		const match = line.match(
			/^\s*(\d{2}:\d{2}:\d{2}\.\d+)\s+(Add|Rmv)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/,
		);

		if (!match) {
			// Skip lines that don't match the expected format
			continue;
		}

		// All capture groups in the regex are non-optional, so they exist when it matched.
		const timestamp = match[1]!;
		const action = match[2]!;
		const iface = match[4]!;
		const domain = match[5]!;
		const serviceType = match[6]!;
		const instanceName = match[7]!;

		// Convert timestamp to milliseconds since epoch (simplified - just use the string as identifier)
		// For a real implementation, you'd parse the date/time from context
		const timeMatch = timestamp.match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
		let timeValue = 0;
		if (timeMatch) {
			// All four capture groups are non-optional, so they exist when the regex matched.
			const hours = timeMatch[1]!;
			const minutes = timeMatch[2]!;
			const seconds = timeMatch[3]!;
			const millis = timeMatch[4]!;
			timeValue =
				(Number.parseInt(hours, 10) * 3600 +
					Number.parseInt(minutes, 10) * 60 +
					Number.parseInt(seconds, 10)) *
					1000 +
				Number.parseInt(millis, 10);
		}

		results.push({
			timestamp: timeValue,
			action: action === "Add" ? "add" : "remove",
			interface: iface,
			domain,
			serviceType,
			instanceName: instanceName.trim(),
		});
	}

	return results;
}

/**
 * Parses the output of `dns-sd -L "name" _airplay._tcp local.`
 *
 * Input format:
 * ```
 * Living Room TV._airplay._tcp.local. can be reached at Apple-TV.local.:7000
 *   (deviceid=AA:BB:CC:DD:EE:FF, features=0x12345678, model=AppleTV6,2, pk=...)
 * ```
 *
 * @param output - The stdout from dns-sd lookup command
 * @returns Parsed lookup result
 * @throws {ParseError} If output cannot be parsed
 */
export function parseLookupOutput(output: string): LookupResult {
	const lines = output.split("\n").filter((line) => line.trim() !== "");

	if (lines.length === 0) {
		throw new ParseError("Empty output", output);
	}

	// Skip header lines like "Lookup", "DATE:", "STARTING"
	// Also skip lines that are just timestamps without any device info
	let firstDataLineIndex = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;

		// Skip obvious header lines
		if (
			line.startsWith("Lookup") ||
			line.includes("DATE:") ||
			line.includes("STARTING")
		) {
			continue;
		}

		// Skip lines that are ONLY a timestamp (no "can be reached at")
		if (line.match(/^\d{2}:\d{2}:\d{2}\.\d+\s*$/)) {
			continue;
		}

		// Found a data line
		firstDataLineIndex = i;
		break;
	}

	// Parse the data line: "Instance._airplay._tcp.local. can be reached at hostname.:port"
	// The line may optionally start with a timestamp
	const firstLine = lines[firstDataLineIndex]!;
	const firstLineMatch = firstLine.match(
		/^(?:\d{2}:\d{2}:\d{2}\.\d+\s+)?(.+)\._airplay\._tcp\.local\.\s+can be reached at\s+(.+)\.local\.:(\d+)(\s+\(interface\s+\d+\))?/,
	);

	if (!firstLineMatch) {
		throw new ParseError(`Cannot parse lookup first line: ${firstLine}`, output);
	}

	// Capture groups 1-3 are non-optional, so they exist when the regex matched.
	const instanceName = firstLineMatch[1]!;
	const hostname = firstLineMatch[2]!;
	const portStr = firstLineMatch[3]!;

	// Parse TXT records from remaining lines
	// Format: key1=value1 key2=value2 (space-separated, not comma-separated)
	// Note: Spaces within values are escaped as \ (backslash-space)
	const txtRecords: TxtRecord[] = [];

	for (let i = firstDataLineIndex + 1; i < lines.length; i++) {
		const line = lines[i]!;
		// Skip empty lines and lines starting with non-key=value format
		if (!line.trim() || line.match(/^\d{2}:\d{2}:\d{2}\.\d+\s*$/)) {
			continue;
		}

		// Parse space-separated key=value pairs
		// The tricky part is that spaces within values are escaped as \
		// We need to find the boundaries between pairs (spaces not preceded by \)
		// Strategy: find all key=value boundaries by finding spaces not preceded by backslash

		const pairs: string[] = [];
		let current = "";
		for (let j = 0; j < line.length; j++) {
			const char = line[j]!;
			const nextChar = line[j + 1];

			// Check if this is a space that's not escaped (not preceded by backslash)
			if (char === " " && line[j - 1] !== "\\") {
				// This is a delimiter between pairs
				if (current.trim()) {
					pairs.push(current.trim());
				}
				current = "";
			} else {
				current += char;
			}
		}
		if (current.trim()) {
			pairs.push(current.trim());
		}

		for (const pair of pairs) {
			const eqIndex = pair.indexOf("=");
			if (eqIndex > 0) {
				let key = pair.slice(0, eqIndex);
				let value = pair.slice(eqIndex + 1);

				// Unescape common escape sequences
				// \\  (backslash-space) = space
				value = value.replace(/\\ /g, " ");
				// \032 = space (octal)
				value = value.replace(/\\032/g, " ");
				// \& = literal &
				value = value.replace(/\\&/g, "&");
				// \\ = literal backslash (at end of value)
				value = value.replace(/\\\\$/g, "\\");

				txtRecords.push({ key, value });
			}
		}
	}

	return {
		instanceName: instanceName.trim(),
		serviceType: "_airplay._tcp",
		domain: "local.",
		hostname: `${hostname}.local.`,
		port: Number.parseInt(portStr, 10),
		txtRecords,
	};
}

/**
 * Parses the output of `dns-sd -G v4v6 hostname.local`
 *
 * Input format (table format with monitoring):
 * ```
 * DATE: ---Sun 01 Feb 2026---
 * 14:15:36.906  ...STARTING...
 * Timestamp     A/R  Flags         IF  Hostname                               Address                                      TTL
 * 14:15:36.907  Add  40000002      14  hostname.local.                       192.168.1.100                                 120
 * 14:15:36.907  Add  40000003      14  hostname.local.                       FE80::1234:5678:90ab:cdef%en0                120
 * ```
 *
 * Alternative format (simple format):
 * ```
 * DNS-SD (v4v6) hostname.local.
 * > IPv4 address: 192.168.1.100
 * > IPv6 address: fe80::1234:5678:90ab:cdef
 * ```
 *
 * @param output - The stdout from dns-sd getaddrinfo command
 * @returns Array of parsed address results
 * @throws {ParseError} If output cannot be parsed
 */
export function parseGetAddrOutput(output: string): AddressResult[] {
	const results: AddressResult[] = [];
	const lines = output.split("\n");

	// Try simple format first: "DNS-SD (v4v6) hostname.local."
	let simpleFormat = false;
	let hostname = "";

	for (const line of lines) {
		const trimmed = line.trim();

		// Skip header lines
		if (
			trimmed.includes("DATE:") ||
			trimmed.includes("STARTING") ||
			(trimmed.includes("Timestamp") && trimmed.includes("Hostname"))
		) {
			continue;
		}

		// Check for simple format header
		if (trimmed.match(/^DNS-SD \(v4v6\)/)) {
			simpleFormat = true;
			const hostnameMatch = trimmed.match(/^DNS-SD \(v4v6\)\s+(.+)\.$/);
			if (hostnameMatch) {
				// The capture group is non-optional, so it exists when the regex matched.
				hostname = hostnameMatch[1]!;
			}
			continue;
		}

		// Simple format address lines: "> IPv4 address: 192.168.1.100"
		if (simpleFormat) {
			const addressMatch = trimmed.match(/^>\s+(IPv4|IPv6)\s+address:\s+(.+)$/);
			if (addressMatch) {
				// Both capture groups are non-optional, so they exist when the regex matched.
				const type = addressMatch[1]!;
				const address = addressMatch[2]!;
				results.push({
					hostname,
					addressType: type === "IPv4" ? "ipv4" : "ipv6",
					address: address.trim(),
				});
			}
			continue;
		}

		// Table format: Parse data rows after header
		// Data line: "14:15:36.907  Add  40000002      14  hostname.local.  192.168.1.100  120"
		// Flags ending in 2 indicate IPv4, 3 indicate IPv6
		const tableMatch = trimmed.match(
			/^\d{2}:\d{2}:\d{2}\.\d+\s+(Add|Rmv)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s+(\d+)$/,
		);
		if (tableMatch) {
			// All capture groups are non-optional, so they exist when the regex matched.
			const flags = tableMatch[2]!;
			const host = tableMatch[4]!;
			const address = tableMatch[5]!;
			// Last hex digit of flags: 2 = IPv4, 3 = IPv6
			const lastFlag = flags.slice(-1);
			const addressType = lastFlag === "2" ? "ipv4" : "ipv6";

			results.push({
				hostname: host,
				addressType,
				address: address.trim(),
			});
		}
	}

	return results;
}

/**
 * Combines lookup and address results into a complete device info
 *
 * @param lookup - The parsed lookup result
 * @param addresses - The parsed address results
 * @returns Complete AirPlay device information
 */
export function combineDeviceInfo(
	lookup: LookupResult,
	addresses: readonly AddressResult[],
): AirPlayDevice {
	const ipv4Addresses = addresses
		.filter((a) => a.addressType === "ipv4")
		.map((a) => a.address);

	const ipv6Addresses = addresses
		.filter((a) => a.addressType === "ipv6")
		.map((a) => a.address);

	const txtRecords = new Map<string, string>();
	for (const record of lookup.txtRecords) {
		txtRecords.set(record.key, record.value);
	}

	return {
		instanceName: lookup.instanceName,
		hostname: lookup.hostname,
		ipv4Addresses,
		ipv6Addresses,
		port: lookup.port,
		txtRecords,
	};
}
