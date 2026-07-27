/**
 * Catalog of pre-built ("dedicated") actions.
 *
 * Single source of truth consumed by:
 *  - the dedicated action classes (src/actions/dedicated/*.ts)
 *  - the icon generator (scripts/generate-icons.ts)
 *  - the manifest generator (scripts/generate-manifest.ts)
 *
 * Each entry's `id` is the manifest UUID suffix AND the icon folder name, so the
 * class decorator, the manifest, and the generated images can never drift.
 */

export const PLUGIN_ID = "de.schwetschke.sd.eiscp-avr-remote";
export const uuidFor = (id: DedicatedId | GenericId): string => `${PLUGIN_ID}.${id}`;

export type DedicatedKind = DedicatedSpec["kind"];

export interface IconSpec {
	/** Lucide icon name for the default / off state. */
	primary: string;
	/** Optional small corner badge (e.g. plus, minus, chevron-right). */
	badge?: string;
	/** Lucide icon name for the on state of a toggle (defaults to `primary`). */
	onPrimary?: string;
}

interface DedicatedSpecBase {
	/** Manifest UUID suffix AND icon folder name. */
	id: string;
	name: string;
	tooltip: string;
	command: string;
	/** number of manifest States (2 for on/off toggles, else 1). */
	states: 1 | 2;
	icon: IconSpec;
}

/** Two-state on/off key (Power, Mute). */
export interface ToggleSpec extends DedicatedSpecBase {
	kind: "toggle";
	controller: "Keypad";
	onValue: string;
	offValue: string;
	/** Hardware toggle parameter (TG), preferred over a soft flip when present. */
	toggleValue?: string;
	states: 2;
}

/** One-shot key (cycler, stepper, transport). */
export interface KeySpec extends DedicatedSpecBase {
	kind: "key";
	controller: "Keypad";
	parameter: string;
	/** Whether to subscribe and show live state as the title. */
	showsState: boolean;
	states: 1;
}

/** Rotary encoder (Stream Deck Plus). */
export interface DialSpec extends DedicatedSpecBase {
	kind: "dial";
	controller: "Encoder";
	upParam: string;
	downParam: string;
	/** Default press behavior (several dials let the PI override it). */
	pressCommand: string;
	pressParam: string;
	encoderLayout: string;
	states: 1;
}

/**
 * Discriminated on `kind`, so kind-specific fields are required — a toggle
 * without onValue or a dial without upParam no longer compiles, and consumers
 * need no bogus fallbacks.
 */
export type DedicatedSpec = ToggleSpec | KeySpec | DialSpec;

export const DEDICATED_SPECS = [
	{
		id: "power", name: "Power", tooltip: "Toggle the receiver on/standby (PWR).",
		kind: "toggle", controller: "Keypad", command: "PWR", onValue: "01", offValue: "00",
		states: 2, icon: { primary: "power" },
	},
	{
		id: "mute", name: "Mute", tooltip: "Toggle audio muting (AMT).",
		kind: "toggle", controller: "Keypad", command: "AMT", onValue: "01", offValue: "00", toggleValue: "TG",
		states: 2, icon: { primary: "volume-2", onPrimary: "volume-x" },
	},
	{
		id: "volume-up", name: "Volume Up", tooltip: "Raise master volume (MVL UP).",
		kind: "key", controller: "Keypad", command: "MVL", parameter: "UP", showsState: true,
		states: 1, icon: { primary: "volume-2", badge: "plus" },
	},
	{
		id: "volume-down", name: "Volume Down", tooltip: "Lower master volume (MVL DOWN).",
		kind: "key", controller: "Keypad", command: "MVL", parameter: "DOWN", showsState: true,
		states: 1, icon: { primary: "volume-1", badge: "minus" },
	},
	{
		id: "volume-dial", name: "Volume", tooltip: "Adjust master volume; press to mute.",
		kind: "dial", controller: "Encoder", command: "MVL", upParam: "UP", downParam: "DOWN",
		pressCommand: "AMT", pressParam: "TG", encoderLayout: "$B1",
		states: 1, icon: { primary: "volume-2" },
	},
	{
		id: "input-next", name: "Next Input", tooltip: "Cycle to the next input source (SLI UP).",
		kind: "key", controller: "Keypad", command: "SLI", parameter: "UP", showsState: true,
		states: 1, icon: { primary: "monitor", badge: "chevron-right" },
	},
	{
		id: "input-prev", name: "Previous Input", tooltip: "Cycle to the previous input source (SLI DOWN).",
		kind: "key", controller: "Keypad", command: "SLI", parameter: "DOWN", showsState: true,
		states: 1, icon: { primary: "monitor", badge: "chevron-left" },
	},
	{
		id: "mode-next", name: "Next Listening Mode", tooltip: "Cycle to the next listening mode (LMD UP).",
		kind: "key", controller: "Keypad", command: "LMD", parameter: "UP", showsState: true,
		states: 1, icon: { primary: "audio-lines", badge: "chevron-right" },
	},
	{
		id: "mode-prev", name: "Previous Listening Mode", tooltip: "Cycle to the previous listening mode (LMD DOWN).",
		kind: "key", controller: "Keypad", command: "LMD", parameter: "DOWN", showsState: true,
		states: 1, icon: { primary: "audio-lines", badge: "chevron-left" },
	},
	{
		id: "transport", name: "Transport", tooltip: "Network/USB transport key (play, pause, stop, next, previous).",
		kind: "key", controller: "Keypad", command: "NTC", parameter: "P/P", showsState: false,
		states: 1, icon: { primary: "play" },
	},
	{
		// Shows the cover art and the track as a key. Pressing it play/pauses, which is
		// the one action a "what is playing" key should have. `showsState: false`
		// because NTC has no readable value — the picture comes from the metadata
		// tracker, not from a command's state.
		id: "now-playing", name: "Now Playing",
		tooltip: "Show the current cover art, title and artist; press to play/pause.",
		kind: "key", controller: "Keypad", command: "NTC", parameter: "P/P", showsState: false,
		states: 1, icon: { primary: "music" },
	},
	{
		id: "bass-up", name: "Bass +", tooltip: "Increase front bass (TFR BUP).",
		kind: "key", controller: "Keypad", command: "TFR", parameter: "BUP", showsState: false,
		states: 1, icon: { primary: "sliders-horizontal", badge: "plus" },
	},
	{
		id: "bass-down", name: "Bass −", tooltip: "Decrease front bass (TFR BDOWN).",
		kind: "key", controller: "Keypad", command: "TFR", parameter: "BDOWN", showsState: false,
		states: 1, icon: { primary: "sliders-horizontal", badge: "minus" },
	},
	{
		id: "treble-up", name: "Treble +", tooltip: "Increase front treble (TFR TUP).",
		kind: "key", controller: "Keypad", command: "TFR", parameter: "TUP", showsState: false,
		states: 1, icon: { primary: "sliders-horizontal", badge: "chevrons-up" },
	},
	{
		id: "treble-down", name: "Treble −", tooltip: "Decrease front treble (TFR TDOWN).",
		kind: "key", controller: "Keypad", command: "TFR", parameter: "TDOWN", showsState: false,
		states: 1, icon: { primary: "sliders-horizontal", badge: "chevrons-down" },
	},
	{
		id: "preset-next", name: "Next Preset", tooltip: "Tuner preset up (PRS UP).",
		kind: "key", controller: "Keypad", command: "PRS", parameter: "UP", showsState: true,
		states: 1, icon: { primary: "radio", badge: "chevron-right" },
	},
	{
		id: "preset-prev", name: "Previous Preset", tooltip: "Tuner preset down (PRS DOWN).",
		kind: "key", controller: "Keypad", command: "PRS", parameter: "DOWN", showsState: true,
		states: 1, icon: { primary: "radio", badge: "chevron-left" },
	},
	// --- Dials (Stream Deck Plus rotary encoders): rotate to adjust, press for a configurable action ---
	// pressCommand/pressParam below are the DEFAULT; input/mode/bass/treble let the
	// user pick the press from a PI dropdown (Mute / Direct / Stereo), so the manifest
	// Push hint reflects the default (Mute). Preset's press is fixed (jump to Tuner).
	{
		id: "input-dial", name: "Input", tooltip: "Rotate to change input source; press for the chosen action (default Mute).",
		kind: "dial", controller: "Encoder", command: "SLI", upParam: "UP", downParam: "DOWN",
		pressCommand: "AMT", pressParam: "TG", encoderLayout: "$A1",
		states: 1, icon: { primary: "monitor" },
	},
	{
		id: "mode-dial", name: "Listening Mode", tooltip: "Rotate to change the listening mode; press for the chosen action (default Mute).",
		kind: "dial", controller: "Encoder", command: "LMD", upParam: "UP", downParam: "DOWN",
		pressCommand: "AMT", pressParam: "TG", encoderLayout: "$A1",
		states: 1, icon: { primary: "audio-lines" },
	},
	{
		id: "bass-dial", name: "Bass", tooltip: "Rotate to adjust front bass; press for the chosen action (default Mute).",
		kind: "dial", controller: "Encoder", command: "TFR", upParam: "BUP", downParam: "BDOWN",
		pressCommand: "AMT", pressParam: "TG", encoderLayout: "$B1",
		states: 1, icon: { primary: "waves" },
	},
	{
		id: "treble-dial", name: "Treble", tooltip: "Rotate to adjust front treble; press for the chosen action (default Mute).",
		kind: "dial", controller: "Encoder", command: "TFR", upParam: "TUP", downParam: "TDOWN",
		pressCommand: "AMT", pressParam: "TG", encoderLayout: "$B1",
		states: 1, icon: { primary: "audio-waveform" },
	},
	{
		id: "preset-dial", name: "Preset", tooltip: "Rotate to change the tuner preset; press to select the Tuner input.",
		kind: "dial", controller: "Encoder", command: "PRS", upParam: "UP", downParam: "DOWN",
		pressCommand: "SLI", pressParam: "26", encoderLayout: "$A1",
		states: 1, icon: { primary: "radio" },
	},
] as const satisfies readonly DedicatedSpec[];

/** Union of all catalog ids — a typo in `protected id = "..."` fails to compile. */
export type DedicatedId = (typeof DEDICATED_SPECS)[number]["id"];

/** Ids of a specific kind, e.g. `DedicatedIdOfKind<"dial">`. */
export type DedicatedIdOfKind<K extends DedicatedSpec["kind"]> = Extract<
	(typeof DEDICATED_SPECS)[number],
	{ kind: K }
>["id"];

export const SPEC_BY_ID = Object.fromEntries(DEDICATED_SPECS.map((s) => [s.id, s])) as {
	[K in DedicatedId]: Extract<(typeof DEDICATED_SPECS)[number], { id: K }>;
};

/** The 4 generic, fully-configurable actions (the "advanced" fallback). */
export interface GenericSpec {
	id: string;
	name: string;
	tooltip: string;
	controller: "Keypad" | "Encoder";
	states: 1 | 2;
	propertyInspector: string;
	encoderLayout?: string;
	/** Lucide icon name (single glyph, no badge). */
	iconName: string;
}

export const GENERIC_SPECS = [
	{
		id: "eiscp-button", name: "eISCP Button",
		tooltip: "Send any eISCP command. Use for one-shot commands, volume up/down, etc.",
		controller: "Keypad", states: 1, propertyInspector: "ui/eiscp-button.html", iconName: "command",
	},
	{
		id: "eiscp-toggle", name: "eISCP Toggle",
		tooltip: "Toggle on/off eISCP commands. Use for power, mute, direct mode, etc.",
		controller: "Keypad", states: 2, propertyInspector: "ui/eiscp-toggle.html", iconName: "toggle-right",
	},
	{
		id: "eiscp-dial", name: "eISCP Dial Value",
		tooltip: "Encoder for text-based eISCP values. Use for input selector, listening mode, etc.",
		controller: "Encoder", states: 1, encoderLayout: "$A1", propertyInspector: "ui/eiscp-dial.html", iconName: "disc-3",
	},
	{
		id: "eiscp-dial-indicator", name: "eISCP Dial Indicator",
		tooltip: "Encoder with progress bar for numeric eISCP values. Use for volume, center level, etc.",
		controller: "Encoder", states: 1, encoderLayout: "$B1", propertyInspector: "ui/eiscp-dial-indicator.html", iconName: "gauge",
	},
] as const satisfies readonly GenericSpec[];

/** Union of the generic action ids. */
export type GenericId = (typeof GENERIC_SPECS)[number]["id"];

/** Property Inspector path for a dedicated action. */
export function dedicatedPropertyInspector(spec: DedicatedSpec): string {
	if (spec.id === "transport") return "ui/transport.html";
	if (spec.id === "now-playing") return "ui/now-playing.html";
	// Learned-name dials: Auto-Discover + configurable press dropdown.
	if (["input-dial", "mode-dial"].includes(spec.id)) return "ui/dial-discover.html";
	// Tone dials: configurable press dropdown.
	if (["bass-dial", "treble-dial"].includes(spec.id)) return "ui/dial-press.html";
	// Input + listening-mode key cyclers get the Auto-Discover button.
	if (["input-next", "input-prev", "mode-next", "mode-prev"].includes(spec.id)) {
		return "ui/discover.html";
	}
	return "ui/dedicated.html";
}

/** Accent background color for a toggle's ON state. */
export function onStateColor(command: string): string {
	return command === "AMT" ? "#F44336" : "#4CAF50";
}

/**
 * File name (no extension) of a key image variant.
 *
 * `dim` is the "receiver is not listening" look shown while it sits in standby or
 * is unreachable. One naming rule shared by the generator (scripts/generate-icons.ts,
 * which writes these files) and the runtime (`keyImageFor` in eiscp-base.ts, which
 * hands the path to `setImage`), so the two cannot drift apart.
 */
export function keyImageName(onState: boolean, dim: boolean): string {
	return `key${onState ? "-on" : ""}${dim ? "-dim" : ""}`;
}

/**
 * Plugin-relative path of a key image variant, as `setImage` wants it.
 *
 * With the extension: the manifest may omit it (Stream Deck resolves it there),
 * `setImage` takes a real file path.
 */
export function keyImagePath(id: string, onState: boolean, dim: boolean): string {
	return `imgs/actions/${id}/${keyImageName(onState, dim)}.svg`;
}

/**
 * The small transparent glyph, which is also what a touch strip shows in its icon
 * slot (the manifest's `Icon` field, without the extension).
 *
 * Needed as an explicit path because a layout item keeps whatever it was last given:
 * once the plugin writes a cover into a dial's icon slot there is no "unset", so the
 * way back is to write this again. Deliberately `icon.svg` and not `key.svg` — the
 * key image carries a dark rounded background that would show as a tile on the strip.
 */
export function listIconPath(id: string): string {
	return `imgs/actions/${id}/icon.svg`;
}
