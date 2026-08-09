/**
 * Assemble the Property Inspector's option-name editor list.
 *
 * The rows are what the user edits: one option code, what the protocol spec calls
 * it, what the receiver called it, and the name the user gave it. Kept apart from
 * `name-store.ts` — and free of the SDK — because this is the one part of the
 * feature that is pure data shaping, so it can be tested without a receiver, a
 * socket or a logger.
 *
 * **Which codes are listed** is the design decision worth knowing about. The spec
 * knows 43 inputs and 81 listening modes; a VSX-S520D has 12 and 8. Listing all of
 * them would bury the ones that exist under three quarters ballast, so a row is
 * created for a code that is *evidenced* — the receiver reported it, a name was
 * learned for it, the user named it, or it is one of the pre-filled tuner slots —
 * and everything else stays one dropdown away (`addable`).
 */
import { COMMAND_REGISTRY } from "../../adapter/eiscp/command-registry.ts";
import { formatCommandValue } from "../eiscp-base.ts";

/** A user-supplied name and whether it is the one in use. */
export interface OptionOverride {
	name: string;
	/** False keeps the text but shows the receiver's name — the switch, not a delete. */
	use: boolean;
}

/**
 * One editable option.
 *
 * A type alias rather than an interface on purpose: rows are sent to the Property
 * Inspector, and only aliases get TypeScript's implicit index signature — an
 * interface is not assignable to the SDK's `JsonValue`.
 */
export type OptionNameRow = {
	/** Wire code, e.g. "2B". */
	code: string;
	/** What the protocol spec calls it — the same fallback the key shows today. */
	spec: string;
	/** The receiver's own name, when one was learned. */
	learned?: string;
	/** The user's name for it, stored or pre-filled. */
	custom?: string;
	/** Whether `custom` is what the deck shows. */
	use: boolean;
	/** True when `custom` is a built-in default rather than something the user stored. */
	seeded: boolean;
};

export type OptionNameList = {
	rows: OptionNameRow[];
	/** Every other code the spec knows, for the "add another option" dropdown. */
	addable: { code: string; spec: string }[];
};

export interface OptionNameInputs {
	/** Codes the receiver has actually reported. */
	seen: Iterable<string>;
	/** Names learned from the receiver's display. */
	learned: ReadonlyMap<string, string>;
	/** Names the user typed. */
	overrides: ReadonlyMap<string, OptionOverride>;
	/** Pre-filled names for codes that cannot be learned correctly (the tuner slots). */
	defaults: Readonly<Record<string, string>>;
}

/**
 * Whether a value of a tracked command is an option a receiver can be *in*.
 *
 * The registry's value list mixes two things: the codes the receiver reports
 * ("2B", "0E") and the command aliases used to steer it ("UP", "DOWN", "STEREO",
 * "MOVIE"). Only the first kind can carry a name. "N/A" is filtered for the same
 * reason — it is the receiver saying the mode is unavailable, not a mode.
 */
function isOptionCode(code: string): boolean {
	return /^[0-9A-Fa-f]{2}$/.test(code);
}

/** Every option code the spec knows for this command, in the registry's order. */
export function specOptionCodes(command: string): string[] {
	return (COMMAND_REGISTRY[command]?.values ?? []).map((v) => v.param).filter(isOptionCode);
}

/**
 * The user's name for a code, if there is one and it is switched on.
 *
 * A *stored* entry always beats the pre-filled default, including one that is
 * switched off: that is how a user says "no, show me what the receiver calls it"
 * for a slot the plugin pre-filled. Only when nothing is stored does the default
 * apply — which is what makes the pre-fills work without a write.
 */
export function effectiveOverride(
	code: string,
	overrides: ReadonlyMap<string, OptionOverride>,
	defaults: Readonly<Record<string, string>>,
): string | undefined {
	const stored = overrides.get(code);
	if (stored) return stored.use && stored.name ? stored.name : undefined;
	return defaults[code];
}

export function buildOptionNames(inputs: OptionNameInputs, command: string): OptionNameList {
	const codes = new Set<string>();
	for (const code of inputs.seen) codes.add(code);
	for (const code of inputs.learned.keys()) codes.add(code);
	for (const code of inputs.overrides.keys()) codes.add(code);
	for (const code of Object.keys(inputs.defaults)) codes.add(code);

	const rows: OptionNameRow[] = [];
	for (const code of [...codes].filter(isOptionCode).sort()) {
		const stored = inputs.overrides.get(code);
		const seeded = stored === undefined && inputs.defaults[code] !== undefined;
		rows.push({
			code,
			spec: formatCommandValue(command, code),
			...(inputs.learned.has(code) ? { learned: inputs.learned.get(code)! } : {}),
			...(stored ? { custom: stored.name } : seeded ? { custom: inputs.defaults[code]! } : {}),
			// A seeded row arrives ticked; that is what "pre-filled as a user name" means.
			use: stored ? stored.use && stored.name !== "" : seeded,
			seeded,
		});
	}

	const addable = specOptionCodes(command)
		.filter((code) => !codes.has(code))
		.map((code) => ({ code, spec: formatCommandValue(command, code) }));

	return { rows, addable };
}
