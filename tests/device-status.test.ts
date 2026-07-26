/**
 * The pure half of the power-state tracking: how observations fold into a status.
 *
 * SDK-free by design (see CLAUDE.md); this file only imports the adapter module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	INITIAL_STATE,
	nextState,
	type HostState,
	type StatusEvent,
} from "../src/adapter/eiscp/device-status.ts";

/** Fold a sequence of events, for the multi-step cases. */
function fold(events: StatusEvent[], from: HostState = INITIAL_STATE): HostState {
	return events.reduce(nextState, from);
}

describe("device status reducer", () => {
	it("reads the two documented power values", () => {
		assert.deepEqual(nextState(INITIAL_STATE, { kind: "power", raw: "01" }), {
			status: "on",
			lastPower: "on",
		});
		assert.deepEqual(nextState(INITIAL_STATE, { kind: "power", raw: "00" }), {
			status: "standby",
			lastPower: "standby",
		});
	});

	it("treats any other power parameter as unknown rather than guessing", () => {
		// "ALL" is the standby-all *command*, not a state report; a malfunctioning
		// or hostile device can send anything at all here.
		// "\u0000" as an escape, not a raw byte: a literal NUL makes git treat the
		// whole file as binary, and it stops diffing from that point on.
		for (const raw of ["ALL", "", "0", "1", "02", "QSTN", " ", "\u0000", "01 "]) {
			assert.equal(nextState({ status: "on", lastPower: "on" }, { kind: "power", raw }).status, "unknown", raw);
		}
	});

	it("goes offline on every kind of connection loss", () => {
		for (const kind of ["disconnected", "connect-failed", "probe-failed"] as const) {
			assert.equal(nextState({ status: "on", lastPower: "on" }, { kind }).status, "offline", kind);
		}
	});

	it("keeps the last power value across an outage and restores it when traffic returns", () => {
		const offline = fold([{ kind: "power", raw: "00" }, { kind: "disconnected" }]);
		assert.equal(offline.status, "offline");
		assert.equal(offline.lastPower, "standby", "remembered for the comeback");

		// The receiver does not re-announce its power state on reconnect, so the
		// remembered side is the best answer until the tracker's PWR query lands.
		assert.equal(nextState(offline, { kind: "message" }).status, "standby");
		assert.equal(nextState(offline, { kind: "connected" }).status, "standby");
	});

	it("comes back as unknown when nothing was ever known", () => {
		const offline = nextState(INITIAL_STATE, { kind: "connect-failed" });
		assert.equal(nextState(offline, { kind: "connected" }).status, "unknown");
	});

	it("leaves a known status alone when unrelated traffic arrives", () => {
		const on: HostState = { status: "on", lastPower: "on" };
		assert.equal(nextState(on, { kind: "message" }), on, "same object, no churn");
		assert.equal(nextState(on, { kind: "connected" }), on);
	});

	it("stays offline without churn while it is already offline", () => {
		const offline: HostState = { status: "offline", lastPower: "on" };
		assert.equal(nextState(offline, { kind: "probe-failed" }), offline);
	});

	it("follows a power change that arrives while offline", () => {
		// A PWR frame is proof of life *and* of which side, so it wins directly.
		const offline: HostState = { status: "offline", lastPower: "standby" };
		assert.deepEqual(nextState(offline, { kind: "power", raw: "01" }), { status: "on", lastPower: "on" });
	});

	it("survives a standby/on/offline round trip", () => {
		const state = fold([
			{ kind: "connected" },
			{ kind: "power", raw: "00" },
			{ kind: "power", raw: "01" },
			{ kind: "disconnected" },
			{ kind: "connect-failed" },
			{ kind: "connected" },
		]);
		assert.deepEqual(state, { status: "on", lastPower: "on" });
	});
});
