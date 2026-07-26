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
	planDeviceListReply,
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

/** The group of a plan that was expected to answer immediately. */
function planGroup(items: DeviceListItem[] | undefined): { label: string; children: DeviceListEntry[] } {
	assert.ok(items, "plan was expected to carry items");
	return group(items);
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

	it("appends pinned entries that discovery did not find", () => {
		const g = group(buildItems([vsx], { pinned: [{ host: "10.2.0.32", model: "" }] }));
		assert.deepEqual(g.children, [
			{ label: "VSX-S520D (10.0.0.5)", value: "10.0.0.5" },
			{ label: "10.2.0.32", value: "10.2.0.32" },
		]);
	});

	it("labels a pinned entry with its remembered model when there is one", () => {
		const g = group(buildItems([], { pinned: [{ host: "10.2.0.32", model: "VSX-S520D" }] }));
		assert.deepEqual(g.children, [{ label: "VSX-S520D (10.2.0.32)", value: "10.2.0.32" }]);
	});

	it("does not duplicate a pinned entry that was discovered", () => {
		const g = group(
			buildItems([{ host: "10.2.0.32", model: "VSX-S520D" }], { pinned: [{ host: "10.2.0.32", model: "" }] }),
		);
		assert.deepEqual(g.children, [{ label: "VSX-S520D (10.2.0.32)", value: "10.2.0.32" }]);
	});

	it("drops a pinned host that is not a literal IP address", () => {
		// Pinned entries come from persisted action settings, which an older build
		// or hand-edited profile may have filled with anything. The host becomes
		// both the option label and the value the PI writes back, and eventually
		// reaches socket.connect() — so it is validated here too, not only where
		// the remembered device is read.
		const g = group(
			buildItems([], {
				pinned: [
					{ host: "receiver.local", model: "" },
					{ host: "[31mnot-an-ip", model: "" },
					{ host: "10.2.0.32", model: "" },
				],
			}),
		);
		assert.deepEqual(g.children, [{ label: "10.2.0.32", value: "10.2.0.32" }]);
	});

	it("ignores a pinned entry with an empty host", () => {
		// The dropdown's "(none found)" placeholder has value "", and an action
		// that was never configured has no selection to pin.
		const g = group(buildItems([], { pinned: [{ host: "", model: "" }] }));
		assert.deepEqual(g.children, [{ label: "(none found)", value: "", disabled: true }]);
	});

	it("keeps 'Custom IP…' as the last entry in every variant", () => {
		const pinned = [{ host: "10.2.0.32", model: "" }];
		const variants = [
			buildItems([]),
			buildItems([vsx]),
			buildItems([], { pinned }),
			buildItems([vsx], { discoveryFailed: true, pinned }),
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

	it("labels the group 'Last used' when only pinned entries are offered", () => {
		const g = group(buildItems([], { pinned: [{ host: "10.2.0.32", model: "VSX-S520D" }] }));
		assert.equal(g.label, "Last used");
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

describe("planDeviceListReply", () => {
	const vsx: Device = { host: "10.0.0.5", model: "VSX-S520D" };
	const remembered: Device = { host: "10.2.0.32", model: "VSX-S520D" };

	it("answers instantly from a stale cache and refreshes in the background", () => {
		const plan = planDeviceListReply({
			isRefresh: false,
			now: () => 1000 + CACHE_TTL_MS,
			cache: { at: 1000, devices: [vsx] },
			pinned: [],
		});
		assert.equal(plan.scan, true, "an expired cache must still trigger a refresh");
		assert.deepEqual(planGroup(plan.items).children, [{ label: "VSX-S520D (10.0.0.5)", value: "10.0.0.5" }]);
	});

	it("does not scan while the cache is fresh", () => {
		const plan = planDeviceListReply({
			isRefresh: false,
			now: () => 1000 + CACHE_TTL_MS - 1,
			cache: { at: 1000, devices: [vsx] },
			pinned: [],
		});
		assert.equal(plan.scan, false);
		assert.ok(plan.items);
	});

	it("answers from the remembered device alone when nothing was ever discovered", () => {
		// The cold start after a plugin restart: this is what removes the wait.
		const plan = planDeviceListReply({ isRefresh: false, now: () => 0, cache: undefined, pinned: [remembered] });
		assert.equal(plan.scan, true);
		assert.deepEqual(planGroup(plan.items).children, [{ label: "VSX-S520D (10.2.0.32)", value: "10.2.0.32" }]);
	});

	it("withholds items when there is nothing to show, so the loading text is honest", () => {
		const plan = planDeviceListReply({ isRefresh: false, now: () => 0, cache: undefined, pinned: [] });
		assert.equal(plan.items, undefined);
		assert.equal(plan.scan, true, "no items means the caller must wait for a scan");
	});

	it("still answers when there is nothing to show and no scan is due", () => {
		// A fresh cache that genuinely found nothing: withholding items here would
		// leave the dropdown on its loading text forever.
		const plan = planDeviceListReply({
			isRefresh: false,
			now: () => 1000,
			cache: { at: 1000, devices: [] },
			pinned: [],
		});
		assert.equal(plan.scan, false);
		assert.deepEqual(planGroup(plan.items).children, [{ label: "(none found)", value: "", disabled: true }]);
	});

	it("scans on an explicit refresh even with a fresh cache", () => {
		const plan = planDeviceListReply({
			isRefresh: true,
			now: () => 1001,
			cache: { at: 1000, devices: [vsx] },
			pinned: [],
		});
		assert.equal(plan.scan, true);
		assert.ok(plan.items, "a refresh still shows the current list while it re-scans");
	});

	it("ignores pinned entries without a host when deciding there is nothing to show", () => {
		const plan = planDeviceListReply({
			isRefresh: false,
			now: () => 0,
			cache: undefined,
			pinned: [{ host: "", model: "" }],
		});
		assert.equal(plan.items, undefined);
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

	it("discovers, reports the devices, and stamps a fresh cache", async () => {
		const { discover, calls } = countingDiscover({ devices: [vsx], errors: [] });
		const res = await resolveDeviceList({ isRefresh: false, now: () => 1000, cache: undefined, discover });
		assert.equal(calls(), 1);
		assert.equal(res.failed, false);
		assert.deepEqual(res.cache, { at: 1000, devices: [vsx] });
		assert.deepEqual(res.devices, [vsx]);
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
		assert.deepEqual(res.devices, [vsx]);
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
		assert.deepEqual(res.devices, [vsx]);
		// The caller renders these; the failure has to be visible in the label.
		const g = group(buildItems(res.devices, { discoveryFailed: res.failed }));
		assert.equal(g.label, FAILED_LABEL);
		assert.deepEqual(g.children, [{ label: "VSX-S520D (10.0.0.5)", value: "10.0.0.5" }]);
	});

	it("reports no devices when discovery throws and nothing was ever cached", async () => {
		const res = await resolveDeviceList({
			isRefresh: false,
			now: () => 1,
			cache: undefined,
			discover: () => Promise.reject(new Error("boom")),
		});
		assert.equal(res.failed, true);
		assert.deepEqual(res.devices, []);
		// Rendered, that must still leave the "Custom IP…" escape hatch.
		const items = buildItems(res.devices, { discoveryFailed: res.failed });
		assert.deepEqual(group(items).children, [{ label: "(none found)", value: "", disabled: true }]);
		assert.deepEqual(items[items.length - 1], CUSTOM_ITEM);
	});

	it("treats zero devices plus socket errors as blocked: failed, cache preserved", async () => {
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
		assert.deepEqual(res.devices, [vsx]);
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
		assert.deepEqual(res.devices, []);
	});
});
