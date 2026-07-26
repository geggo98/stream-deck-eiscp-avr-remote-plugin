/**
 * Learn and persist the receiver's own names for option codes (listening modes
 * and inputs) from its front-panel display (FLD).
 *
 * How the receiver reports names (verified on hardware):
 *  - LISTENING MODE: an `LMD <code>` event is followed within ~2.5s by an `FLD`
 *    event whose text is the model-correct mode name (e.g. "DTS Neural:X"). The
 *    mode name never ends in the volume digits. Unavailable modes -> LMD "N/A".
 *  - INPUT: the FLD is a persistent "<input>      <volume>" readout (e.g.
 *    "BD/DVD      14"); the input label is that text with the trailing volume
 *    stripped. Because it's persistent, we can learn the CURRENT input's name
 *    from any such readout (no time window) using the cached SLI code.
 *
 * So FLD text is routed by format: ends-in-digits -> input name (strip volume),
 * else -> mode name (within the post-change window).
 *
 * Learned names are cached in memory and persisted (debounced) to Stream Deck
 * global settings, merged so the device IP is never clobbered.
 */
import { streamDeck } from "@elgato/streamdeck";
import { sanitiseDeviceText } from "../../adapter/eiscp/device-text.ts";
import { parsePlayStatus } from "../../adapter/eiscp/play-status.ts";
import { equalsSpecValue, matchesSpecValue, sameLabel } from "../../adapter/eiscp/spec-labels.ts";
import { truncateForLog } from "../../adapter/logging.ts";
import {
	decodeDisplayText,
	formatCommandValue,
	updateGlobalSettings,
	type SerializedNames,
	type SerializedOverrides,
	type SerializedSeenCodes,
} from "../eiscp-base.ts";
import { effectiveOverride, type OptionOverride } from "./option-names.ts";

const logger = streamDeck.logger.createScope("Names");

export type TrackedCommand = "LMD" | "SLI";

/**
 * What became of an attempt to record an input name.
 *
 * - `learned` / `unchanged` — stored, and trustworthy.
 * - `doubtful` — stored, but the text is not what the spec calls this input, so a
 *   second reading is worth taking (see runSweep). Stored anyway, because a
 *   receiver is allowed to relabel its inputs and a name is better than none.
 * - `rejected` — **not** stored: another command owned the display, so the text
 *   describes that command, not the input.
 */
export type SliRecordOutcome = "learned" | "unchanged" | "doubtful" | "rejected";
const TRACKED: TrackedCommand[] = ["LMD", "SLI"];
const LMD_WINDOW_MS = 2500;
// The SLI code event and its input-name FLD can arrive in EITHER order and up to
// ~1.5s apart (verified on hardware: FLD name at +213ms, SLI code at +1549ms),
// so we pair whichever arrives, within this window.
const SLI_PAIR_MS = 3000;
/**
 * How long after an input change an `LMD` still counts as the receiver's answer to it
 * rather than as something the user did.
 *
 * The receiver announces a listening mode of its own on every input change — it has
 * to, since the mode follows the source format. Measured across every `LMD` in both
 * recordings, timed from the last input change, the two populations do not overlap
 * and there is nothing at all in between:
 *
 *   receiver's own:  9, 9, 10, 13, 13, 15, 36, 40, 70, 255, 337, **780** ms
 *   —————————— nothing measured in this band ——————————
 *   the user's:      2410 ms (`LMD 80` -> `LMD 00`, display "    Stereo    ")
 *
 * So the value is picked from the gap, not from a margin around one side of it. A
 * *wider* window was the first attempt and the standby recording refuted it — it
 * swallowed that "Stereo", which is a name the passive learner is supposed to get.
 *
 * Then 800 ms was nearly refuted from the other side: `input-hop-capture.json`, taken
 * while AirPlay was playing, caught the receiver announcing its own mode **780 ms**
 * after hopping back — 20 ms inside the window. Every earlier sample was under 340 ms,
 * so the spread is much wider than the first eleven suggested and the value has to sit
 * in the middle of the gap rather than at the edge of what has been seen: 1.9x the
 * slowest echo, and 0.6x the fastest deliberate change.
 */
const INPUT_ECHO_MS = 1500;
const PERSIST_DEBOUNCE_MS = 1500;

// Everything learned here comes from the receiver's display field: untrusted
// network data that is persisted into Stream Deck's global settings and rendered
// as button titles. A hostile or malfunctioning device could otherwise grow the
// store without limit along three axes — one entry per distinct code it reports,
// unbounded name length, and one top-level key per host — and the whole blob is
// re-serialised and pushed to Stream Deck on every debounce window.
/** Longest learned name kept. Real input/mode labels are well under this. */
const MAX_NAME_LENGTH = 48;
/** Longest wire code accepted as a map key (real ones are 2-3 characters). */
const MAX_CODE_LENGTH = 8;
/** Entries per host per command. The largest real receivers expose ~50 inputs. */
const MAX_ENTRIES_PER_COMMAND = 128;
/** Hosts tracked at once. */
const MAX_HOSTS = 32;

/**
 * Names pre-filled as the user's own, for the codes that learning provably cannot get
 * right.
 *
 * With a tuner input selected the display genuinely shows the *station* — "FM
 * 87.50MHz", "TEDDY" on DAB — because that is what the receiver reports for that
 * input. No guard can separate that from an input name, and Auto-Discover reads the
 * same thing, so these three slots would stay wrong however often they are swept.
 *
 * They take effect with nothing stored (see `effectiveOverride`), so the fix applies
 * whether or not the editor is ever opened; the learned text is kept and the user can
 * switch back to it per option.
 */
const DEFAULT_NAMES: Record<TrackedCommand, Readonly<Record<string, string>>> = {
	SLI: { "24": "FM", "25": "AM", "33": "DAB" },
	LMD: {},
};

/**
 * Strip control characters and clamp length.
 *
 * Delegates to the shared boundary in `device-text.ts`: the same policy now guards
 * learned names and now-playing metadata, and a security boundary with two copies
 * drifts. Control bytes genuinely arrive — the receiver prefixes its display
 * payloads with 0x1a — and would otherwise be persisted and pushed into Stream
 * Deck titles.
 */
function sanitiseLearned(value: string, maxLength: number): string {
	return sanitiseDeviceText(value, maxLength);
}

interface HostState {
	names: Record<TrackedCommand, Map<string, string>>;
	/**
	 * Codes this receiver has reported, whether or not a name could be learned for
	 * them. This is what the PI's name editor lists, and the interesting entries are
	 * exactly the nameless ones: a tuner input shows its station rather than its own
	 * name, so it never learns — and without a record that the code exists there
	 * would be nothing to hang a hand-typed name on.
	 */
	seen: Record<TrackedCommand, Set<string>>;
	/** Names the user typed in the PI. They win over the learned ones; see `nameFor`. */
	overrides: Record<TrackedCommand, Map<string, OptionOverride>>;
	/** `fromInput`: the receiver announced this mode itself, right after an input change. */
	lmdPending?: { code: string; at: number; fromInput: boolean };
	sliCode?: { value: string; at: number };
	sliName?: { value: string; at: number };
	/** When something other than the input last took over the display; see displayIsBusy. */
	displayOwnedAt?: number;
	/** When the source last pushed playback metadata (a title, a station, cover art). */
	metadataAt?: number;
	/** When the selected input last *changed*; recorded even while sweeping. */
	inputChangedAt?: number;
	/** The last SLI value seen, so a re-broadcast of the same input is not a change. */
	lastSli?: string;
	/** The receiver's current volume, i.e. what an input readout has to end in. */
	volume?: number;
	/**
	 * Whether a network source is playing right now, from the last `NST` frame.
	 *
	 * Undefined means no `NST` has been seen — which is not the same as "not playing"
	 * and must not be treated as one: the receiver broadcasts it only when the
	 * transport *changes*, so a plugin that connected mid-playback has never seen one.
	 */
	sourcePlaying?: boolean;
	/** What the last refusal was about, so a burst of them logs one line. */
	lastVeto?: string;
}

/**
 * Commands whose new value the receiver shows in the display *instead of* the
 * input readout: "Volume      14", "Bass : +2", and so on.
 *
 * The trap they set is that such a readout is shaped exactly like the input one —
 * a label, padding, and a trailing number — so `endsWithVolume` cannot tell them
 * apart, and a volume change ended up stored as the name of whatever input was
 * selected. Two real examples were found in the wild: an input called
 * "Bass : +" and one called "Volume".
 *
 * A veto list, so a command missing from it only means the old behaviour rather
 * than a new failure. `LMD` is absent on purpose: mode names are the *other*
 * branch of noteFld and have their own window.
 */
const DISPLAY_OWNING_COMMANDS: readonly string[] = ["MVL", "AMT", "TFR", "TFW", "PRS", "CTL", "SWL", "DIM"];

/**
 * Commands that mean "this source is streaming something and putting its metadata on
 * the display" — a track title, a station name, cover art.
 *
 * A different problem from the list above, and it caught a real one: listening mode
 * `82` was learned as **"...Baby One M"**, a scrolling track title clipped to the
 * display width, without the user touching the mode. A mode name is any FLD that does
 * *not* end in digits and arrives inside the `LMD_WINDOW_MS` window — and an `LMD`
 * event is not proof of a user action: the receiver re-broadcasts it on an input change
 * (recorded: `SLI 10` at 28600 ms, `LMD 80` at 28640 ms) and switches modes by itself
 * when the source format changes.
 *
 * Taken from what the reference unit actually sends during playback
 * (`tests/fixtures/raw-dump.bin`: NJA 169x cover art, NLS 45x and NLT list text, NTM
 * elapsed time, NFI file info) rather than from the spec — this firmware never sends
 * `NTI`/`NAT`/`NAL`, so a spec-derived list would have missed the case entirely. Those
 * three are included anyway as same-family siblings; an entry that never arrives costs
 * nothing.
 *
 * Deliberately **text, art and time only**. The status flags of the same family — `NDS`
 * (a device is present), `NST` (playing/paused) — are not here: they say nothing about
 * what is on the display, and treating them as metadata would block learning on a
 * source that is merely connected.
 *
 * This only fires on the sources that behave this way (DAB, USB, NET), and only while
 * they are playing: the metadata stream stops, and learning resumes.
 */
const METADATA_COMMANDS: readonly string[] = ["NJA", "NLS", "NLT", "NTM", "NFI", "NTI", "NAT", "NAL"];

/**
 * How long such a change is assumed to own the display. The input readout is
 * persistent, so it comes back on its own; this only has to cover the moment it
 * is pushed aside (measured at ~0.6-2 s on a VSX-S520D).
 */
const DISPLAY_OWNED_MS = 1500;

/**
 * Whether the display currently belongs to something other than the input.
 *
 * Recency decides, not a fixed window — a window cannot separate the two cases
 * that actually occur (both measured, `tests/fixtures/standby-behaviour-capture.json`,
 * same `SLI 10` in both):
 *
 *   28600 SLI 10 -> 28640 FLD "BD/DVD       1"   input changed 40 ms ago, MVL 814 ms ago
 *   28600 SLI 10 -> 30515 FLD "Volume      14"   MVL 18 ms ago, input 1915 ms ago
 *
 * So: a fresh non-input change wins unless the input changed *strictly* later.
 * With no input change recorded at all (the sweep suppresses them, and a name can
 * legitimately arrive before its code) a fresh non-input change simply wins.
 *
 * A tie counts as busy on purpose — the two can land in the same millisecond
 * inside a power-on burst, and not learning a name costs one clean input change,
 * whereas learning a wrong one persists until something overwrites it.
 */
function displayIsBusy(
	s: HostState,
	now: number,
	ownChangeAt: number | undefined,
	options: { includeMetadata: boolean },
): boolean {
	const candidates = [s.displayOwnedAt];
	if (options.includeMetadata) candidates.push(s.metadataAt);
	const at = Math.max(...candidates.map((value) => value ?? -Infinity));
	if (!Number.isFinite(at) || now - at > DISPLAY_OWNED_MS) return false;
	return ownChangeAt === undefined || ownChangeAt <= at;
}

/**
 * Whether an input change happened close enough to `at` to explain what is on the
 * display.
 *
 * `displayIsBusy`'s recency rule cannot answer this, and deliberately so: it gives
 * the display to whichever change came *later*, and the receiver's own `LMD` always
 * comes later than the `SLI` that caused it. Distance either way, because the input
 * readout and its code arrive in either order (the name can lead the code by 1-2 s).
 */
function inputEcho(s: HostState, at: number): boolean {
	return s.inputChangedAt !== undefined && Math.abs(at - s.inputChangedAt) <= INPUT_ECHO_MS;
}

/**
 * Whether `text` is the name of the input that is selected right now — in which case
 * it is the input readout, whatever else is going on, and never a mode name.
 *
 * The comparison is *exact* (`sameLabel` / `equalsSpecValue`, not `matchesSpecValue`);
 * the reason lives with those functions in `spec-labels.ts`.
 *
 * Worth knowing before it looks like the fix it is not: this does **not** catch the
 * AirPlay case it was written alongside. `specValueLabels("SLI", "2D")` is `["AIPLAY"]`
 * — a typo in the vendor workbook — and the reference unit reaches AirPlay through
 * `SLI 2B` ("NET") anyway. It is the second layer, for the ordinary inputs.
 */
function textNamesCurrentInput(s: HostState, text: string): boolean {
	const code = s.sliCode?.value;
	if (!code) return false;
	const learned = s.names.SLI.get(code);
	if (learned !== undefined && sameLabel(learned, text)) return true;
	return equalsSpecValue("SLI", code, text);
}

/**
 * Note that a command took the display over. Fed from the same observer as
 * noteChange/noteFld (see discovery.ts) — unknown commands are ignored.
 *
 * The two families are tracked apart because they are trusted apart: the sweep asks
 * the display a question at a moment it chose and may ignore playback metadata, while
 * passive learning only overhears the display and has to respect both.
 *
 * `MVL` also carries its value, because the input readout ends in it (see
 * `endsWithVolume`).
 */
export function noteDisplayChange(host: string, command: string, parameter?: string): void {
	if (DISPLAY_OWNING_COMMANDS.includes(command)) {
		const s = hostState(host);
		s.displayOwnedAt = Date.now();
		// Only an actual level: MVL also carries UP/DOWN/QSTN, and a two-digit hex
		// value is the only form the readout can be compared against.
		if (command === "MVL" && parameter !== undefined && /^[0-9A-Fa-f]{2}$/.test(parameter))
			s.volume = parseInt(parameter, 16);
	} else if (METADATA_COMMANDS.includes(command)) hostState(host).metadataAt = Date.now();
	else if (command === "NST") {
		// Only a value we can read: an unparseable `NST` is no evidence either way, and
		// silently reading it as "stopped" would switch the guard below off.
		const status = parsePlayStatus(parameter);
		if (status !== undefined) hostState(host).sourcePlaying = status === "play";
	}
}

const STATE = new Map<string, HostState>();

function hostState(host: string): HostState {
	let s = STATE.get(host);
	if (!s) {
		if (STATE.size >= MAX_HOSTS) {
			// Evict the oldest tracked host rather than refusing to learn for the
			// new one: hosts are configured by the user, so the newest is the one
			// they are most likely looking at.
			const oldest = STATE.keys().next();
			if (!oldest.done) STATE.delete(oldest.value);
		}
		s = {
			names: { LMD: new Map(), SLI: new Map() },
			seen: { LMD: new Set(), SLI: new Set() },
			overrides: { LMD: new Map(), SLI: new Map() },
		};
		STATE.set(host, s);
	}
	return s;
}

/** The "<input>      <volume>" readout ends in the volume digits. */
function endsWithVolume(text: string): boolean {
	return /\d\s*$/.test(text);
}

/**
 * Whether a text that ends in digits really is the input readout — i.e. whether the
 * number at the end is the volume the receiver is actually at.
 *
 * That is what the readout *means*, and the recording proves it: every
 * digit-terminated FLD in `tests/fixtures/standby-behaviour-capture.json` ends in the
 * `MVL` in force at that moment (`0E` -> "GAME        14", `02` -> "CBL/SAT      2",
 * `01` -> "...1"). A scrolling track title clipped to the display width does not: a
 * user's input ended up named "at is Love (", from "at is Love (7" read while the
 * volume was 14.
 *
 * **Unknown volume vetoes nothing.** Not every receiver announces `MVL` before the
 * first readout arrives (`name-discovery-capture.json` contains none at all), and a
 * device that never does must still be learnable — this only rejects a number we can
 * positively show to be the wrong one.
 */
function trailingNumberIsVolume(s: HostState, text: string): boolean {
	if (s.volume === undefined) return true;
	const digits = /(\d+)\s*$/.exec(text);
	if (!digits) return true;
	return parseInt(digits[1]!, 10) === s.volume;
}
/** Turn a fixed-width "<input>      <volume>" readout into a clean input label. */
function stripVolume(text: string): string {
	return text
		.replace(/\s*\d+\s*$/, "") // trailing volume number
		.replace(/\s*-+\s*$/, "") // trailing scroll indicator ("--")
		.replace(/\s{2,}/g, " ") // collapse fixed-width padding
		.trim();
}

function learn(host: string, command: TrackedCommand, rawCode: string, rawName: string): boolean {
	const code = sanitiseLearned(rawCode, MAX_CODE_LENGTH);
	const name = sanitiseLearned(rawName, MAX_NAME_LENGTH);
	if (!code || !name) return false;
	const map = hostState(host).names[command];
	const previous = map.get(code);
	if (previous === name) return false;
	// Cap distinct codes per command: a device reporting ever-changing values
	// would otherwise add an entry forever. Updating an existing code is always
	// allowed, so a full store still tracks changes to what it already knows.
	if (!map.has(code) && map.size >= MAX_ENTRIES_PER_COMMAND) return false;
	map.set(code, name);
	// Keyed on change, so this is rare by construction — a name is learned once and
	// then stays. It is also the only record of *when* a name became what it is, which
	// is the question a wrong one raises; there was none, and a receiver relabelling a
	// mode as "Airplay" left nothing in the log at all.
	logger.info(
		`${host} ${command} ${code}: ${previous === undefined ? "" : `"${truncateForLog(previous, 48)}" -> `}"${truncateForLog(name, 48)}"`,
	);
	markDirty();
	emitNamesChanged(host);
	return true;
}

/**
 * Refuse a reading, and say so once.
 *
 * Only the refusals this file learned about the hard way are logged, and only when the
 * reason changes: an FLD arrives for every frame of a scrolling title, so a line per
 * refusal would be a line per ~200 ms of playback. The pre-existing metadata veto stays
 * silent for the same reason — it fires on every track of every stream.
 */
function refuse(host: string, s: HostState, what: string, text: string, why: string): false {
	// Keyed on the *reason*, not on the text. A scrolling title is a new string every
	// few hundred milliseconds — deduping on it would put a line on the log for every
	// window that happens to end in a digit, for as long as the music plays. The text
	// is in the message because the first one is the useful one.
	const key = JSON.stringify([what, why]);
	if (s.lastVeto !== key) {
		s.lastVeto = key;
		logger.info(`${host} ${what}: ignored "${truncateForLog(text, 48)}" (${why})`);
	}
	return false;
}

// Hosts whose SLI is being actively swept: the sweep learns input names
// deterministically (see recordSli), so passive SLI pairing is suppressed to
// avoid the name-before-code race corrupting entries during the sweep.
const sliSweeping = new Set<string>();
export function setSliSweeping(host: string, on: boolean): void {
	if (on) sliSweeping.add(host);
	else sliSweeping.delete(host);
}

/** Pair the latest SLI code with the latest input-name FLD (either order, within window). */
function tryPairSli(host: string): boolean {
	if (sliSweeping.has(host)) return false;
	const s = hostState(host);
	if (!s.sliCode || !s.sliName) return false;
	if (Math.abs(s.sliCode.at - s.sliName.at) > SLI_PAIR_MS) return false;
	return learn(host, "SLI", s.sliCode.value, s.sliName.value);
}

/**
 * Learn an input name directly from a code + its FLD readout (deterministic; used
 * by the sweep).
 *
 * The sweep queries the display right after selecting an input, so the answer is
 * *usually* the input readout — but `query("FLD")` is settled by the first FLD
 * that arrives, solicited or not, so a volume or tone readout can land in its
 * place. This path had no check at all and would store it verbatim.
 *
 * `tentative` means the caller is still deciding: the outcome is reported, but a
 * reading the spec does not recognise is **not** stored. That is what the sampling
 * loop in `sweep.ts` needs — it used to store every sample it was about to discard,
 * so a source whose display never settles (a scrolling track title on a streaming
 * input) left its last reading behind while the sweep logged "leaving it unnamed".
 */
export function recordSli(
	host: string,
	code: string,
	fldHex: string,
	options: { corroborated?: boolean; tentative?: boolean } = {},
): SliRecordOutcome {
	const text = decodeDisplayText(fldHex);
	if (!text) return "rejected";
	const name = stripVolume(text);
	// Nothing to store and nothing a second reading would fix. Sanitised the way
	// `learn` will sanitise it, so "rejected" means the same thing at both ends —
	// a name of nothing but control characters does not survive either.
	if (!sanitiseLearned(name, MAX_NAME_LENGTH) || !sanitiseLearned(code, MAX_CODE_LENGTH)) return "rejected";
	const s = hostState(host);
	// `corroborated` means the caller established the reading some other way — the
	// sweep re-measures and takes a majority, and a text that stays on the display
	// across several samples is better evidence than *this* check can give: whoever
	// owned the display for one reading rarely owns it for three.
	if (!options.corroborated && displayIsBusy(s, Date.now(), undefined, { includeMetadata: false })) {
		if (options.tentative) refuse(host, s, `SLI ${code}`, text, "another command owns the display");
		return "rejected";
	}
	// The number at the end has to be the volume; see trailingNumberIsVolume. This is
	// the sweep's only defence against a streaming source, since playback metadata
	// deliberately does not veto this path (the sweep has to be able to name NET/USB).
	//
	// **`corroborated` does not excuse it**, unlike the check above, and the difference
	// is the whole point: a majority establishes *which text* was on the display, never
	// that the text is an input readout. A frozen scrolling title reads identically
	// three times running and wins a majority by definition — measured, it stored
	// "at is Love (" through this very path while every other guard was in place.
	if (endsWithVolume(text) && !trailingNumberIsVolume(s, text)) {
		refuse(host, s, `SLI ${code}`, text, `it does not end in the volume (${s.volume})`);
		return "rejected";
	}
	const known = matchesSpecValue("SLI", code, name);
	// Report without storing while the caller is still corroborating.
	if (options.tentative && !known) {
		refuse(host, s, `SLI ${code}`, text, "the spec calls this input something else; reading it again");
		return "doubtful";
	}
	const stored = learn(host, "SLI", code, name) ? "learned" : "unchanged";
	// The protocol spec knows what this input is called. A mismatch vetoes nothing —
	// receivers relabel inputs ("BT AUDIO" where the spec says "BLUETOOTH"), so the
	// name is kept — it only reports that the reading is worth taking again. The
	// sweep does exactly that and replaces it with the majority if one emerges.
	if (!options.corroborated && !known) return "doubtful";
	return stored;
}

/**
 * Record that this receiver has an option with this code.
 *
 * Only real option codes: the receiver also reports `N/A` for a listening mode it
 * does not have, and the wire carries the steering aliases (`UP`, `DOWN`, `STEREO`)
 * through the same command. Neither is something a name can belong to.
 */
function addSeen(s: HostState, command: TrackedCommand, code: string): boolean {
	if (!/^[0-9A-Fa-f]{2}$/.test(code)) return false;
	const set = s.seen[command];
	if (set.has(code)) return false;
	// Same cap as the name map, and for the same reason: a device reporting
	// ever-changing values must not grow the persisted blob without limit.
	if (set.size >= MAX_ENTRIES_PER_COMMAND) return false;
	set.add(code);
	return true;
}

function noteSeen(s: HostState, command: TrackedCommand, code: string): void {
	if (addSeen(s, command, code)) markDirty();
}

/**
 * Note that a tracked command changed. For LMD this opens the window for the
 * transient mode-name FLD; for SLI it records the code to pair with the input
 * name (the code event can arrive before OR after the name FLD).
 */
export function noteChange(host: string, command: TrackedCommand, code: string): void {
	const s = hostState(host);
	const now = Date.now();
	noteSeen(s, command, code);
	if (command === "LMD") {
		// Whether this mode is the receiver's answer to an input change is decided
		// here, at the causal moment, rather than when the FLD turns up: the FLD may
		// be up to LMD_WINDOW_MS later, and by then the two are only correlated.
		s.lmdPending = { code, at: now, fromInput: inputEcho(s, now) };
	} else if (command === "SLI") {
		// Recorded before the sweep's early return, and only on a real change. The
		// sweep steps through every input and the receiver answers each step with an
		// LMD of its own, so without this an input readout could be learned as a mode
		// name during Auto-Discover — the recorded sweep contains "TEDDY" and
		// "FM 87.50MHz", neither of which ends in digits. A first sighting counts (the
		// connect burst carries SLI, LMD and FLD together); a query answering with the
		// value we already had does not, so binding an action suppresses nothing.
		if (s.lastSli !== code) s.inputChangedAt = now;
		s.lastSli = code;
		if (sliSweeping.has(host)) return;
		s.sliCode = { value: code, at: now };
		tryPairSli(host);
	}
}

/**
 * Feed an FLD display value, routed by format: a "<input>      <volume>" readout
 * is the input label (paired with the SLI code), anything else within the LMD
 * window is the mode name. Returns true if a name was learned/updated.
 */
export function noteFld(host: string, hex: string): boolean {
	const text = decodeDisplayText(hex);
	if (!text) return false;

	const s = hostState(host);
	const now = Date.now();

	if (endsWithVolume(text)) {
		// "Volume      14" and "Bass : +2" are shaped exactly like an input readout.
		// Whoever wrote the display last owns it.
		if (displayIsBusy(s, now, s.sliCode?.at, { includeMetadata: true })) return false;
		// A scrolling title is shaped like one too, whenever its window happens to end
		// in a digit — and unlike the volume readout there is no command to blame it on,
		// because the source wrote it. The number is the check: it has to be the volume.
		if (!trailingNumberIsVolume(s, text))
			return refuse(host, s, `SLI ${s.sliCode?.value ?? "?"}`, text, `it does not end in the volume (${s.volume})`);
		s.sliName = { value: stripVolume(text), at: now };
		return tryPairSli(host);
	}

	// Transient mode-name readout -> the listening-mode name. Same rule as above, and
	// it belongs here just as much: a scrolling track title is not a mode name, and an
	// LMD event is no proof of a user action (see METADATA_COMMANDS).
	const pending = s.lmdPending;
	if (!pending || now - pending.at > LMD_WINDOW_MS) return false;
	if (displayIsBusy(s, now, pending.at, { includeMetadata: true })) return false;
	// A playing source owns the display for as long as it plays — the metadata veto
	// above only covers the moments it *announces* something, and the gaps between
	// those are wider than this window.
	//
	// Measured in `input-hop-capture.json`, taken with AirPlay playing: the display
	// scrolls the track title one frame every ~300 ms — "100% Pure Lov", "% Pure Love",
	// " Pure Love" — and **none of those end in a digit**, so every one of them is
	// routed here, to the branch that stores mode names. Nothing in the text says it is
	// a title; the same disease as "at is Love (" on the input side, where the trailing
	// volume settles it. There is no such number here, so the transport is asked
	// instead: `NST` says whether a source is playing, it is broadcast unsolicited, and
	// on this hardware it says `Sxx` the moment the input leaves the source.
	//
	// The cost is stated plainly: while a source plays, listening-mode names are not
	// learned at all — including by an Auto-Discover sweep, which is why `runSweep`
	// reports it rather than leaving the panel to blame the power state. That is the
	// trade this file makes everywhere: a missing name costs one clean mode change, a
	// wrong one persists until something overwrites it.
	if (s.sourcePlaying)
		return refuse(host, s, `LMD ${pending.code}`, text, "a source is playing and owns the display");
	// An input change is a display change, and the receiver announces a mode of its own
	// right after one — so this window was opened by the input, and what is in it is the
	// input's readout. Measured: the mode "DTS Neural:X" was renamed "Airplay" when this
	// receiver hopped back to its network input by itself. The second term covers an
	// input change that lands between the LMD and its FLD.
	if (pending.fromInput || inputEcho(s, now))
		return refuse(host, s, `LMD ${pending.code}`, text, "the input changed, not the mode");
	if (textNamesCurrentInput(s, text))
		return refuse(host, s, `LMD ${pending.code}`, text, "it is the current input's name");
	return learn(host, "LMD", pending.code, text);
}

/**
 * Whether this code has a name the receiver told us, as opposed to the registry
 * fallback `nameFor` would show.
 *
 * The sweep uses it to report how many options it actually came back with — a
 * sweep that achieved nothing (the receiver was asleep, so `UP` never moved) used
 * to be reported as a success with its step count relabelled as "names".
 */
export function hasLearnedName(host: string, command: TrackedCommand, code: string): boolean {
	return hostState(host).names[command].has(code);
}

/**
 * Best display name for a code: the user's own name, else the receiver's learned
 * text, else the registry name.
 *
 * The user comes first because they are the only one who can be right about the
 * cases the receiver gets wrong — a tuner input showing its station, a network input
 * called "NET" that is a pair of speakers with a name.
 */
export function nameFor(host: string, command: TrackedCommand, code: string | undefined): string {
	if (!code) return "";
	if (command === "LMD" && code === "N/A") return "Not Available";
	const s = hostState(host);
	const own = effectiveOverride(code, s.overrides[command], DEFAULT_NAMES[command]);
	return own ?? s.names[command].get(code) ?? formatCommandValue(command, code);
}

// --- the user's own names -------------------------------------------------

/**
 * Store (or clear) the user's name for one option.
 *
 * An empty name clears the entry rather than storing a blank one, so "I do not want
 * my own name here" is expressible — and for a pre-filled tuner slot it restores the
 * pre-fill. Switching a name *off* is the other thing, and it keeps the text: that is
 * what the editor's checkbox does, and losing the text on every toggle would make
 * switching back a retype.
 *
 * Returns what is stored afterwards, so the caller can answer the Property Inspector
 * with the truth rather than with what it asked for.
 */
export function setOverride(
	host: string,
	command: TrackedCommand,
	rawCode: string,
	patch: { name?: string; use?: boolean },
): OptionOverride | undefined {
	const code = sanitiseLearned(rawCode, MAX_CODE_LENGTH);
	if (!code) return undefined;
	// The PI is the only sender, but the text still ends up in global settings and in
	// Stream Deck titles, so it is clamped exactly like a learned one.
	const name = sanitiseLearned(patch.name ?? "", MAX_NAME_LENGTH);
	const s = hostState(host);
	const map = s.overrides[command];
	const previous = map.get(code);
	if (!name) {
		if (!previous) return undefined;
		map.delete(code);
		logger.info(`${host} ${command} ${code}: user name cleared`);
		markDirty();
		emitNamesChanged(host);
		return undefined;
	}
	if (!map.has(code) && map.size >= MAX_ENTRIES_PER_COMMAND) {
		logger.warn(`${host} ${command} ${code}: refusing a user name, ${MAX_ENTRIES_PER_COMMAND} already stored`);
		return previous;
	}
	const next: OptionOverride = { name, use: patch.use !== false };
	if (previous && previous.name === next.name && previous.use === next.use) return previous;
	map.set(code, next);
	// One line per change, like `learn`: when a name became what it is, is the question
	// a wrong name raises, and a hand-typed one is no easier to explain afterwards.
	logger.info(`${host} ${command} ${code}: user name "${truncateForLog(name, 48)}" (${next.use ? "on" : "off"})`);
	markDirty();
	emitNamesChanged(host);
	return next;
}

/** What the PI's editor needs: the codes seen, the learned names, the user's names. */
export function optionNameState(
	host: string,
	command: TrackedCommand,
): {
	seen: Set<string>;
	learned: Map<string, string>;
	overrides: Map<string, OptionOverride>;
	defaults: Readonly<Record<string, string>>;
} {
	const s = hostState(host);
	return {
		seen: s.seen[command],
		learned: s.names[command],
		overrides: s.overrides[command],
		defaults: DEFAULT_NAMES[command],
	};
}

/**
 * Names changed for this host.
 *
 * Keys and dials redraw on a learned name only because learning rides on an `FLD`
 * message that the ConnectionManager broadcasts anyway. A name typed in the Property
 * Inspector produces no such frame, so there has to be something to subscribe to.
 */
type NamesListener = (host: string) => void;
const nameListeners = new Set<NamesListener>();

export function onNamesChanged(listener: NamesListener): () => void {
	nameListeners.add(listener);
	return () => nameListeners.delete(listener);
}

function emitNamesChanged(host: string): void {
	// Copied first: a listener that unsubscribes itself must not disturb the walk.
	for (const listener of [...nameListeners]) {
		try {
			listener(host);
		} catch (err) {
			logger.warn(`name listener failed: ${err}`);
		}
	}
}

// --- persistence (Stream Deck global settings) ---

let dirty = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Merge previously-persisted names into the in-memory cache (runtime wins).
 *
 * Applies the same validation as `learn`: this data was persisted by an earlier
 * version with no caps at all, and it is device-supplied either way, so it is
 * not trusted just because it round-tripped through global settings.
 */
export function load(serialized: SerializedNames | undefined): void {
	if (!serialized) return;
	for (const [host, byCommand] of Object.entries(serialized)) {
		if (STATE.size >= MAX_HOSTS && !STATE.has(host)) continue;
		const s = hostState(host);
		for (const command of TRACKED) {
			const entries = byCommand?.[command];
			if (!entries) continue;
			for (const [rawCode, rawName] of Object.entries(entries)) {
				if (typeof rawName !== "string") continue;
				const code = sanitiseLearned(rawCode, MAX_CODE_LENGTH);
				const name = sanitiseLearned(rawName, MAX_NAME_LENGTH);
				if (!code || !name) continue;
				if (s.names[command].has(code)) continue;
				if (s.names[command].size >= MAX_ENTRIES_PER_COMMAND) break;
				s.names[command].set(code, name);
			}
		}
	}
}

/**
 * Merge the persisted user names back in.
 *
 * Same validation as `setOverride` applies: this round-tripped through Stream Deck's
 * global settings, which is not a reason to trust it any more than the wire.
 */
export function loadOverrides(serialized: SerializedOverrides | undefined): void {
	if (!serialized) return;
	for (const [host, byCommand] of Object.entries(serialized)) {
		if (STATE.size >= MAX_HOSTS && !STATE.has(host)) continue;
		const s = hostState(host);
		for (const command of TRACKED) {
			const entries = byCommand?.[command];
			if (!entries) continue;
			for (const [rawCode, entry] of Object.entries(entries)) {
				if (!entry || typeof entry !== "object" || typeof entry.name !== "string") continue;
				const code = sanitiseLearned(rawCode, MAX_CODE_LENGTH);
				const name = sanitiseLearned(entry.name, MAX_NAME_LENGTH);
				if (!code || !name) continue;
				if (s.overrides[command].has(code)) continue;
				if (s.overrides[command].size >= MAX_ENTRIES_PER_COMMAND) break;
				s.overrides[command].set(code, { name, use: entry.use !== false });
			}
		}
	}
}

/** Merge the persisted list of codes each receiver reported. */
export function loadSeenCodes(serialized: SerializedSeenCodes | undefined): void {
	if (!serialized) return;
	for (const [host, byCommand] of Object.entries(serialized)) {
		if (STATE.size >= MAX_HOSTS && !STATE.has(host)) continue;
		const s = hostState(host);
		for (const command of TRACKED) {
			for (const code of byCommand?.[command] ?? []) {
				if (typeof code !== "string") continue;
				// addSeen, not noteSeen: reading persisted state back is not a change to
				// persist, and marking dirty here would queue a write of what we just read.
				addSeen(s, command, code);
			}
		}
	}
}

export function serialize(): SerializedNames {
	const out: SerializedNames = {};
	for (const [host, s] of STATE) {
		const entry: { [command: string]: { [code: string]: string } } = {};
		for (const command of TRACKED) {
			if (s.names[command].size) entry[command] = Object.fromEntries(s.names[command]);
		}
		if (Object.keys(entry).length) out[host] = entry;
	}
	return out;
}

export function serializeOverrides(): SerializedOverrides {
	const out: SerializedOverrides = {};
	for (const [host, s] of STATE) {
		const entry: { [command: string]: { [code: string]: { name?: string; use?: boolean } } } = {};
		for (const command of TRACKED) {
			if (s.overrides[command].size) entry[command] = Object.fromEntries(s.overrides[command]);
		}
		if (Object.keys(entry).length) out[host] = entry;
	}
	return out;
}

export function serializeSeenCodes(): SerializedSeenCodes {
	const out: SerializedSeenCodes = {};
	for (const [host, s] of STATE) {
		const entry: { [command: string]: string[] } = {};
		for (const command of TRACKED) {
			if (s.seen[command].size) entry[command] = [...s.seen[command]];
		}
		if (Object.keys(entry).length) out[host] = entry;
	}
	return out;
}

function markDirty(): void {
	dirty = true;
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => void persist(), PERSIST_DEBOUNCE_MS);
	// Never keep the process alive just for persistence (scripts, tests).
	persistTimer.unref?.();
}

let persistRetries = 0;

async function persist(): Promise<void> {
	if (!dirty) return;
	dirty = false;
	try {
		// Through the shared funnel: it holds the write until the initial load has
		// landed and serialises against the other writer (the remembered device),
		// so neither can persist a snapshot that is missing the other's key.
		// All three in one patch: they are one subject, and a second writer for the
		// same subject is exactly how the funnel's doc comment says this data is lost.
		await updateGlobalSettings((current) => ({
			...current,
			names: serialize(),
			nameOverrides: serializeOverrides(),
			seenCodes: serializeSeenCodes(),
		}));
		persistRetries = 0;
	} catch (err) {
		// Re-arm the timer with backoff; without it the learned names would sit
		// dirty in memory and be lost on the next plugin restart.
		dirty = true;
		persistRetries++;
		const delay = Math.min(PERSIST_DEBOUNCE_MS * 2 ** persistRetries, 60_000);
		streamDeck.logger.error(`name-store: failed to persist names (retrying in ${delay} ms): ${err}`);
		if (persistTimer) clearTimeout(persistTimer);
		persistTimer = setTimeout(() => void persist(), delay);
		persistTimer.unref?.();
	}
}
