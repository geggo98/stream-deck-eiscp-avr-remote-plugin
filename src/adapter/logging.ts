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
