/**
 * EiscpButtonAction - Universal button for sending any eISCP command+parameter
 *
 * Use for: volume up/down, input selection, listening mode changes, etc.
 * Shows current state as title text.
 */

import {
	action,
	KeyDownEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	streamDeck,
} from "@elgato/streamdeck";
import { ConnectionManager } from "../adapter/eiscp/connection-manager.ts";
import { type EiscpActionSettings, resolveDeviceIp, formatCommandValue } from "./eiscp-base.ts";

interface ButtonSettings extends EiscpActionSettings {
	parameter?: string;
}

@action({ UUID: "de.schwetschke.sd.pioneer-onkyo-remote.eiscp-button" })
export class EiscpButtonAction extends SingletonAction<ButtonSettings> {
	private unsubscribers: Map<string, () => void> = new Map();

	override async onWillAppear(ev: WillAppearEvent<ButtonSettings>): Promise<void> {
		const { command } = ev.payload.settings;
		if (!command) {
			await ev.action.setTitle("?");
			return;
		}

		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();
		const actionId = ev.action.id;

		// Subscribe to command updates
		const unsub = mgr.onCommandUpdate(host, command, (rawValue) => {
			ev.action.setTitle(formatCommandValue(command, rawValue));
		});
		this.unsubscribers.set(actionId, unsub);

		// Query current state
		try {
			const value = await mgr.queryCommand(host, command);
			await ev.action.setTitle(formatCommandValue(command, value));
		} catch {
			await ev.action.setTitle(command);
		}
	}

	override async onWillDisappear(ev: WillDisappearEvent<ButtonSettings>): Promise<void> {
		const unsub = this.unsubscribers.get(ev.action.id);
		if (unsub) {
			unsub();
			this.unsubscribers.delete(ev.action.id);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<ButtonSettings>): Promise<void> {
		const { command, parameter } = ev.payload.settings;
		if (!command || !parameter) {
			ev.action.showAlert();
			return;
		}

		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();

		try {
			await mgr.sendCommand(host, command, parameter);
			ev.action.showOk();
		} catch (err) {
			streamDeck.logger.error(`Button action error: ${err}`);
			ev.action.showAlert();
		}
	}
}
