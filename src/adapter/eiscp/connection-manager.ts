/**
 * Connection Manager (shared singleton)
 *
 * Provides a shared pool of EiscpClient connections and a generic
 * command interface for the universal Stream Deck actions.
 */

import { streamDeck } from "@elgato/streamdeck";
import { EiscpClient, createClient, type DecodedMessage } from "./client.ts";

const logger = streamDeck.logger.createScope("ConnectionManager");

type CommandCallback = (rawValue: string) => void;

interface Subscription {
	host: string;
	command: string;
	callback: CommandCallback;
}

type MessageObserver = (host: string, command: string, parameter: string) => void;

export class ConnectionManager {
	private static instance: ConnectionManager;
	private clients: Map<string, EiscpClient> = new Map();
	private stateCache: Map<string, Map<string, string>> = new Map();
	private subscriptions: Subscription[] = [];
	private messageObservers: MessageObserver[] = [];
	private connecting: Map<string, Promise<EiscpClient>> = new Map();

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
		} finally {
			this.connecting.delete(host);
		}
	}

	private async connectClient(host: string, port: number): Promise<EiscpClient> {
		let client = this.clients.get(host);
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

	async sendCommand(host: string, command: string, parameter: string): Promise<void> {
		logger.info(`sendCommand: ${command} ${parameter} -> ${host}`);
		const client = await this.ensureConnected(host);
		await client.send(command, parameter);
		logger.debug(`sendCommand: ${command} ${parameter} sent successfully`);
	}

	async queryCommand(host: string, command: string): Promise<string> {
		logger.info(`queryCommand: ${command} -> ${host}`);
		const client = await this.ensureConnected(host);
		const result = await client.query(command);
		logger.info(`queryCommand: ${command} -> ${result}`);
		return result;
	}

	getCachedValue(host: string, command: string): string | undefined {
		return this.stateCache.get(host)?.get(command);
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
	 * which actions are subscribed.
	 */
	addMessageObserver(cb: MessageObserver): void {
		this.messageObservers.push(cb);
	}

	private handleMessage(host: string, msg: DecodedMessage): void {
		const command = msg.command;
		const parameter = msg.parameter;

		// Update cache
		const hostCache = this.stateCache.get(host);
		if (hostCache) {
			hostCache.set(command, parameter);
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
