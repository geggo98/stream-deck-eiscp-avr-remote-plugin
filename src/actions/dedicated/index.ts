/**
 * Pre-built ("dedicated") actions: ready-to-drop remote keys with baked-in
 * command, behavior and canonical Lucide icons. Thin subclasses over the shared
 * bases in eiscp-action-base.ts; all configuration comes from ./catalog.ts.
 */

import streamDeck, {
	action,
	type DialAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type SendToPluginEvent,
	type WillAppearEvent,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { ConnectionManager } from "../../adapter/eiscp/connection-manager.ts";
import { type EiscpActionSettings, resolveDeviceIp } from "../eiscp-base.ts";
import {
	DialActionBase,
	KeyActionBase,
	ToggleActionBase,
	type DialConfig,
	type KeyConfig,
	type ToggleConfig,
} from "../eiscp-action-base.ts";
import { SPEC_BY_ID, uuidFor } from "./catalog.ts";
import { nameFor, type TrackedCommand } from "./name-store.ts";
import { runSweep } from "./discovery.ts";

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

// Input cyclers defined below (extend LearnedNameKeyAction, declared later).

/**
 * Cycler that shows the receiver's OWN learned name for its command (LMD modes
 * or SLI inputs) instead of the generic registry name, and offers an
 * Auto-Discover sweep from the Property Inspector. Names are learned passively
 * (see discovery.ts) and read from the name store; unavailable LMD modes ("N/A")
 * render as "Not Available".
 */
abstract class LearnedNameKeyAction extends KeyActionBase<EiscpActionSettings> {
	protected abstract id: string;

	protected getKeyConfig(): KeyConfig {
		return keyCfg(this.id);
	}

	private displayCommand(): TrackedCommand {
		return SPEC_BY_ID[this.id].command as TrackedCommand;
	}

	override async onWillAppear(ev: WillAppearEvent<EiscpActionSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		const action = ev.action;
		this.clearSubs(action.id);
		const host = resolveDeviceIp(ev.payload.settings);
		const command = this.displayCommand();
		const mgr = ConnectionManager.getInstance();
		const refresh = () => action.setTitle(nameFor(host, command, mgr.getCachedValue(host, command)));

		// Re-render on a value change, or when a name is learned (FLD arrives).
		this.trackSub(action.id, mgr.onCommandUpdate(host, command, () => refresh()));
		this.trackSub(action.id, mgr.onCommandUpdate(host, "FLD", () => refresh()));

		try {
			await mgr.queryCommand(host, command);
			refresh();
		} catch (err) {
			this.logger.error(`onWillAppear: query ${command} failed: ${err}`);
		}
	}

	/** PI "Auto-Discover" button → sweep all options, learning each name. */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, EiscpActionSettings>): Promise<void> {
		const payload = ev.payload as { action?: string } | null;
		if (!payload || typeof payload !== "object" || payload.action !== "discover") return;
		if (!ev.action.isKey()) return;
		const action = ev.action;
		const settings = await action.getSettings();
		const host = resolveDeviceIp(settings);
		const command = this.displayCommand();
		// Plugin -> PI messages go through the global UI controller (targets the
		// currently-visible property inspector, which is this action's PI).
		const send = (m: JsonValue) => void streamDeck.ui.sendToPropertyInspector(m);

		send({ event: "discover", phase: "start", command });
		try {
			const { count } = await runSweep(host, command, (p) =>
				send({ event: "discover", phase: "progress", done: p.done, current: p.current }),
			);
			send({ event: "discover", phase: "done", count });
			action.showOk();
		} catch (err) {
			this.logger.error(`discover sweep failed: ${err}`);
			send({ event: "discover", phase: "error", message: String(err) });
			action.showAlert();
		}
	}
}

@action({ UUID: uuidFor("mode-next") })
export class ModeNextAction extends LearnedNameKeyAction {
	protected id = "mode-next";
	constructor() {
		super("ModeNext");
	}
}

@action({ UUID: uuidFor("mode-prev") })
export class ModePrevAction extends LearnedNameKeyAction {
	protected id = "mode-prev";
	constructor() {
		super("ModePrev");
	}
}

@action({ UUID: uuidFor("input-next") })
export class InputNextAction extends LearnedNameKeyAction {
	protected id = "input-next";
	constructor() {
		super("InputNext");
	}
}

@action({ UUID: uuidFor("input-prev") })
export class InputPrevAction extends LearnedNameKeyAction {
	protected id = "input-prev";
	constructor() {
		super("InputPrev");
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
