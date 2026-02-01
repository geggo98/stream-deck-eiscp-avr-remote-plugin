/**
 * eISCP Client
 *
 * High-level client API for controlling Onkyo/Pioneer receivers.
 * Provides state management and control methods with volume cap support.
 *
 * Features:
 * - Power, volume, mute, input, and listening mode control
 * - Volume cap and step configuration
 * - State tracking with change events
 * - Automatic state synchronization via notifications
 */

import { EventEmitter } from "node:events";
import { EiscpTransport, ConnectionState, type EiscpTransportOptions } from "./transport.ts";
import {
	encodePacket,
	createQuery,
	decodePacket,
	parseIscpMessage,
	parseQueryResponse,
	type EiscpPacket,
	type EncodedPacket,
} from "./protocol.ts";
import {
	IscpCommand,
	PowerState,
	MuteState,
	InputSource,
	ListeningMode,
	getInputByHex,
	getInputByDecimal,
	getListeningModeByHex,
	getListeningModeByDecimal,
	type InputSourceKey,
	type ListeningModeKey,
} from "./enums.ts";

/**
 * Receiver state
 */
export interface ReceiverState {
	power: boolean;
	volume: number; // 0-100 (scaled) or 0-maxVolume (raw)
	muted: boolean;
	input: string; // Input source name
	listeningMode: string; // Listening mode name
	rawPower: string; // Raw ISCP value
	rawVolume: string; // Raw ISCP value
	rawInput: string; // Raw ISCP value
	rawListeningMode: string; // Raw ISCP value
}

/**
 * Volume configuration
 */
export interface VolumeConfig {
	max: number; // Maximum volume level (hardware-specific, e.g., 80 or 100)
	cap?: number; // Optional software cap (0-max)
	steps: number; // Number of discrete steps (for UI sliders)
}

/**
 * Client events
 */
export interface EiscpClientEvents {
	connected: () => void;
	disconnected: () => void;
	stateChanged: (state: Partial<ReceiverState>) => void;
	error: (error: Error) => void;
	rawPacket: (direction: "sent" | "received", packet: EncodedPacket | EiscpPacket) => void;
}

/**
 * Declares the EventEmitter signature for EiscpClient
 */
declare interface EiscpClient {
	on<K extends keyof EiscpClientEvents>(event: K, listener: EiscpClientEvents[K]): this;
	once<K extends keyof EiscpClientEvents>(event: K, listener: EiscpClientEvents[K]): this;
	off<K extends keyof EiscpClientEvents>(event: K, listener: EiscpClientEvents[K]): this;
	emit<K extends keyof EiscpClientEvents>(
		event: K,
		...args: Parameters<EiscpClientEvents[K]>
	): boolean;
}

/**
 * Mixin to add typed event methods to a class
 */
type EventEmitterWithEvents<T> = EventEmitter & {
	on<K extends keyof T>(event: K, listener: T[K]): this;
	once<K extends keyof T>(event: K, listener: T[K]): this;
	off<K extends keyof T>(event: K, listener: T[K]): this;
	emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): boolean;
};

/**
 * eISCP Client options
 */
export interface EiscpClientOptions extends EiscpTransportOptions {
	volume?: Partial<VolumeConfig>;
	autoQuery?: boolean; // Automatically query state on connect
	debugLog?: boolean; // Log all packets
	commandTimeoutMs?: number; // Timeout for command responses
}

/**
 * Default volume configuration
 */
const DEFAULT_VOLUME_CONFIG: Required<VolumeConfig> = {
	max: 80,
	cap: 80,
	steps: 80,
};

/**
 * eISCP Client
 *
 * High-level API for controlling Onkyo/Pioneer receivers.
 */
export class EiscpClient extends EventEmitter {
	private transport: EiscpTransport;
	private volumeConfig: Required<VolumeConfig>;
	private autoQuery: boolean;
	private debugLog: boolean;
	private commandTimeoutMs: number;
	private state: ReceiverState;
	private pendingQueries: Map<string, Array<(value: string) => void>> = new Map();

	constructor(options: EiscpClientOptions) {
		super();

		// Initialize transport
		this.transport = new EiscpTransport(options);
		this.autoQuery = options.autoQuery ?? true;
		this.debugLog = options.debugLog ?? false;
		this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;

		// Initialize volume config
		const volumeOptions = options.volume ?? {};
		this.volumeConfig = {
			max: volumeOptions.max ?? DEFAULT_VOLUME_CONFIG.max,
			cap: volumeOptions.cap ?? volumeOptions.max ?? DEFAULT_VOLUME_CONFIG.cap,
			steps: volumeOptions.steps ?? DEFAULT_VOLUME_CONFIG.steps,
		};

		// Initialize state
		this.state = {
			power: false,
			volume: 0,
			muted: false,
			input: "",
			listeningMode: "",
			rawPower: "",
			rawVolume: "",
			rawInput: "",
			rawListeningMode: "",
		};

		// Setup transport event handlers
		this.setupTransportHandlers();
	}

	/**
	 * Get current receiver state
	 */
	getState(): Readonly<ReceiverState> {
		return this.state;
	}

	/**
	 * Get volume configuration
	 */
	getVolumeConfig(): Readonly<Required<VolumeConfig>> {
		return this.volumeConfig;
	}

	/**
	 * Update volume configuration
	 */
	updateVolumeConfig(config: Partial<VolumeConfig>): void {
		if (config.max !== undefined) this.volumeConfig.max = config.max;
		if (config.cap !== undefined) this.volumeConfig.cap = config.cap;
		if (config.steps !== undefined) this.volumeConfig.steps = config.steps;
	}

	/**
	 * Connect to the receiver
	 */
	async connect(): Promise<void> {
		await this.transport.connect();
		if (this.autoQuery) {
			await this.refreshState();
		}
	}

	/**
	 * Disconnect from the receiver
	 */
	disconnect(): void {
		this.transport.disconnect();
	}

	/**
	 * Check if connected
	 */
	isConnected(): boolean {
		return this.transport.isConnected();
	}

	/**
	 * Refresh all state from receiver
	 */
	async refreshState(): Promise<void> {
		const results = await Promise.allSettled([
			this.queryPower(),
			this.queryVolume(),
			this.queryMute(),
			this.queryInput(),
			this.queryListeningMode(),
		]);

		for (const result of results) {
			if (result.status === "rejected") {
				const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
				if (this.listenerCount("error") > 0) {
					this.emit("error", err);
				}
			}
		}
	}

	/**
	 * Setup transport event handlers
	 */
	private setupTransportHandlers(): void {
		this.transport.on("data", (packet) => this.handlePacket(packet));
		this.transport.on("connect", () => this.emit("connected"));
		this.transport.on("close", () => this.emit("disconnected"));
		this.transport.on("error", (err) => this.emit("error", err));
	}

	/**
	 * Handle incoming packet
	 */
	private handlePacket(packet: EiscpPacket): void {
		if (this.debugLog) {
			this.emit("rawPacket", "received", packet);
		}

		try {
			const message = parseIscpMessage(packet.message);
			this.handleIscpMessage(message);
		} catch (err) {
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		}
	}

	/**
	 * Handle ISCP message and update state
	 */
	private handleIscpMessage(message: ReturnType<typeof parseIscpMessage>): void {
		const changes: Partial<ReceiverState> = {};

		// Check if this is a response to a pending query (do this first for all messages)
		const pendingKey = `${message.command}`;
		const callbacks = this.pendingQueries.get(pendingKey);
		if (callbacks) {
			for (const cb of callbacks) {
				cb(message.parameter);
			}
			this.pendingQueries.delete(pendingKey);
		}

		switch (message.command) {
			case IscpCommand.POWER:
				changes.power = message.parameter === PowerState.ON;
				changes.rawPower = message.parameter;
				break;

			case IscpCommand.VOLUME:
				changes.volume = this.parseVolume(message.parameter);
				changes.rawVolume = message.parameter;
				break;

			case IscpCommand.MUTE:
				changes.muted = message.parameter === MuteState.ON;
				break;

			case IscpCommand.INPUT:
				const input = getInputByHex(message.parameter);
				if (input) {
					changes.input = input.name;
					changes.rawInput = message.parameter;
				}
				break;

			case IscpCommand.LISTENING_MODE:
				const mode = getListeningModeByHex(message.parameter);
				if (mode) {
					changes.listeningMode = mode.name;
					changes.rawListeningMode = message.parameter;
				}
				break;

			default:
				// Unknown command, no state update needed
				return;
		}

		// Update state and emit change event
		Object.assign(this.state, changes);
		this.emit("stateChanged", changes);
	}

	/**
	 * Send a command and return the response
	 */
	private async sendCommand(
		command: string,
		parameter: string,
		options: { expectResponse?: boolean; sendRaw?: boolean } = {},
	): Promise<string> {
		const encoded = encodePacket(command, parameter);

		if (this.debugLog) {
			this.emit("rawPacket", "sent", encoded);
		}

		const expectResponse = options.expectResponse ?? true;
		const sendRaw = options.sendRaw ?? false;

		if (!expectResponse) {
			this.transport.send(encoded.bytes);
			return "";
		}

		return new Promise((resolve, reject) => {
			// Listen for response
			const key = command;
			const callbacks = this.pendingQueries.get(key) ?? [];
			const callback = (value: string) => {
				clearTimeout(timeout);
				resolve(value);
			};

			// Set up timeout
			const timeout = setTimeout(() => {
				const existing = this.pendingQueries.get(key);
				if (existing) {
					const idx = existing.indexOf(callback);
					if (idx >= 0) existing.splice(idx, 1);
					if (existing.length === 0) {
						this.pendingQueries.delete(key);
					}
				}
				reject(new Error(`Command ${command} ${parameter} timed out`));
			}, this.commandTimeoutMs);

			callbacks.push(callback);
			this.pendingQueries.set(key, callbacks);

			// Send command
			try {
				this.transport.send(encoded.bytes);
				if (sendRaw) {
					this.transport.sendString(encoded.iscpMessage);
				}
			} catch (err) {
				clearTimeout(timeout);
				// Remove callback
				const idx = callbacks.indexOf(callback);
				if (idx >= 0) callbacks.splice(idx, 1);
				reject(err);
			}
		});
	}

	/**
	 * Parse volume from hex string
	 */
	private parseVolume(hex: string): number {
		return parseInt(hex, 16);
	}

	/**
	 * Convert volume to hex string
	 */
	private volumeToHex(volume: number): string {
		// Apply cap
		const capped = Math.min(volume, this.volumeConfig.cap);
		const hex = Math.round(capped).toString(16).toUpperCase().padStart(2, "0");
		return hex;
	}

	// ===== Power Control =====

	/**
	 * Query power state
	 */
	async queryPower(): Promise<boolean> {
		const response = await this.sendCommand(IscpCommand.POWER, "QSTN", { sendRaw: true });
		return response === PowerState.ON;
	}

	/**
	 * Set power state
	 */
	async setPower(on: boolean): Promise<void> {
		const parameter = on ? PowerState.ON : PowerState.OFF;
		await this.sendCommand(IscpCommand.POWER, parameter, { expectResponse: false });
	}

	/**
	 * Power on
	 */
	async powerOn(): Promise<void> {
		await this.setPower(true);
	}

	/**
	 * Power off
	 */
	async powerOff(): Promise<void> {
		await this.setPower(false);
	}

	// ===== Volume Control =====

	/**
	 * Query volume level
	 */
	async queryVolume(): Promise<number> {
		const response = await this.sendCommand(IscpCommand.VOLUME, "QSTN", { sendRaw: true });
		return this.parseVolume(response);
	}

	/**
	 * Set volume level (0 to max, or 0 to cap if cap is set)
	 */
	async setVolume(level: number): Promise<void> {
		const parameter = this.volumeToHex(level);
		await this.sendCommand(IscpCommand.VOLUME, parameter, { expectResponse: false });
	}

	/**
	 * Set volume as percentage (0-100)
	 */
	async setVolumePercent(percent: number): Promise<void> {
		const level = Math.round((percent / 100) * this.volumeConfig.cap);
		await this.setVolume(level);
	}

	/**
	 * Get current volume as percentage
	 */
	getVolumePercent(): number {
		return (this.state.volume / this.volumeConfig.max) * 100;
	}

	/**
	 * Volume up by one step
	 */
	async volumeUp(): Promise<void> {
		const newLevel = Math.min(this.state.volume + 1, this.volumeConfig.cap);
		await this.setVolume(newLevel);
	}

	/**
	 * Volume down by one step
	 */
	async volumeDown(): Promise<void> {
		const newLevel = Math.max(this.state.volume - 1, 0);
		await this.setVolume(newLevel);
	}

	// ===== Mute Control =====

	/**
	 * Query mute state
	 */
	async queryMute(): Promise<boolean> {
		const response = await this.sendCommand(IscpCommand.MUTE, "QSTN", { sendRaw: true });
		return response === MuteState.ON;
	}

	/**
	 * Set mute state
	 */
	async setMute(muted: boolean): Promise<void> {
		const parameter = muted ? MuteState.ON : MuteState.OFF;
		await this.sendCommand(IscpCommand.MUTE, parameter, { expectResponse: false });
	}

	/**
	 * Toggle mute
	 */
	async toggleMute(): Promise<void> {
		await this.sendCommand(IscpCommand.MUTE, MuteState.TOGGLE, { expectResponse: false });
	}

	/**
	 * Mute audio
	 */
	async mute(): Promise<void> {
		await this.setMute(true);
	}

	/**
	 * Unmute audio
	 */
	async unmute(): Promise<void> {
		await this.setMute(false);
	}

	// ===== Input Selection =====

	/**
	 * Query current input
	 */
	async queryInput(): Promise<string> {
		const response = await this.sendCommand(IscpCommand.INPUT, "QSTN", { sendRaw: true });
		const input = getInputByHex(response);
		return input?.name ?? response;
	}

	/**
	 * Set input source by name
	 */
	async setInput(inputName: InputSourceKey): Promise<void> {
		const input = InputSource[inputName];
		if (!input) {
			throw new Error(`Unknown input: ${inputName}`);
		}
		await this.sendCommand(IscpCommand.INPUT, input.hex, { expectResponse: false });
	}

	/**
	 * Set input by decimal value
	 */
	async setInputByDecimal(decimal: number): Promise<void> {
		const input = getInputByDecimal(decimal);
		if (!input) {
			throw new Error(`Unknown input decimal: ${decimal}`);
		}
		await this.sendCommand(IscpCommand.INPUT, input.hex, { expectResponse: false });
	}

	/**
	 * Set input by hex value
	 */
	async setInputByHex(hex: string): Promise<void> {
		await this.sendCommand(IscpCommand.INPUT, hex, { expectResponse: false });
	}

	// ===== Listening Mode =====

	/**
	 * Query current listening mode
	 */
	async queryListeningMode(): Promise<string> {
		const response = await this.sendCommand(IscpCommand.LISTENING_MODE, "QSTN", { sendRaw: true });
		const mode = getListeningModeByHex(response);
		return mode?.name ?? response;
	}

	/**
	 * Set listening mode by name
	 */
	async setListeningMode(modeName: ListeningModeKey): Promise<void> {
		const mode = ListeningMode[modeName];
		if (!mode) {
			throw new Error(`Unknown listening mode: ${modeName}`);
		}
		await this.sendCommand(IscpCommand.LISTENING_MODE, mode.hex, { expectResponse: false });
	}

	/**
	 * Set listening mode by decimal value
	 */
	async setListeningModeByDecimal(decimal: number): Promise<void> {
		const mode = getListeningModeByDecimal(decimal);
		if (!mode) {
			throw new Error(`Unknown listening mode decimal: ${decimal}`);
		}
		await this.sendCommand(IscpCommand.LISTENING_MODE, mode.hex, { expectResponse: false });
	}

	/**
	 * Set listening mode by hex value
	 */
	async setListeningModeByHex(hex: string): Promise<void> {
		await this.sendCommand(IscpCommand.LISTENING_MODE, hex, { expectResponse: false });
	}
}

/**
 * Create an eISCP client instance
 *
 * @param options - Client options
 * @returns Client instance
 */
export function createClient(options: EiscpClientOptions): EiscpClient {
	return new EiscpClient(options);
}
