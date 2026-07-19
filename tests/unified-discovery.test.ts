/**
 * Unit tests for the DeviceTracker: the device merging/tracking core of the
 * unified eISCP discovery (src/adapter/discovery/device-tracker.ts).
 *
 * The tracker is pure state (no sockets), so these tests exercise the real
 * merge logic instead of simulating it:
 * - airplay + eiscp-broadcast sightings sharing an IP merge into one device
 * - two eiscp sightings with the same hardware identifier merge across IPs
 * - repeated sightings neither duplicate devices nor IPs
 * - update events (device-created, ips-added, metadata-*) and their payloads
 * - emitted snapshots stay immutable when the live device mutates later
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	DeviceTracker,
	type DeviceUpdate,
	type DiscoveredDevice,
} from "../src/adapter/discovery/device-tracker.ts";

/**
 * A discovered device shaped like the controller builds it from an AirPlay
 * (DNS-SD) result: hostname-derived id, possibly multiple IPs (v4 + v6).
 */
function airplayDevice(hostname: string, ips: string[]): DiscoveredDevice {
	return {
		id: `airplay-${hostname}`,
		ips,
		source: "airplay",
		metadata: {
			airplay: {
				instanceName: `Instance ${hostname}`,
				hostname,
				txtRecords: new Map([["model", "VSX-S520D"]]),
			},
		},
	};
}

/**
 * A discovered device shaped like the controller builds it from an eISCP ECN
 * broadcast response. The original id defaults to the controller's
 * `eiscp-<identifier>` scheme but can be overridden to simulate the same
 * receiver being reported under different ids (identifier-based merging).
 */
function eiscpDevice(
	identifier: string,
	ips: string[],
	originalId: string = `eiscp-${identifier}`,
): DiscoveredDevice {
	return {
		id: originalId,
		ips,
		source: "eiscp-broadcast",
		metadata: {
			eiscpBroadcast: {
				modelName: "VSX-S520D",
				iscpPort: 60128,
				areaCode: "DX",
				identifier,
				unitType: "1",
				rawMessage: `!1ECNVSX-S520D/60128/DX${identifier}`,
			},
		},
	};
}

/**
 * A discovered device shaped like the controller builds it from a TCP network
 * scan hit (no identifying metadata beyond the IP).
 */
function scannedDevice(ip: string): DiscoveredDevice {
	return {
		id: `eiscp-scan-${ip}:60128`,
		ips: [ip],
		source: "eiscp-scan",
		metadata: {
			eiscpScan: { timeout: 200 },
		},
	};
}

describe("DeviceTracker (unified discovery device merging)", () => {
	describe("device merging", () => {
		it("merges an eiscp-broadcast sighting into an earlier airplay device sharing an IP", () => {
			const updates: DeviceUpdate[] = [];
			const tracker = new DeviceTracker((update) => updates.push(update));

			const first = tracker.addDiscoveredDevice(
				airplayDevice("PioneerVSX", ["192.168.1.100", "fe80::1"]),
			);
			const second = tracker.addDiscoveredDevice(
				eiscpDevice("0123456789AB", ["192.168.1.100"]),
			);

			assert.equal(first.isNew, true);
			assert.equal(second.isNew, false);
			assert.equal(second.deviceId, first.deviceId, "shared IP must merge into one device");

			const tracked = tracker.get(first.deviceId)!;
			assert.deepEqual(tracked.ips, ["192.168.1.100", "fe80::1"]);
			assert.deepEqual([...tracked.sources], ["airplay", "eiscp-broadcast"]);
			// Metadata of both sources survives the merge
			assert.equal(tracked.metadata.airplay?.hostname, "PioneerVSX");
			assert.equal(tracked.metadata.eiscpBroadcast?.identifier, "0123456789AB");

			// The merge itself is announced as new eISCP metadata (no new IPs)
			assert.deepEqual(
				updates.map((update) => update.type),
				["device-created", "metadata-eiscp-broadcast"],
			);
		});

		it("merges two eiscp sightings with the same identifier but disjoint IPs", () => {
			const updates: DeviceUpdate[] = [];
			const tracker = new DeviceTracker((update) => updates.push(update));

			// Same receiver answering the ECN query on two interfaces: different
			// original ids and disjoint IPs, but the same hardware identifier.
			const first = tracker.addDiscoveredDevice(
				eiscpDevice("0123456789AB", ["192.168.1.50"], "eiscp-if0-0123456789AB"),
			);
			const second = tracker.addDiscoveredDevice(
				eiscpDevice("0123456789AB", ["10.0.0.5"], "eiscp-if1-0123456789AB"),
			);

			assert.equal(second.isNew, false);
			assert.equal(second.deviceId, first.deviceId, "identifier must merge across IPs");
			assert.deepEqual(tracker.get(first.deviceId)!.ips, ["192.168.1.50", "10.0.0.5"]);

			// The extra interface IP is announced via ips-added
			const ipsAdded = updates.filter((update) => update.type === "ips-added");
			assert.equal(ipsAdded.length, 1);
			assert.equal(ipsAdded[0]!.deviceId, first.deviceId);
			assert.deepEqual(ipsAdded[0]!.changes.newIps, ["10.0.0.5"]);
		});

		it("does not create a second device or duplicate IPs when the same device is reported twice", () => {
			const updates: DeviceUpdate[] = [];
			const tracker = new DeviceTracker((update) => updates.push(update));

			const first = tracker.addDiscoveredDevice(eiscpDevice("0123456789AB", ["192.168.1.100"]));
			const second = tracker.addDiscoveredDevice(eiscpDevice("0123456789AB", ["192.168.1.100"]));

			assert.equal(first.isNew, true);
			assert.equal(second.isNew, false);
			assert.equal(second.deviceId, first.deviceId);
			assert.deepEqual(tracker.get(first.deviceId)!.ips, ["192.168.1.100"]);
			// Nothing changed on the repeat sighting, so no extra update is emitted
			assert.deepEqual(updates.map((update) => update.type), ["device-created"]);
		});

		it("assigns sequential, distinct deviceIds to unrelated devices", () => {
			const tracker = new DeviceTracker();

			const a = tracker.addDiscoveredDevice(eiscpDevice("AAAAAAAAAAAA", ["192.168.1.10"]));
			const b = tracker.addDiscoveredDevice(airplayDevice("OtherBox", ["192.168.1.11"]));
			const c = tracker.addDiscoveredDevice(scannedDevice("192.168.1.12"));

			assert.deepEqual([a.deviceId, b.deviceId, c.deviceId], [0, 1, 2]);
			assert.ok(a.isNew && b.isNew && c.isNew);
		});
	});

	describe("update events", () => {
		it("emits device-created first, then typed updates each carrying currentState", () => {
			const updates: DeviceUpdate[] = [];
			const tracker = new DeviceTracker((update) => updates.push(update));

			const { deviceId } = tracker.addDiscoveredDevice(
				airplayDevice("PioneerVSX", ["192.168.1.100"]),
			);
			// Same device seen via eISCP broadcast with one shared and one new IP:
			// merged by the shared IP, contributing a new IP and new metadata at once.
			tracker.addDiscoveredDevice(eiscpDevice("0123456789AB", ["192.168.1.100", "10.2.0.32"]));

			assert.deepEqual(
				updates.map((update) => update.type),
				["device-created", "ips-added", "metadata-eiscp-broadcast"],
			);

			for (const update of updates) {
				assert.equal(update.deviceId, deviceId);
				// Every update carries the full current device state
				assert.equal(update.currentState.deviceId, deviceId);
			}

			// device-created reports the discovering source; ips-added the new IPs
			assert.equal(updates[0]!.changes.source, "airplay");
			assert.deepEqual(updates[1]!.changes.newIps, ["10.2.0.32"]);
			assert.equal(updates[1]!.changes.source, "eiscp-broadcast");
			assert.equal(updates[2]!.changes.newIps, undefined);

			// The final snapshot contains the fully merged result
			const last = updates[2]!;
			assert.deepEqual(last.currentState.ips, ["192.168.1.100", "10.2.0.32"]);
			assert.ok(last.currentState.metadata.airplay);
			assert.ok(last.currentState.metadata.eiscpBroadcast);
		});
	});

	describe("snapshot immutability", () => {
		it("keeps already-emitted snapshots unchanged when the live device mutates later", () => {
			const updates: DeviceUpdate[] = [];
			const tracker = new DeviceTracker((update) => updates.push(update));

			const { deviceId } = tracker.addDiscoveredDevice(
				airplayDevice("PioneerVSX", ["192.168.1.100"]),
			);
			const created = updates[0]!.currentState;

			// A later sighting mutates the live tracked object in place (new IP,
			// new source, new metadata)...
			tracker.addDiscoveredDevice(eiscpDevice("0123456789AB", ["192.168.1.100", "10.2.0.32"]));
			// ...and mutate the live object directly for good measure.
			const live = tracker.get(deviceId)!;
			live.ips.push("172.16.0.9");
			live.sources.add("eiscp-scan");
			live.metadata.airplay!.txtRecords.set("mutated", "yes");

			// The device-created snapshot still describes the state at emit time
			assert.deepEqual(created.ips, ["192.168.1.100"]);
			assert.deepEqual([...created.sources], ["airplay"]);
			assert.equal(created.metadata.eiscpBroadcast, undefined);
			// The airplay txtRecords Map was deep-copied too, not shared
			assert.equal(created.metadata.airplay!.txtRecords.get("mutated"), undefined);
			assert.equal(created.metadata.airplay!.txtRecords.get("model"), "VSX-S520D");

			// Intermediate snapshots are equally isolated from later mutations
			const ipsAdded = updates.find((update) => update.type === "ips-added")!;
			assert.deepEqual(ipsAdded.currentState.ips, ["192.168.1.100", "10.2.0.32"]);
		});
	});
});
