/**
 * EiscpToggleAction - Toggle action for on/off eISCP commands
 *
 * Use for: power, mute, direct mode, cinema filter, etc.
 * Two visual states (off/on) with automatic state tracking.
 * Shows current state as background color (green=on, red=muted, dark=off).
 */

import { action } from "@elgato/streamdeck";
import { COMMAND_REGISTRY } from "../adapter/eiscp/command-registry.ts";
import { type EiscpActionSettings, resolveParam } from "./eiscp-base.ts";
import { ToggleActionBase, type ToggleConfig } from "./eiscp-action-base.ts";

interface ToggleSettings extends EiscpActionSettings {
	onValue?: string;
	customOnValue?: string;
	offValue?: string;
	customOffValue?: string;
}

@action({ UUID: "de.schwetschke.sd.eiscp-avr-remote.eiscp-toggle" })
export class EiscpToggleAction extends ToggleActionBase<ToggleSettings> {
	constructor() {
		super("EiscpToggle");
	}

	protected getToggleConfig(settings: ToggleSettings): ToggleConfig | undefined {
		const command = settings.command;
		if (!command) return undefined;
		const cmd = COMMAND_REGISTRY[command];
		// The user may point the generic toggle at any command; only real
		// toggles carry wire values, everything else falls back to 01/00.
		const toggleDef = cmd?.actionType === "toggle" ? cmd : undefined;
		const onValue = resolveParam(settings.onValue, settings.customOnValue) ?? toggleDef?.onValue ?? "01";
		const offValue = resolveParam(settings.offValue, settings.customOffValue) ?? toggleDef?.offValue ?? "00";
		return { command, onValue, offValue, toggleValue: toggleDef?.toggleValue };
	}
}
