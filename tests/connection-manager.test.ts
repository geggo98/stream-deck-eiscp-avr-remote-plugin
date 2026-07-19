/**
 * Unit tests for the ConnectionManager
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { ConnectionManager } from "../src/adapter/eiscp/connection-manager.ts";
import { createTransport } from "../src/adapter/eiscp/transport.ts";
import { startMockReceiver } from "./helpers/mock-receiver.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until the predicate holds or the timeout elapses. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!predicate() && Date.now() - start < timeoutMs) {
		await sleep(10);
	}
	assert.ok(predicate(), "condition not reached in time");
}

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

	describe("behaviour against the mock receiver", () => {
		it("an incoming message updates the cache and notifies only matching subscribers", async () => {
			const mock = await startMockReceiver();
			const mgr = new ConnectionManager();
			const host = "127.0.0.1";
			const matching: string[] = [];
			const wrongCommand: string[] = [];
			const wrongHost: string[] = [];
			mgr.onCommandUpdate(host, "MVL", (v) => matching.push(v));
			mgr.onCommandUpdate(host, "PWR", (v) => wrongCommand.push(v));
			mgr.onCommandUpdate("10.9.9.9", "MVL", (v) => wrongHost.push(v));
			try {
				const client = await mgr.ensureConnected(host, mock.port);
				await mock.waitForClient();
				mock.broadcast("MVL", "1A");
				await until(() => matching.length > 0);
				assert.deepEqual(matching, ["1A"]);
				assert.deepEqual(wrongCommand, []);
				assert.deepEqual(wrongHost, []);
				assert.equal(mgr.getCachedValue(host, "MVL"), "1A");
				client.disconnect();
			} finally {
				await mock.close();
			}
		});

		it("unsubscribe really stops delivery", async () => {
			const mock = await startMockReceiver();
			const mgr = new ConnectionManager();
			const host = "127.0.0.1";
			const seen: string[] = [];
			const unsub = mgr.onCommandUpdate(host, "MVL", (v) => seen.push(v));
			try {
				const client = await mgr.ensureConnected(host, mock.port);
				await mock.waitForClient();
				mock.broadcast("MVL", "01");
				await until(() => seen.length === 1);
				unsub();
				mock.broadcast("MVL", "02");
				// The second value must still land in the cache (proving the
				// message arrived) without reaching the unsubscribed callback.
				await until(() => mgr.getCachedValue(host, "MVL") === "02");
				assert.deepEqual(seen, ["01"]);
				client.disconnect();
			} finally {
				await mock.close();
			}
		});

		it("a throwing subscriber does not stop delivery to later subscribers (end to end)", async () => {
			const mock = await startMockReceiver();
			const mgr = new ConnectionManager();
			const host = "127.0.0.1";
			const seen: string[] = [];
			mgr.onCommandUpdate(host, "PWR", () => {
				throw new Error("render failed");
			});
			mgr.onCommandUpdate(host, "PWR", (v) => seen.push(v));
			try {
				const client = await mgr.ensureConnected(host, mock.port);
				await mock.waitForClient();
				mock.broadcast("PWR", "01");
				await until(() => seen.length > 0);
				assert.deepEqual(seen, ["01"]);
				client.disconnect();
			} finally {
				await mock.close();
			}
		});

		it("ensureConnected reconnects a disconnected client", async () => {
			const mock = await startMockReceiver();
			const mgr = new ConnectionManager();
			const host = "127.0.0.1";
			try {
				const first = await mgr.ensureConnected(host, mock.port);
				await mock.waitForClient();
				first.disconnect();
				await until(() => !first.isConnected());

				const second = await mgr.ensureConnected(host, mock.port);
				assert.strictEqual(second, first, "the pooled client is reused");
				assert.ok(second.isConnected(), "and reconnected");
				// The revived connection actually works end to end.
				assert.equal(await mgr.queryCommand(host, "PWR"), "00");
				second.disconnect();
			} finally {
				await mock.close();
			}
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
