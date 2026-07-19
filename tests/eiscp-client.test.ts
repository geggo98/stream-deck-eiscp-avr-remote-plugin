/**
 * Behaviour tests for the EiscpClient query/response correlation, timeouts,
 * fail-fast on close, and the volume cap — against the fixture-driven mock
 * receiver (no hardware).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createClient, type EiscpClient } from "../src/adapter/eiscp/client.ts";
import { startMockReceiver, type MockReceiver } from "./helpers/mock-receiver.ts";

async function withClient(
	options: { responses?: Record<string, string>; commandTimeoutMs?: number },
	run: (client: EiscpClient, mock: MockReceiver) => Promise<void>,
): Promise<void> {
	const mock = await startMockReceiver({ responses: options.responses });
	const client = createClient({
		host: "127.0.0.1",
		port: mock.port,
		autoQuery: false,
		commandTimeoutMs: options.commandTimeoutMs ?? 1000,
	});
	client.on("error", () => {});
	try {
		await client.connect();
		await mock.waitForClient();
		await run(client, mock);
	} finally {
		client.disconnect();
		await mock.close();
	}
}

function pendingQueryCount(client: EiscpClient): number {
	return (client as unknown as { pendingQueries: Map<string, unknown[]> }).pendingQueries.size;
}

describe("EiscpClient queries", () => {
	it("resolves a query with the answered parameter", async () => {
		await withClient({}, async (client) => {
			assert.equal(await client.query("PWR"), "00");
			assert.equal(await client.query("MVL"), "0E");
			assert.equal(pendingQueryCount(client), 0);
		});
	});

	it("resolves two parallel queries for the same command", async () => {
		await withClient({}, async (client) => {
			const [a, b] = await Promise.all([client.query("MVL"), client.query("MVL")]);
			assert.equal(a, "0E");
			assert.equal(b, "0E");
			assert.equal(pendingQueryCount(client), 0);
		});
	});

	it("rejects after the timeout when the receiver stays silent, leaving no pending queries", async () => {
		await withClient({ commandTimeoutMs: 50 }, async (client) => {
			// SPA is on the mock's ignore list (like on the real VSX-S520D).
			await assert.rejects(client.query("SPA"), /timed out after 50 ms/);
			assert.equal(pendingQueryCount(client), 0);
		});
	});

	it("does not throw on an unsolicited message without a pending query", async () => {
		await withClient({}, async (client, mock) => {
			const messages: string[] = [];
			client.on("message", (m) => messages.push(`${m.command}${m.parameter}`));
			mock.broadcast("MVL", "20");
			const start = Date.now();
			while (messages.length === 0 && Date.now() - start < 2000) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			assert.deepEqual(messages, ["MVL20"]);
			assert.equal(pendingQueryCount(client), 0);
		});
	});

	it("rejects all pending queries immediately when the connection closes", async () => {
		await withClient({ commandTimeoutMs: 5000 }, async (client, mock) => {
			// Two queries the mock will never answer, then cut the connection:
			// both must reject with "closed", far before the 5 s timeout.
			const started = Date.now();
			const pending = [client.query("SPA"), client.query("SPB")];
			await new Promise((resolve) => setTimeout(resolve, 50));
			for (const socket of mock.sockets) socket.destroy();
			await assert.rejects(pending[0]!, /closed while awaiting a response/);
			await assert.rejects(pending[1]!, /closed while awaiting a response/);
			assert.ok(Date.now() - started < 3000, "must fail fast, not wait out the timeout");
			assert.equal(pendingQueryCount(client), 0);
		});
	});
});

describe("EiscpClient volume cap (bytes on the wire)", () => {
	it("setVolume(200) with cap 50 sends MVL32, never MVLC8", async () => {
		const mock = await startMockReceiver();
		const client = createClient({
			host: "127.0.0.1",
			port: mock.port,
			autoQuery: false,
			volume: { max: 80, cap: 50, steps: 80 },
		});
		client.on("error", () => {});
		try {
			await client.connect();
			await mock.waitForClient();
			await client.setVolume(200);
			await mock.waitForCommand("MVL");
			assert.deepEqual(mock.received.at(-1), { command: "MVL", parameter: "32" }); // 0x32 = 50
		} finally {
			client.disconnect();
			await mock.close();
		}
	});

	it("setVolume(-1) clamps to 00 instead of putting '-1' on the wire", async () => {
		const mock = await startMockReceiver();
		const client = createClient({ host: "127.0.0.1", port: mock.port, autoQuery: false });
		client.on("error", () => {});
		try {
			await client.connect();
			await mock.waitForClient();
			await client.setVolume(-1);
			await mock.waitForCommand("MVL");
			assert.deepEqual(mock.received.at(-1), { command: "MVL", parameter: "00" });
		} finally {
			client.disconnect();
			await mock.close();
		}
	});

	it("volumeUp at the cap stays at the cap", async () => {
		const mock = await startMockReceiver({ responses: { MVL: "32" } }); // at cap 50
		const client = createClient({
			host: "127.0.0.1",
			port: mock.port,
			autoQuery: false,
			volume: { max: 80, cap: 50, steps: 80 },
		});
		client.on("error", () => {});
		try {
			await client.connect();
			await mock.waitForClient();
			await client.queryVolume(); // seed internal state with the current level
			await client.volumeUp();
			await mock.waitForCommand("MVL", 2); // query + set
			const set = mock.received.filter((m) => m.command === "MVL" && m.parameter !== "QSTN").at(-1);
			assert.deepEqual(set, { command: "MVL", parameter: "32" }); // still 50
		} finally {
			client.disconnect();
			await mock.close();
		}
	});

	it("a cap above max is clamped to max", async () => {
		const mock = await startMockReceiver();
		const client = createClient({
			host: "127.0.0.1",
			port: mock.port,
			autoQuery: false,
			volume: { max: 80, cap: 200, steps: 80 },
		});
		client.on("error", () => {});
		try {
			assert.equal(client.getVolumeConfig().cap, 80);
			client.updateVolumeConfig({ cap: 300 });
			assert.equal(client.getVolumeConfig().cap, 80);
		} finally {
			client.disconnect();
			await mock.close();
		}
	});
});
