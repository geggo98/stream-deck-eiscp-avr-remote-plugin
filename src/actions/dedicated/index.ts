/**
 * Pre-built ("dedicated") actions: ready-to-drop remote keys with baked-in
 * command, behavior and canonical Lucide icons. Thin subclasses over the shared
 * bases in eiscp-action-base.ts; all configuration comes from ./catalog.ts.
 */

import {
	action,
	type DidReceiveSettingsEvent,
	type FeedbackPayload,
	type KeyAction,
	type SendToPluginEvent,
	type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { ConnectionManager } from "../../adapter/eiscp/connection-manager.ts";
import { COMMAND_REGISTRY } from "../../adapter/eiscp/command-registry.ts";
import {
	type EiscpActionSettings,
	fireAndLog,
	presetLabel,
	resolveDeviceIp,
	resolveDialPress,
	toneFeedback,
	UNCONFIGURED_TITLE,
} from "../eiscp-base.ts";
import {
	DialActionBase,
	KeyActionBase,
	ToggleActionBase,
	type DialConfig,
	type KeyConfig,
	type ToggleConfig,
} from "../eiscp-action-base.ts";
import { SPEC_BY_ID, uuidFor, type DedicatedIdOfKind, type ToggleSpec } from "./catalog.ts";
import { nameFor, type TrackedCommand } from "./name-store.ts";
import { handleDiscoverMessage } from "./discovery.ts";

/** Learned-name actions (Auto-Discover UI); their commands are tracked by the name store. */
type LearnedKeyId = "input-next" | "input-prev" | "mode-next" | "mode-prev";
type LearnedDialId = "input-dial" | "mode-dial";

function toggleCfg(id: DedicatedIdOfKind<"toggle">): ToggleConfig {
	// Widen to the interface so the optional toggleValue is accessible even on
	// catalog literals that omit it.
	const s: ToggleSpec = SPEC_BY_ID[id];
	return { command: s.command, onValue: s.onValue, offValue: s.offValue, toggleValue: s.toggleValue };
}

function keyCfg(id: DedicatedIdOfKind<"key">): KeyConfig {
	const s = SPEC_BY_ID[id];
	return { command: s.command, parameter: s.parameter };
}

// --- Toggles (distinct on/off State images; no colored background overlay) ---

@action({ UUID: uuidFor("power") })
export class PowerAction extends ToggleActionBase<EiscpActionSettings> {
	protected override coloredBackground = false;
	protected override showTitle = false;
	constructor() {
		super("Power");
	}
	protected getToggleConfig(): ToggleConfig {
		return toggleCfg("power");
	}
}

@action({ UUID: uuidFor("mute") })
export class MuteAction extends ToggleActionBase<EiscpActionSettings> {
	protected override coloredBackground = false;
	protected override showTitle = false;
	constructor() {
		super("Mute");
	}
	protected getToggleConfig(): ToggleConfig {
		return toggleCfg("mute");
	}
}

// --- Simple keys: cyclers (prev/next) and steppers (up/down) ---

/** Base for a key whose command/parameter is fixed by a catalog id. */
abstract class FixedKeyAction extends KeyActionBase<EiscpActionSettings> {
	protected abstract readonly id: DedicatedIdOfKind<"key">;
	protected getKeyConfig(): KeyConfig {
		return keyCfg(this.id);
	}
}

@action({ UUID: uuidFor("volume-up") })
export class VolumeUpAction extends FixedKeyAction {
	protected readonly id = "volume-up";
	constructor() {
		super("VolumeUp");
		this.showsState = true;
	}
}

@action({ UUID: uuidFor("volume-down") })
export class VolumeDownAction extends FixedKeyAction {
	protected readonly id = "volume-down";
	constructor() {
		super("VolumeDown");
		this.showsState = true;
	}
}

// Input cyclers defined below (extend LearnedNameKeyAction, declared later).

/**
 * Cycler that shows the receiver's OWN learned name for its command (LMD modes
 * or SLI inputs) instead of the generic registry name, and offers an
 * Auto-Discover sweep from the Property Inspector. Names are learned passively
 * (see discovery.ts) and read from the name store; unavailable LMD modes ("N/A")
 * render as "Not Available".
 */
abstract class LearnedNameKeyAction extends KeyActionBase<EiscpActionSettings> {
	protected abstract readonly id: LearnedKeyId;

	protected getKeyConfig(): KeyConfig {
		return keyCfg(this.id);
	}

	private displayCommand(): TrackedCommand {
		return SPEC_BY_ID[this.id].command;
	}

	override async onWillAppear(ev: WillAppearEvent<EiscpActionSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		await this.bindKey(ev.action, ev.payload.settings);
	}

	// onDidReceiveSettings is inherited from KeyActionBase and calls bindKey,
	// so a "No IP" title clears once the PI supplies the device IP.

	protected override async bindKey(
		action: KeyAction<EiscpActionSettings>,
		rawSettings: EiscpActionSettings,
	): Promise<EiscpActionSettings> {
		// This bind replaces the base's entirely, so the device memory (adopt on a
		// freshly added action, remember an explicit pick) has to be synced here too
		// — and the generation has to predate that await, see KeyActionBase.bindKey.
		const generation = this.nextBindGeneration(action.id);
		const fresh = () => this.isCurrentBind(action.id, generation);
		const settings = await this.syncDeviceMemory(action, rawSettings);
		if (!fresh()) return settings;
		this.clearSubs(action.id);
		const host = resolveDeviceIp(settings);
		if (!host) {
			this.logger.warn("bindKey: no device IP configured");
			fireAndLog(action.setTitle(UNCONFIGURED_TITLE), this.logger, "setTitle");
			return settings;
		}
		const command = this.displayCommand();
		const mgr = ConnectionManager.getInstance();
		const refresh = (): void => {
			const cached = mgr.getCachedValue(host, command);
			this.paintKeyImage(action, command, [0]);
			// "?" rather than an empty key while the receiver has not said anything yet.
			this.paintKeyTitle(action, cached === undefined ? "?" : nameFor(host, command, cached));
		};

		// Re-render on a value change, when a name is learned (FLD arrives), and when
		// the receiver's power state changes.
		this.trackSub(action.id, mgr.onCommandUpdate(host, command, () => refresh()));
		this.trackSub(action.id, mgr.onCommandUpdate(host, "FLD", () => refresh()));
		this.watchStatus(action.id, host, refresh);

		try {
			await mgr.queryCommand(host, command);
			if (!fresh()) return settings; // a newer bind owns the key now
			refresh();
		} catch (err) {
			this.logger.error(`bindKey: query ${command} on ${host} failed: ${err}`);
			// refresh() already degrades to "?" when the cache is empty.
			if (fresh()) refresh();
		}
		return settings;
	}

	/** PI "Auto-Discover" button → sweep all options; also serve the device list (super). */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, EiscpActionSettings>): Promise<void> {
		await handleDiscoverMessage(ev, this.displayCommand(), this.logger);
		await super.onSendToPlugin(ev);
	}
}

@action({ UUID: uuidFor("mode-next") })
export class ModeNextAction extends LearnedNameKeyAction {
	protected readonly id = "mode-next";
	constructor() {
		super("ModeNext");
	}
}

@action({ UUID: uuidFor("mode-prev") })
export class ModePrevAction extends LearnedNameKeyAction {
	protected readonly id = "mode-prev";
	constructor() {
		super("ModePrev");
	}
}

@action({ UUID: uuidFor("input-next") })
export class InputNextAction extends LearnedNameKeyAction {
	protected readonly id = "input-next";
	constructor() {
		super("InputNext");
	}
}

@action({ UUID: uuidFor("input-prev") })
export class InputPrevAction extends LearnedNameKeyAction {
	protected readonly id = "input-prev";
	constructor() {
		super("InputPrev");
	}
}

@action({ UUID: uuidFor("bass-up") })
export class BassUpAction extends FixedKeyAction {
	protected readonly id = "bass-up";
	constructor() {
		super("BassUp");
		this.showsState = false;
	}
}

@action({ UUID: uuidFor("bass-down") })
export class BassDownAction extends FixedKeyAction {
	protected readonly id = "bass-down";
	constructor() {
		super("BassDown");
		this.showsState = false;
	}
}

@action({ UUID: uuidFor("treble-up") })
export class TrebleUpAction extends FixedKeyAction {
	protected readonly id = "treble-up";
	constructor() {
		super("TrebleUp");
		this.showsState = false;
	}
}

@action({ UUID: uuidFor("treble-down") })
export class TrebleDownAction extends FixedKeyAction {
	protected readonly id = "treble-down";
	constructor() {
		super("TrebleDown");
		this.showsState = false;
	}
}

@action({ UUID: uuidFor("preset-next") })
export class PresetNextAction extends FixedKeyAction {
	protected readonly id = "preset-next";
	constructor() {
		super("PresetNext");
		this.showsState = true;
	}
}

@action({ UUID: uuidFor("preset-prev") })
export class PresetPrevAction extends FixedKeyAction {
	protected readonly id = "preset-prev";
	constructor() {
		super("PresetPrev");
		this.showsState = true;
	}
}

// --- Transport: one configurable key (NTC), function chosen in the PI ---

interface TransportSettings extends EiscpActionSettings {
	transportKey?: string;
}

const TRANSPORT_LABELS: Record<string, string> = {
	"P/P": "Play/Pause",
	PLAY: "Play",
	PAUSE: "Pause",
	STOP: "Stop",
	TRUP: "Next",
	TRDN: "Prev",
};

@action({ UUID: uuidFor("transport") })
export class TransportAction extends KeyActionBase<TransportSettings> {
	constructor() {
		super("Transport");
		this.showsState = false;
	}

	protected getKeyConfig(settings: TransportSettings): KeyConfig {
		return { command: "NTC", parameter: settings.transportKey || SPEC_BY_ID["transport"].parameter };
	}

	/**
	 * The key's own label. Returned to the base rather than written here, so the
	 * label, the "No IP" state and the receiver's power state all come out of one
	 * ordered paint instead of racing each other — this key used to lose its label
	 * whenever the base repainted after it.
	 */
	protected override statelessTitle(settings: TransportSettings): string {
		const key = settings.transportKey || SPEC_BY_ID["transport"].parameter;
		return TRANSPORT_LABELS[key] ?? key;
	}
}

// --- Volume encoder (MVL with progress bar; press toggles mute) ---

@action({ UUID: uuidFor("volume-dial") })
export class VolumeDialAction extends DialActionBase<EiscpActionSettings> {
	constructor() {
		super("VolumeDial");
	}

	protected getDialConfig(): DialConfig {
		const s = SPEC_BY_ID["volume-dial"];
		return {
			command: s.command,
			upParam: s.upParam,
			downParam: s.downParam,
			pressCommand: s.pressCommand,
			pressParam: s.pressParam,
		};
	}

	protected buildFeedback(
		cfg: DialConfig,
		rawValue: string,
		_settings: EiscpActionSettings,
		pressOn: boolean,
	): FeedbackPayload {
		const num = parseInt(rawValue, 16);
		const mvl = COMMAND_REGISTRY[cfg.command];
		const max = mvl?.actionType === "stepper" ? mvl.maxValue : 80;
		const percent = Math.round(((Number.isNaN(num) ? 0 : num) / max) * 100);
		return {
			value: Number.isNaN(num) ? rawValue : String(num),
			title: pressOn ? "MUTED" : "Volume",
			indicator: { value: Math.min(percent, 100), bar_fill_c: pressOn ? "#F44336" : "#4CAF50" },
		};
	}
}

// --- Additional dials: input, listening mode, bass, treble, preset ----------

/**
 * Dial whose touch strip shows the receiver's OWN learned name for its command
 * (SLI inputs or LMD modes), and offers the same Auto-Discover sweep as the key
 * cyclers. Names are learned passively (FLD) and read from the name store, so we
 * also redraw on FLD via extraRerenderCommands.
 */
abstract class LearnedNameDialAction extends DialActionBase<EiscpActionSettings> {
	protected abstract readonly id: LearnedDialId;
	/** Short title for the touch strip (the catalog name can be too long). */
	protected abstract stripTitle: string;

	private spec() {
		return SPEC_BY_ID[this.id];
	}
	private command(): TrackedCommand {
		return this.spec().command;
	}

	protected getDialConfig(settings: EiscpActionSettings): DialConfig {
		const s = this.spec();
		const press = resolveDialPress(settings.pressAction);
		return {
			command: s.command,
			upParam: s.upParam,
			downParam: s.downParam,
			pressCommand: press.command,
			pressParam: press.param,
			pressOnValue: press.on,
			pressLabel: press.label,
		};
	}

	protected override extraRerenderCommands(): string[] {
		return ["FLD"];
	}

	protected buildFeedback(
		cfg: DialConfig,
		rawValue: string,
		settings: EiscpActionSettings,
		pressOn: boolean,
	): FeedbackPayload {
		const host = resolveDeviceIp(settings);
		return {
			title: pressOn ? (cfg.pressLabel ?? "ON") : this.stripTitle,
			// bind() never renders without a host; fall back defensively anyway.
			value: host ? nameFor(host, this.command(), rawValue) : rawValue,
		};
	}

	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, EiscpActionSettings>): Promise<void> {
		await handleDiscoverMessage(ev, this.command(), this.logger);
		await super.onSendToPlugin(ev);
	}
}

@action({ UUID: uuidFor("input-dial") })
export class InputDialAction extends LearnedNameDialAction {
	protected readonly id = "input-dial";
	protected stripTitle = "Input";
	constructor() {
		super("InputDial");
	}
}

@action({ UUID: uuidFor("mode-dial") })
export class ModeDialAction extends LearnedNameDialAction {
	protected readonly id = "mode-dial";
	protected stripTitle = "Mode";
	constructor() {
		super("ModeDial");
	}
}

/**
 * Dial for one component (bass or treble) of the receiver's combined TFR tone
 * readout ("B{xx}T{yy}"), shown as a −10..+10 progress bar. Press runs the
 * configurable press action (default Mute); while it reads ON the bar greys out.
 */
abstract class ToneDialAction extends DialActionBase<EiscpActionSettings> {
	protected abstract readonly id: DedicatedIdOfKind<"dial">;
	/** Which half of "B{xx}T{yy}" this dial reflects. */
	protected abstract component: "bass" | "treble";
	protected abstract stripTitle: string;

	protected getDialConfig(settings: EiscpActionSettings): DialConfig {
		const s = SPEC_BY_ID[this.id];
		const press = resolveDialPress(settings.pressAction);
		return {
			command: s.command,
			upParam: s.upParam,
			downParam: s.downParam,
			pressCommand: press.command,
			pressParam: press.param,
			pressOnValue: press.on,
			pressLabel: press.label,
		};
	}

	protected buildFeedback(
		cfg: DialConfig,
		rawValue: string,
		_settings: EiscpActionSettings,
		pressOn: boolean,
	): FeedbackPayload {
		const { percent, display } = toneFeedback(rawValue, this.component);
		return {
			title: pressOn ? (cfg.pressLabel ?? "ON") : this.stripTitle,
			value: display,
			indicator: {
				value: percent,
				bar_fill_c: pressOn ? "#9E9E9E" : "#4CAF50",
			},
		};
	}
}

@action({ UUID: uuidFor("bass-dial") })
export class BassDialAction extends ToneDialAction {
	protected readonly id = "bass-dial";
	protected component = "bass" as const;
	protected stripTitle = "Bass";
	constructor() {
		super("BassDial");
	}
}

@action({ UUID: uuidFor("treble-dial") })
export class TrebleDialAction extends ToneDialAction {
	protected readonly id = "treble-dial";
	protected component = "treble" as const;
	protected stripTitle = "Treble";
	constructor() {
		super("TrebleDial");
	}
}

/** Tuner preset dial: rotate steps presets (PRS), press jumps to the Tuner input. */
@action({ UUID: uuidFor("preset-dial") })
export class PresetDialAction extends DialActionBase<EiscpActionSettings> {
	constructor() {
		super("PresetDial");
	}

	protected getDialConfig(): DialConfig {
		const s = SPEC_BY_ID["preset-dial"];
		return {
			command: s.command,
			upParam: s.upParam ?? "UP",
			downParam: s.downParam ?? "DOWN",
			pressCommand: s.pressCommand,
			pressParam: s.pressParam,
		};
	}

	protected buildFeedback(
		_cfg: DialConfig,
		rawValue: string,
		_settings: EiscpActionSettings,
		_pressOn: boolean,
	): FeedbackPayload {
		return { title: "Preset", value: presetLabel(rawValue) };
	}
}

/** All dedicated action instances, registered in plugin.ts. */
export const DEDICATED_ACTIONS = [
	new PowerAction(),
	new MuteAction(),
	new VolumeUpAction(),
	new VolumeDownAction(),
	new VolumeDialAction(),
	new InputNextAction(),
	new InputPrevAction(),
	new ModeNextAction(),
	new ModePrevAction(),
	new TransportAction(),
	new BassUpAction(),
	new BassDownAction(),
	new TrebleUpAction(),
	new TrebleDownAction(),
	new PresetNextAction(),
	new PresetPrevAction(),
	new InputDialAction(),
	new ModeDialAction(),
	new BassDialAction(),
	new TrebleDialAction(),
	new PresetDialAction(),
];
