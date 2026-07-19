/**
 * eISCP Network Transport Layer
 *
 * Handles TCP connection and packet transmission/reception.
 * Separates network concerns from protocol encoding/decoding.
 *
 * This layer:
 * - Manages TCP socket lifecycle
 * - Sends encoded packets
 * - Receives raw data buffers
 * - Handles connection state and errors
 */

import { connect, Socket, type TcpNetConnectOpts } from "node:net";
import { EventEmitter } from "node:events";
import type { EiscpPacket } from "./protocol.ts";
import { decodeMultiplePackets } from "./protocol.ts";

/**
 * Connection state
 */
export const ConnectionState = {
	DISCONNECTED: "disconnected",
	CONNECTING: "connecting",
	CONNECTED: "connected",
} as const;

export type ConnectionState = (typeof ConnectionState)[keyof typeof ConnectionState];

/**
 * Configuration for eISCP connection
 */
export interface EiscpTransportOptions {
	host: string;
	port?: number;
	connectTimeout?: number;
	keepAlive?: boolean;
	keepAliveInitialDelay?: number;
}

/**
 * Events emitted by EiscpTransport
 */
export interface EiscpTransportEvents {
	connect: () => void;
	close: (hadError: boolean) => void;
	error: (error: Error) => void;
	data: (packet: EiscpPacket) => void;
	packet: (raw: Buffer) => void;
}

/**
 * eISCP Network Transport
 *
 * Manages TCP connection to the receiver and handles raw packet transmission.
 */
export class EiscpTransport extends EventEmitter {
	private socket: Socket | null = null;
	private state: ConnectionState = ConnectionState.DISCONNECTED;
	private connectPromise: Promise<void> | null = null;
	private abortConnect: ((err: Error) => void) | null = null;
	private options: Required<Omit<EiscpTransportOptions, "keepAliveInitialDelay">> & {
		keepAliveInitialDelay?: number;
	};
	private receiveBuffer: Buffer = Buffer.alloc(0);

	constructor(options: EiscpTransportOptions) {
		super();
		this.options = {
			host: options.host,
			port: options.port ?? 60128,
			connectTimeout: options.connectTimeout ?? 10000,
			keepAlive: options.keepAlive ?? true,
			keepAliveInitialDelay: options.keepAliveInitialDelay ?? 1000,
		};
	}

	/**
	 * Get current connection state
	 */
	getState(): ConnectionState {
		return this.state;
	}

	/**
	 * Check if connected
	 */
	isConnected(): boolean {
		return this.state === ConnectionState.CONNECTED && this.socket?.readyState === "open";
	}

	/**
	 * Connect to the receiver
	 */
	async connect(): Promise<void> {
		if (this.isConnected()) {
			return;
		}

		// Concurrent callers (e.g. several actions appearing on the same profile
		// page) share the in-flight attempt instead of failing.
		if (this.connectPromise) {
			return this.connectPromise;
		}

		this.state = ConnectionState.CONNECTING;

		this.connectPromise = new Promise((resolve, reject) => {
			const connectOpts: TcpNetConnectOpts = {
				host: this.options.host,
				port: this.options.port,
				timeout: this.options.connectTimeout,
			};

			// A previous socket may linger after a remote close; replace it cleanly.
			this.socket?.destroy();
			this.socket = new Socket();

			// Backstop against late socket errors (e.g. the macOS local-network
			// firewall delivering EHOSTUNREACH after the connect attempt already
			// failed): a Socket without an "error" listener throws
			// ERR_UNHANDLED_ERROR and kills the plugin process.
			this.socket.on("error", () => {});

			const cleanup = () => {
				this.socket?.off("connect", onConnect);
				this.socket?.off("error", onError);
				this.socket?.off("timeout", onTimeout);
				this.connectPromise = null;
				this.abortConnect = null;
			};

			const onConnect = () => {
				cleanup();
				this.state = ConnectionState.CONNECTED;

				// Enable keepalive
				this.socket?.setKeepAlive(this.options.keepAlive, this.options.keepAliveInitialDelay);

				// Setup data handling
				this.setupDataHandlers();

				this.emit("connect");
				resolve();
			};

			const onError = (err: Error) => {
				cleanup();
				// Destroy, or a late success would leak an open TCP connection
				// while the state still says DISCONNECTED.
				this.socket?.destroy();
				this.socket = null;
				this.state = ConnectionState.DISCONNECTED;
				this.emit("error", err);
				reject(err);
			};

			const onTimeout = () => {
				onError(new Error(`Connection timeout to ${this.options.host}:${this.options.port}`));
			};

			// Lets disconnect() fail a pending attempt instead of leaving the
			// promise (and every future connect() joining it) hanging forever.
			this.abortConnect = onError;

			this.socket.once("connect", onConnect);
			this.socket.once("error", onError);
			this.socket.once("timeout", onTimeout);

			this.socket.connect(connectOpts);
		});
		return this.connectPromise;
	}

	/**
	 * Disconnect from the receiver
	 */
	disconnect(): void {
		this.abortConnect?.(new Error("Disconnected while connecting"));
		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}
		this.state = ConnectionState.DISCONNECTED;
		this.receiveBuffer = Buffer.alloc(0);
	}

	/**
	 * Setup data handlers for receiving packets
	 */
	private setupDataHandlers(): void {
		if (!this.socket) return;

		this.socket.on("data", (data: Buffer) => {
			// Append to receive buffer
			this.receiveBuffer = Buffer.concat([this.receiveBuffer as Uint8Array<ArrayBufferLike>, data as Uint8Array<ArrayBufferLike>]);

			// Try to decode complete packets
			this.processReceiveBuffer();
		});

		this.socket.on("close", (hadError: boolean) => {
			this.state = ConnectionState.DISCONNECTED;
			this.receiveBuffer = Buffer.alloc(0);
			this.emit("close", hadError);
		});

		this.socket.on("error", (err: Error) => {
			this.emit("error", err);
		});
	}

	/**
	 * Process receive buffer and extract complete packets
	 */
	private processReceiveBuffer(): void {
		try {
			while (this.receiveBuffer.length >= 16) {
				// Check minimum packet size (header only)
				const header = this.receiveBuffer.subarray(0, 4).toString("ascii");
				if (header !== "ISCP") {
					// Attempt to parse raw ISCP message without eISCP header.
					const startIdx = this.receiveBuffer.indexOf(0x21); // '!'
					if (startIdx === -1) {
						this.receiveBuffer = Buffer.alloc(0);
						break;
					}

					if (startIdx > 0) {
						this.receiveBuffer = this.receiveBuffer.subarray(startIdx);
					}

					const terminatorIdx = this.receiveBuffer.findIndex(
						(byte) => byte === 0x0d || byte === 0x0a || byte === 0x1a,
					);
					if (terminatorIdx === -1) {
						break; // Need more data
					}

					const rawPacket = this.receiveBuffer.subarray(0, terminatorIdx + 1);
					this.receiveBuffer = this.receiveBuffer.subarray(terminatorIdx + 1);

					this.emit("packet", rawPacket);
					this.emit("data", {
						header: "RAW",
						headerSize: 0,
						dataSize: rawPacket.length,
						version: Buffer.alloc(0),
						message: rawPacket.toString("ascii"),
						rawMessage: rawPacket,
					});
					continue;
				}

				const dataSize = this.receiveBuffer.readUInt32BE(8);
				const packetSize = 16 + dataSize;

				// Check if we have a complete packet
				if (this.receiveBuffer.length < packetSize) {
					break; // Need more data
				}

				// Extract packet
				const packetBuffer = this.receiveBuffer.subarray(0, packetSize);
				this.receiveBuffer = this.receiveBuffer.subarray(packetSize);

				// Emit raw packet
				this.emit("packet", packetBuffer);

				// Decode and emit parsed packet
				try {
					const packets = decodeMultiplePackets(packetBuffer);
					for (const packet of packets) {
						this.emit("data", packet);
					}
				} catch (err) {
					this.emit("error", err instanceof Error ? err : new Error(String(err)));
				}
			}
		} catch (err) {
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		}
	}

	/**
	 * Send raw bytes to the receiver
	 *
	 * @param data - Buffer to send
	 * @throws Error if not connected
	 */
	send(data: Buffer): void {
		if (!this.isConnected()) {
			throw new Error("Not connected to receiver");
		}

		this.socket?.write(data as Uint8Array<ArrayBufferLike>);
	}

	/**
	 * Send a string (encoded as ASCII)
	 *
	 * @param str - String to send
	 * @throws Error if not connected
	 */
	sendString(str: string): void {
		this.send(Buffer.from(str, "ascii"));
	}

	/**
	 * Get connection info
	 */
	getConnectionInfo(): { host: string; port: number; state: ConnectionState } {
		return {
			host: this.options.host,
			port: this.options.port,
			state: this.state,
		};
	}
}

/**
 * Create a transport instance with auto-reconnect
 *
 * @param options - Transport options
 * @returns Transport instance
 */
export function createTransport(options: EiscpTransportOptions): EiscpTransport {
	return new EiscpTransport(options);
}
