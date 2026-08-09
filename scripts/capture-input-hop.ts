#!/usr/bin/env tsx
/**
 * Capture what the receiver does on its own when the input is taken away from a
 * playing network source.
 *
 * Two things are being pinned down, both reported from the deck and neither
 * reproducible from anything already recorded:
 *
 *  1. **the hop** — a few seconds after the input moves away from AirPlay, this unit
 *     goes back to it unasked, announcing the input, a listening mode and display text;
 *  2. **the volume** — it was observed dropping to zero at that moment, and the plugin
 *     provably did not send it (the only `MVL` senders in the plugin are the volume
 *     key and dial, and both send `UP`/`DOWN` — there is no absolute volume set
 *     anywhere in the code). So either the receiver or the AirPlay sender does it,
 *     and only the wire can say which.
 *
 * Two runs, because the timing is the interesting variable: one input step, then two
 * in quick succession — the second is the race the user hits when clicking past a
 * source before the receiver pulls it back.
 *
 * NOT SAFE like capture:responses — this *changes* receiver state. It snapshots
 * power, input, volume and mute first, restores them afterwards, and refuses to run
 * without an explicit opt-in.
 *
 * Usage:
 *   EISCP_ALLOW_STATE_CHANGES=1 npm run capture:hop
 *
 * The receiver keeps only one eISCP connection, so stop the plugin first:
 *   npx streamdeck stop de.schwetschke.sd.eiscp-avr-remote
 *
 * Output: tests/fixtures/input-hop-capture.json.
 *
 * Cover art is recorded as a length, not as bytes: `NJA` arrives at ~1800 frames a
 * second during a transfer and would bury both the file and the finding.
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "../src/adapter/eiscp/client.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(PROJECT_ROOT, "tests/fixtures/input-hop-capture.json");

const host = process.env.EISCP_HOST ?? "10.2.0.32";
const port = Number.parseInt(process.env.EISCP_PORT ?? "60128", 10);
/** How long to watch after the last input change, in ms. The hop is "a few seconds". */
const WATCH_MS = Number.parseInt(process.env.EISCP_WATCH_MS ?? "25000", 10);
/** Gap between the two steps of the second run — fast enough to beat the hop. */
const QUICK_STEP_MS = 400;

interface CapturedFrame {
	dir: "out" | "in";
	ms: number;
	iscp: string;
	command?: string;
	parameter?: string;
	/** Cover-art payloads are recorded as a byte count only; see the header. */
	bytes?: number;
	/** Frames folded into this one (cover-art runs); see collapseArt. */
	frames?: number;
	/** How long the folded run lasted. */
	spanMs?: number;
}

/**
 * Fold a run of cover-art frames into one entry.
 *
 * A transfer is ~1800 frames a second and they arrive in unbroken runs, so keeping
 * them one-per-line makes the fixture eight times larger than every other capture in
 * the repository while adding nothing: what matters here is *that* a cover arrived,
 * when, and how big it was. The count, the byte total and the span are kept, so the
 * "nothing may render or log per frame" measurement is still readable off the file.
 */
export function collapseArt(frames: CapturedFrame[]): CapturedFrame[] {
	const out: CapturedFrame[] = [];
	for (const frame of frames) {
		const previous = out[out.length - 1];
		if (frame.command === "NJA" && previous?.command === "NJA" && previous.dir === frame.dir) {
			previous.frames = (previous.frames ?? 1) + 1;
			previous.bytes = (previous.bytes ?? 0) + (frame.bytes ?? 0);
			previous.spanMs = frame.ms - previous.ms;
			previous.iscp = `!1NJA<art x ${previous.frames}>`;
			continue;
		}
		out.push({ ...frame });
	}
	return out;
}

interface Phase {
	name: string;
	steps: number;
	/** Values in force when the phase started, from the receiver's own answers. */
	before: Record<string, string>;
	after: Record<string, string>;
	frames: CapturedFrame[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function splitIscp(iscp: string): { command?: string; parameter?: string } {
	const m = /^!.(\w{3})(.*)$/.exec(iscp.replace(/[\x1a\r\n]+$/, ""));
	return m ? { command: m[1], parameter: m[2] } : {};
}

/** Decode an FLD payload for the console; the fixture keeps the hex. */
function displayText(parameter: string): string {
	try {
		// Filtered by code point rather than by a regex literal: a character class of
		// raw control bytes in the source is exactly what the pre-commit hook rejects.
		return [...Buffer.from(parameter, "hex").toString("utf8")]
			.filter((ch) => {
				const code = ch.codePointAt(0) ?? 0;
				return code >= 0x20 && code !== 0x7f;
			})
			.join("");
	} catch {
		return parameter;
	}
}

function requireOptIn(): void {
	if (process.env.EISCP_ALLOW_STATE_CHANGES === "1") return;
	console.error(
		"Refusing to run: this capture changes the input on the receiver (and watches\n" +
			"what it does about it). Re-run with EISCP_ALLOW_STATE_CHANGES=1 once the Stream\n" +
			"Deck plugin is stopped — it holds the receiver's only eISCP connection.",
	);
	process.exit(1);
}

async function main(): Promise<void> {
	requireOptIn();
	console.log(`Connecting to ${host}:${port} …`);
	const client = createClient({ host, port, autoQuery: false, debugLog: true, commandTimeoutMs: 5000 });

	let frames: CapturedFrame[] = [];
	let t0 = Date.now();
	const live: string[] = [];

	client.on("rawPacket", (direction, packet) => {
		const iscp =
			"iscpMessage" in packet ? packet.iscpMessage : "message" in packet ? packet.message : String(packet);
		const { command, parameter } = splitIscp(iscp);
		const ms = Date.now() - t0;
		// Cover art by the metre: keep the fact and the size, drop the payload.
		if (command === "NJA" && parameter !== undefined && parameter.length > 16) {
			frames.push({ dir: direction === "sent" ? "out" : "in", ms, iscp: "!1NJA<art>", command, bytes: parameter.length / 2 });
			return;
		}
		frames.push({
			dir: direction === "sent" ? "out" : "in",
			ms,
			iscp: iscp.replace(/[\x1a\r\n]+$/, ""),
			...(command ? { command } : {}),
			...(parameter !== undefined ? { parameter } : {}),
		});
		// Everything that matters for these two questions, printed as it happens.
		if (direction === "received" && command && parameter !== undefined) {
			if (["SLI", "MVL", "AMT", "NST", "PWR", "LMD"].includes(command)) {
				live.push(`${ms} ${command} ${parameter}`);
				console.log(`   ${String(ms).padStart(6)} ms  ${command} ${parameter}`);
			} else if (command === "FLD") {
				console.log(`   ${String(ms).padStart(6)} ms  FLD "${displayText(parameter)}"`);
			}
		}
	});
	client.on("error", (err) => console.error(`client error: ${err.message}`));

	await client.connect();
	console.log("Connected.\n");

	const read = async (commands: string[]): Promise<Record<string, string>> => {
		const out: Record<string, string> = {};
		for (const command of commands) {
			try {
				out[command] = await client.query(command);
			} catch (err) {
				console.warn(`  could not read ${command}: ${err}`);
			}
		}
		return out;
	};

	const snapshot = await read(["PWR", "SLI", "MVL", "AMT", "NST"]);
	console.log(`Snapshot: ${JSON.stringify(snapshot)}\n`);
	if (snapshot["PWR"] !== "01") {
		console.error("The receiver is not powered on — nothing to observe. Aborting.");
		client.disconnect();
		process.exit(1);
	}

	const phases: Phase[] = [];

	/** One run: take `steps` inputs away, then watch what the receiver does about it. */
	const runPhase = async (name: string, steps: number, gapMs: number): Promise<void> => {
		console.log(`\n=== ${name}: ${steps} step(s) ===`);
		const before = await read(["SLI", "MVL", "AMT", "NST"]);
		console.log(`  before: ${JSON.stringify(before)}`);
		frames = [];
		live.length = 0;
		t0 = Date.now();
		for (let i = 0; i < steps; i++) {
			await client.send("SLI", "UP");
			console.log(`   ${String(Date.now() - t0).padStart(6)} ms  -> sent SLI UP`);
			if (i < steps - 1) await sleep(gapMs);
		}
		console.log(`  watching for ${WATCH_MS / 1000} s …`);
		await sleep(WATCH_MS);
		const after = await read(["SLI", "MVL", "AMT", "NST"]);
		console.log(`  after:  ${JSON.stringify(after)}`);
		phases.push({ name, steps, before, after, frames: collapseArt(frames) });
	};

	try {
		await runPhase("one step away", 1, 0);
		// Put it back where it started before the second run, so both start alike.
		console.log(`\nRestoring ${snapshot["SLI"]} before the second run …`);
		await client.send("SLI", snapshot["SLI"]!);
		await sleep(6000);
		await runPhase("two steps away, quickly", 2, QUICK_STEP_MS);
	} finally {
		// --- restore ---------------------------------------------------------
		console.log("\nRestoring …");
		for (const [command, value] of [
			["SLI", snapshot["SLI"]],
			["MVL", snapshot["MVL"]],
			["AMT", snapshot["AMT"]],
		] as const) {
			if (value === undefined) continue;
			try {
				await client.send(command, value);
				console.log(`  ${command} -> ${value}`);
				await sleep(500);
			} catch (err) {
				console.error(`  FAILED to restore ${command}=${value}: ${err}`);
			}
		}
		const restored = await read(["SLI", "MVL", "AMT"]);
		console.log(`  now: ${JSON.stringify(restored)}`);

		const fixture = {
			capturedAt: new Date().toISOString(),
			host,
			port,
			model: "VSX-S520D",
			note:
				"Input taken away from a playing AirPlay source, twice: one step and two quick steps. " +
				"Records the receiver's unsolicited hop back and any volume change it makes on its own. " +
				"NJA cover-art payloads are recorded as byte counts only.",
			snapshot,
			watchMs: WATCH_MS,
			quickStepMs: QUICK_STEP_MS,
			phases,
		};
		writeFileSync(OUT, `${JSON.stringify(fixture, null, "\t")}\n`);
		console.log(`\nWrote ${OUT}`);
		client.disconnect();
	}
}

// Only when run, not when imported: `collapseArt` is reused to fold the cover-art
// runs of an already-recorded fixture, and importing must not start a capture.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
