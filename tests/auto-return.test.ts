/**
 * A receiver that steers itself, against the passive learner and against Auto-Discover.
 *
 * The reference VSX-S520D hops back to its network input by itself, a few seconds after
 * the input is moved away from it, whenever AirPlay is playing. Nothing requests it and
 * nothing announces it as different from a change the plugin asked for — which is why
 * both learned-name defects this branch fixes were invisible until they had already been
 * persisted.
 *
 * This is the only test in the suite that wires the REAL sweep, the REAL name store and a
 * REAL socket together. `tests/sweep.test.ts` fakes the receiver, `tests/sweep-capture.test.ts`
 * fakes the store, and neither can express a frame the receiver sent on its own initiative.
 *
 * Two liberties, both taken deliberately:
 *  - time is compressed (the sweep's waits are capped at SLEEP_CAP_MS, the hop fires after
 *    HOP_MS). What matters is the *order* — the hop lands while the sweep is on another
 *    input — not the absolute seconds, which on the real unit are 3 s of settle against a
 *    few seconds of hop.
 *  - the display scrolls, one window per read. A frozen readout is a different receiver:
 *    it is a persistent one, and the sweep's majority rule is entitled to believe it.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runSweep, type SweepDeps } from "../src/actions/dedicated/sweep.ts";
import {
	hasLearnedName,
	nameFor,
	noteChange,
	noteDisplayChange,
	noteFld,
	recordSli,
	serialize,
	setSliSweeping,
} from "../src/actions/dedicated/name-store.ts";
import { createClient } from "../src/adapter/eiscp/client.ts";
import { startMockReceiver, type MockReceiver } from "./helpers/mock-receiver.ts";

/** Codes as the reference unit reports them. */
const NET = "2B"; // the network input AirPlay plays on
const BLURAY = "10";
const MODE_ON_NET = "82"; // "DTS Neural:X" — the mode it announces with the hop

/** The service name it puts on the display when it lands, which became a mode name. */
const SERVICE = "Airplay";
/** A scrolling title, one window per read — the shape that became an input name. */
const TITLE_WINDOWS = ["at is Love (7", "t is Love (Ra", " is Love (Rad", "is Love (Radi", "s Love (Radio"];

const HOP_MS = 60;
const SLEEP_CAP_MS = 25;

const sleepMs = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});

interface Rig {
	client: ReturnType<typeof createClient>;
	mock: MockReceiver;
	/** Codes as ConnectionManager would cache them. */
	codes: Record<string, string>;
	/** Every inbound `<command> <parameter>`, in order. */
	inbound: string[];
	deps: SweepDeps;
	logLines: string[];
}

/**
 * Start the double, connect a real client, and feed every inbound frame to the name
 * store exactly the way `src/actions/dedicated/discovery.ts` does.
 *
 * `register()` is not used on purpose: it is a module-global singleton bound to the real
 * ConnectionManager, so a test that called it would leak into every other test.
 */
async function rig(host: string, options: Parameters<typeof startMockReceiver>[0] = {}): Promise<Rig> {
	const mock = await startMockReceiver({
		responses: {
			PWR: "01",
			SLI: NET,
			LMD: MODE_ON_NET,
			// The quieting asks for these three; without them every query would sit out
			// its full timeout, which turns a 4 s test into a two-minute one.
			MVL: "0E",
			AMT: "00",
			NST: "P--", // playing, so the hop is armed and the resume is exercised
			// A well-formed input readout for the steps where the hop's scrolling text
			// is not in play: "NET          14", ending in the volume above.
			FLD: Buffer.from("NET          14", "ascii").toString("hex").toUpperCase(),
		},
		...options,
	});
	// `debugLog` is what makes the client emit `rawPacket`, which is this rig's only
	// window onto the wire — without it the observer below never runs and every
	// assertion here passes for the wrong reason.
	const client = createClient({
		host: "127.0.0.1",
		port: mock.port,
		autoQuery: false,
		debugLog: true,
		commandTimeoutMs: 2000,
	});
	const codes: Record<string, string> = {};
	const inbound: string[] = [];
	const logLines: string[] = [];

	client.on("rawPacket", (direction, packet) => {
		if (direction !== "received") return;
		const message = "message" in packet ? packet.message : "";
		const m = /^!.(\w{3})(.*)$/.exec(message.replace(/[\x1a\r\n]+$/, ""));
		if (!m) return;
		const [, command, parameter] = m as unknown as [string, string, string];
		codes[command] = parameter;
		inbound.push(`${command} ${parameter}`);
		if (command === "SLI" || command === "LMD") noteChange(host, command, parameter);
		else if (command === "FLD") noteFld(host, parameter);
		else noteDisplayChange(host, command, parameter);
	});
	client.on("error", () => {});
	await client.connect();
	await mock.waitForClient();
	// A receiver with something playing has announced it: `NST` is broadcast on every
	// state change, and the plugin has been listening since it connected. That frame is
	// the whole of how the sweep knows whether it may resume afterwards.
	if (options.autoReturn) {
		mock.broadcast("NST", "P--");
		await sleepMs(20);
	}

	const deps: SweepDeps = {
		send: (_h, command, param) => client.send(command, param),
		query: (_h, command) => client.query(command),
		getCached: (_h, command) => codes[command],
		// The sweep's real waits are seconds; keep the order, drop the duration.
		sleep: (ms) => sleepMs(Math.min(ms, SLEEP_CAP_MS)),
		nameFor,
		recordSli,
		hasLearnedName,
		setSliSweeping,
		log: {
			info: (m) => logLines.push(`info ${m}`),
			debug: (m) => logLines.push(`debug ${m}`),
			warn: (m) => logLines.push(`warn ${m}`),
			error: (m) => logLines.push(`error ${m}`),
		},
	};
	return { client, mock, codes, inbound, deps, logLines };
}

async function shutdown(r: Rig): Promise<void> {
	r.client.disconnect();
	await r.mock.close();
}

const autoReturn = (display?: readonly string[]) => ({
	input: NET,
	afterMs: HOP_MS,
	mode: MODE_ON_NET,
	display,
});

/**
 * The other kind of receiver: one that wants its input back even while the source is
 * paused. Whether the reference unit is this one is unmeasured, so the sweep's
 * detect-and-report path has to keep working for it.
 */
const stubbornAutoReturn = (display?: readonly string[]) => ({ ...autoReturn(display), ignoresPause: true });

describe("a receiver that changes the input by itself", () => {
	it("really does announce an input nobody asked for (the premise)", async () => {
		// Everything below is only interesting if the double does the hard thing. It has
		// to move the input on its own initiative, announce a listening mode with it, and
		// put text on the display — none of it in answer to a request.
		const r = await rig("ar-premise", { autoReturn: autoReturn([SERVICE]) });
		try {
			await r.client.send("SLI", BLURAY);
			await sleepMs(HOP_MS * 4);

			const setsAsked = r.mock.received.filter((m) => m.command === "SLI" && m.parameter !== "QSTN");
			assert.deepEqual(
				setsAsked.map((m) => m.parameter),
				[BLURAY],
				"the plugin asked for exactly one input change",
			);
			const hop = r.inbound.indexOf(`SLI ${NET}`);
			assert.ok(hop > r.inbound.indexOf(`SLI ${BLURAY}`), `the receiver announced a second one: ${r.inbound}`);
			assert.ok(r.inbound.indexOf(`LMD ${MODE_ON_NET}`) > hop, "and a listening mode of its own after it");
			assert.ok(
				r.inbound.some((f) => f.startsWith("FLD ")),
				"and then put something on the display",
			);
		} finally {
			await shutdown(r);
		}
	});

	it("does not let the hop rename the listening mode", async () => {
		// The reported defect: mode 82 ("DTS Neural:X") became "Airplay".
		const host = "ar-mode";
		const r = await rig(host, { autoReturn: autoReturn([SERVICE]) });
		try {
			await r.client.send("SLI", BLURAY);
			await sleepMs(HOP_MS * 4);
			assert.notEqual(nameFor(host, "LMD", MODE_ON_NET), SERVICE);
			assert.equal(serialize()[host]?.LMD, undefined, "the receiver's own announcement taught us nothing");
		} finally {
			await shutdown(r);
		}
	});

	it("does not let the hop's display text become an input name", async () => {
		// The other reported defect: the Input encoder read "at is Love (".
		const host = "ar-input";
		const r = await rig(host, { autoReturn: autoReturn(TITLE_WINDOWS) });
		try {
			// The receiver has a volume, as it does in every recording; the readout has
			// to end in it, and a scrolling title does not.
			await r.client.send("MVL", "0E");
			await r.client.send("SLI", BLURAY);
			await sleepMs(HOP_MS * 4);
			const learned = serialize()[host]?.SLI ?? {};
			assert.deepEqual(
				Object.values(learned).filter((name) => name.includes("Love")),
				[],
				`a track title was stored as an input name: ${JSON.stringify(learned)}`,
			);
		} finally {
			await shutdown(r);
		}
	});
});

describe("Auto-Discover against a receiver that changes the input by itself", () => {
	it("stores no name it cannot stand behind, and says in the log what happened", async () => {
		// The sweep cannot tell its own UP from the receiver's hop — both arrive as an
		// SLI frame — so what it must not do is *store* something wrong, and what it must
		// do is leave a trail. Both are asserted; the truncation itself is reported by the
		// stopping line rather than prevented here.
		const host = "ar-sweep";
		const r = await rig(host, { autoReturn: stubbornAutoReturn(TITLE_WINDOWS) });
		try {
			await r.client.send("MVL", "0E");
			const result = await runSweep(host, "SLI", undefined, r.deps);
			// The walk is cut short — the hop back to the input the sweep started on
			// is an exact wrap — and saying so is the whole of the fix here. Reported
			// as a clean run, the Property Inspector asks whether the receiver is
			// switched on, about one that is awake and playing.
			assert.equal(result.interrupted, true, `the run was disrupted but did not say so: ${JSON.stringify(result)}`);

			const learned = serialize()[host]?.SLI ?? {};
			assert.deepEqual(
				Object.entries(learned).filter(([, name]) => name.includes("Love")),
				[],
				`the sweep stored a scrolling title as an input name: ${JSON.stringify(learned)}`,
			);
			assert.equal(serialize()[host]?.LMD, undefined, "and no mode name from the modes it announced");

			// The log has to answer "what did it do", not just "it is done".
			const steps = r.logLines.filter((l) => /^info sweep SLI step \d+:/.test(l));
			assert.ok(steps.length > 0, `no per-step lines: ${r.logLines.join(" | ")}`);
			assert.ok(
				r.logLines.some((l) => l.startsWith("info sweep SLI stopping:")),
				`nothing says why it stopped: ${r.logLines.join(" | ")}`,
			);
		} finally {
			await shutdown(r);
		}
	});

	it("tells the Property Inspector what happened, before it blames the power state", () => {
		// The PI is static JS in the webview, so nothing else here can reach it. What
		// this pins is the *order*: the interrupted branch has to come before the
		// "is the receiver switched on?" one, because a truncated run also has few or
		// no names and would otherwise be diagnosed as a sleeping receiver.
		const pi = readFileSync(
			new URL("../de.schwetschke.sd.eiscp-avr-remote.sdPlugin/ui/eiscp-pi.js", import.meta.url),
			"utf-8",
		);
		const interrupted = pi.indexOf("p.interrupted");
		const powerQuestion = pi.indexOf("is the receiver switched on?");
		assert.ok(interrupted > 0, "the PI does not handle an interrupted sweep at all");
		assert.ok(powerQuestion > 0, "the standby wording moved; this test needs updating");
		assert.ok(interrupted < powerQuestion, "the interrupted case must be answered before the standby one");
	});

	it("a paused source really does stop the receiver hopping (the premise)", async () => {
		// The one thing about this change that is modelled rather than measured. If the
		// double did not honour the pause, everything below would prove nothing — so it
		// is asserted directly, before any test leans on it.
		const r = await rig("ar-pause-premise", { autoReturn: autoReturn([SERVICE]) });
		try {
			await r.client.send("NTC", "PAUSE");
			await r.client.send("SLI", BLURAY);
			await sleepMs(HOP_MS * 6);
			assert.ok(
				!r.inbound.includes(`SLI ${NET}`),
				`the receiver hopped back anyway: ${r.inbound.join(" | ")}`,
			);
			// And it starts hopping again once the source resumes — otherwise the test
			// above would pass on a double that simply never hops.
			await r.client.send("NTC", "PLAY");
			await sleepMs(HOP_MS * 6);
			assert.ok(r.inbound.includes(`SLI ${NET}`), "resuming did not re-arm the hop");
		} finally {
			await shutdown(r);
		}
	});

	it("finishes the walk on a receiver that would otherwise steer it", async () => {
		// The whole point: same receiver, same hop, but the sweep silences it first.
		const host = "ar-sweep-quiet";
		const r = await rig(host, { autoReturn: autoReturn(TITLE_WINDOWS) });
		try {
			const result = await runSweep(host, "SLI", undefined, r.deps);
			assert.equal(result.interrupted, false, `still disrupted: ${r.logLines.join(" | ")}`);
			assert.ok(result.count > 2, `the walk was still truncated after ${result.count} steps`);
			assert.ok(
				r.logLines.some((l) => l.includes("paused the source")),
				`it did not quieten: ${r.logLines.join(" | ")}`,
			);
		} finally {
			await shutdown(r);
		}
	});

	it("notices out loud when the receiver moves an input it is still reading", async () => {
		// Silent on a healthy sweep; the point is that the disrupted one is not silent.
		const host = "ar-sweep-noticed";
		const r = await rig(host, { autoReturn: stubbornAutoReturn(TITLE_WINDOWS) });
		try {
			await runSweep(host, "SLI", undefined, r.deps);
			const noticed = r.logLines.filter(
				(l) => l.includes("the receiver is moving on its own") || l.includes("the input is"),
			);
			assert.ok(noticed.length > 0, `nothing recorded the interference: ${r.logLines.join(" | ")}`);
		} finally {
			await shutdown(r);
		}
	});
});
