/**
 * Adapter-layer logging indirection.
 *
 * Importing `@elgato/streamdeck` rotates the SDK's log files as a module
 * side effect. Adapter modules also run in scripts and in parallel test
 * processes, where concurrent rotation races crash the process (ENOENT from
 * FileTarget.reIndex). They therefore must not import the SDK; they log
 * through this indirection instead. The plugin entry point injects the SDK
 * logger at startup, everything else falls back to the console.
 */

/**
 * Make an untrusted string safe to put in a log line.
 *
 * Parse errors used to embed the peer's bytes verbatim (`ISCP message too
 * short: ${trimmed}`), so a peer controlled both the content and the volume of
 * the plugin's log files — up to 10x50 MB on disk, and control characters
 * (including ANSI escapes, since ASCII decoding masks the high bit rather than
 * rejecting) went straight into a file a maintainer later opens in a terminal.
 *
 * @param value - Untrusted text.
 * @param maxLength - Characters kept before eliding the rest.
 */
export function truncateForLog(value: string, maxLength = 120): string {
	let out = "";
	for (const ch of value) {
		if (out.length >= maxLength) return `${out}… (${value.length} chars total)`;
		const code = ch.codePointAt(0)!;
		// Escape rather than drop, so the log still shows that something was there.
		out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, "0")}` : ch;
	}
	return out;
}

/** Minimal logger contract shared by `console` and the SDK logger. */
export interface AdapterLogger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

let root: AdapterLogger = console;

/** Route adapter logging to the given logger (called once by the plugin). */
export function setAdapterLogger(logger: AdapterLogger): void {
	root = logger;
}

/**
 * A logger that prefixes messages with a scope name and always delegates to
 * the currently injected root logger (late binding, so module-level scoped
 * loggers pick up the plugin's logger even when created before injection).
 */
export function scopedLogger(scope: string): AdapterLogger {
	const prefix = (message: string) => `${scope}: ${message}`;
	return {
		debug: (message) => root.debug(prefix(message)),
		info: (message) => root.info(prefix(message)),
		warn: (message) => root.warn(prefix(message)),
		error: (message) => root.error(prefix(message)),
	};
}
