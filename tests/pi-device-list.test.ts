/**
 * Tests for the pure Device IP dropdown logic (Property Inspector data source).
 * Imports only the SDK-free pi-device-list.ts — no @elgato/streamdeck anywhere
 * in the import chain (the SDK import rotates log files as a side effect).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	buildItems,
	CACHE_TTL_MS,
	resolveDeviceList,
	type Device,
	type DeviceListEntry,
	type DeviceListItem,
	type DiscoverResult,
} from "../src/actions/pi-device-list.ts";

const FAILED_LABEL = "Discovery failed — check Local Network permission";
const CUSTOM_ITEM = { label: "Custom IP…", value: "custom" };

/** The single group heading the item list always starts with. */
function group(items: DeviceListItem[]): { label: string; children: DeviceListEntry[] } {
	const g = items[0];
	assert.ok(g && "children" in g, "first item must be the group");
	return g;
}

describe("buildItems", () => {
	const vsx: Device = { host: "10.0.0.5", model: "VSX-S520D" };

	it("labels discovered devices with model and host", () => {
		const g = group(buildItems([vsx]));
		assert.equal(g.label, "Discovered");
		assert.deepEqual(g.children, [{ label: "VSX-S520D (10.0.0.5)", value: "10.0.0.5" }]);
	});

	it("falls back to the bare host for a model-less device", () => {
		const g = group(buildItems([{ host: "10.0.0.7", model: "" }]));
		assert.deepEqual(g.children, [{ label: "10.0.0.7", value: "10.0.0.7" }]);
	});

	it("always includes the configured IP as 'Configured (...)'", () => {
		const g = group(buildItems([vsx], { configuredIp: "10.2.0.32" }));
		assert.deepEqual(g.children, [
			{ label: "VSX-S520D (10.0.0.5)", value: "10.0.0.5" },
			{ label: "Configured (10.2.0.32)", value: "10.2.0.32" },
		]);
	});

	it("does not duplicate the configured IP when it was discovered", () => {
		const g = group(buildItems([{ host: "10.2.0.32", model: "VSX-S520D" }], { configuredIp: "10.2.0.32" }));
		assert.deepEqual(g.children, [{ label: "VSX-S520D (10.2.0.32)", value: "10.2.0.32" }]);
	});

	it("keeps 'Custom IP…' as the last entry in every variant", () => {
		const variants = [
			buildItems([]),
			buildItems([vsx]),
			buildItems([], { configuredIp: "10.2.0.32" }),
			buildItems([vsx], { discoveryFailed: true, configuredIp: "10.2.0.32" }),
		];
		for (const items of variants) {
			assert.deepEqual(items[items.length - 1], CUSTOM_ITEM);
		}
	});

	it("dedupes devices by host (first entry wins)", () => {
		const g = group(
			buildItems([vsx, { host: "10.0.0.5", model: "OTHER" }, { host: "10.0.0.6", model: "TX-NR696" }]),
		);
		assert.deepEqual(g.children, [
			{ label: "VSX-S520D (10.0.0.5)", value: "10.0.0.5" },
			{ label: "TX-NR696 (10.0.0.6)", value: "10.0.0.6" },
		]);
	});

	it("labels the group 'Pre-configured' when only the configured IP is offered", () => {
		const g = group(buildItems([], { configuredIp: "10.2.0.32" }));
		assert.equal(g.label, "Pre-configured");
		assert.deepEqual(g.children, [{ label: "Configured (10.2.0.32)", value: "10.2.0.32" }]);
	});

	it("names a failed discovery even when cached devices are shown", () => {
		const g = group(buildItems([vsx], { discoveryFailed: true }));
		assert.equal(g.label, FAILED_LABEL);
		assert.equal(g.children.length, 1);
	});

	it("shows a disabled '(none found)' placeholder when the group would be empty", () => {
		const g = group(buildItems([]));
		assert.deepEqual(g.children, [{ label: "(none found)", value: "", disabled: true }]);
	});
});

describe("resolveDeviceList", () => {
	const vsx: Device = { host: "10.0.0.5", model: "VSX-S520D" };

	function countingDiscover(result: DiscoverResult): { discover: () => Promise<DiscoverResult>; calls: () => number } {
		let calls = 0;
		return {
			discover: () => {
				calls++;
				return Promise.resolve(result);
			},
			calls: () => calls,
		};
	}

	it("discovers, builds the item list, and stamps a fresh cache", async () => {
		const { discover, calls } = countingDiscover({ devices: [vsx], errors: [] });
		const res = await resolveDeviceList({ isRefresh: false, now: () => 1000, cache: undefined, discover });
		assert.equal(calls(), 1);
		assert.equal(res.failed, false);
		assert.deepEqual(res.cache, { at: 1000, devices: [vsx] });
		assert.equal(group(res.items).label, "Discovered");
	});

	it("serves the cache within the TTL without calling discover", async () => {
		const { discover, calls } = countingDiscover({ devices: [], errors: [] });
		const cache = { at: 1000, devices: [vsx] };
		const res = await resolveDeviceList({
			isRefresh: false,
			now: () => 1000 + CACHE_TTL_MS - 1,
			cache,
			discover,
		});
		assert.equal(calls(), 0);
		assert.equal(res.cache, cache);
		assert.equal(res.failed, false);
		assert.deepEqual(group(res.items).children, [{ label: "VSX-S520D (10.0.0.5)", value: "10.0.0.5" }]);
	});

	it("re-discovers once the cache is older than the TTL", async () => {
		const { discover, calls } = countingDiscover({ devices: [vsx], errors: [] });
		const res = await resolveDeviceList({
			isRefresh: false,
			now: () => 1000 + CACHE_TTL_MS,
			cache: { at: 1000, devices: [] },
			discover,
		});
		assert.equal(calls(), 1);
		assert.deepEqual(res.cache?.devices, [vsx]);
	});

	it("bypasses a fresh cache when isRefresh is set", async () => {
		const { discover, calls } = countingDiscover({ devices: [vsx], errors: [] });
		const res = await resolveDeviceList({
			isRefresh: true,
			now: () => 1001,
			cache: { at: 1000, devices: [] },
			discover,
		});
		assert.equal(calls(), 1);
		assert.deepEqual(res.cache?.devices, [vsx]);
	});

	it("falls back to cached devices when discovery throws — the list is never empty", async () => {
		const cache = { at: 0, devices: [vsx] };
		const boom = new Error("boom");
		const res = await resolveDeviceList({
			isRefresh: true,
			now: () => 1,
			cache,
			discover: () => Promise.reject(boom),
		});
		assert.equal(res.failed, true);
		assert.equal(res.error, boom);
		assert.equal(res.cache, cache, "cache must survive a failed discovery");
		const g = group(res.items);
		assert.equal(g.label, FAILED_LABEL);
		assert.deepEqual(g.children, [{ label: "VSX-S520D (10.0.0.5)", value: "10.0.0.5" }]);
		assert.deepEqual(res.items[res.items.length - 1], CUSTOM_ITEM);
	});

	it("still offers 'Custom IP…' when discovery throws and nothing was ever cached", async () => {
		const res = await resolveDeviceList({
			isRefresh: false,
			now: () => 1,
			cache: undefined,
			discover: () => Promise.reject(new Error("boom")),
		});
		assert.equal(res.failed, true);
		assert.deepEqual(group(res.items).children, [{ label: "(none found)", value: "", disabled: true }]);
		assert.deepEqual(res.items[res.items.length - 1], CUSTOM_ITEM);
	});

	it("treats zero devices plus socket errors as blocked: failed label, cache preserved", async () => {
		const cache = { at: 0, devices: [vsx] };
		const errors = [{ interfaceAddress: "192.168.1.10", message: "EPERM" }];
		const res = await resolveDeviceList({
			isRefresh: true,
			now: () => 1,
			cache,
			discover: () => Promise.resolve({ devices: [], errors }),
		});
		assert.equal(res.failed, true);
		assert.deepEqual(res.blockedErrors, errors);
		assert.equal(res.cache, cache, "blocked discovery must not overwrite the cache with emptiness");
		const g = group(res.items);
		assert.equal(g.label, FAILED_LABEL);
		assert.deepEqual(g.children, [{ label: "VSX-S520D (10.0.0.5)", value: "10.0.0.5" }]);
	});

	it("caches a genuinely empty result (no devices, no errors) as not-failed", async () => {
		const res = await resolveDeviceList({
			isRefresh: true,
			now: () => 42,
			cache: { at: 0, devices: [vsx] },
			discover: () => Promise.resolve({ devices: [], errors: [] }),
		});
		assert.equal(res.failed, false);
		assert.deepEqual(res.cache, { at: 42, devices: [] });
		assert.equal(group(res.items).label, "Pre-configured");
	});
});
