/**
 * Comparing what a receiver *displays* against what the protocol spec *calls* a value.
 *
 * Lives in its own file for a concrete reason: it used to sit at the end of
 * `command-registry.ts`, which is generated from `docs/eiscp-commands.yaml`. Any
 * `npm run generate` therefore silently deleted it — 53 lines of hand-written logic
 * gone, discovered only because the build then failed on a missing export. Generated
 * files must contain nothing but generated content.
 */

import { COMMAND_REGISTRY } from "./command-registry.ts";

/** Letters and digits only, upper-cased — "BD/DVD", "bd-dvd" and "Bd Dvd" compare equal. */
function normaliseLabel(value: string): string {
	return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The labels the protocol spec knows for one value of a command.
 *
 * Both the short name and the words of the description are used, because the
 * description is where the vendor spelled out what the front panel says:
 * `SLI 10` is `name: "dvd"` but `description: "sets DVD, BD/DVD"`, and "BD/DVD"
 * is exactly what the receiver displays. Generated from
 * `docs/eiscp-commands.yaml` (see scripts/generate-command-registry.ts), so this
 * list comes from the spec rather than from guesses.
 */
export function specValueLabels(code: string, param: string): string[] {
	const cmd = COMMAND_REGISTRY[code];
	if (!cmd) return [];
	const value = cmd.values.find((v) => v.param.toLowerCase() === param.toLowerCase());
	if (!value) return [];
	const described = (value.description ?? "").replace(/^\s*sets\s+/i, "");
	const labels: string[] = [value.name ?? ""];
	for (const phrase of described.split(",")) {
		// Both forms: the whole phrase ("BD/DVD", which is what the panel shows) and
		// its alternatives ("BD", "DVD"), since a receiver may display either.
		labels.push(phrase, ...phrase.split("/"));
	}
	return [...new Set(labels.map(normaliseLabel).filter(Boolean))];
}

/**
 * Whether `text` plausibly is what the spec calls this value.
 *
 * A corroboration signal, **never** a veto: receivers relabel their inputs, so a
 * mismatch means "look again", not "wrong". Measured against a real VSX-S520D, the
 * spec labels accept nine of twelve inputs outright (including "CBL/SAT" for the
 * spec's "CBL, SAT" and "FM 87.50MHz" for "FM") and flag three: a genuinely
 * corrupted name ("Bass : +" on the DVD input), a tuner showing its station
 * ("TEDDY" on DAB), and one honest relabel ("BT AUDIO" where the spec says
 * "BLUETOOTH"). The first two deserve a second look; the third costs one.
 */
export function matchesSpecValue(code: string, param: string, text: string): boolean {
	const candidate = normaliseLabel(text);
	if (!candidate) return false;
	const labels = specValueLabels(code, param);
	if (labels.length === 0) return false;
	// Either side may be the longer one: the display truncates ("STRM BOX" for
	// "strm-box") and it also appends state ("FM 87.50MHz" for "FM").
	return labels.some(
		(label) => candidate === label || (label.length >= 2 && (candidate.startsWith(label) || label.startsWith(candidate))),
	);
}
