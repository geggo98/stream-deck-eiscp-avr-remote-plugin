/**
 * EiscpDialIndicatorAction - Encoder/dial with progress bar for eISCP values
 *
 * Use for: master volume, center level, or any command with UP/DOWN.
 * Stepper commands show a progress bar indicator + numeric value.
 * Selector commands show the value name + progress bar disabled.
 * Subscribes to press command for status display (e.g. mute indicator).
 */

import { action, type DialAction } from "@elgato/streamdeck";
import { COMMAND_REGISTRY } from "../adapter/eiscp/command-registry.ts";
import { type EiscpActionSettings, fireAndLog, resolveParam, formatCommandValue } from "./eiscp-base.ts";
import { DialActionBase, type DialConfig } from "./eiscp-action-base.ts";

interface DialIndicatorSettings extends EiscpActionSettings {
	upParam?: string;
	customUpParam?: string;
	downParam?: string;
	customDownParam?: string;
	pressCommand?: string;
	pressParam?: string;
	customPressParam?: string;
	barColor?: string;
	barMutedColor?: string;
}

@action({ UUID: "de.schwetschke.sd.eiscp-avr-remote.eiscp-dial-indicator" })
export class EiscpDialIndicatorAction extends DialActionBase<DialIndicatorSettings> {
	constructor() {
		super("EiscpDialIndicator");
	}

	private getMaxValue(command: string): number {
		return command === "MVL" ? 80 : 24;
	}

	protected getDialConfig(settings: DialIndicatorSettings): DialConfig | undefined {
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
		action: DialAction<DialIndicatorSettings>,
		cfg: DialConfig,
		rawValue: string,
		settings: DialIndicatorSettings,
		pressOn: boolean,
	): void {
		const cmd = COMMAND_REGISTRY[cfg.command];
		const pressDef = cfg.pressCommand ? COMMAND_REGISTRY[cfg.pressCommand] : undefined;
		const barColor = settings.barColor || "#4CAF50";
		const barMutedColor = settings.barMutedColor || "#F44336";

		const title = pressOn && pressDef ? pressDef.name.toUpperCase() : cmd?.description?.split(" ")[0] ?? cfg.command;

		if (cmd?.actionType === "stepper") {
			const num = parseInt(rawValue, 16);
			const max = this.getMaxValue(cfg.command);
			const percent = Math.round((num / max) * 100);
			const fillColor = pressOn ? barMutedColor : barColor;
			fireAndLog(
				action.setFeedback({
					value: `${num}`,
					title,
					indicator: { value: Math.min(percent, 100), bar_fill_c: fillColor },
				}),
				this.logger,
				"setFeedback",
			);
		} else {
			fireAndLog(
				action.setFeedback({
					value: formatCommandValue(cfg.command, rawValue),
					title,
					indicator: { value: 0, enabled: false },
				}),
				this.logger,
				"setFeedback",
			);
		}
	}
}
