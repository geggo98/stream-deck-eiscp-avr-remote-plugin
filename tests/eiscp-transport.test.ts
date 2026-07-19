/**
 * Unit tests for the eISCP transport: socket lifecycle and receive-buffer
 * reassembly (split packets, garbage resync, headerless raw ISCP lines).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { createTransport, ConnectionState, type InboundFrame } from "../src/adapter/eiscp/transport.ts";
import { frameReply, startMockReceiver } from "./helpers/mock-receiver.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the collector holds at least n frames (or time out). */
async function waitForFrames(frames: InboundFrame[], n: number, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	while (frames.length < n && Date.now() - start < timeoutMs) {
		await sleep(20);
	}
	assert.ok(frames.length >= n, `expected ${n} frames, got ${frames.length}`);
}

/** Compact projection of a frame for exact-sequence assertions. */
function project(frame: InboundFrame): string {
	return frame.kind === "eiscp"
		? `eiscp:${frame.packet.message.replace(/[\r\n\x1a]+$/, "")}`
		: `raw:${frame.message.replace(/[\r\n\x1a]+$/, "")}`;
}

/** Bind a TCP server to an ephemeral port, tracking accepted sockets. */
async function startServer(): Promise<{ server: Server; port: number; sockets: Socket[] }> {
	const sockets: Socket[] = [];
	const server = createServer((socket) => {
		socket.on("error", () => {});
		sockets.push(socket);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return { server, port, sockets };
}

/** Find a port with nothing listening on it. */
async function closedPort(): Promise<number> {
	const { server, port } = await startServer();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

describe("EiscpTransport lifecycle", () => {
	it("failed connect destroys the socket and leaves a consistent state", async () => {
		const port = await closedPort();
		const transport = createTransport({ host: "127.0.0.1", port });
		const errors: Error[] = [];
		transport.on("error", (err: Error) => errors.push(err));

		await assert.rejects(transport.connect());
		assert.equal(transport.getState(), ConnectionState.DISCONNECTED);
		assert.equal(transport.isConnected(), false);
		assert.ok(errors.length >= 1, "connect failure should be emitted");
	});

	it("a late socket error after a failed connect does not crash the process", async () => {
		const port = await closedPort();
		const transport = createTransport({ host: "127.0.0.1", port });
		transport.on("error", () => {});

		const attempt = transport.connect();
		// Grab the socket while the attempt is in flight; the late error arrives
		// on this object in the real failure (macOS local-network firewall).
		const socket = (transport as unknown as { socket: Socket }).socket;
		assert.ok(socket, "socket should exist while connecting");

		await assert.rejects(attempt);
		// Without the permanent backstop listener this would throw
		// ERR_UNHANDLED_ERROR and kill the test process.
		socket.emit("error", new Error("late EHOSTUNREACH"));
		assert.equal(transport.getState(), ConnectionState.DISCONNECTED);
	});

	it("disconnect during connect rejects the pending attempt", async () => {
		// 203.0.113.0/24 (TEST-NET-3) never answers, so the connect stays pending
		// long enough to abort it; if the local network fast-fails instead, the
		// attempt still rejects, which is all this asserts.
		const transport = createTransport({ host: "203.0.113.1", port: 60128, connectTimeout: 5000 });
		transport.on("error", () => {});

		const attempt = transport.connect();
		transport.disconnect();

		// Deadline guard: if the abort logic regresses, the attempt never
		// settles and this test would otherwise hang the whole suite
		// (node --test runs without a per-test timeout here).
		const deadline = new Promise((_, reject) => {
			const t = setTimeout(() => reject(new Error("test deadline: connect promise never settled")), 5000);
			t.unref?.();
		});
		await assert.rejects(Promise.race([attempt, deadline]), /Disconnected while connecting|ECONN|EHOST|ENET/);
		assert.equal(transport.getState(), ConnectionState.DISCONNECTED);
	});

	it("connect timeout rejects, destroys the socket, and leaves a consistent state", async () => {
		// TEST-NET-3 never answers, so the socket 'timeout' event fires after
		// connectTimeout (exercising onTimeout). If the local network
		// fast-fails instead, the same onError path runs — either way the
		// attempt must reject quickly and clean up.
		const transport = createTransport({ host: "203.0.113.1", port: 60128, connectTimeout: 150 });
		const errors: Error[] = [];
		transport.on("error", (err: Error) => errors.push(err));

		await assert.rejects(transport.connect(), /timeout|EHOST|ENET|ECONN/i);
		assert.equal(transport.getState(), ConnectionState.DISCONNECTED);
		assert.equal(transport.isConnected(), false);
		assert.equal(
			(transport as unknown as { socket: Socket | null }).socket,
			null,
			"socket must be destroyed and cleared",
		);
		assert.ok(errors.length >= 1, "failure should be emitted");

		// A fresh attempt must be possible (no stuck connectPromise).
		await assert.rejects(transport.connect(), /timeout|EHOST|ENET|ECONN/i);
	});

	it("reassembles frames split mid-header and mid-body", async () => {
		const mock = await startMockReceiver();
		const transport = createTransport({ host: "127.0.0.1", port: mock.port });
		transport.on("error", () => {});
		const frames: InboundFrame[] = [];
		transport.on("data", (frame) => frames.push(frame));
		try {
			await transport.connect();
			await mock.waitForClient();
			const full = frameReply("PWR", "01");
			// Split inside the 16-byte header, then inside the body.
			mock.broadcastRaw(full.subarray(0, 7));
			await sleep(30);
			mock.broadcastRaw(full.subarray(7, 20));
			await sleep(30);
			mock.broadcastRaw(full.subarray(20));
			await waitForFrames(frames, 1);
			assert.deepEqual(frames.map(project), ["eiscp:!1PWR01"]);
		} finally {
			transport.disconnect();
			await mock.close();
		}
	});

	it("reassembles a frame delivered byte by byte", async () => {
		const mock = await startMockReceiver();
		const transport = createTransport({ host: "127.0.0.1", port: mock.port });
		transport.on("error", () => {});
		const frames: InboundFrame[] = [];
		transport.on("data", (frame) => frames.push(frame));
		try {
			await transport.connect();
			await mock.waitForClient();
			const full = frameReply("MVL", "0E");
			for (const byte of full) {
				mock.broadcastRaw(Buffer.from([byte]));
				await sleep(2);
			}
			await waitForFrames(frames, 1);
			assert.deepEqual(frames.map(project), ["eiscp:!1MVL0E"]);
		} finally {
			transport.disconnect();
			await mock.close();
		}
	});

	it("emits multiple packets arriving in one data event", async () => {
		const mock = await startMockReceiver();
		const transport = createTransport({ host: "127.0.0.1", port: mock.port });
		transport.on("error", () => {});
		const frames: InboundFrame[] = [];
		transport.on("data", (frame) => frames.push(frame));
		try {
			await transport.connect();
			await mock.waitForClient();
			mock.broadcastRaw(
				Buffer.concat([frameReply("PWR", "01"), frameReply("MVL", "0E"), frameReply("AMT", "00")]),
			);
			await waitForFrames(frames, 3);
			assert.deepEqual(frames.map(project), ["eiscp:!1PWR01", "eiscp:!1MVL0E", "eiscp:!1AMT00"]);
		} finally {
			transport.disconnect();
			await mock.close();
		}
	});

	it("falls back to headerless raw ISCP lines", async () => {
		const mock = await startMockReceiver();
		const transport = createTransport({ host: "127.0.0.1", port: mock.port });
		transport.on("error", () => {});
		const frames: InboundFrame[] = [];
		transport.on("data", (frame) => frames.push(frame));
		try {
			await transport.connect();
			await mock.waitForClient();
			// The parser only runs with >= 16 buffered bytes, so the second
			// 8-byte line stays queued until more data arrives — that is the
			// documented reassembly behaviour, asserted here.
			mock.broadcastRaw(Buffer.from("!1PWR01\r!1MVL0E\r", "ascii"));
			await waitForFrames(frames, 1);
			assert.deepEqual(frames.map(project), ["raw:!1PWR01"]);

			// More data flushes the queued line, then the new frame decodes.
			mock.broadcastRaw(frameReply("AMT", "00"));
			await waitForFrames(frames, 3);
			assert.deepEqual(frames.map(project), ["raw:!1PWR01", "raw:!1MVL0E", "eiscp:!1AMT00"]);
		} finally {
			transport.disconnect();
			await mock.close();
		}
	});

	it("resyncs on garbage bytes before a raw ISCP line", async () => {
		const mock = await startMockReceiver();
		const transport = createTransport({ host: "127.0.0.1", port: mock.port });
		transport.on("error", () => {});
		const frames: InboundFrame[] = [];
		transport.on("data", (frame) => frames.push(frame));
		try {
			await transport.connect();
			await mock.waitForClient();
			// Garbage prefix, then a valid raw line; the parser scans to '!'.
			mock.broadcastRaw(Buffer.concat([Buffer.from("GARBAGEBYTES", "ascii"), Buffer.from("!1PWR01\r", "ascii")]));
			await waitForFrames(frames, 1);
			assert.deepEqual(frames.map(project), ["raw:!1PWR01"]);

			// Pure garbage (no '!' at all, >= 16 bytes) is dropped silently
			// and a following clean eISCP frame still decodes.
			mock.broadcastRaw(Buffer.from("################", "ascii"));
			await sleep(50);
			mock.broadcastRaw(frameReply("AMT", "00"));
			await waitForFrames(frames, 2);
			assert.deepEqual(frames.map(project).at(-1), "eiscp:!1AMT00");
		} finally {
			transport.disconnect();
			await mock.close();
		}
	});

	it("can reconnect after a remote close", async () => {
		const { server, port, sockets } = await startServer();
		const transport = createTransport({ host: "127.0.0.1", port });
		transport.on("error", () => {});
		try {
			await transport.connect();
			assert.ok(transport.isConnected());

			// The server registers the connection a tick after connect()
			// resolves; destroying before that destroys nothing and the
			// close event never comes (this hung the whole suite once).
			const start = Date.now();
			while (sockets.length === 0 && Date.now() - start < 2000) {
				await sleep(5);
			}
			assert.ok(sockets.length > 0, "server never saw the connection");

			const closed = new Promise<void>((resolve) => transport.once("close", () => resolve()));
			for (const socket of sockets) {
				socket.destroy();
			}
			await closed;
			assert.equal(transport.isConnected(), false);

			await transport.connect();
			assert.ok(transport.isConnected(), "reconnect after remote close should work");
		} finally {
			transport.disconnect();
			server.close();
		}
	});
});
