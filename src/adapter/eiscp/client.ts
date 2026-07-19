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
import type { AdapterLogger } from "../logging.ts";
import { EiscpTransport, ConnectionState, type EiscpTransportOptions } from "./transport.ts";
import {
	encodePacket,
	createQuery,
	decodePacket,
	parseIscpMessage,
	parseQueryResponse,
	type EiscpPacket,
	type EncodedPacket,
	type IscpMessage,
} from "./protocol.ts";
import {
	IscpCommand,
	PowerState,
	MuteState,
	InputSource,
	ListeningMode,
	NetworkService,
	getInputByHex,
	getInputByDecimal,
	getListeningModeByHex,
	getListeningModeByDecimal,
	getNetworkServiceByKey,
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
 * Decoded message event types
 *
 * These represent the different types of decoded ISCP messages that can be received.
 * Each type has specific properties based on the command.
 */

/**
 * Power state message
 */
export interface PowerMessage {
	type: "power";
	command: "PWR";
	parameter: string;
	on: boolean;
	raw: string;
}

/**
 * Volume message
 */
export interface VolumeMessage {
	type: "volume";
	command: "MVL";
	parameter: string;
	level: number; // Raw volume level (0-max)
	percent?: number; // Percentage (if max is known)
	raw: string;
}

/**
 * Mute state message
 */
export interface MuteMessage {
	type: "mute";
	command: "AMT";
	parameter: string;
	muted: boolean;
	raw: string;
}

/**
 * Input source message
 */
export interface InputMessage {
	type: "input";
	command: "SLI";
	parameter: string;
	input?: {
		name: string;
		hex: string;
		decimal: number;
	};
	raw: string;
}

/**
 * Listening mode message
 */
export interface ListeningModeMessage {
	type: "listeningMode";
	command: "LMD";
	parameter: string;
	mode?: {
		name: string;
		hex: string;
		decimal: number;
	};
	raw: string;
}

/**
 * Audio EQ message
 */
export interface AudioEqMessage {
	type: "audioEq";
	command: "AEQ";
	parameter: string;
	raw: string;
}

/**
 * Display field message (FLD)
 * Contains hex-encoded ASCII text for the receiver's display
 */
export interface DisplayFieldMessage {
	type: "displayField";
	command: "FLD";
	parameter: string;
	text?: string; // Decoded ASCII text
	raw: string;
}

/**
 * Network list service message (NLS)
 * Contains information about network music services
 */
export interface NetworkServiceMessage {
	type: "networkService";
	command: "NLS";
	parameter: string;
	subCommand: "C" | "U"; // C=Category, U=Service
	service?: {
		name: string;
		key: string;
	};
	raw: string;
}

/**
 * Network list track message (NLT)
 */
export interface NetworkTrackMessage {
	type: "networkTrack";
	command: "NLT";
	parameter: string;
	raw: string;
}

/**
 * Unknown/unsupported message type
 */
export interface UnknownMessage {
	type: "unknown";
	command: string;
	parameter: string;
	raw: string;
	rawMessage: IscpMessage;
}

/**
 * Union type for all decoded messages
 */
export type DecodedMessage =
	| PowerMessage
	| VolumeMessage
	| MuteMessage
	| InputMessage
	| ListeningModeMessage
	| AudioEqMessage
	| DisplayFieldMessage
	| NetworkServiceMessage
	| NetworkTrackMessage
	| UnknownMessage;

/**
 * Client events
 */
export interface EiscpClientEvents {
	connected: () => void;
	disconnected: () => void;
	stateChanged: (state: Partial<ReceiverState>) => void;
	error: (error: Error) => void;
	rawPacket: (direction: "sent" | "received", packet: EncodedPacket | EiscpPacket) => void;
	message: (message: DecodedMessage) => void;
}

/**
 * eISCP Client options
 */
export interface EiscpClientOptions extends EiscpTransportOptions {
	volume?: Partial<VolumeConfig>;
	autoQuery?: boolean; // Automatically query state on connect
	debugLog?: boolean; // Log all packets
	commandTimeoutMs?: number; // Timeout for command responses
	logger?: AdapterLogger; // Fallback reporting when no "error" listener is attached
}

/**
 * Default volume configuration
 */
const DEFAULT_VOLUME_CONFIG: Required<VolumeConfig> = {
	max: 80,
	cap: 80,
	steps: 80,
};

/** A query waiting for its response; both paths clear the query's timeout. */
interface PendingQuery {
	settle: (value: string) => void;
	fail: (err: Error) => void;
}

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
	private logger: AdapterLogger;
	private state: ReceiverState;
	private pendingQueries: Map<string, PendingQuery[]> = new Map();

	constructor(options: EiscpClientOptions) {
		super();

		// Initialize transport
		this.transport = new EiscpTransport(options);
		this.autoQuery = options.autoQuery ?? true;
		this.debugLog = options.debugLog ?? false;
		this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
		this.logger = options.logger ?? console;

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
				this.emitError(err, "state refresh failed");
			}
		}
	}

	/**
	 * Emit an error if anyone listens; otherwise log it. Emitting "error" on
	 * an EventEmitter without listeners would crash the process.
	 */
	private emitError(err: Error, context: string): void {
		if (this.listenerCount("error") > 0) {
			this.emit("error", err);
		} else {
			const { host, port } = this.transport.getConnectionInfo();
			this.logger.warn(`eISCP client ${host}:${port}: ${context}: ${err.message}`);
		}
	}

	/**
	 * Setup transport event handlers
	 */
	private setupTransportHandlers(): void {
		this.transport.on("data", (packet) => this.handlePacket(packet));
		this.transport.on("connect", () => this.emit("connected"));
		this.transport.on("close", () => {
			this.emit("disconnected");
			// Fail fast: a closed connection can never answer, so waiting for
			// the full command timeout only delays the error.
			const { host, port } = this.transport.getConnectionInfo();
			this.failPendingQueries(new Error(`Connection to ${host}:${port} closed while awaiting a response`));
		});
		this.transport.on("error", (err) => this.emitError(err, "transport error"));
	}

	/** Reject every pending query at once (connection is gone). */
	private failPendingQueries(reason: Error): void {
		if (this.pendingQueries.size === 0) return;
		const pending = Array.from(this.pendingQueries.values()).flat();
		this.pendingQueries.clear();
		for (const entry of pending) {
			entry.fail(reason);
		}
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
			this.emitError(err instanceof Error ? err : new Error(String(err)), "failed to parse packet");
		}
	}

	/**
	 * Handle ISCP message and update state
	 */
	private handleIscpMessage(message: ReturnType<typeof parseIscpMessage>): void {
		// Decode and emit message event for all messages
		const decoded = this.decodeMessage(message);
		if (decoded) {
			this.emit("message", decoded);
		}

		const changes: Partial<ReceiverState> = {};

		// Check if this is a response to a pending query (do this first for all messages)
		const pendingKey = `${message.command}`;
		const callbacks = this.pendingQueries.get(pendingKey);
		if (callbacks) {
			this.pendingQueries.delete(pendingKey);
			for (const cb of callbacks) {
				cb.settle(message.parameter);
			}
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
	 * Decode an ISCP message into a typed DecodedMessage
	 */
	private decodeMessage(message: ReturnType<typeof parseIscpMessage>): DecodedMessage | null {
		const raw = message.raw; // Full ISCP message string

		switch (message.command) {
			case IscpCommand.POWER: {
				return {
					type: "power",
					command: "PWR",
					parameter: message.parameter,
					on: message.parameter === PowerState.ON,
					raw,
				};
			}

			case IscpCommand.VOLUME: {
				const level = parseInt(message.parameter, 16);
				return {
					type: "volume",
					command: "MVL",
					parameter: message.parameter,
					level,
					percent: (level / this.volumeConfig.max) * 100,
					raw,
				};
			}

			case IscpCommand.MUTE: {
				return {
					type: "mute",
					command: "AMT",
					parameter: message.parameter,
					muted: message.parameter === MuteState.ON,
					raw,
				};
			}

			case IscpCommand.INPUT: {
				const input = getInputByHex(message.parameter);
				return {
					type: "input",
					command: "SLI",
					parameter: message.parameter,
					input: input
						? {
								name: input.name,
								hex: input.hex,
								decimal: input.decimal,
							}
						: undefined,
					raw,
				};
			}

			case IscpCommand.LISTENING_MODE: {
				const mode = getListeningModeByHex(message.parameter);
				return {
					type: "listeningMode",
					command: "LMD",
					parameter: message.parameter,
					mode: mode
						? {
								name: mode.name,
								hex: mode.hex,
								decimal: mode.decimal,
							}
						: undefined,
					raw,
				};
			}

			case "AEQ": {
				return {
					type: "audioEq",
					command: "AEQ",
					parameter: message.parameter,
					raw,
				};
			}

			case "FLD": {
				// Decode hex-encoded ASCII text
				let text: string | undefined;
				try {
					text = Buffer.from(message.parameter, "hex")
						.toString("ascii")
						.trim();
				} catch {
					// Keep as undefined if hex decoding fails
				}
				return {
					type: "displayField",
					command: "FLD",
					parameter: message.parameter,
					text,
					raw,
				};
			}

			case "NLS": {
				// Parse NLS parameter: e.g., "C0P" or "U0-TuneIn"
				const subCommand = message.parameter.charAt(0) as "C" | "U";
				let service: { name: string; key: string } | undefined;

				if (subCommand === "U" && message.parameter.includes("-")) {
					const match = message.parameter.match(/U(\d+)-(.+)/);
					if (match) {
						service = {
							key: match[1],
							name: match[2],
						};
					}
				}

				return {
					type: "networkService",
					command: "NLS",
					parameter: message.parameter,
					subCommand,
					service,
					raw,
				};
			}

			case "NLT": {
				return {
					type: "networkTrack",
					command: "NLT",
					parameter: message.parameter,
					raw,
				};
			}

			default: {
				return {
					type: "unknown",
					command: message.command,
					parameter: message.parameter,
					raw,
					rawMessage: message,
				};
			}
		}
	}

	/**
	 * Send a command and return the response
	 *
	 * Awaits the actual socket write, so a failed write (half-open
	 * connection) rejects instead of pretending the command was delivered.
	 */
	private async sendCommand(
		command: string,
		parameter: string,
		options: { expectResponse?: boolean } = {},
	): Promise<string> {
		const encoded = encodePacket(command, parameter);

		if (this.debugLog) {
			this.emit("rawPacket", "sent", encoded);
		}

		const expectResponse = options.expectResponse ?? true;

		if (!expectResponse) {
			await this.transport.send(encoded.bytes);
			return "";
		}

		return new Promise((resolve, reject) => {
			// Listen for response
			const key = command;
			const entries = this.pendingQueries.get(key) ?? [];
			const entry: PendingQuery = {
				settle: (value) => {
					clearTimeout(timeout);
					resolve(value);
				},
				fail: (err) => {
					clearTimeout(timeout);
					reject(err);
				},
			};

			const removeEntry = () => {
				const existing = this.pendingQueries.get(key);
				if (existing) {
					const idx = existing.indexOf(entry);
					if (idx >= 0) existing.splice(idx, 1);
					if (existing.length === 0) {
						this.pendingQueries.delete(key);
					}
				}
			};

			// Set up timeout
			const timeout = setTimeout(() => {
				removeEntry();
				const { host, port } = this.transport.getConnectionInfo();
				reject(
					new Error(
						`Command ${command} ${parameter} to ${host}:${port} timed out after ${this.commandTimeoutMs} ms`,
					),
				);
			}, this.commandTimeoutMs);

			entries.push(entry);
			this.pendingQueries.set(key, entries);

			// Send command. The VSX-S520D answers the framed eISCP packet on
			// its own; an additional naked ISCP string (a historic "double
			// send") is ignored by the receiver and was removed.
			this.transport.send(encoded.bytes).catch((err: unknown) => {
				removeEntry();
				entry.fail(err instanceof Error ? err : new Error(String(err)));
			});
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

	// ===== Generic Command Interface =====

	/**
	 * Send a generic command with parameter
	 */
	async send(command: string, parameter: string): Promise<void> {
		await this.sendCommand(command, parameter, { expectResponse: false });
	}

	/**
	 * Query a generic command and return the raw parameter value
	 */
	async query(command: string): Promise<string> {
		return this.sendCommand(command, "QSTN");
	}

	// ===== Power Control =====

	/**
	 * Query power state
	 */
	async queryPower(): Promise<boolean> {
		const response = await this.sendCommand(IscpCommand.POWER, "QSTN");
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
		const response = await this.sendCommand(IscpCommand.VOLUME, "QSTN");
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
		const response = await this.sendCommand(IscpCommand.MUTE, "QSTN");
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
		const response = await this.sendCommand(IscpCommand.INPUT, "QSTN");
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
		const response = await this.sendCommand(IscpCommand.LISTENING_MODE, "QSTN");
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
