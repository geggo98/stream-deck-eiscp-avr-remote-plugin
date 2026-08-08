/**
 * Reading a setting's true state off the receiver's front panel.
 *
 * Needed because `RES QSTN` is not a sensor, it is a receipt: it answers with
 * whatever the *protocol* last wrote, so after the user switches 4K upscaling off
 * in the receiver's own menu the query still reports it on, indefinitely
 * (measured on a VSX-S520D, 2026-08-08). No `RES` frame is broadcast either. The
 * single trace of such a change is a line of display text — `Upscaling:Off` or
 * `Upscaling:Auto` — so that text is the only evidence there is.
 *
 * The danger is equally measured. This same display carries the input readout
 * (`"CBL/SAT      2"`), listening-mode names (`"    Stereo    "`), scrolling track
 * titles and volume changes, and reading state out of it carelessly is exactly how
 * an input came to be called "Bass : +" and listening mode 82 came to be called
 * "...Baby One M". So the parser is deliberately narrow:
 *
 *  - it only speaks when the text **names the setting** — the label left of the
 *    colon has to match the anchor, so an unrelated readout is not merely ignored,
 *    it is unrecognisable;
 *  - and only when the text **also carries a state word** it knows. A matching
 *    label with an unknown word yields nothing rather than a guess, which keeps a
 *    firmware that words it differently at "no worse than today" instead of wrong.
 *
 * Of the 27 display texts recorded from the reference unit, exactly one contains a
 * colon at all — `" DTS Neural:X "`, a listening-mode name — and it fails both
 * tests. That is the case `tests/fld-state.test.ts` pins.
 */

/** Longest label this will consider, so a hostile payload cannot make work for us. */
const MAX_LABEL_LENGTH = 32;
/** Longest state word. The panel is 14 characters wide in total; this is slack. */
const MAX_STATE_LENGTH = 16;

/**
 * Words that mean on/off across settings, already normalised.
 *
 * English and German because the panel language follows the receiver's own menu
 * setting. Values a *specific* setting uses instead — "Auto" for upscaling — do
 * not belong here: they are not generically boolean, and putting them here would
 * make "Auto" mean "on" for every setting that ever prints it.
 */
const GENERIC_ON = ["ON", "AN", "EIN", "YES", "JA"];
const GENERIC_OFF = ["OFF", "AUS", "NO", "NEIN"];

/**
 * How a setting announces itself on the front panel.
 *
 * Both halves are **measured, not derived**, and neither is in the command
 * registry: the panel prints "Upscaling" where the spec calls the command
 * "Monitor Out Resolution", and its on word is "Auto" where the spec calls
 * `RES 01` simply "auto" and `RES 00` "through" rather than "Off".
 */
export interface FldStateAnchor {
	/** Text left of the colon, as the panel prints it. Compared loosely. */
	label: string;
	/** On words beyond the generic vocabulary, e.g. "Auto". */
	onWords?: readonly string[];
	/** Off words beyond the generic vocabulary. */
	offWords?: readonly string[];
}

/** Letters and digits only, upper-cased — "Super Res   " and "superres" compare equal. */
function normalise(value: string): string {
	return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The state a display line announces for `anchor`, or `undefined`.
 *
 * `undefined` covers every uncertainty — a different setting, no colon, a state
 * word we do not know, a label clipped by the 14-character panel — because each
 * of those means "keep showing what we already believe", which is the behaviour
 * without this module at all.
 */
export function parseFldState(text: string, anchor: FldStateAnchor): "on" | "off" | undefined {
	const colon = text.indexOf(":");
	if (colon < 0) return undefined;

	const label = text.slice(0, colon);
	const state = text.slice(colon + 1);
	// Bound before normalising: the panel is 14 characters, but this text comes off
	// the wire and only decodeDisplayText's cap stands between it and here.
	if (label.length > MAX_LABEL_LENGTH || state.length > MAX_STATE_LENGTH) return undefined;

	if (normalise(label) !== normalise(anchor.label)) return undefined;

	const word = normalise(state);
	if (!word) return undefined;
	if (matches(word, GENERIC_ON, anchor.onWords)) return "on";
	if (matches(word, GENERIC_OFF, anchor.offWords)) return "off";
	return undefined;
}

function matches(word: string, generic: readonly string[], extra: readonly string[] | undefined): boolean {
	if (generic.includes(word)) return true;
	return (extra ?? []).some((candidate) => normalise(candidate) === word);
}
