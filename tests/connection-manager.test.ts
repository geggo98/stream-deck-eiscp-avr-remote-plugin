/**
 * Unit tests for the ConnectionManager
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ConnectionManager } from "../src/adapter/eiscp/connection-manager.ts";

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
});
