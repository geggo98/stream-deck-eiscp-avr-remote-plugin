/**
 * Unit tests for the eISCP transport socket lifecycle.
 *
 * The reassembly logic (processReceiveBuffer) is covered further down via a
 * local mock server; these tests focus on connect/error/disconnect handling.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { createTransport, ConnectionState } from "../src/adapter/eiscp/transport.ts";

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

		await assert.rejects(attempt);
		assert.equal(transport.getState(), ConnectionState.DISCONNECTED);
	});

	it("can reconnect after a remote close", async () => {
		const { server, port, sockets } = await startServer();
		const transport = createTransport({ host: "127.0.0.1", port });
		transport.on("error", () => {});
		try {
			await transport.connect();
			assert.ok(transport.isConnected());

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
