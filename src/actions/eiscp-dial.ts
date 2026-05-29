/**
 * EiscpDialAction - Encoder/dial for text-based eISCP values
 *
 * Use for: input selector, listening mode, HDMI output, dimmer, etc.
 * Shows the current value as text on the dial display (no progress bar).
 * Subscribes to press command for status display (e.g. mute indicator).
 */

import { action, type DialAction } from "@elgato/streamdeck";
import { COMMAND_REGISTRY } from "../adapter/eiscp/command-registry.ts";
import { type EiscpActionSettings, resolveParam, formatCommandValue } from "./eiscp-base.ts";
import { DialActionBase, type DialConfig } from "./eiscp-action-base.ts";

interface DialSettings extends EiscpActionSettings {
	upParam?: string;
	customUpParam?: string;
	downParam?: string;
	customDownParam?: string;
	pressCommand?: string;
	pressParam?: string;
	customPressParam?: string;
}

@action({ UUID: "de.schwetschke.sd.pioneer-onkyo-remote.eiscp-dial" })
export class EiscpDialAction extends DialActionBase<DialSettings> {
	constructor() {
		super("EiscpDial");
	}

	protected getDialConfig(settings: DialSettings): DialConfig | undefined {
		const command = settings.command;
		if (!command) return undefined;
		return {
			command,
			upParam: resolveParam(settings.upParam, settings.customUpParam, "UP"),
			downParam: resolveParam(settings.downParam, settings.customDownParam, "DOWN"),
			pressCommand: settings.pressCommand,
			pressParam: resolveParam(settings.pressParam, settings.customPressParam),
		};
	}

	protected updateFeedback(
		action: DialAction<DialSettings>,
		cfg: DialConfig,
		rawValue: string,
		_settings: DialSettings,
		pressOn: boolean,
	): void {
		const label = formatCommandValue(cfg.command, rawValue);
		const pressDef = cfg.pressCommand ? COMMAND_REGISTRY[cfg.pressCommand] : undefined;
		const title = pressOn && pressDef ? pressDef.name.toUpperCase() : cfg.command;
		action.setFeedback({ value: label, title });
	}
}
