/**
 * The wired half of the power-state tracking, against the mock receiver.
 *
 * What matters here is the timing contract the deck display depends on:
 *  - a PWR frame flips the status *immediately*, without waiting for a heartbeat,
 *  - the heartbeat only runs while somebody is watching that host,
 *  - a receiver that stops answering (or was never there) becomes "offline".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ConnectionManager } from "../src/adapter/eiscp/connection-manager.ts";
import { DeviceStatusTracker, type DeviceStatus } from "../src/adapter/eiscp/device-status.ts";
import { startMockReceiver, type MockReceiver } from "./helpers/mock-receiver.ts";

const HOST = "127.0.0.1";

/** Poll until `check` holds; the status path is event-driven, not awaitable. */
async function until(check: () => boolean, timeoutMs = 3000, what = "condition"): Promise<void> {
	const start = Date.now();
	while (!check() && Date.now() - start < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	if (!check()) throw new Error(`timed out waiting for ${what}`);
}

/**
 * A tracker on its own ConnectionManager (not the singleton) with fast timers,
 * plus everything needed to tear both down.
 */
function makeTracker(
	mock: MockReceiver,
	options: { heartbeatMs?: number; offlineBackoffMs?: number[] } = {},
): {
	tracker: DeviceStatusTracker;
	mgr: ConnectionManager;
	statuses: DeviceStatus[];
	watch: () => () => void;
	dispose: () => void;
} {
	const mgr = new ConnectionManager();
	// The tracker queries through the manager, which defaults to port 60128 — so
	// point it at the mock's port by pre-connecting below.
	const tracker = new DeviceStatusTracker(
		{
			queryCommand: (host, command) =>
				mgr.ensureConnected(host, mock.port).then((client) => client.query(command)),
			addMessageObserver: (cb) => mgr.addMessageObserver(cb),
			addConnectionObserver: (cb) => mgr.addConnectionObserver(cb),
		},
		{ heartbeatMs: options.heartbeatMs ?? 60_000, offlineBackoffMs: options.offlineBackoffMs ?? [40] },
	);
	tracker.start();
	const statuses: DeviceStatus[] = [];
	return {
		tracker,
		mgr,
		statuses,
		watch: () => tracker.onStatus(HOST, (s) => statuses.push(s)),
		dispose: () => tracker.stop(),
	};
}

describe("DeviceStatusTracker", () => {
	it("learns the power state as soon as an action watches the host", async () => {
		const mock = await startMockReceiver({ power: "standby" });
		const { tracker, watch, dispose } = makeTracker(mock);
		try {
			const off = watch();
			await until(() => tracker.getStatus(HOST) === "standby", 3000, "standby");
			off();
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("flips on the receiver's own PWR frame, without waiting for the heartbeat", async () => {
		const mock = await startMockReceiver({ power: "standby" });
		// A heartbeat far beyond the test's lifetime: if the status still changes,
		// it can only have come from the pushed frame.
		const { tracker, statuses, watch, dispose } = makeTracker(mock, { heartbeatMs: 600_000 });
		try {
			watch();
			await until(() => tracker.getStatus(HOST) === "standby", 3000, "initial standby");

			const before = Date.now();
			mock.broadcast("PWR", "01");
			await until(() => tracker.getStatus(HOST) === "on", 1000, "on");
			assert.ok(Date.now() - before < 500, "status followed the frame immediately");
			assert.deepEqual(statuses, ["standby", "on"], "one notification per change, no repeats");
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("reports offline for a receiver that is not there", async () => {
		const mock = await startMockReceiver({ refuseConnections: true });
		const { tracker, watch, dispose } = makeTracker(mock);
		try {
			watch();
			await until(() => tracker.getStatus(HOST) === "offline", 3000, "offline");
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("reports offline for a receiver that accepts the connection but never answers", async () => {
		// The half-open case: TCP is fine, the device is not. Only a probe finds it.
		const mock = await startMockReceiver({ silent: true });
		const { tracker, watch, dispose } = makeTracker(mock);
		try {
			watch();
			await until(() => tracker.getStatus(HOST) === "offline", 8000, "offline after the query timeout");
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("notices when an established connection drops", async () => {
		const mock = await startMockReceiver({ power: "on" });
		const { tracker, watch, dispose } = makeTracker(mock, { heartbeatMs: 600_000 });
		try {
			watch();
			await until(() => tracker.getStatus(HOST) === "on", 3000, "on");
			mock.resetConnections();
			await until(() => tracker.getStatus(HOST) === "offline", 3000, "offline after the drop");
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("recovers on its own once the receiver answers again", async () => {
		const mock = await startMockReceiver({ power: "standby" });
		// Tight backoff so the probe comes round quickly.
		const { tracker, watch, dispose } = makeTracker(mock, { heartbeatMs: 600_000, offlineBackoffMs: [30] });
		try {
			watch();
			await until(() => tracker.getStatus(HOST) === "standby", 3000, "standby");
			mock.resetConnections();
			await until(() => tracker.getStatus(HOST) === "offline", 3000, "offline");
			// Nothing else happens — the backoff probe has to reconnect by itself.
			await until(() => tracker.getStatus(HOST) === "standby", 5000, "recovered");
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("only heartbeats while a host is watched", async () => {
		const mock = await startMockReceiver({ power: "on" });
		const { tracker, watch, dispose } = makeTracker(mock, { heartbeatMs: 40 });
		try {
			const off = watch();
			await until(() => tracker.getStatus(HOST) === "on", 3000, "on");
			await until(() => mock.received.filter((m) => m.command === "PWR").length >= 3, 3000, "heartbeats");

			off();
			const afterUnsubscribe = mock.received.filter((m) => m.command === "PWR").length;
			await new Promise((resolve) => setTimeout(resolve, 200)); // several heartbeat periods
			assert.equal(
				mock.received.filter((m) => m.command === "PWR").length,
				afterUnsubscribe,
				"the heartbeat stopped with the last listener",
			);
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("waitForStatus resolves as soon as the receiver confirms, and gives up cleanly", async () => {
		// This is what a key press waits on after waking the receiver: it must return
		// on the device's own PWR frame, and it must never hang the press.
		const mock = await startMockReceiver({ power: "standby" });
		const { tracker, watch, dispose } = makeTracker(mock, { heartbeatMs: 600_000 });
		try {
			watch();
			await until(() => tracker.getStatus(HOST) === "standby", 3000, "standby");

			assert.equal(await tracker.waitForStatus(HOST, "standby", 50), true, "already there → immediate");
			assert.equal(await tracker.waitForStatus(HOST, "on", 60), false, "times out instead of hanging");

			const waiting = tracker.waitForStatus(HOST, "on", 2000);
			mock.broadcast("PWR", "01");
			assert.equal(await waiting, true, "resolved by the receiver's frame");
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("wakes on a PWR set the way the real receiver does", async () => {
		// End to end through the mock: the plugin sends PWR 01, the mock echoes it,
		// and the tracker turns that frame into "on" — no polling in between.
		const mock = await startMockReceiver({ power: "standby" });
		const { tracker, mgr, watch, dispose } = makeTracker(mock, { heartbeatMs: 600_000 });
		try {
			watch();
			await until(() => tracker.getStatus(HOST) === "standby", 3000, "standby");
			const client = await mgr.ensureConnected(HOST, mock.port);
			await client.send("PWR", "01");
			assert.equal(await tracker.waitForStatus(HOST, "on", 2000), true);
		} finally {
			dispose();
			await mock.close();
		}
	});

	it("shares one status between several watchers and notifies all of them", async () => {
		const mock = await startMockReceiver({ power: "standby" });
		const { tracker, watch, statuses, dispose } = makeTracker(mock, { heartbeatMs: 600_000 });
		try {
			watch();
			const second: DeviceStatus[] = [];
			tracker.onStatus(HOST, (s) => second.push(s));
			await until(() => tracker.getStatus(HOST) === "standby", 3000, "standby");
			mock.broadcast("PWR", "01");
			await until(() => second.includes("on"), 1000, "second watcher notified");
			assert.deepEqual(statuses.at(-1), "on");
		} finally {
			dispose();
			await mock.close();
		}
	});
});
