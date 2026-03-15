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
import { type EiscpActionSettings, resolveDeviceIp, resolveParam, formatCommandValue } from "./eiscp-base.ts";

const logger = streamDeck.logger.createScope("EiscpButton");

interface ButtonSettings extends EiscpActionSettings {
	parameter?: string;
	customParameter?: string;
}

@action({ UUID: "de.schwetschke.sd.pioneer-onkyo-remote.eiscp-button" })
export class EiscpButtonAction extends SingletonAction<ButtonSettings> {
	private unsubscribers: Map<string, () => void> = new Map();

	override async onWillAppear(ev: WillAppearEvent<ButtonSettings>): Promise<void> {
		const { command } = ev.payload.settings;
		logger.info(`onWillAppear: command=${command}, settings=${JSON.stringify(ev.payload.settings)}`);
		if (!command) {
			logger.warn("onWillAppear: No command configured, showing '?'");
			await ev.action.setTitle("?");
			return;
		}

		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();
		const actionId = ev.action.id;

		// Subscribe to command updates
		const unsub = mgr.onCommandUpdate(host, command, (rawValue) => {
			logger.debug(`State update for ${command}: ${rawValue}`);
			ev.action.setTitle(formatCommandValue(command, rawValue));
		});
		this.unsubscribers.set(actionId, unsub);

		// Query current state
		try {
			const value = await mgr.queryCommand(host, command);
			await ev.action.setTitle(formatCommandValue(command, value));
		} catch (err) {
			logger.error(`onWillAppear: Query failed for ${command}: ${err}`);
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
		const { command } = ev.payload.settings;
		const parameter = resolveParam(ev.payload.settings.parameter, ev.payload.settings.customParameter);
		logger.info(`onKeyDown: command=${command}, parameter=${parameter}, host=${resolveDeviceIp(ev.payload.settings)}`);
		if (!command || !parameter) {
			logger.warn(`onKeyDown: Missing command=${command} or parameter=${parameter}, showing alert`);
			ev.action.showAlert();
			return;
		}

		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();

		try {
			await mgr.sendCommand(host, command, parameter);
			logger.info(`onKeyDown: Command ${command} ${parameter} sent successfully`);
			ev.action.showOk();
		} catch (err) {
			logger.error(`onKeyDown: Command ${command} ${parameter} failed: ${err}`);
			ev.action.showAlert();
		}
	}
}
