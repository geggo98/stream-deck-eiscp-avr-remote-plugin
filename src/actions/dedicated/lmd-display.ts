/**
 * Learn the receiver's own listening-mode names from its front-panel display.
 *
 * The receiver reports a mode change as an `LMD <code>` event followed shortly
 * by an `FLD` event carrying the front-panel text — the model-correct name
 * (e.g. code 82 -> "DTS Neural:X"). The LMD code alone is not a name, and the
 * static registry name is model-generic, so we capture the FLD text that
 * arrives right after an LMD change and cache it per host+code. Unavailable
 * modes come back as LMD "N/A" (FLD "Not Available").
 *
 * FLD is a shared, transient display (normally "INPUT        VOL"), so we only
 * trust it inside a short window after an LMD change and ignore the at-rest
 * input+volume readout.
 */
import { decodeDisplayText, formatCommandValue } from "../eiscp-base.ts";

interface HostState {
	names: Map<string, string>; // lmd code -> learned display name
	lastCode?: string;
	expectUntil: number;
}

const STATE = new Map<string, HostState>();
const NAME_WINDOW_MS = 2500;

function stateFor(host: string): HostState {
	let s = STATE.get(host);
	if (!s) {
		s = { names: new Map(), expectUntil: 0 };
		STATE.set(host, s);
	}
	return s;
}

/** The at-rest display shows "<input>      <volume>" — ends in the volume digits. */
function looksLikeInputVolume(text: string): boolean {
	return /\d\s*$/.test(text);
}

/** Record that the listening mode just changed to `code`; expect an FLD name next. */
export function noteLmd(host: string, code: string): void {
	const s = stateFor(host);
	s.lastCode = code;
	s.expectUntil = Date.now() + NAME_WINDOW_MS;
}

/**
 * Feed an FLD display value. If it arrives inside the post-change window and
 * looks like a mode name (not the input/volume readout), cache it for the
 * current code. Returns true if a name was learned/updated.
 */
export function noteFld(host: string, hex: string): boolean {
	const s = stateFor(host);
	if (!s.lastCode || Date.now() > s.expectUntil) return false;
	const text = decodeDisplayText(hex);
	if (!text || looksLikeInputVolume(text)) return false;
	if (s.names.get(s.lastCode) === text) return false;
	s.names.set(s.lastCode, text);
	return true;
}

/** Best display name for an LMD code: the receiver's own text, else the registry name. */
export function lmdDisplayName(host: string, code: string | undefined): string {
	if (!code) return "";
	if (code === "N/A") return "Not Available";
	return stateFor(host).names.get(code) ?? formatCommandValue("LMD", code);
}
