/**
 * Pre-built ("dedicated") actions: ready-to-drop remote keys with baked-in
 * command, behavior and canonical Lucide icons. Thin subclasses over the shared
 * bases in eiscp-action-base.ts; all configuration comes from ./catalog.ts.
 */

import {
	action,
	type DialAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type WillAppearEvent,
} from "@elgato/streamdeck";
import type { EiscpActionSettings } from "../eiscp-base.ts";
import {
	DialActionBase,
	KeyActionBase,
	ToggleActionBase,
	type DialConfig,
	type KeyConfig,
	type ToggleConfig,
} from "../eiscp-action-base.ts";
import { SPEC_BY_ID, uuidFor } from "./catalog.ts";

function toggleCfg(id: string): ToggleConfig {
	const s = SPEC_BY_ID[id];
	return { command: s.command, onValue: s.onValue ?? "01", offValue: s.offValue ?? "00", toggleValue: s.toggleValue };
}

function keyCfg(id: string): KeyConfig {
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
	protected abstract id: string;
	protected getKeyConfig(): KeyConfig {
		return keyCfg(this.id);
	}
}

@action({ UUID: uuidFor("volume-up") })
export class VolumeUpAction extends FixedKeyAction {
	protected id = "volume-up";
	constructor() {
		super("VolumeUp");
		this.showsState = true;
	}
}

@action({ UUID: uuidFor("volume-down") })
export class VolumeDownAction extends FixedKeyAction {
	protected id = "volume-down";
	constructor() {
		super("VolumeDown");
		this.showsState = true;
	}
}

@action({ UUID: uuidFor("input-next") })
export class InputNextAction extends FixedKeyAction {
	protected id = "input-next";
	constructor() {
		super("InputNext");
		this.showsState = true;
	}
}

@action({ UUID: uuidFor("input-prev") })
export class InputPrevAction extends FixedKeyAction {
	protected id = "input-prev";
	constructor() {
		super("InputPrev");
		this.showsState = true;
	}
}

@action({ UUID: uuidFor("mode-next") })
export class ModeNextAction extends FixedKeyAction {
	protected id = "mode-next";
	constructor() {
		super("ModeNext");
		this.showsState = true;
	}
}

@action({ UUID: uuidFor("mode-prev") })
export class ModePrevAction extends FixedKeyAction {
	protected id = "mode-prev";
	constructor() {
		super("ModePrev");
		this.showsState = true;
	}
}

@action({ UUID: uuidFor("bass-up") })
export class BassUpAction extends FixedKeyAction {
	protected id = "bass-up";
	constructor() {
		super("BassUp");
		this.showsState = false;
	}
}

@action({ UUID: uuidFor("bass-down") })
export class BassDownAction extends FixedKeyAction {
	protected id = "bass-down";
	constructor() {
		super("BassDown");
		this.showsState = false;
	}
}

@action({ UUID: uuidFor("treble-up") })
export class TrebleUpAction extends FixedKeyAction {
	protected id = "treble-up";
	constructor() {
		super("TrebleUp");
		this.showsState = false;
	}
}

@action({ UUID: uuidFor("treble-down") })
export class TrebleDownAction extends FixedKeyAction {
	protected id = "treble-down";
	constructor() {
		super("TrebleDown");
		this.showsState = false;
	}
}

@action({ UUID: uuidFor("preset-next") })
export class PresetNextAction extends FixedKeyAction {
	protected id = "preset-next";
	constructor() {
		super("PresetNext");
		this.showsState = true;
	}
}

@action({ UUID: uuidFor("preset-prev") })
export class PresetPrevAction extends FixedKeyAction {
	protected id = "preset-prev";
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

	private setTransportTitle(action: KeyAction<TransportSettings>, settings: TransportSettings): void {
		const key = settings.transportKey || SPEC_BY_ID["transport"].parameter || "P/P";
		action.setTitle(TRANSPORT_LABELS[key] ?? key);
	}

	override async onWillAppear(ev: WillAppearEvent<TransportSettings>): Promise<void> {
		await super.onWillAppear(ev);
		if (ev.action.isKey()) this.setTransportTitle(ev.action, ev.payload.settings);
	}

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<TransportSettings>): void {
		if (ev.action.isKey()) this.setTransportTitle(ev.action, ev.payload.settings);
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
			upParam: s.upParam ?? "UP",
			downParam: s.downParam ?? "DOWN",
			pressCommand: s.pressCommand,
			pressParam: s.pressParam,
		};
	}

	protected updateFeedback(
		action: DialAction<EiscpActionSettings>,
		_cfg: DialConfig,
		rawValue: string,
		_settings: EiscpActionSettings,
		pressOn: boolean,
	): void {
		const num = parseInt(rawValue, 16);
		const percent = Math.round(((Number.isNaN(num) ? 0 : num) / 80) * 100);
		action.setFeedback({
			value: Number.isNaN(num) ? rawValue : String(num),
			title: pressOn ? "MUTED" : "Volume",
			indicator: { value: Math.min(percent, 100), bar_fill_c: pressOn ? "#F44336" : "#4CAF50" },
		});
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
];
