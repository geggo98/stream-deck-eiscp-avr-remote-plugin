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

export const PLUGIN_ID = "de.schwetschke.sd.pioneer-onkyo-remote";
export const uuidFor = (id: string): string => `${PLUGIN_ID}.${id}`;

export type DedicatedKind = "toggle" | "key" | "dial";

export interface IconSpec {
	/** Lucide icon name for the default / off state. */
	primary: string;
	/** Optional small corner badge (e.g. plus, minus, chevron-right). */
	badge?: string;
	/** Lucide icon name for the on state of a toggle (defaults to `primary`). */
	onPrimary?: string;
}

export interface DedicatedSpec {
	id: string;
	name: string;
	tooltip: string;
	kind: DedicatedKind;
	controller: "Keypad" | "Encoder";
	command: string;
	/** key actions: the parameter to send. */
	parameter?: string;
	/** key actions: whether to subscribe and show live state as the title. */
	showsState?: boolean;
	/** toggle actions. */
	onValue?: string;
	offValue?: string;
	toggleValue?: string;
	/** dial actions. */
	upParam?: string;
	downParam?: string;
	pressCommand?: string;
	pressParam?: string;
	encoderLayout?: string;
	/** number of manifest States (2 for on/off toggles, else 1). */
	states: 1 | 2;
	icon: IconSpec;
}

export const DEDICATED_SPECS: DedicatedSpec[] = [
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
];

export const SPEC_BY_ID: Record<string, DedicatedSpec> = Object.fromEntries(
	DEDICATED_SPECS.map((s) => [s.id, s]),
);

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

export const GENERIC_SPECS: GenericSpec[] = [
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
];

/** Property Inspector path for a dedicated action. */
export function dedicatedPropertyInspector(spec: DedicatedSpec): string {
	if (spec.id === "transport") return "ui/transport.html";
	// Input + listening-mode cyclers get the Auto-Discover button.
	if (["input-next", "input-prev", "mode-next", "mode-prev"].includes(spec.id)) {
		return "ui/discover.html";
	}
	return "ui/dedicated.html";
}

/** Accent background color for a toggle's ON state. */
export function onStateColor(command: string): string {
	return command === "AMT" ? "#F44336" : "#4CAF50";
}
