/**
 * Tests for the persistent name store (FLD-based name learning for LMD + SLI).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { decodeDisplayText } from "../src/actions/eiscp-base.ts";
import {
	hasLearnedName,
	load,
	loadOverrides,
	loadSeenCodes,
	nameFor,
	noteChange,
	noteDisplayChange,
	noteFld,
	onNamesChanged,
	optionNameState,
	recordSli,
	serialize,
	serializeOverrides,
	serializeSeenCodes,
	setOverride,
	setSliSweeping,
} from "../src/actions/dedicated/name-store.ts";

// Hex-ASCII helpers for FLD payloads.
const hex = (s: string) => Buffer.from(s, "ascii").toString("hex");
const DTS_X = hex("DTS Neural:X"); // mode name (no trailing digits)
const CD_VOL = hex("CD          14"); // input + volume readout

/**
 * Let the millisecond clock move on, so "more recently" means something: the store
 * decides who owns the display by comparing timestamps, and events fired in the same
 * millisecond are deliberately treated as a tie.
 */
const tick = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 5).unref?.();
	});

describe("decodeDisplayText", () => {
	it("decodes hex-encoded ASCII", () => {
		assert.equal(decodeDisplayText(DTS_X), "DTS Neural:X");
		assert.equal(decodeDisplayText(CD_VOL), "CD          14");
	});
	it("returns empty string for invalid hex", () => {
		assert.equal(decodeDisplayText("zzzz"), "");
	});
});

describe("name-store learning", () => {
	it("learns a listening-mode name from an FLD that follows an LMD change", () => {
		const host = "ns-lmd";
		noteChange(host, "LMD", "82");
		assert.equal(noteFld(host, DTS_X), true);
		assert.equal(nameFor(host, "LMD", "82"), "DTS Neural:X");
	});

	it("pairs the input+volume readout with the SLI code (code-then-name)", () => {
		const host = "ns-sli-abs";
		noteChange(host, "SLI", "23"); // absolute switch: code first
		assert.equal(noteFld(host, CD_VOL), true); // then the input+volume FLD
		assert.equal(nameFor(host, "SLI", "23"), "CD");
	});

	it("pairs the input name with a later SLI code (name-then-code, like UP)", () => {
		const host = "ns-sli-up";
		assert.equal(noteFld(host, CD_VOL), false); // FLD name arrives first (no code yet)
		noteChange(host, "SLI", "23"); // code arrives ~1s later -> pairs
		assert.equal(nameFor(host, "SLI", "23"), "CD");
	});

	it("does not learn a mode name when no LMD change preceded it", () => {
		const host = "ns-nowindow";
		assert.equal(noteFld(host, DTS_X), false);
	});

	it("does not misroute the input+volume readout to a pending LMD change", () => {
		const host = "ns-route";
		noteChange(host, "LMD", "00");
		noteChange(host, "SLI", "23");
		// An input+volume FLD must be attributed to SLI, never to LMD.
		noteFld(host, CD_VOL);
		assert.equal(nameFor(host, "SLI", "23"), "CD");
		assert.equal(nameFor(host, "LMD", "00"), "stereo"); // registry fallback, not "CD"
	});

	it("recordSli cleans the fixed-width readout (padding, volume, scroll dashes)", () => {
		const host = "ns-record";
		recordSli(host, "10", hex("BD/DVD      14"));
		recordSli(host, "24", hex("FM 87.50MHz --"));
		recordSli(host, "33", hex("TEDDY       --"));
		assert.equal(nameFor(host, "SLI", "10"), "BD/DVD");
		// Read the learned map rather than nameFor for the tuner slots: those are
		// pre-filled with a user name ("FM", "DAB") precisely because what the display
		// shows there is the station, which is what this test feeds in.
		const learned = optionNameState(host, "SLI").learned;
		assert.equal(learned.get("24"), "FM 87.50MHz");
		assert.equal(learned.get("33"), "TEDDY");
	});

	it("renders the LMD N/A sentinel as 'Not Available'", () => {
		assert.equal(nameFor("ns-any", "LMD", "N/A"), "Not Available");
	});

	it("falls back to the registry name when nothing is learned", () => {
		assert.equal(nameFor("ns-fresh", "LMD", "82"), "neo-6-cinema");
		assert.equal(nameFor("ns-fresh", "SLI", "23"), "cd");
	});
});

describe("name-store persistence", () => {
	it("serializes learned names and round-trips through load()", () => {
		const host = "ns-persist";
		noteChange(host, "LMD", "82");
		noteFld(host, DTS_X);
		noteChange(host, "SLI", "23");
		noteFld(host, CD_VOL);

		const snapshot = serialize();
		assert.equal(snapshot[host]!.LMD!["82"], "DTS Neural:X");
		assert.equal(snapshot[host]!.SLI!["23"], "CD");

		// Loading into a fresh host key restores the names.
		load({ "ns-loaded": { LMD: { "11": "Pure Audio" }, SLI: { "24": "FM" } } });
		assert.equal(nameFor("ns-loaded", "LMD", "11"), "Pure Audio");
		assert.equal(nameFor("ns-loaded", "SLI", "24"), "FM");
	});

	it("load() does not overwrite a runtime-learned name", () => {
		const host = "ns-nooverwrite";
		noteChange(host, "LMD", "82");
		noteFld(host, DTS_X); // runtime: "DTS Neural:X"
		load({ [host]: { LMD: { "82": "stale-name" } } });
		assert.equal(nameFor(host, "LMD", "82"), "DTS Neural:X");
	});
});

// Everything the store learns is device-supplied: it is persisted into Stream
// Deck's global settings and rendered as button titles, so a hostile or
// malfunctioning receiver must not be able to grow it without limit.
describe("name-store input hardening", () => {
	it("caps a long learned name", () => {
		const host = "ns-longname";
		noteChange(host, "LMD", "82");
		noteFld(host, hex("N".repeat(500)));
		const learned = nameFor(host, "LMD", "82");
		assert.ok(learned, "an over-long name should still be learned, just clamped");
		assert.ok(learned.length <= 48, `name length ${learned.length} should be clamped`);
	});

	it("strips control characters from learned names", () => {
		const host = "ns-ctrl";
		noteChange(host, "LMD", "82");
		// ASCII decoding masks the high bit rather than rejecting, so control bytes
		// genuinely reach the store; an ANSI escape would otherwise be persisted
		// and rendered.
		noteFld(host, hex("Pure\x1b[31m\x00Audio"));
		const learned = nameFor(host, "LMD", "82");
		assert.equal(learned, "Pure[31mAudio");
		assert.ok(!/[\x00-\x1f\x7f]/.test(learned!), "no control characters may survive");
	});

	it("bounds the decoded display text regardless of parameter length", () => {
		// The FLD parameter is unbounded network data; decoding must not allocate
		// proportionally to it.
		const decoded = decodeDisplayText(hex("A".repeat(100_000)));
		assert.ok(decoded.length <= 128, `decoded length ${decoded.length} should be bounded`);
	});

	it("caps distinct codes per command but keeps updating known ones", () => {
		const host = "ns-cap";
		// A device reporting ever-changing SLI codes would otherwise add an entry
		// forever. 128 is the cap.
		for (let i = 0; i < 300; i++) {
			recordSli(host, `C${i}`, hex(`Input ${i}`));
		}
		const stored = serialize()[host]?.SLI ?? {};
		assert.equal(Object.keys(stored).length, 128);

		// A code already tracked must still accept a new name.
		const known = Object.keys(stored)[0]!;
		assert.equal(recordSli(host, known, hex("Renamed")), "doubtful", "stored, but worth a second reading");
		assert.equal(nameFor(host, "SLI", known), "Renamed");
	});

	it("rejects empty names and codes", () => {
		const host = "ns-empty";
		assert.equal(recordSli(host, "", hex("Something")), "rejected", "an empty code stores nothing");
		assert.equal(recordSli(host, "10", hex("")), "rejected");
		assert.equal(recordSli(host, "10", hex("   ")), "rejected");
		assert.equal(recordSli(host, "10", hex("\x00\x01")), "rejected");
	});

	it("load() applies the same validation to previously persisted data", () => {
		// Data persisted by an earlier version had no caps at all, and it is
		// device-supplied either way — round-tripping through global settings does
		// not make it trusted.
		// Asserted against serialize() rather than nameFor, which would mask a
		// rejected entry behind its registry-name / raw-code display fallback.
		load({
			"ns-loadhard": {
				LMD: { Z1: "x".repeat(500), Z2: "Pure\x00Audio", Z3: "" },
			},
		});
		const stored = serialize()["ns-loadhard"]!.LMD!;
		assert.ok(stored["Z1"]!.length <= 48, "over-long persisted name should be clamped");
		assert.equal(stored["Z2"], "PureAudio");
		assert.equal("Z3" in stored, false, "empty persisted name should not be stored");
	});

	it("load() ignores non-string persisted names", () => {
		load({ "ns-loadtype": { LMD: { Z1: 42 as never, Z2: "Fine" } } });
		const stored = serialize()["ns-loadtype"]!.LMD!;
		assert.equal("Z1" in stored, false, "non-string persisted name should be ignored");
		assert.equal(stored["Z2"], "Fine");
	});
});

// --- the display does not belong to the input alone -------------------------

describe("name-store: readouts that only look like an input", () => {
	const VOLUME = hex("Volume      14");
	const BASS = hex("Bass : +2");
	const BD_DVD = hex("BD/DVD       1");

	it("does not learn a volume readout as an input name", () => {
		// Shaped exactly like "<input>  <volume>", which is why it used to be stored:
		// a real receiver ended up with an input literally called "Volume".
		const host = "ns-volume";
		noteChange(host, "SLI", "10");
		noteDisplayChange(host, "MVL");
		assert.equal(noteFld(host, VOLUME), false);
		// Nothing learned at all, so the key falls back to the registry name.
		assert.equal(serialize()[host], undefined);
		assert.notEqual(nameFor(host, "SLI", "10"), "Volume");
	});

	it("does not learn a tone readout as an input name", () => {
		// The observed defect: input 10 was called "Bass : +" (the trailing digit
		// stripped, which is also why the sign was provably positive).
		const host = "ns-bass";
		noteChange(host, "SLI", "10");
		noteDisplayChange(host, "TFR");
		assert.equal(noteFld(host, BASS), false);
		assert.notEqual(nameFor(host, "SLI", "10"), "Bass : +");
	});

	it("does not let a stale volume change block a real input name", async () => {
		// Measured on hardware: the input readout arrives 40 ms after the SLI while
		// the last volume change is ~800 ms old. Recency decides, not a window — so
		// the test has to let real time pass between the two, which is the whole
		// point of the rule.
		const host = "ns-recency";
		noteDisplayChange(host, "MVL");
		await tick();
		noteChange(host, "SLI", "10"); // input changed *after* the volume
		assert.equal(noteFld(host, BD_DVD), true);
		assert.equal(nameFor(host, "SLI", "10"), "BD/DVD");
	});

	it("keeps learning names when nothing else touched the display", () => {
		const host = "ns-clean";
		noteChange(host, "SLI", "23");
		assert.equal(noteFld(host, CD_VOL), true);
		assert.equal(nameFor(host, "SLI", "23"), "CD");
	});

	it("ignores commands that do not own the display", () => {
		// A veto list: MOT/PCT/NDS and friends broadcast constantly and must not
		// suppress learning.
		const host = "ns-unrelated";
		noteChange(host, "SLI", "23");
		noteDisplayChange(host, "MOT");
		noteDisplayChange(host, "NDS");
		assert.equal(noteFld(host, CD_VOL), true);
	});

	it("refuses a swept name while another command owns the display", () => {
		// recordSli is the sweep's deterministic path and had no check at all: its
		// FLD query is settled by the first FLD to arrive, solicited or not.
		const host = "ns-sweep";
		noteDisplayChange(host, "MVL");
		assert.equal(recordSli(host, "10", VOLUME), "rejected");
		assert.equal(recordSli(host, "10", BD_DVD), "rejected", "the query answer is suspect either way");
	});

	it("still records a swept name on a quiet display", () => {
		const host = "ns-sweep-quiet";
		assert.equal(recordSli(host, "10", BD_DVD), "learned");
		assert.equal(nameFor(host, "SLI", "10"), "BD/DVD");
	});
});

describe("name-store: a playing source is not a mode name", () => {
	// The case found in the wild: listening mode 82 was learned as "...Baby One M",
	// a scrolling track title clipped to the display width, while the user had not
	// touched the mode at all.
	const TITLE = hex("...Baby One M");
	const MODE = hex("DTS Neural:X");

	it("does not learn a track title as a listening-mode name", async () => {
		const host = "ns-title";
		noteChange(host, "LMD", "82"); // the receiver re-broadcasts this by itself
		await tick();
		noteDisplayChange(host, "NJA"); // cover art: the source is putting metadata up
		assert.equal(noteFld(host, TITLE), false);
		assert.notEqual(nameFor(host, "LMD", "82"), "...Baby One M");
	});

	it("still learns a mode name when the source is quiet", async () => {
		// Everything except DAB/USB/NET behaves this way — no metadata, so no veto.
		const host = "ns-mode-quiet";
		noteChange(host, "LMD", "82");
		assert.equal(noteFld(host, MODE), true);
		assert.equal(nameFor(host, "LMD", "82"), "DTS Neural:X");
	});

	it("learns a mode name that was changed after the metadata stopped", async () => {
		// Playback ends, the display returns to the mode: the veto must not linger.
		const host = "ns-mode-after";
		noteDisplayChange(host, "NLS");
		await tick();
		noteChange(host, "LMD", "80"); // the mode change is the more recent event
		assert.equal(noteFld(host, hex("Dolby Surr")), true);
		assert.equal(nameFor(host, "LMD", "80"), "Dolby Surr");
	});

	it("does not learn the upscaling readout as a listening-mode name", async () => {
		// The 4K key writes "Upscaling:Auto" to the panel. Neither that nor
		// "Upscaling:Off " ends in digits, so both land on THIS branch — the same one
		// that once learned a scrolling track title as mode 82 — and never on the
		// input branch. Measured on a VSX-S520D: the RES echo arrives ~27 ms BEFORE
		// the text, which is what lets the display-ownership guard get in front of it.
		// The LMD here is an unrelated mode change, because a RES set broadcasts no
		// LMD of its own. Fails if RES leaves DISPLAY_OWNING_COMMANDS (verified).
		const host = "ns-upscaling";
		noteChange(host, "LMD", "82");
		await tick();
		noteDisplayChange(host, "RES"); // the echo takes the display over
		assert.equal(noteFld(host, hex("Upscaling:Auto")), false);
		assert.notEqual(nameFor(host, "LMD", "82"), "Upscaling:Auto");
	});

	it("keeps the sweep able to name a streaming input", async () => {
		// The recorded SLI sweep contains 35 metadata frames — it steps onto NET/USB
		// while they stream. If playback metadata vetoed the sweep's own FLD query too,
		// those inputs could never be named.
		const host = "ns-sweep-streaming";
		noteDisplayChange(host, "NJA");
		assert.notEqual(recordSli(host, "2B", hex("NET          14")), "rejected");
		assert.equal(nameFor(host, "SLI", "2B"), "NET");
	});

	it("does not learn the Super Resolution readout as an input name", async () => {
		// This one is shaped like the volume readout, not like a mode name: measured
		// as "Super Res   :2", trailing digit and all, so endsWithVolume claims it and
		// strips the digits — which is exactly how an input came to be called
		// "Bass : +". Fails if SPR leaves DISPLAY_OWNING_COMMANDS (verified).
		const host = "ns-super-res";
		noteChange(host, "SLI", "10");
		await tick();
		noteDisplayChange(host, "SPR"); // the echo takes the display over
		assert.equal(noteFld(host, hex("Super Res   :2")), false);
		assert.notEqual(nameFor(host, "SLI", "10"), "Super Res   :");
	});

	it("still refuses a swept name while the volume is on the display", async () => {
		// The other family is unchanged: that one does block the sweep.
		const host = "ns-sweep-volume";
		noteDisplayChange(host, "MVL");
		assert.equal(recordSli(host, "2B", hex("Volume      14")), "rejected");
	});
});

// --- an input change is a display change ------------------------------------

/**
 * Run `body` with the clock stopped at `ms`.
 *
 * The rules here span seconds — three for the input echo — so a test that waited
 * would be a test nobody runs. `tests/name-store-capture.test.ts` replays real
 * recordings the same way.
 */
function at(ms: number, body: () => void): void {
	const realNow = Date.now;
	Date.now = () => ms;
	try {
		body();
	} finally {
		Date.now = realNow;
	}
}

describe("name-store: an input change is not a mode change", () => {
	it("still learns a mode the user chose long after the input changed", () => {
		// The guard is deliberately wide, so this is the case it must not eat: the
		// input settled minutes ago and the mode change is the user's own.
		const host = "ns-echo-later";
		at(1_000, () => noteChange(host, "SLI", "10"));
		at(60_000, () => noteChange(host, "LMD", "82"));
		at(60_100, () => assert.equal(noteFld(host, hex("DTS Neural:X")), true));
		assert.equal(nameFor(host, "LMD", "82"), "DTS Neural:X");
	});

	it("refuses the display text that follows the receiver's own mode announcement", () => {
		// Measured on hardware: `SLI 2B` then `LMD 82` 10 ms later, then the service
		// name. Mode 82 is "DTS Neural:X" and was renamed "Airplay".
		const host = "ns-echo";
		at(1_000, () => noteChange(host, "SLI", "2B"));
		at(1_010, () => noteChange(host, "LMD", "82"));
		at(1_788, () => assert.equal(noteFld(host, hex("Airplay")), false));
		assert.notEqual(nameFor(host, "LMD", "82"), "Airplay");
	});

	it("refuses an input change that lands between the mode and its display text", () => {
		// The other order: the mode window was open for good reasons, and then the
		// input changed underneath it.
		const host = "ns-echo-between";
		at(1_000, () => noteChange(host, "LMD", "82"));
		at(1_500, () => noteChange(host, "SLI", "2B"));
		at(2_200, () => assert.equal(noteFld(host, hex("Airplay")), false));
	});

	it("refuses a text that is the current input's own name", () => {
		// Independent of timing: whatever else is going on, this is the input readout.
		const host = "ns-input-name";
		at(1_000, () => noteChange(host, "SLI", "02")); // the spec calls it GAME
		at(10_000, () => noteChange(host, "LMD", "82"));
		at(10_100, () => assert.equal(noteFld(host, hex("GAME")), false));
	});

	it("still learns a mode whose name merely starts like the input's", () => {
		// Why that guard compares for equality and not the way matchesSpecValue does:
		// "Game-RPG" starts with "GAME", and the GAME input is exactly when a user
		// picks it.
		const host = "ns-input-prefix";
		at(1_000, () => noteChange(host, "SLI", "02"));
		at(10_000, () => noteChange(host, "LMD", "0F"));
		at(10_100, () => assert.equal(noteFld(host, hex("Game-RPG")), true));
		assert.equal(nameFor(host, "LMD", "0F"), "Game-RPG");
	});
});

describe("name-store: the number at the end of a readout is the volume", () => {
	// The volume change itself owns the display for DISPLAY_OWNED_MS, and that veto
	// would answer every test below before the volume was even compared. So the MVL
	// is old in each of them: known value, quiet display — which is also the real
	// situation, since a receiver announces its volume long before a track scrolls by.
	it("refuses a scrolling title that happens to end in a digit", () => {
		// The observed defect: the Input encoder read "at is Love (" — a track title
		// clipped to the 14-character display, its trailing digit taken for a volume.
		const host = "ns-scrolling-title";
		at(1_000, () => noteDisplayChange(host, "MVL", "0E")); // volume 14
		at(60_000, () => noteChange(host, "SLI", "2B"));
		at(60_100, () => assert.equal(noteFld(host, hex("at is Love (7")), false));
		assert.notEqual(nameFor(host, "SLI", "2B"), "at is Love (");
		assert.equal(serialize()[host], undefined, "and nothing else was learned either");
	});

	it("learns the readout that does end in the volume", () => {
		const host = "ns-volume-match";
		at(1_000, () => noteDisplayChange(host, "MVL", "0E"));
		at(60_000, () => noteChange(host, "SLI", "23"));
		at(60_100, () => assert.equal(noteFld(host, hex("CD          14")), true));
		assert.equal(nameFor(host, "SLI", "23"), "CD");
	});

	it("vetoes nothing while the volume is unknown", () => {
		// Not every receiver announces MVL before the first readout arrives, and one
		// that never does must still be learnable.
		const host = "ns-volume-unknown";
		noteChange(host, "SLI", "23");
		assert.equal(noteFld(host, hex("CD          14")), true);
	});

	it("refuses a swept reading whose number is not the volume", () => {
		// The sweep's own path: playback metadata deliberately does not veto it, so
		// this is its only defence against querying the display of a streaming source.
		const host = "ns-sweep-title";
		at(1_000, () => noteDisplayChange(host, "MVL", "0E"));
		at(60_000, () => assert.equal(recordSli(host, "2B", hex("at is Love (7")), "rejected"));
		assert.equal(serialize()[host], undefined);
	});

	it("still records a swept reading that ends in the volume", () => {
		const host = "ns-sweep-volume-ok";
		at(1_000, () => noteDisplayChange(host, "MVL", "0E"));
		at(60_000, () => assert.notEqual(recordSli(host, "2B", hex("NET         14")), "rejected"));
		assert.equal(nameFor(host, "SLI", "2B"), "NET");
	});
});

describe("name-store: a playing source is not a mode name either", () => {
	/**
	 * The frames a scrolling title actually produces, lifted from
	 * `tests/fixtures/input-hop-capture.json` (AirPlay playing, ~300 ms apart).
	 *
	 * The point of using the real ones: not a single frame ends in a digit, so every
	 * one of them is routed to the mode branch — there is no volume to check them
	 * against, which is what makes this the harder half of the same defect.
	 */
	const TITLE_FRAMES = ["100% Pure Lov", "00% Pure Love", "% Pure Love  ", " Pure Love   ", "Pure Love    "];

	it("refuses the display while the transport says a source is playing", () => {
		const host = "ns-lmd-playing";
		noteDisplayChange(host, "NST", "Pxx");
		noteChange(host, "LMD", "9A");
		for (const frame of TITLE_FRAMES) {
			assert.equal(noteFld(host, hex(frame)), false, `"${frame}" must not become a mode name`);
		}
		assert.equal(serialize()[host], undefined, "nothing stored at all");
	});

	it("learns again once the source stops", () => {
		// This receiver reports `Sxx` the moment the input leaves a playing source, so
		// the guard lifts on its own — no timeout, no window.
		const host = "ns-lmd-stopped";
		noteDisplayChange(host, "NST", "Pxx");
		noteDisplayChange(host, "NST", "Sxx");
		noteChange(host, "LMD", "00");
		assert.equal(noteFld(host, hex("    Stereo    ")), true);
		assert.equal(nameFor(host, "LMD", "00"), "Stereo");
	});

	it("treats a paused source as free to read", () => {
		const host = "ns-lmd-paused";
		noteDisplayChange(host, "NST", "pxx");
		noteChange(host, "LMD", "00");
		assert.equal(noteFld(host, hex("    Stereo    ")), true);
	});

	it("vetoes nothing when the transport never said anything", () => {
		// NST is broadcast only on a change, so a plugin that connected to a silent
		// receiver has never seen one. Absent evidence must not act like evidence.
		const host = "ns-lmd-no-nst";
		noteChange(host, "LMD", "00");
		assert.equal(noteFld(host, hex("    Stereo    ")), true);
	});

	it("ignores an NST it cannot read rather than switching the guard off", () => {
		const host = "ns-lmd-bad-nst";
		noteDisplayChange(host, "NST", "Pxx");
		noteDisplayChange(host, "NST", "");
		noteChange(host, "LMD", "9A");
		assert.equal(noteFld(host, hex("100% Pure Lov")), false);
	});

	it("leaves input names alone — those have the volume to check", () => {
		// The input branch must keep working on a streaming source: NET and USB are
		// named from exactly this readout, and the trailing volume already settles it.
		const host = "ns-sli-playing";
		noteDisplayChange(host, "NST", "Pxx");
		// Timestamps spread out: the volume readout owning the display is decided by
		// recency, and a tie counts as busy (see displayIsBusy).
		at(1_000, () => noteDisplayChange(host, "MVL", "0E"));
		at(60_000, () => noteChange(host, "SLI", "2B"));
		at(60_100, () => assert.equal(noteFld(host, hex("NET         14")), true));
		assert.equal(nameFor(host, "SLI", "2B"), "NET");
	});
});

/** A control byte, built rather than typed: a raw one in a source file is refused. */
const CTRL = String.fromCharCode(1);

describe("name-store: the user's own names", () => {
	it("shows the user's name instead of the receiver's, and keeps both", () => {
		const host = "ns-own-name";
		noteChange(host, "SLI", "2B");
		assert.equal(noteFld(host, hex("NET         14")), true);
		assert.equal(nameFor(host, "SLI", "2B"), "NET");

		setOverride(host, "SLI", "2B", { name: "Sonos", use: true });
		assert.equal(nameFor(host, "SLI", "2B"), "Sonos");
		assert.equal(optionNameState(host, "SLI").learned.get("2B"), "NET", "the learned name is not replaced");
		assert.equal(hasLearnedName(host, "SLI", "2B"), true, "and the sweep still counts it as learned");
	});

	it("switches back to the receiver's name without losing the text", () => {
		const host = "ns-own-switch";
		noteChange(host, "SLI", "2B");
		noteFld(host, hex("NET         14"));
		setOverride(host, "SLI", "2B", { name: "Sonos", use: true });
		setOverride(host, "SLI", "2B", { name: "Sonos", use: false });
		assert.equal(nameFor(host, "SLI", "2B"), "NET");
		assert.equal(
			optionNameState(host, "SLI").overrides.get("2B")?.name,
			"Sonos",
			"switching back must not mean retyping",
		);
	});

	it("falls back to the registry name when nothing was learned", () => {
		const host = "ns-own-registry";
		assert.equal(nameFor(host, "SLI", "12"), "tv");
		setOverride(host, "SLI", "12", { name: "Beamer", use: true });
		assert.equal(nameFor(host, "SLI", "12"), "Beamer");
	});

	it("clears an entry when the name is emptied", () => {
		const host = "ns-own-clear";
		noteChange(host, "SLI", "2B");
		noteFld(host, hex("NET         14"));
		setOverride(host, "SLI", "2B", { name: "Sonos", use: true });
		assert.equal(setOverride(host, "SLI", "2B", { name: "  ", use: true }), undefined);
		assert.equal(nameFor(host, "SLI", "2B"), "NET");
		assert.equal(optionNameState(host, "SLI").overrides.size, 0);
	});

	it("clamps and strips what it is given", () => {
		const host = "ns-own-hardening";
		// The Property Inspector is the only sender, but the text is persisted into
		// global settings and painted onto keys, so it is clamped like a learned one.
		const stored = setOverride(host, "SLI", "2B", { name: `Sonos${CTRL}${"!".repeat(80)}`, use: true });
		assert.ok(!stored!.name.includes(CTRL), "control bytes never reach a Stream Deck title");
		assert.ok(stored!.name.length <= 48);
		assert.equal(setOverride(host, "SLI", "", { name: "x", use: true }), undefined);
	});
});

describe("name-store: the pre-filled tuner slots", () => {
	it("names FM, AM and DAB without anything being stored", () => {
		const host = "ns-tuner-defaults";
		assert.equal(nameFor(host, "SLI", "24"), "FM");
		assert.equal(nameFor(host, "SLI", "25"), "AM");
		assert.equal(nameFor(host, "SLI", "33"), "DAB");
		assert.equal(serializeOverrides()[host], undefined, "a default is not a write");
	});

	it("beats the station name the receiver reports for that input", () => {
		// The reason they exist: with a tuner input selected the display shows the
		// station, so the learned name is "TEDDY" and no sweep can do better.
		const host = "ns-tuner-station";
		noteChange(host, "SLI", "33");
		assert.equal(noteFld(host, hex("TEDDY       14")), true);
		assert.equal(optionNameState(host, "SLI").learned.get("33"), "TEDDY");
		assert.equal(nameFor(host, "SLI", "33"), "DAB");
	});

	it("gives the station back when the user switches the pre-fill off", () => {
		const host = "ns-tuner-off";
		noteChange(host, "SLI", "33");
		noteFld(host, hex("TEDDY       14"));
		setOverride(host, "SLI", "33", { name: "DAB", use: false });
		assert.equal(nameFor(host, "SLI", "33"), "TEDDY", "a stored entry wins over the default, off included");
	});

	it("leaves listening modes alone", () => {
		// The defaults are about what the tuner *inputs* display; LMD 24 is a mode.
		assert.notEqual(nameFor("ns-tuner-lmd", "LMD", "24"), "FM");
	});
});

describe("name-store: the codes a receiver reported", () => {
	it("records every option code it sees, including during a sweep", () => {
		const host = "ns-seen";
		noteChange(host, "SLI", "2B");
		setSliSweeping(host, true);
		try {
			// Auto-Discover is the one run that reaches every option; it must not be the
			// one run that records none.
			noteChange(host, "SLI", "10");
			noteChange(host, "SLI", "24");
		} finally {
			setSliSweeping(host, false);
		}
		assert.deepEqual([...optionNameState(host, "SLI").seen].sort(), ["10", "24", "2B"]);
	});

	it("ignores what is not an option a receiver can be in", () => {
		const host = "ns-seen-aliases";
		noteChange(host, "LMD", "N/A"); // "this mode is unavailable", not a mode
		noteChange(host, "LMD", "UP"); // a steering alias
		noteChange(host, "LMD", "00");
		assert.deepEqual([...optionNameState(host, "LMD").seen], ["00"]);
	});

	it("survives a restart, which is the only reason it is persisted", () => {
		// A tuner input never learns a name, so without the code itself being kept
		// there would be no row to hang a hand-typed name on after a restart.
		const host = "ns-seen-persist";
		noteChange(host, "SLI", "33");
		setOverride(host, "SLI", "33", { name: "Radio", use: true });
		const seen = serializeSeenCodes();
		const overrides = serializeOverrides();

		const fresh = "ns-seen-restored";
		// The store tracks 32 hosts and this file has long since created that many, so
		// a load for an unknown host is skipped by that cap. Touch it first: in the
		// plugin the load happens into an empty store.
		nameFor(fresh, "SLI", "00");
		loadSeenCodes({ [fresh]: seen[host]! });
		loadOverrides({ [fresh]: overrides[host]! });
		assert.deepEqual([...optionNameState(fresh, "SLI").seen], ["33"]);
		assert.equal(nameFor(fresh, "SLI", "33"), "Radio");
	});

	it("does not trust what round-tripped through the settings", () => {
		const host = "ns-load-hardening";
		nameFor(host, "SLI", "00"); // see above: the host cap skips loads for unknown hosts
		loadOverrides({ [host]: { SLI: { "2B": { name: `x${CTRL}y`, use: true }, "": { name: "no code" } } } });
		const stored = optionNameState(host, "SLI").overrides;
		assert.equal(stored.get("2B")?.name, "xy");
		assert.equal(stored.size, 1);
		loadSeenCodes({ [host]: { SLI: ["UP", "2B"] } });
		assert.deepEqual([...optionNameState(host, "SLI").seen], ["2B"]);
	});
});

describe("name-store: telling the deck a name changed", () => {
	it("fires when a name is learned and when the user types one", () => {
		const host = "ns-emit";
		const seen: string[] = [];
		const off = onNamesChanged((h) => seen.push(h));
		try {
			noteChange(host, "SLI", "23");
			noteFld(host, CD_VOL);
			assert.deepEqual(seen, [host], "a learned name reaches the deck on an FLD frame anyway");
			setOverride(host, "SLI", "23", { name: "Player", use: true });
			assert.deepEqual(seen, [host, host], "a typed one arrives on no frame at all");
		} finally {
			off();
		}
		setOverride(host, "SLI", "23", { name: "Other", use: true });
		assert.equal(seen.length, 2, "and unsubscribing stops it");
	});

	it("stays quiet when nothing actually changed", () => {
		const host = "ns-emit-quiet";
		setOverride(host, "SLI", "23", { name: "Player", use: true });
		const seen: string[] = [];
		const off = onNamesChanged((h) => seen.push(h));
		try {
			setOverride(host, "SLI", "23", { name: "Player", use: true });
			assert.deepEqual(seen, [], "a repaint per keystroke is not free");
		} finally {
			off();
		}
	});
});
