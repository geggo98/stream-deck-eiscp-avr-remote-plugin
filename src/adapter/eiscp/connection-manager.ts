/**
 * Connection Manager (shared singleton)
 *
 * Provides a shared pool of EiscpClient connections and a generic
 * command interface for the universal Stream Deck actions.
 */

import { scopedLogger, truncateForLog } from "../logging.ts";
import { EiscpClient, createClient, type DecodedMessage } from "./client.ts";

const logger = scopedLogger("ConnectionManager");

/**
 * Distinct commands cached per host.
 *
 * The generated registry has 23 commands and a receiver emits a bounded set of
 * status updates, so this is far above real usage; it exists because the cache
 * key is unvalidated wire data.
 */
const MAX_CACHED_COMMANDS_PER_HOST = 256;

type CommandCallback = (rawValue: string) => void;

interface Subscription {
	host: string;
	command: string;
	callback: CommandCallback;
}

type MessageObserver = (host: string, command: string, parameter: string) => void;

/**
 * What happened to a host's connection. `connect-failed` is deliberately
 * distinct from `disconnected`: the first means we never reached the receiver
 * (unplugged, wrong IP, blocked by the local-network firewall), the second that
 * an established session went away.
 */
export type ConnectionEvent = "connected" | "disconnected" | "connect-failed";

type ConnectionObserver = (host: string, event: ConnectionEvent) => void;

export class ConnectionManager {
	private static instance: ConnectionManager;
	private clients: Map<string, EiscpClient> = new Map();
	private stateCache: Map<string, Map<string, string>> = new Map();
	private subscriptions: Subscription[] = [];
	private messageObservers: MessageObserver[] = [];
	private connectionObservers: ConnectionObserver[] = [];
	private connecting: Map<string, Promise<EiscpClient>> = new Map();
	private evictionTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

	/** How long a disconnected client (and its now-stale cache) stays pooled. */
	private static readonly EVICT_AFTER_MS = 10 * 60 * 1000;
	/** Injectable for tests; production uses the default. */
	private readonly evictAfterMs: number;

	constructor(evictAfterMs: number = ConnectionManager.EVICT_AFTER_MS) {
		this.evictAfterMs = evictAfterMs;
	}

	static getInstance(): ConnectionManager {
		if (!ConnectionManager.instance) {
			ConnectionManager.instance = new ConnectionManager();
		}
		return ConnectionManager.instance;
	}

	async ensureConnected(host: string, port = 60128): Promise<EiscpClient> {
		const client = this.clients.get(host);
		if (client && client.isConnected()) {
			logger.debug(`Reusing existing connection to ${host}:${port}`);
			return client;
		}

		// Actions appearing together on a profile page all fire ensureConnected
		// for the same host at once; they must share one connect attempt.
		const inFlight = this.connecting.get(host);
		if (inFlight) {
			logger.debug(`Joining in-flight connect to ${host}:${port}`);
			return inFlight;
		}

		const attempt = this.connectClient(host, port);
		this.connecting.set(host, attempt);
		try {
			return await attempt;
		} catch (err) {
			// A client whose connect failed never emits "disconnected" (the
			// close handler is only attached after a successful connect), so
			// without this it would sit in the pool forever.
			this.scheduleEviction(host);
			// Same reason the eviction is needed: nothing else reports this, and
			// "we could not reach the receiver at all" is exactly what the power
			// state display has to distinguish from standby.
			this.notifyConnection(host, "connect-failed");
			throw err;
		} finally {
			this.connecting.delete(host);
		}
	}

	private async connectClient(host: string, port: number): Promise<EiscpClient> {
		let client = this.clients.get(host);
		// A port change is a reconfiguration: replace the pooled client
		// instead of silently ignoring the requested port.
		if (client && client.getConnectionInfo().port !== port) {
			logger.info(`Port for ${host} changed to ${port}; replacing pooled client`);
			client.disconnect();
			this.clients.delete(host);
			client = undefined;
		}
		if (!client) {
			logger.info(`Creating new client for ${host}:${port}`);
			client = createClient({
				host,
				port,
				autoQuery: false,
				debugLog: false,
				logger,
			});
			this.clients.set(host, client);
			this.stateCache.set(host, new Map());

			// Listen for all messages to update cache and notify subscribers
			client.on("message", (msg: DecodedMessage) => {
				logger.debug(`Received message from ${host}: ${msg.command} ${msg.parameter}`);
				this.handleMessage(host, msg);
			});

			client.on("error", (err: Error) => {
				logger.error(`Client error for ${host}: ${err.message}`);
			});

			client.on("disconnected", () => {
				logger.warn(`Client disconnected from ${host}`);
				this.scheduleEviction(host);
				this.notifyConnection(host, "disconnected");
			});

			client.on("connected", () => {
				this.cancelEviction(host);
				this.notifyConnection(host, "connected");
			});
		} else {
			logger.info(`Reconnecting existing client to ${host}:${port}`);
		}

		if (!client.isConnected()) {
			logger.info(`Connecting to ${host}:${port}...`);
			await client.connect();
			logger.info(`Connected to ${host}:${port}`);
		}

		return client;
	}

	// These ran at INFO, which the SDK writes in every configuration — so a LAN IP
	// plus every command and value the user sent landed on disk during normal use.
	// DEBUG keeps them for troubleshooting without making the log a usage record,
	// and device-supplied results are truncated and escaped.
	async sendCommand(host: string, command: string, parameter: string): Promise<void> {
		logger.debug(`sendCommand: ${command} ${parameter} -> ${host}`);
		const client = await this.ensureConnected(host);
		await client.send(command, parameter);
		logger.debug(`sendCommand: ${command} ${parameter} sent successfully`);
	}

	async queryCommand(host: string, command: string): Promise<string> {
		logger.debug(`queryCommand: ${command} -> ${host}`);
		const client = await this.ensureConnected(host);
		const result = await client.query(command);
		logger.debug(`queryCommand: ${command} -> ${truncateForLog(result)}`);
		return result;
	}

	getCachedValue(host: string, command: string): string | undefined {
		return this.stateCache.get(host)?.get(command);
	}

	/**
	 * Evict a client that stayed disconnected: the pool would otherwise keep
	 * dead clients and their stale state cache forever. Subscriptions are
	 * untouched — they belong to actions and re-apply on the next connect.
	 */
	private scheduleEviction(host: string): void {
		this.cancelEviction(host);
		const timer = setTimeout(() => {
			this.evictionTimers.delete(host);
			// A reconnect may be in flight right now (isConnected() is false
			// while CONNECTING): evicting would orphan a client that then
			// completes its connect outside the pool — duplicate dispatch and
			// a leaked TCP session. Re-arm instead; a failed attempt
			// re-schedules eviction itself, a successful one cancels it.
			if (this.connecting.has(host)) {
				this.scheduleEviction(host);
				return;
			}
			const client = this.clients.get(host);
			if (client && !client.isConnected()) {
				logger.info(`Evicting disconnected client for ${host} (stale for ${this.evictAfterMs} ms)`);
				this.clients.delete(host);
				this.stateCache.delete(host);
			}
		}, this.evictAfterMs);
		timer.unref?.();
		this.evictionTimers.set(host, timer);
	}

	private cancelEviction(host: string): void {
		const timer = this.evictionTimers.get(host);
		if (timer) {
			clearTimeout(timer);
			this.evictionTimers.delete(host);
		}
	}

	onCommandUpdate(host: string, command: string, cb: CommandCallback): () => void {
		const sub: Subscription = { host, command, callback: cb };
		this.subscriptions.push(sub);

		return () => {
			const idx = this.subscriptions.indexOf(sub);
			if (idx >= 0) this.subscriptions.splice(idx, 1);
		};
	}

	/**
	 * Observe every decoded message from every host (after the cache is updated).
	 * Used by passive name discovery, which must see all traffic regardless of
	 * which actions are subscribed. Returns an unsubscribe function.
	 */
	addMessageObserver(cb: MessageObserver): () => void {
		this.messageObservers.push(cb);
		return () => {
			const idx = this.messageObservers.indexOf(cb);
			if (idx >= 0) this.messageObservers.splice(idx, 1);
		};
	}

	/**
	 * Observe connect/disconnect/connect-failure for every host.
	 *
	 * These already happened inside the pool (they drive eviction and the log);
	 * they are published because no action can otherwise tell "the receiver is in
	 * standby" from "the receiver is not there at all" — both look like a rejected
	 * promise. Returns an unsubscribe function.
	 */
	addConnectionObserver(cb: ConnectionObserver): () => void {
		this.connectionObservers.push(cb);
		return () => {
			const idx = this.connectionObservers.indexOf(cb);
			if (idx >= 0) this.connectionObservers.splice(idx, 1);
		};
	}

	/** A throwing observer must not stop delivery to the remaining ones. */
	private notifyConnection(host: string, event: ConnectionEvent): void {
		for (const observer of this.connectionObservers) {
			try {
				observer(host, event);
			} catch (err) {
				logger.error(`connection observer failed for ${host}/${event}: ${err}`);
			}
		}
	}

	private handleMessage(host: string, msg: DecodedMessage): void {
		const command = msg.command;
		const parameter = msg.parameter;

		// Update cache. The command name is 3 arbitrary characters straight off the
		// wire (parseIscpMessage validates neither the unit nor the command), so a
		// device emitting varying names would otherwise add a key per name and hold
		// them until the host is evicted. Refuse new keys past the cap but keep
		// updating ones already tracked, so the actions in use stay current.
		const hostCache = this.stateCache.get(host);
		if (hostCache) {
			if (hostCache.has(command) || hostCache.size < MAX_CACHED_COMMANDS_PER_HOST) {
				hostCache.set(command, parameter);
			} else {
				logger.debug(
					`state cache for ${host} is full (${MAX_CACHED_COMMANDS_PER_HOST} commands); ` +
						`ignoring ${truncateForLog(command, 8)}`,
				);
			}
		}

		// Notify subscribers; a throwing callback (e.g. a render error in an
		// action) must not stop delivery to the remaining subscribers.
		for (const sub of this.subscriptions) {
			if (sub.host === host && sub.command === command) {
				try {
					sub.callback(parameter);
				} catch (err) {
					logger.error(`subscriber for ${host}/${command} threw: ${err}`);
				}
			}
		}

		// Notify generic observers (cache is already up to date).
		for (const observer of this.messageObservers) {
			try {
				observer(host, command, parameter);
			} catch (err) {
				logger.error(`message observer failed for ${command}: ${err}`);
			}
		}
	}
}
