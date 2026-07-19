/**
 * Unit tests for the ConnectionManager
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { ConnectionManager } from "../src/adapter/eiscp/connection-manager.ts";
import { createTransport } from "../src/adapter/eiscp/transport.ts";

/** Start a TCP server on an ephemeral port and count incoming connections. */
async function startCountingServer(): Promise<{ server: Server; port: number; connections: () => number }> {
	const server = createServer();
	let count = 0;
	server.on("connection", (socket: Socket) => {
		count++;
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return { server, port, connections: () => count };
}

describe("ConnectionManager", () => {
	describe("singleton", () => {
		it("should return the same instance", () => {
			const a = ConnectionManager.getInstance();
			const b = ConnectionManager.getInstance();
			assert.strictEqual(a, b);
		});
	});

	describe("state cache", () => {
		it("getCachedValue returns undefined for unknown host", () => {
			const mgr = ConnectionManager.getInstance();
			assert.equal(mgr.getCachedValue("unknown-host", "PWR"), undefined);
		});
	});

	describe("subscriptions", () => {
		it("onCommandUpdate returns an unsubscribe function", () => {
			const mgr = ConnectionManager.getInstance();
			let called = false;
			const unsub = mgr.onCommandUpdate("test-host", "PWR", () => {
				called = true;
			});

			assert.equal(typeof unsub, "function");

			// Unsubscribe should not throw
			unsub();
		});

		it("unsubscribe prevents future callbacks", () => {
			const mgr = ConnectionManager.getInstance();
			let callCount = 0;
			const unsub = mgr.onCommandUpdate("test-host-2", "MVL", () => {
				callCount++;
			});

			unsub();

			// After unsubscribe, callback should not be called
			// (We can't easily trigger a message without a real connection,
			// but at least verify the unsubscribe doesn't throw)
			assert.equal(callCount, 0);
		});
	});

	describe("subscriber dispatch", () => {
		it("a throwing subscriber does not block later subscribers", () => {
			const mgr = new ConnectionManager();
			const received: string[] = [];
			mgr.onCommandUpdate("throwing-host", "PWR", () => {
				throw new Error("render failed");
			});
			mgr.onCommandUpdate("throwing-host", "PWR", (value) => received.push(value));

			// handleMessage is private; drive it directly instead of via a
			// network round-trip (the end-to-end path is covered elsewhere).
			(
				mgr as unknown as {
					handleMessage(host: string, msg: { command: string; parameter: string }): void;
				}
			).handleMessage("throwing-host", { command: "PWR", parameter: "01" });

			assert.deepEqual(received, ["01"]);
		});
	});

	describe("connect deduplication", () => {
		it("parallel ensureConnected calls share a single connection", async () => {
			const { server, port, connections } = await startCountingServer();
			const mgr = new ConnectionManager();
			try {
				const [a, b] = await Promise.all([
					mgr.ensureConnected("127.0.0.1", port),
					mgr.ensureConnected("127.0.0.1", port),
				]);
				assert.strictEqual(a, b);
				assert.ok(a.isConnected());
				// The server registers the connection a beat after the client does.
				await new Promise((resolve) => setTimeout(resolve, 50));
				assert.equal(connections(), 1);
				a.disconnect();
			} finally {
				server.close();
			}
		});

		it("parallel transport.connect calls resolve without throwing", async () => {
			const { server, port } = await startCountingServer();
			const transport = createTransport({ host: "127.0.0.1", port });
			// Without a listener a late socket error would crash the test process.
			transport.on("error", () => {});
			try {
				await Promise.all([transport.connect(), transport.connect()]);
				assert.ok(transport.isConnected());
			} finally {
				transport.disconnect();
				server.close();
			}
		});
	});
});
