/**
 * Connection Manager (shared singleton)
 *
 * Provides a shared pool of EiscpClient connections and a generic
 * command interface for the universal Stream Deck actions.
 */

import { EiscpClient, createClient, type DecodedMessage } from "./client.ts";

type CommandCallback = (rawValue: string) => void;

interface Subscription {
	host: string;
	command: string;
	callback: CommandCallback;
}

export class ConnectionManager {
	private static instance: ConnectionManager;
	private clients: Map<string, EiscpClient> = new Map();
	private stateCache: Map<string, Map<string, string>> = new Map();
	private subscriptions: Subscription[] = [];

	static getInstance(): ConnectionManager {
		if (!ConnectionManager.instance) {
			ConnectionManager.instance = new ConnectionManager();
		}
		return ConnectionManager.instance;
	}

	async ensureConnected(host: string, port = 60128): Promise<EiscpClient> {
		let client = this.clients.get(host);
		if (client && client.isConnected()) {
			return client;
		}

		if (!client) {
			client = createClient({
				host,
				port,
				autoQuery: false,
				debugLog: false,
			});
			this.clients.set(host, client);
			this.stateCache.set(host, new Map());

			// Listen for all messages to update cache and notify subscribers
			client.on("message", (msg: DecodedMessage) => {
				this.handleMessage(host, msg);
			});
		}

		if (!client.isConnected()) {
			await client.connect();
		}

		return client;
	}

	async sendCommand(host: string, command: string, parameter: string): Promise<void> {
		const client = await this.ensureConnected(host);
		await client.send(command, parameter);
	}

	async queryCommand(host: string, command: string): Promise<string> {
		const client = await this.ensureConnected(host);
		return client.query(command);
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

	private handleMessage(host: string, msg: DecodedMessage): void {
		const command = msg.command;
		const parameter = msg.parameter;

		// Update cache
		const hostCache = this.stateCache.get(host);
		if (hostCache) {
			hostCache.set(command, parameter);
		}

		// Notify subscribers
		for (const sub of this.subscriptions) {
			if (sub.host === host && sub.command === command) {
				sub.callback(parameter);
			}
		}
	}
}
