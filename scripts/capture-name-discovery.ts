#!/usr/bin/env tsx
/**
 * Capture the wire traffic of the Auto-Discover sweeps from a real receiver.
 *
 * NOT SAFE like capture:responses — this one *changes* receiver state: it cycles
 * every input and every listening mode, exactly as the plugin's "Auto-Discover
 * option names" button does. It snapshots power/input/mode first and restores
 * them afterwards, and it refuses to run without an explicit opt-in.
 *
 * The sweep is driven by the plugin's own state machine (`runSweep`), so the
 * recording is what production actually sends rather than a hand-rolled
 * imitation of it; only the side effects (receiver I/O, sleeping, name
 * recording) are wired up here. Every frame in both directions is taken from the
 * client's `rawPacket` tap.
 *
 * Usage:
 *   EISCP_ALLOW_STATE_CHANGES=1 EISCP_HOST=10.2.0.32 npm run capture:names
 *
 * The receiver keeps only one eISCP connection, so stop the Stream Deck plugin
 * first: npx streamdeck stop de.schwetschke.sd.eiscp-avr-remote
 *
 * Output: tests/fixtures/name-discovery-capture.json, replayed by
 * tests/helpers/mock-receiver.ts (see tests/sweep-capture.test.ts).
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type EiscpClient } from "../src/adapter/eiscp/client.ts";
import { runSweep, type SweepDeps } from "../src/actions/dedicated/sweep.ts";
import type { TrackedCommand } from "../src/actions/dedicated/name-store.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(PROJECT_ROOT, "tests/fixtures/name-discovery-capture.json");

const host = process.env.EISCP_HOST ?? "10.2.0.32";
const port = Number.parseInt(process.env.EISCP_PORT ?? "60128", 10);

/** One recorded frame. `iscp` is the message; `hex` the raw bytes where we have them. */
interface CapturedFrame {
	dir: "out" | "in";
	ms: number;
	iscp: string;
	command?: string;
	parameter?: string;
	hex?: string;
}

interface CapturedSweep {
	start: string;
	steps: number;
	/** code -> learned display name (SLI only; LMD names are learned passively). */
	names: Record<string, string>;
	frames: CapturedFrame[];
}

const BASELINE_QUERIES = ["PWR", "MVL", "AMT", "SLI", "LMD", "FLD", "DIM"];

function requireOptIn(): void {
	if (process.env.EISCP_ALLOW_STATE_CHANGES === "1") return;
	console.error(
		"Refusing to run: this capture cycles every input and listening mode on the\n" +
			"receiver. Re-run with EISCP_ALLOW_STATE_CHANGES=1 once the Stream Deck plugin\n" +
			"is stopped (it holds the receiver's only eISCP connection).",
	);
	process.exit(1);
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => {
		setTimeout(r, ms).unref?.();
	});

/** Decode "!1SLI10" into its command and parameter, tolerating odd input. */
function splitIscp(message: string): { command?: string; parameter?: string } {
	const m = /^!.(\w{3})(.*)$/.exec(message.replace(/[\x1a\r\n]+$/, ""));
	return m ? { command: m[1], parameter: m[2] } : {};
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

	// Raw codes per command, the way ConnectionManager caches them for the sweep.
	const codes: Record<string, string> = {};
	let frames: CapturedFrame[] = [];
	let t0 = Date.now();

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
		if (direction === "received" && command && parameter !== undefined) codes[command] = parameter;
	});
	client.on("error", (err) => console.error(`client error: ${err.message}`));

	await client.connect();
	console.log("Connected.\n");

	// --- snapshot -----------------------------------------------------------
	const snapshot: Record<string, string> = {};
	for (const command of ["PWR", "SLI", "LMD", "MVL"]) {
		try {
			snapshot[command] = await client.query(command);
		} catch (err) {
			console.warn(`  could not snapshot ${command}: ${err}`);
		}
	}
	console.log(`Snapshot: ${JSON.stringify(snapshot)}\n`);

	const poweredOn = snapshot["PWR"] === "01";
	if (!poweredOn) {
		console.log("Receiver is in standby — powering on for the capture.");
		await client.send("PWR", "01");
		await sleep(3000);
	}

	// --- baseline queries ---------------------------------------------------
	const baseline: { command: string; parameter: string }[] = [];
	for (const command of BASELINE_QUERIES) {
		try {
			baseline.push({ command, parameter: await client.query(command) });
			console.log(`  ${command} = ${baseline[baseline.length - 1]!.parameter}`);
		} catch (err) {
			console.log(`  ${command} timed out (the real unit ignores some commands): ${err}`);
		}
	}

	// --- sweeps -------------------------------------------------------------
	const sweeps: Record<string, CapturedSweep> = {};

	for (const command of ["SLI", "LMD"] as TrackedCommand[]) {
		console.log(`\nSweeping ${command} …`);
		const names: Record<string, string> = {};
		frames = [];
		t0 = Date.now();
		const start = codes[command] ?? snapshot[command] ?? "";

		const deps: SweepDeps = {
			send: (_h, cmd, param) => client.send(cmd, param),
			query: (_h, cmd) => client.query(cmd),
			getCached: (_h, cmd) => codes[cmd],
			sleep,
			// Names are what we are capturing, so keep the label raw.
			nameFor: (_h, _cmd, code) => code ?? "",
			recordSli: (_h, code, fldHex) => {
				// The plugin decodes this FLD payload into a display string; here the
				// raw hex is the interesting part for a test double.
				names[code] = fldHex;
				// "learned" on purpose: the recording is meant to capture what a single
				// reading returns. Reporting anything else would make the sweep
				// re-measure and the capture would no longer show one FLD per step.
				return "learned";
			},
			// The capture keeps its own map, so "does this code have a name" is simply
			// whether the sweep already recorded one for it.
			hasLearnedName: (_h, _cmd, code) => names[code] !== undefined,
			setSliSweeping: () => {},
			log: {
				info: (m) => console.log(`  ${m}`),
				debug: () => {},
				error: (m) => console.error(`  ${m}`),
			},
		};

		const { count } = await runSweep(host, command, (p) => console.log(`  step ${p.done}: ${p.current}`), deps);
		sweeps[command] = { start, steps: count, names, frames };
		console.log(`  ${command}: ${count} steps, ${frames.length} frames recorded`);
	}

	// --- restore ------------------------------------------------------------
	console.log("\nRestoring …");
	for (const command of ["SLI", "LMD"]) {
		const value = snapshot[command];
		if (value && codes[command] !== value) {
			await client.send(command, value);
			await sleep(1500);
			console.log(`  ${command} -> ${value}`);
		}
	}
	if (!poweredOn) {
		await client.send("PWR", "00");
		console.log("  PWR -> 00 (standby, as found)");
	}

	const fixture = {
		capturedAt: new Date().toISOString(),
		host,
		port,
		model: process.env.EISCP_MODEL ?? "VSX-S520D",
		note:
			"Wire-level recording of the Auto-Discover sweeps, driven by the plugin's own " +
			"runSweep state machine. State-changing capture: snapshot/restore included. " +
			"Replayed by tests/helpers/mock-receiver.ts.",
		baseline,
		sweeps,
	};
	writeFileSync(OUT, `${JSON.stringify(fixture, null, "\t")}\n`);
	console.log(`\nWrote ${OUT}`);

	client.disconnect();
}

main().catch((err) => {
	console.error(`Capture failed: ${err}`);
	process.exit(1);
});
