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
import {
	decodeDisplayText,
	formatCommandValue,
	updateGlobalSettings,
	type SerializedNames,
} from "../eiscp-base.ts";

export type TrackedCommand = "LMD" | "SLI";
const TRACKED: TrackedCommand[] = ["LMD", "SLI"];
const LMD_WINDOW_MS = 2500;
// The SLI code event and its input-name FLD can arrive in EITHER order and up to
// ~1.5s apart (verified on hardware: FLD name at +213ms, SLI code at +1549ms),
// so we pair whichever arrives, within this window.
const SLI_PAIR_MS = 3000;
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
 * Strip control characters and clamp length.
 *
 * `decodeDisplayText` decodes the FLD hex as ASCII, which masks the high bit
 * rather than rejecting, so control bytes reach here intact and would otherwise
 * be persisted and pushed into Stream Deck titles.
 */
function sanitiseLearned(value: string, maxLength: number): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		if (code >= 0x20 && code !== 0x7f) out += ch;
		if (out.length >= maxLength) break;
	}
	return out.trim();
}

interface HostState {
	names: Record<TrackedCommand, Map<string, string>>;
	lmdPending?: { code: string; until: number };
	sliCode?: { value: string; at: number };
	sliName?: { value: string; at: number };
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
		s = { names: { LMD: new Map(), SLI: new Map() } };
		STATE.set(host, s);
	}
	return s;
}

/** The "<input>      <volume>" readout ends in the volume digits. */
function endsWithVolume(text: string): boolean {
	return /\d\s*$/.test(text);
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
	if (map.get(code) === name) return false;
	// Cap distinct codes per command: a device reporting ever-changing values
	// would otherwise add an entry forever. Updating an existing code is always
	// allowed, so a full store still tracks changes to what it already knows.
	if (!map.has(code) && map.size >= MAX_ENTRIES_PER_COMMAND) return false;
	map.set(code, name);
	markDirty();
	return true;
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

/** Learn an input name directly from a code + its FLD readout (deterministic; used by the sweep). */
export function recordSli(host: string, code: string, fldHex: string): boolean {
	const text = decodeDisplayText(fldHex);
	if (!text) return false;
	return learn(host, "SLI", code, stripVolume(text));
}

/**
 * Note that a tracked command changed. For LMD this opens the window for the
 * transient mode-name FLD; for SLI it records the code to pair with the input
 * name (the code event can arrive before OR after the name FLD).
 */
export function noteChange(host: string, command: TrackedCommand, code: string): void {
	const s = hostState(host);
	if (command === "LMD") {
		s.lmdPending = { code, until: Date.now() + LMD_WINDOW_MS };
	} else if (command === "SLI") {
		if (sliSweeping.has(host)) return;
		s.sliCode = { value: code, at: Date.now() };
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

	if (endsWithVolume(text)) {
		hostState(host).sliName = { value: stripVolume(text), at: Date.now() };
		return tryPairSli(host);
	}

	// Transient mode-name readout -> the listening-mode name.
	const pending = hostState(host).lmdPending;
	if (!pending || Date.now() > pending.until) return false;
	return learn(host, "LMD", pending.code, text);
}

/** Best display name for a code: the receiver's learned text, else the registry name. */
export function nameFor(host: string, command: TrackedCommand, code: string | undefined): string {
	if (!code) return "";
	if (command === "LMD" && code === "N/A") return "Not Available";
	return hostState(host).names[command].get(code) ?? formatCommandValue(command, code);
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
		await updateGlobalSettings((current) => ({ ...current, names: serialize() }));
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
