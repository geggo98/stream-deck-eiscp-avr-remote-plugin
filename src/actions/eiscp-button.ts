/**
 * EiscpButtonAction - Universal button for sending any eISCP command+parameter
 *
 * Use for: volume up/down, input selection, listening mode changes, etc.
 * Shows current state as title text.
 */

import { action } from "@elgato/streamdeck";
import { type EiscpActionSettings, resolveParam } from "./eiscp-base.ts";
import { KeyActionBase, type KeyConfig } from "./eiscp-action-base.ts";

interface ButtonSettings extends EiscpActionSettings {
	parameter?: string;
	customParameter?: string;
}

@action({ UUID: "de.schwetschke.sd.pioneer-onkyo-remote.eiscp-button" })
export class EiscpButtonAction extends KeyActionBase<ButtonSettings> {
	constructor() {
		super("EiscpButton");
	}

	protected getKeyConfig(settings: ButtonSettings): KeyConfig | undefined {
		const command = settings.command;
		if (!command) return undefined;
		const parameter = resolveParam(settings.parameter, settings.customParameter);
		return { command, parameter };
	}
}
