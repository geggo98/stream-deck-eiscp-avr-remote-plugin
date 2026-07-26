/**
 * What the real receiver does in standby, and whether the test double agrees.
 *
 * Two layers, deliberately:
 *  1. the recording (`npm run capture:standby`) is asserted directly, so the
 *     hardware truth is pinned in an executable form rather than in prose, and
 *  2. the mock's synthetic standby model is driven with a real client and has to
 *     reproduce exactly those facts.
 *
 * If someone re-captures against a device that behaves differently, layer 1 fails
 * and the mock's default has to be reconsidered — which is the point.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createClient } from "../src/adapter/eiscp/client.ts";
import { startMockReceiver } from "./helpers/mock-receiver.ts";

interface Probe {
	command: string;
	before: string;
	sent: string;
	answered: string[];
	after: string;
	changed: boolean;
	powerBefore: string;
	powerAfter: string;
	wokeDevice: boolean;
}

interface Capture {
	model: string;
	snapshot: Record<string, string>;
	verify: Record<string, string>;
	volumeCap: number;
	phases: { standby: { power: string; probes: Probe[] }; awake: { power: string; probes: Probe[] } };
	frames: { dir: "out" | "in"; ms: number; iscp: string; command?: string; parameter?: string }[];
}

const capture = JSON.parse(
	readFileSync(new URL("./fixtures/standby-behaviour-capture.json", import.meta.url), "utf-8"),
) as Capture;

const probe = (phase: "standby" | "awake", command: string): Probe => {
	const found = capture.phases[phase].probes.find((p) => p.command === command);
	assert.ok(found, `${phase} phase has no ${command} probe`);
	return found;
};

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => {
		setTimeout(r, ms).unref?.();
	});

describe("recorded standby behaviour (VSX-S520D)", () => {
	it("was captured with the receiver restored to how it was found", () => {
		// A capture that changed the user's receiver and left it that way would be a
		// bug in the script, and the fixture is where that shows up.
		assert.deepEqual(capture.verify, capture.snapshot);
		assert.ok(capture.volumeCap <= 2, "the volume cap the capture promises");
	});

	it("answers queries in standby", () => {
		// Every probe read a value before its set, in both phases.
		for (const phase of ["standby", "awake"] as const) {
			for (const p of capture.phases[phase].probes) {
				assert.notEqual(p.before, "", `${phase}/${p.command} answered its query`);
			}
		}
	});

	it("drops LMD, AMT and MVL sets in standby without so much as an echo", () => {
		for (const command of ["LMD", "AMT", "MVL"]) {
			const p = probe("standby", command);
			assert.equal(p.changed, false, `${command} did not change`);
			assert.deepEqual(p.answered, [], `${command} was not even acknowledged`);
			assert.equal(p.wokeDevice, false, `${command} did not wake the unit`);
		}
	});

	it("wakes the receiver on an SLI set in standby, and applies it", () => {
		const p = probe("standby", "SLI");
		assert.equal(p.powerBefore, "00", "measured from standby");
		assert.equal(p.changed, true, "the input was actually switched");
		assert.equal(p.wokeDevice, true, "and the unit powered on");
		assert.equal(p.powerAfter, "01");
		assert.ok(
			p.answered.some((m) => m.startsWith("!1PWR01")),
			`the wake was announced: ${p.answered.join(" ")}`,
		);
	});

	it("honours every set once awake", () => {
		for (const p of capture.phases.awake.probes) {
			assert.equal(p.powerBefore, "01", `${p.command} measured while on`);
			assert.equal(p.changed, true, `${p.command} applied`);
			assert.ok(p.answered.length > 0, `${p.command} echoed`);
		}
	});

	it("is replayable through the mock receiver", async () => {
		// Not a full session replay (the capture's own sequence is data-dependent):
		// just proof that the frame list groups into exchanges the double can serve.
		const mock = await startMockReceiver({ replay: capture, replayTimeScale: 0 });
		const client = createClient({ host: "127.0.0.1", port: mock.port, autoQuery: false, commandTimeoutMs: 2000 });
		try {
			await client.connect();
			// The first recorded PWRQSTN was answered with the snapshot's value.
			assert.equal(await client.query("PWR"), capture.snapshot["PWR"]);
			assert.equal(await client.query("SLI"), capture.snapshot["SLI"]);
		} finally {
			client.disconnect();
			await mock.close();
		}
	});
});

describe("mock receiver standby model", () => {
	it("reproduces the recorded device: queries answered, sets dropped, SLI wakes it", async () => {
		const mock = await startMockReceiver({ power: "standby" });
		const client = createClient({ host: "127.0.0.1", port: mock.port, autoQuery: false, commandTimeoutMs: 2000 });
		try {
			await client.connect();
			assert.equal(await client.query("PWR"), "00", "standby");

			// MVL: dropped in silence, so a query afterwards still reads the old value.
			const volume = await client.query("MVL");
			await client.send("MVL", "02");
			await sleep(30);
			assert.equal(await client.query("MVL"), volume, "the set was ignored");
			assert.equal(await client.query("PWR"), "00", "and it stayed in standby");

			// SLI: applied *and* it powers the unit on, like the real device.
			await client.send("SLI", "02");
			await sleep(30);
			assert.equal(await client.query("SLI"), "02", "the input was switched");
			assert.equal(await client.query("PWR"), "01", "and the unit woke up");

			// Awake, the previously ignored command works.
			await client.send("MVL", "02");
			await sleep(30);
			assert.equal(await client.query("MVL"), "02");
		} finally {
			client.disconnect();
			await mock.close();
		}
	});

	it("can play the other device variant: sets acknowledged but not applied", async () => {
		const mock = await startMockReceiver({ power: "standby", standbySets: "echo" });
		const client = createClient({ host: "127.0.0.1", port: mock.port, autoQuery: false, commandTimeoutMs: 2000 });
		try {
			await client.connect();
			const volume = await client.query("MVL");
			// The echo is the *unchanged* value: a client that trusts the echo would
			// believe it worked, which is why the plugin must not trust it.
			assert.equal(await client.query("MVL"), volume);
			await client.send("MVL", "02");
			await sleep(30);
			assert.equal(await client.query("MVL"), volume, "still not applied");
		} finally {
			client.disconnect();
			await mock.close();
		}
	});

	it("can play a receiver that honours sets in standby", async () => {
		const mock = await startMockReceiver({ power: "standby", standbySets: "accept" });
		const client = createClient({ host: "127.0.0.1", port: mock.port, autoQuery: false, commandTimeoutMs: 2000 });
		try {
			await client.connect();
			await client.send("MVL", "02");
			await sleep(30);
			assert.equal(await client.query("MVL"), "02", "applied while in standby");
			assert.equal(await client.query("PWR"), "00", "without waking up");
		} finally {
			client.disconnect();
			await mock.close();
		}
	});

	it("keeps PWR working in standby whatever the variant", async () => {
		for (const standbySets of ["ignore", "echo", "accept"] as const) {
			const mock = await startMockReceiver({ power: "standby", standbySets });
			const client = createClient({ host: "127.0.0.1", port: mock.port, autoQuery: false, commandTimeoutMs: 2000 });
			try {
				await client.connect();
				await client.send("PWR", "01");
				await sleep(30);
				assert.equal(await client.query("PWR"), "01", `PWR works with standbySets=${standbySets}`);
			} finally {
				client.disconnect();
				await mock.close();
			}
		}
	});
});
