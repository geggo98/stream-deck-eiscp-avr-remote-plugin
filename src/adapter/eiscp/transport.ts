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
import { scopedLogger } from "../logging.ts";
import type { EiscpPacket } from "./protocol.ts";
import { decodeMultiplePackets, MAX_FRAME_BYTES } from "./protocol.ts";
import { ReceiveBuffer } from "./receive-buffer.ts";

const logger = scopedLogger("EiscpTransport");

/**
 * Hard ceiling on unparsed bytes held for one connection.
 *
 * Sized to hold a few maximum-size frames (see `MAX_FRAME_BYTES`) so legitimate
 * pipelined traffic is never affected, while bounding what a peer can make the
 * plugin retain. Exceeding it is treated as a protocol violation: we cannot keep
 * framing a stream once we would have to drop bytes from it, so the connection
 * is torn down and reconnected on next use.
 */
export const MAX_RECEIVE_BUFFER_BYTES = 4 * MAX_FRAME_BYTES;

/**
 * Consecutive undecodable frames tolerated before dropping the connection.
 *
 * Malformed frames used to be surfaced as `error` events forever, so a peer
 * could emit unlimited errors (and unlimited log volume) while staying
 * connected. A handful of failures is plausible from a genuine glitch; a
 * sustained stream of them is not something to keep listening to.
 */
const MAX_CONSECUTIVE_BAD_FRAMES = 16;

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
 * A decoded inbound frame: a proper eISCP packet, or a headerless raw ISCP
 * line (some receivers emit those). Modelled as a union instead of a
 * fabricated EiscpPacket whose "RAW" header violated the type's invariants.
 */
export type InboundFrame =
	| { kind: "eiscp"; packet: EiscpPacket }
	| { kind: "raw-iscp"; message: string };

/**
 * Events emitted by EiscpTransport (tuple map bound to the EventEmitter, so
 * event names and payloads are compile-checked at every on/emit site).
 */
export interface EiscpTransportEvents {
	connect: [];
	close: [hadError: boolean];
	error: [error: Error];
	data: [frame: InboundFrame];
	packet: [raw: Buffer];
}

/**
 * eISCP Network Transport
 *
 * Manages TCP connection to the receiver and handles raw packet transmission.
 */
export class EiscpTransport extends EventEmitter<EiscpTransportEvents> {
	private socket: Socket | null = null;
	private state: ConnectionState = ConnectionState.DISCONNECTED;
	private connectPromise: Promise<void> | null = null;
	private abortConnect: ((err: Error) => void) | null = null;
	private options: Required<Omit<EiscpTransportOptions, "keepAliveInitialDelay">> & {
		keepAliveInitialDelay?: number;
	};
	private receiveBuffer = new ReceiveBuffer(MAX_RECEIVE_BUFFER_BYTES);
	private consecutiveBadFrames = 0;

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
			};

			// A previous socket may linger after a remote close; replace it cleanly.
			this.socket?.destroy();
			this.socket = new Socket();

			// Socket.prototype.connect IGNORES a `timeout` option (only
			// net.connect() honours it), so the timeout must be armed
			// explicitly or connects to silent hosts hang for the OS TCP
			// timeout (~75 s). onConnect disarms it.
			this.socket.setTimeout(this.options.connectTimeout);

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

				// The connect timeout must not double as an idle timeout.
				this.socket?.setTimeout(0);

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
		this.receiveBuffer.clear();
		this.consecutiveBadFrames = 0;
	}

	/**
	 * Setup data handlers for receiving packets
	 */
	private setupDataHandlers(): void {
		if (!this.socket) return;

		this.socket.on("data", (data: Buffer) => {
			if (!this.receiveBuffer.append(data)) {
				// Refusing the append means we would have to exceed the ceiling.
				// Dropping bytes mid-stream would desynchronise framing silently,
				// so fail loud and let ConnectionManager reconnect on next use.
				this.failConnection(
					new Error(
						`${this.options.host}: receive buffer limit exceeded ` +
							`(${this.receiveBuffer.length} buffered + ${data.length} received > ` +
							`${MAX_RECEIVE_BUFFER_BYTES}); dropping connection`,
					),
				);
				return;
			}

			// Try to decode complete packets
			this.processReceiveBuffer();
		});

		this.socket.on("close", (hadError: boolean) => {
			this.state = ConnectionState.DISCONNECTED;
			this.receiveBuffer.clear();
			this.consecutiveBadFrames = 0;
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
			while (this.receiveBuffer.length > 0) {
				// A full eISCP header is 16 bytes. Anything shorter is either the
				// start of one we have not fully received, or a headerless raw ISCP
				// line — the latter can be as short as 8 bytes ("!1PWR01\r"), so we
				// must try the raw path before waiting for 16 bytes.
				const looksLikeHeader = this.startsWithMagic();
				if (looksLikeHeader === "incomplete") break; // need more data

				if (looksLikeHeader === "no") {
					if (!this.processRawIscpLine()) break; // need more data
					continue;
				}

				if (this.receiveBuffer.length < 16) break; // header not fully received

				const dataSize = this.receiveBuffer.readUInt32BE(8);

				// Check the declared size before waiting on it: an oversized
				// dataSize would otherwise keep this loop waiting for bytes that
				// will never legitimately arrive, buffering all the while.
				if (dataSize > MAX_FRAME_BYTES) {
					this.failConnection(
						new Error(
							`${this.options.host}: declared frame size ${dataSize} exceeds ` +
								`maximum ${MAX_FRAME_BYTES}; dropping connection`,
						),
					);
					return;
				}

				const packetSize = 16 + dataSize;

				// Check if we have a complete packet
				if (this.receiveBuffer.length < packetSize) {
					break; // Need more data
				}

				const packetBuffer = this.receiveBuffer.consume(packetSize);

				// Emit raw packet
				this.emit("packet", packetBuffer);

				// Decode and emit parsed packet
				try {
					const packets = decodeMultiplePackets(packetBuffer);
					for (const packet of packets) {
						this.emit("data", { kind: "eiscp", packet });
					}
					this.consecutiveBadFrames = 0;
				} catch (err) {
					this.emit("error", err instanceof Error ? err : new Error(String(err)));
					if (this.noteBadFrame()) return;
				}
			}
		} catch (err) {
			this.emit("error", err instanceof Error ? err : new Error(String(err)));
		}
	}

	/**
	 * Offset of the first complete eISCP magic in the buffer, or -1.
	 *
	 * A partial magic at the very end is deliberately not reported: the caller
	 * would discard bytes before it and then still have to wait, and the next
	 * `data` event re-runs this anyway.
	 */
	private indexOfMagic(): number {
		const MAGIC = "ISCP";
		let from = 0;
		for (;;) {
			const candidate = this.receiveBuffer.indexOfByte(MAGIC.charCodeAt(0), from);
			if (candidate === -1) return -1;
			if (candidate + MAGIC.length > this.receiveBuffer.length) return -1;
			let matched = true;
			for (let i = 1; i < MAGIC.length; i++) {
				if (this.receiveBuffer.byteAt(candidate + i) !== MAGIC.charCodeAt(i)) {
					matched = false;
					break;
				}
			}
			if (matched) return candidate;
			from = candidate + 1;
		}
	}

	/**
	 * Whether the buffer starts with the eISCP magic. "incomplete" means fewer
	 * than 4 bytes are buffered and they are still a viable prefix of "ISCP", so
	 * the caller must wait rather than guess.
	 */
	private startsWithMagic(): "yes" | "no" | "incomplete" {
		const MAGIC = "ISCP";
		const available = Math.min(this.receiveBuffer.length, MAGIC.length);
		for (let i = 0; i < available; i++) {
			if (this.receiveBuffer.byteAt(i) !== MAGIC.charCodeAt(i)) return "no";
		}
		return available === MAGIC.length ? "yes" : "incomplete";
	}

	/**
	 * Try to frame one headerless raw ISCP line ("!1PWR01\r"). Some receivers
	 * emit these without the eISCP envelope.
	 *
	 * @returns `false` when more data is needed, `true` when a line was emitted
	 * or the buffer was resynchronised and the caller should loop again.
	 */
	private processRawIscpLine(): boolean {
		// Resync to whichever marker comes first: the eISCP magic, or a bare '!'.
		// Skipping straight to '!' would find the marker *inside* the body of a
		// following enveloped frame, silently discarding its header and reframing it
		// as a headerless line. The message survived that, but preferring the magic
		// keeps the framing (and the declared length) intact.
		const magicIdx = this.indexOfMagic();
		const bangIdx = this.receiveBuffer.indexOfByte(0x21); // '!'

		if (magicIdx !== -1 && (bangIdx === -1 || magicIdx < bangIdx)) {
			logger.debug(
				`${this.options.host}: skipping ${magicIdx} bytes before an eISCP header: ` +
					this.receiveBuffer.peek(Math.min(magicIdx, 32)).toString("hex"),
			);
			this.receiveBuffer.discard(magicIdx);
			return true; // let the main loop take the enveloped path
		}

		const startIdx = bangIdx;
		if (startIdx === -1) {
			// Breadcrumb for protocol debugging — otherwise dropped
			// bytes are indistinguishable from "nothing received".
			logger.warn(
				`${this.options.host}: discarding ${this.receiveBuffer.length} unparseable bytes: ` +
					this.receiveBuffer.peek(32).toString("hex"),
			);
			this.receiveBuffer.clear();
			this.noteBadFrame();
			return false;
		}

		if (startIdx > 0) {
			logger.debug(
				`${this.options.host}: skipping ${startIdx} bytes before ISCP start: ` +
					this.receiveBuffer.peek(Math.min(startIdx, 32)).toString("hex"),
			);
			this.receiveBuffer.discard(startIdx);
		}

		const terminatorIdx = this.receiveBuffer.findIndex(
			(byte) => byte === 0x0d || byte === 0x0a || byte === 0x1a,
		);
		if (terminatorIdx === -1) return false; // Need more data

		const rawPacket = this.receiveBuffer.consume(terminatorIdx + 1);

		this.emit("packet", rawPacket);
		// UTF-8 for the same reason as the enveloped path in `decodePacket`: "ascii"
		// masks the high bit and turns device text into different letters instead of
		// failing. This branch has no `rawMessage` to fall back on, so a wrong decode
		// here is unrecoverable downstream.
		this.emit("data", { kind: "raw-iscp", message: rawPacket.toString("utf8") });
		this.consecutiveBadFrames = 0;
		return true;
	}

	/**
	 * Record an undecodable frame.
	 *
	 * @returns `true` when the connection was dropped for exceeding
	 * `MAX_CONSECUTIVE_BAD_FRAMES`, so callers stop processing.
	 */
	private noteBadFrame(): boolean {
		this.consecutiveBadFrames++;
		if (this.consecutiveBadFrames < MAX_CONSECUTIVE_BAD_FRAMES) return false;

		this.failConnection(
			new Error(
				`${this.options.host}: ${this.consecutiveBadFrames} consecutive undecodable ` +
					"frames; dropping connection",
			),
		);
		return true;
	}

	/**
	 * Report a protocol-level violation and tear the connection down.
	 *
	 * `disconnect()` clears the buffer and destroys the socket, so the next use
	 * reconnects through ConnectionManager with clean framing state.
	 */
	private failConnection(err: Error): void {
		logger.warn(err.message);
		this.emit("error", err);
		this.disconnect();
	}

	/**
	 * Send raw bytes to the receiver
	 *
	 * Resolves once the bytes were handed to the kernel; rejects when the
	 * write fails (e.g. a half-open connection to a receiver in standby), in
	 * which case the socket is torn down so the next use reconnects.
	 *
	 * @param data - Buffer to send
	 */
	send(data: Buffer): Promise<void> {
		if (!this.isConnected() || !this.socket) {
			return Promise.reject(new Error(`Not connected to ${this.options.host}:${this.options.port}`));
		}

		const socket = this.socket;
		return new Promise((resolve, reject) => {
			socket.write(data as Uint8Array<ArrayBufferLike>, (err) => {
				if (err) {
					// Mark the connection dead; callers reconnect on next use.
					socket.destroy();
					reject(
						new Error(`Write to ${this.options.host}:${this.options.port} failed: ${err.message}`),
					);
				} else {
					resolve();
				}
			});
		});
	}

	/**
	 * Send a string (encoded as ASCII)
	 *
	 * @param str - String to send
	 */
	sendString(str: string): Promise<void> {
		return this.send(Buffer.from(str, "ascii"));
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
 * Create a transport instance
 *
 * No auto-reconnect: when the connection closes, callers must reconnect
 * themselves (e.g. on next use).
 *
 * @param options - Transport options
 * @returns Transport instance
 */
export function createTransport(options: EiscpTransportOptions): EiscpTransport {
	return new EiscpTransport(options);
}
