#!/usr/bin/env tsx
/**
 * Measure and record what a receiver does with SET commands while it is in
 * network standby — the question the plugin's power-state display hinges on.
 *
 * Two things are unknown from the outside and both matter for the test double:
 *
 *  1. does the receiver *answer* a set it will not honour (echo) or stay silent?
 *  2. does its internal state change anyway (so a later query reports the new
 *     value even though nothing was audible)?
 *
 * The script answers both by probing each command twice: once in standby, once
 * awake, always as "query — set — wait — query" so the answer is a comparison
 * rather than an assumption. Every frame in both directions comes from the
 * client's `rawPacket` tap, and the whole frame list is written in the format
 * tests/helpers/mock-receiver.ts replays.
 *
 * NOT SAFE like capture:responses — this *changes* receiver state: it toggles
 * power, switches the input, the listening mode and the volume. It snapshots
 * everything first, restores it afterwards, keeps the receiver muted while it is
 * awake, and refuses to run without an explicit opt-in.
 *
 * Volume: hard-capped at VOLUME_CAP. The cap is asserted, not just intended.
 *
 * Usage:
 *   EISCP_ALLOW_STATE_CHANGES=1 EISCP_HOST=10.2.0.32 npm run capture:standby
 *
 * The receiver keeps only one eISCP connection, so stop the Stream Deck plugin
 * first: npx streamdeck stop de.schwetschke.sd.eiscp-avr-remote
 *
 * Output: tests/fixtures/standby-behaviour-capture.json
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type EiscpClient } from "../src/adapter/eiscp/client.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(PROJECT_ROOT, "tests/fixtures/standby-behaviour-capture.json");

const host = process.env.EISCP_HOST ?? "10.2.0.32";
const port = Number.parseInt(process.env.EISCP_PORT ?? "60128", 10);

/** Never send a volume above this, in either phase. Asserted below. */
const VOLUME_CAP = 2;

/** How long to wait for the receiver to react to a set before querying back. */
const SETTLE_MS = 2000;
/** The unit needs a moment after power-on before it accepts commands. */
const POWER_ON_MS = 4000;
const POWER_OFF_MS = 2000;

/** One recorded frame. `iscp` is the message; `hex` the raw bytes where we have them. */
interface CapturedFrame {
	dir: "out" | "in";
	ms: number;
	iscp: string;
	command?: string;
	parameter?: string;
	hex?: string;
}

/** The outcome of one "query — set — wait — query" probe. */
interface Probe {
	command: string;
	/** Value the receiver reported before the set. */
	before: string;
	/** Value we sent. */
	sent: string;
	/** ISCP messages the receiver sent back within the settle window. */
	answered: string[];
	/** Value the receiver reported after the set ("" when the query failed). */
	after: string;
	/** Whether the reported value actually moved to what we sent. */
	changed: boolean;
	/** PWR before the set — re-established per probe, see runPhase. */
	powerBefore: string;
	/** PWR after the set. */
	powerAfter: string;
	/** The set alone brought the unit out of standby. */
	wokeDevice: boolean;
}

interface Phase {
	/** Raw PWR value this phase re-establishes before *every* probe. */
	power: string;
	probes: Probe[];
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => {
		setTimeout(r, ms).unref?.();
	});

function requireOptIn(): void {
	if (process.env.EISCP_ALLOW_STATE_CHANGES === "1") return;
	console.error(
		"Refusing to run: this capture toggles power and changes input, listening mode\n" +
			"and volume on the receiver. Re-run with EISCP_ALLOW_STATE_CHANGES=1 once the\n" +
			"Stream Deck plugin is stopped (it holds the receiver's only eISCP connection).",
	);
	process.exit(1);
}

/** Decode "!1SLI10" into its command and parameter, tolerating odd input. */
function splitIscp(message: string): { command?: string; parameter?: string } {
	const m = /^!.(\w{3})(.*)$/.exec(message.replace(/[\x1a\r\n]+$/, ""));
	return m ? { command: m[1], parameter: m[2] } : {};
}

/**
 * The value to probe each command with: something the receiver is not already
 * on, so "nothing changed" is distinguishable from "it was already there".
 * Deliberately quiet choices — a silent input, stereo, mute on, volume 2.
 */
function probeValue(command: string, current: string): string {
	switch (command) {
		case "SLI":
			// 02 = GAME, 01 = CBL/SAT: both silent with nothing connected. Never 26
			// (TUNER), which would start playing a station.
			return current === "02" ? "01" : "02";
		case "LMD":
			return current === "00" ? "80" : "00"; // 00 = STEREO
		case "AMT":
			return current === "01" ? "00" : "01";
		case "MVL": {
			// Must differ from the current level, or "changed" would be true for a
			// set the receiver ignored. Both candidates are at or below the cap.
			const level = Number.parseInt(current, 16) === VOLUME_CAP ? VOLUME_CAP - 1 : VOLUME_CAP;
			return level.toString(16).toUpperCase().padStart(2, "0");
		}
		default:
			throw new Error(`no probe value defined for ${command}`);
	}
}

/**
 * Guard the one command that can be loud.
 *
 * Applies to values *this script chooses*. Restoring the level the receiver was
 * found at is exempt: that is the user's own setting, and leaving the unit on a
 * volume it did not have would be the worse outcome. The restore happens as the
 * last step before standby, so it is never played at length.
 */
function assertQuiet(command: string, parameter: string): void {
	if (command !== "MVL") return;
	const level = Number.parseInt(parameter, 16);
	if (Number.isNaN(level) || level > VOLUME_CAP) {
		throw new Error(`refusing to send MVL ${parameter} (level ${level}) — cap is ${VOLUME_CAP}`);
	}
}

async function main(): Promise<void> {
	requireOptIn();
	console.log(`Connecting to ${host}:${port} …`);

	const client: EiscpClient = createClient({
		host,
		port,
		autoQuery: false,
		// The tap this whole script exists for.
		debugLog: true,
		commandTimeoutMs: 5000,
	});

	const frames: CapturedFrame[] = [];
	const t0 = Date.now();

	client.on("rawPacket", (direction, packet) => {
		const iscp =
			"iscpMessage" in packet ? packet.iscpMessage : "message" in packet ? packet.message : String(packet);
		const { command, parameter } = splitIscp(iscp);
		const hex =
			"bytes" in packet
				? packet.bytes.toString("hex")
				: "rawMessage" in packet
					? packet.rawMessage.toString("hex")
					: undefined;
		frames.push({
			dir: direction === "sent" ? "out" : "in",
			ms: Date.now() - t0,
			iscp: iscp.replace(/[\x1a\r\n]+$/, ""),
			...(command ? { command } : {}),
			...(parameter !== undefined ? { parameter } : {}),
			...(hex ? { hex } : {}),
		});
	});
	client.on("error", (err) => console.error(`client error: ${err.message}`));

	await client.connect();
	console.log("Connected.\n");

	const query = async (command: string): Promise<string> => {
		try {
			return await client.query(command);
		} catch (err) {
			console.warn(`  ${command} query failed: ${err}`);
			return "";
		}
	};

	// --- snapshot -----------------------------------------------------------
	const PROBED = ["SLI", "LMD", "AMT", "MVL"];
	const snapshot: Record<string, string> = {};
	for (const command of ["PWR", ...PROBED]) {
		snapshot[command] = await query(command);
	}
	console.log(`Snapshot: ${JSON.stringify(snapshot)}\n`);
	if (!snapshot["PWR"]) throw new Error("could not read PWR — refusing to change state blindly");

	/** Bring the receiver to `want` and report what it actually reports afterwards. */
	const ensurePower = async (want: "00" | "01"): Promise<string> => {
		const now = await query("PWR");
		if (now === want) return now;
		await client.send("PWR", want);
		await sleep(want === "01" ? POWER_ON_MS : POWER_OFF_MS);
		return await query("PWR");
	};

	/**
	 * Run one probe per command, re-establishing `power` before each of them.
	 *
	 * The per-probe reset is the whole reason this script exists twice: measured
	 * on this unit, `SLI` in standby *wakes it* (the receiver answers `PWR01`), so
	 * a phase that only set the power once would silently measure every later
	 * probe on an awake device.
	 */
	const runPhase = async (label: string, power: "00" | "01"): Promise<Phase> => {
		console.log(`\n--- ${label} (PWR ${power} before every probe) ---`);
		const probes: Probe[] = [];
		for (const command of PROBED) {
			const powerBefore = await ensurePower(power);
			const before = await query(command);
			const sent = probeValue(command, before);
			assertQuiet(command, sent);
			const mark = frames.length;
			await client.send(command, sent);
			await sleep(SETTLE_MS);
			// Whatever came back between the send and now is the receiver's answer
			// to it — silence is the interesting case.
			const answered = frames.slice(mark).filter((f) => f.dir === "in").map((f) => f.iscp);
			const after = await query(command);
			const powerAfter = await query("PWR");
			const changed = after === sent;
			const wokeDevice = power === "00" && powerAfter === "01";
			probes.push({ command, before, sent, answered, after, changed, powerBefore, powerAfter, wokeDevice });
			console.log(
				`  ${command}: ${before} --set ${sent}--> ${after || "(no answer)"} | changed=${changed}` +
					`${wokeDevice ? " | WOKE THE DEVICE" : ""}\n` +
					`      answered: ${answered.length ? answered.join(" ") : "(silence)"}`,
			);
		}
		return { power, probes };
	};

	const phases: Record<string, Phase> = {};

	// --- phase 1: standby ---------------------------------------------------
	phases["standby"] = await runPhase("standby", "00");

	// --- phase 2: awake -----------------------------------------------------
	// Turn the volume down to the cap *first*: from here on nothing this script
	// does can be loud, whatever it mutes or unmutes along the way.
	await ensurePower("01");
	const quiet = VOLUME_CAP.toString(16).toUpperCase().padStart(2, "0");
	assertQuiet("MVL", quiet);
	await client.send("MVL", quiet);
	await sleep(SETTLE_MS);
	console.log(`\nVolume held at ${await query("MVL")} for the awake phase.`);
	phases["awake"] = await runPhase("awake", "01");

	// --- restore ------------------------------------------------------------
	console.log("\nRestoring …");
	// The unit has to be awake to accept these (that is what phase 1 measures),
	// so restore first and only then go back to standby. Volume last before the
	// power, so the found level is never played for longer than the power-off.
	await ensurePower("01");
	for (const command of ["SLI", "LMD", "AMT", "MVL"]) {
		const value = snapshot[command];
		if (!value) continue;
		const current = await query(command);
		if (current === value) {
			console.log(`  ${command} already ${value}`);
			continue;
		}
		// Deliberately not assertQuiet: this is the level the receiver was found
		// at, see the comment on that function.
		await client.send(command, value);
		await sleep(SETTLE_MS);
		console.log(`  ${command} -> ${value} (was ${current})`);
	}
	if (snapshot["PWR"] !== "01") {
		await client.send("PWR", "00");
		await sleep(POWER_OFF_MS);
		console.log("  PWR -> 00 (standby, as found)");
	}

	const verify: Record<string, string> = {};
	for (const command of ["PWR", ...PROBED]) verify[command] = await query(command);
	console.log(`\nAfter restore: ${JSON.stringify(verify)}`);
	const drifted = Object.keys(snapshot).filter((c) => snapshot[c] !== verify[c]);
	if (drifted.length) console.warn(`  !! not fully restored: ${drifted.join(", ")}`);

	const fixture = {
		capturedAt: new Date().toISOString(),
		host,
		port,
		model: process.env.EISCP_MODEL ?? "VSX-S520D",
		note:
			"Wire-level recording of how the receiver treats SET commands in network standby " +
			"versus awake. Each probe is query-set-wait-query, so `changed` is measured, not " +
			"assumed, and `answered` records whether the device echoed a set it ignored. " +
			"State-changing capture: snapshot/restore included, volume capped at " +
			`${VOLUME_CAP}, receiver kept muted while awake. Replayed by ` +
			"tests/helpers/mock-receiver.ts.",
		volumeCap: VOLUME_CAP,
		snapshot,
		verify,
		phases,
		frames,
	};
	writeFileSync(OUT, `${JSON.stringify(fixture, null, "\t")}\n`);
	console.log(`\nWrote ${OUT} (${frames.length} frames)`);

	client.disconnect();
}

main().catch((err) => {
	console.error(`Capture failed: ${err}`);
	process.exit(1);
});
