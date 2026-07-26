/**
 * Fixture-driven mock eISCP receiver (test double).
 *
 * A TCP server that behaves like the captured VSX-S520D:
 *  - answers `<CMD>QSTN` from a response map (default: the real answers in
 *    tests/fixtures/command-responses.json)
 *  - ignores commands in `ignore` entirely, like the real unit ignores
 *    SPA/SPB (and DIR) — the client's query then times out
 *  - echoes set commands back as state broadcasts (the receiver's
 *    auto-status behaviour), including UP/DOWN stepping and TG toggling
 *  - replies use the exact wire format of the captured device:
 *    eISCP frame around `!1<CMD><VALUE>\x1a\r\n`
 *
 * Shared by the transport/client/connection-manager behaviour tests.
 */

import { createServer, type Server, type Socket } from "node:net";
import { readFileSync } from "node:fs";

export interface MockReceiverOptions {
	/** command -> parameter map answering QSTN; defaults to the captured fixture. */
	responses?: Record<string, string>;
	/** Commands the mock never answers (queries into them time out). */
	ignore?: readonly string[];
	/** Echo set commands back as state broadcasts (default true). */
	echoSets?: boolean;
	/** Artificial delay before every reply, in ms. */
	replyDelayMs?: number;
	/**
	 * Replay a recorded exchange instead of synthesising answers: the frames
	 * captured from the real unit by `npm run capture:names`.
	 *
	 * Behaviour the synthetic echo cannot express and the sweep depends on: the
	 * input *name* (FLD) leads the input *code* by ~1 s on the real device, other
	 * commands broadcast in between, and UP does not step numerically through the
	 * codes. See tests/fixtures/name-discovery-capture.json.
	 */
	replay?: CapturedExchangeSource;
	/**
	 * Scale for the captured inter-frame delays. 0 (default) replays in captured
	 * order but immediately, which keeps tests fast; 1 replays in real time.
	 */
	replayTimeScale?: number;
}

/** One frame as recorded by scripts/capture-name-discovery.ts. */
export interface CapturedFrame {
	dir: "out" | "in";
	ms: number;
	iscp: string;
	command?: string;
	parameter?: string;
	hex?: string;
}

/** A recorded sweep (or any frame list) to replay. */
export interface CapturedExchangeSource {
	frames: CapturedFrame[];
}

/** An outbound message and the inbound frames the real device answered it with. */
interface ReplayExchange {
	key: string;
	responses: { command: string; parameter: string; afterMs: number }[];
}

/**
 * Group a captured frame list into request/response exchanges: every outbound
 * frame owns the inbound frames that followed it until the next outbound one.
 */
function buildExchanges(frames: CapturedFrame[]): Map<string, ReplayExchange[]> {
	const byKey = new Map<string, ReplayExchange[]>();
	let current: { frame: CapturedFrame; exchange: ReplayExchange } | undefined;
	const flush = (): void => {
		if (!current) return;
		const list = byKey.get(current.exchange.key) ?? [];
		list.push(current.exchange);
		byKey.set(current.exchange.key, list);
		current = undefined;
	};
	for (const frame of frames) {
		if (frame.dir === "out") {
			flush();
			const { command, parameter } = frame;
			if (command === undefined || parameter === undefined) continue;
			current = { frame, exchange: { key: `${command}${parameter}`, responses: [] } };
			continue;
		}
		if (!current || frame.command === undefined || frame.parameter === undefined) continue;
		current.exchange.responses.push({
			command: frame.command,
			parameter: frame.parameter,
			afterMs: Math.max(0, frame.ms - current.frame.ms),
		});
	}
	flush();
	return byKey;
}

export interface ReceivedMessage {
	command: string;
	parameter: string;
}

export interface MockReceiver {
	port: number;
	/** Every decoded inbound ISCP message, in arrival order. */
	received: ReceivedMessage[];
	/** Currently connected sockets (server side). */
	sockets: Set<Socket>;
	/** Current state map (mutated by echoed sets). */
	state: Record<string, string>;
	/**
	 * Resolve once at least one client connection is registered server-side.
	 * The server sees the connection a tick after the client's connect()
	 * resolves — broadcasting before that sends into the void.
	 */
	waitForClient(timeoutMs?: number): Promise<void>;
	/** Resolve once at least `count` messages for `command` were received. */
	waitForCommand(command: string, count?: number, timeoutMs?: number): Promise<void>;
	/** Send a framed state broadcast to every connected client. */
	broadcast(command: string, parameter: string): void;
	/** Send raw bytes to every connected client (for reassembly tests). */
	broadcastRaw(bytes: Buffer): void;
	/**
	 * Send raw bytes split into `chunkSize`-byte writes, so the client's framing
	 * has to reassemble them. Fuzzing needs this because chunk boundaries are
	 * where reassembly bugs live, and a single write usually arrives intact.
	 *
	 * @param bytes - Bytes to send.
	 * @param chunkSize - Bytes per write (at least 1).
	 */
	broadcastRawChunked(bytes: Buffer, chunkSize: number): void;
	/**
	 * Destroy every connected socket without a graceful close, simulating a
	 * receiver that drops the connection mid-frame. Unlike `close()` the server
	 * keeps listening, so the client can reconnect.
	 */
	resetConnections(): void;
	close(): Promise<void>;
}

/** Load the captured VSX-S520D query answers (skipping timed-out commands). */
export function loadCapturedResponses(): Record<string, string> {
	const fixture = JSON.parse(
		readFileSync(new URL("../fixtures/command-responses.json", import.meta.url), "utf-8"),
	) as { responses?: { command: string; response: string }[] };
	const map: Record<string, string> = {};
	for (const r of fixture.responses ?? []) {
		if (!r.response.startsWith("ERROR")) map[r.command] = r.response;
	}
	return map;
}

/** Frame an ISCP payload exactly like the captured receiver does. */
export function frameReply(command: string, parameter: string): Buffer {
	const payload = Buffer.from(`!1${command}${parameter}\x1a\r\n`, "ascii");
	const header = Buffer.alloc(16);
	header.write("ISCP", 0, "ascii");
	header.writeUInt32BE(16, 4); // header size
	header.writeUInt32BE(payload.length, 8); // data size
	header.writeUInt8(0x01, 12); // version
	return Buffer.concat([header, payload]);
}

export async function startMockReceiver(options: MockReceiverOptions = {}): Promise<MockReceiver> {
	const state: Record<string, string> = { ...(options.responses ?? loadCapturedResponses()) };
	const ignore = new Set(options.ignore ?? ["SPA", "SPB", "DIR"]);
	const echoSets = options.echoSets ?? true;
	const received: ReceivedMessage[] = [];
	const sockets = new Set<Socket>();

	const reply = (socket: Socket, command: string, parameter: string) => {
		const send = () => {
			if (!socket.destroyed) socket.write(frameReply(command, parameter));
		};
		if (options.replyDelayMs) setTimeout(send, options.replyDelayMs);
		else send();
	};

	// Recorded exchanges, consumed in capture order per request key: the sweep
	// sends the same request many times (SLI UP, FLD QSTN) and each repetition
	// must get the answer the real device gave *that* time round.
	const exchanges = options.replay ? buildExchanges(options.replay.frames) : undefined;
	const timeScale = options.replayTimeScale ?? 0;

	const replayNext = (socket: Socket, command: string, parameter: string): boolean => {
		const queue = exchanges?.get(`${command}${parameter}`);
		if (!queue || queue.length === 0) return false;
		const exchange = queue.shift()!;
		for (const response of exchange.responses) {
			const send = () => {
				if (!socket.destroyed) socket.write(frameReply(response.command, response.parameter));
				state[response.command] = response.parameter;
			};
			const delay = Math.round(response.afterMs * timeScale);
			if (delay > 0) setTimeout(send, delay).unref?.();
			// Keep the captured order without the captured wait.
			else setImmediate(send);
		}
		return true;
	};

	const handleMessage = (socket: Socket, command: string, parameter: string) => {
		received.push({ command, parameter });
		if (ignore.has(command)) return;
		// Replay wins where a recording exists; anything not recorded falls through
		// to the synthetic behaviour, so a replaying mock is still a usable receiver.
		if (replayNext(socket, command, parameter)) return;

		if (parameter === "QSTN") {
			const value = state[command];
			if (value !== undefined) reply(socket, command, value);
			return;
		}
		if (!echoSets) return;

		// Model the receiver's auto-status echo for sets.
		let next = parameter;
		const current = state[command];
		if (parameter === "UP" || parameter === "DOWN") {
			const num = Number.parseInt(current ?? "00", 16);
			const stepped = parameter === "UP" ? num + 1 : Math.max(0, num - 1);
			next = stepped.toString(16).toUpperCase().padStart(2, "0");
		} else if (parameter === "TG") {
			next = current === "01" ? "00" : "01";
		}
		state[command] = next;
		reply(socket, command, next);
	};

	/** Incremental inbound parser: eISCP frames or bare ISCP lines. */
	const makeParser = (socket: Socket) => {
		let buffer = Buffer.alloc(0);
		return (data: Buffer) => {
			buffer = Buffer.concat([buffer, data]);
			for (;;) {
				if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "ISCP") {
					if (buffer.length < 16) return;
					const dataSize = buffer.readUInt32BE(8);
					if (buffer.length < 16 + dataSize) return;
					const payload = buffer.subarray(16, 16 + dataSize).toString("ascii");
					buffer = buffer.subarray(16 + dataSize);
					const m = /^!.(\w{3})(.*?)[\r\n\x1a]*$/s.exec(payload);
					if (m) handleMessage(socket, m[1]!, m[2]!);
					continue;
				}
				const nl = buffer.findIndex((b) => b === 0x0d || b === 0x0a);
				if (nl === -1) return;
				const line = buffer.subarray(0, nl).toString("ascii");
				buffer = buffer.subarray(nl + 1);
				const m = /^!.(\w{3})(.*)$/.exec(line);
				if (m) handleMessage(socket, m[1]!, m[2]!);
			}
		};
	};

	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
		socket.on("data", makeParser(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;

	return {
		port,
		received,
		sockets,
		state,
		async waitForClient(timeoutMs = 2000) {
			const start = Date.now();
			while (sockets.size === 0 && Date.now() - start < timeoutMs) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			if (sockets.size === 0) throw new Error("no client connected to the mock receiver");
		},
		async waitForCommand(command, count = 1, timeoutMs = 2000) {
			const seen = () => received.filter((m) => m.command === command).length;
			const start = Date.now();
			while (seen() < count && Date.now() - start < timeoutMs) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			if (seen() < count) {
				throw new Error(`expected ${count}x ${command}, got ${seen()}`);
			}
		},
		broadcast(command, parameter) {
			for (const socket of sockets) {
				if (!socket.destroyed) socket.write(frameReply(command, parameter));
			}
		},
		broadcastRaw(bytes) {
			for (const socket of sockets) {
				if (!socket.destroyed) socket.write(bytes);
			}
		},

		broadcastRawChunked(bytes, chunkSize) {
			const size = Math.max(1, Math.floor(chunkSize));
			for (const socket of sockets) {
				if (socket.destroyed) continue;
				for (let offset = 0; offset < bytes.length; offset += size) {
					socket.write(bytes.subarray(offset, offset + size));
				}
			}
		},

		resetConnections() {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
		},
		async close() {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
