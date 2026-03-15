/**
 * EiscpDialAction - Encoder/dial action for eISCP commands
 *
 * Use for: volume control (with mute on press), input cycling, etc.
 * Supports rotation (up/down) and press actions.
 */

import {
	action,
	DialDownEvent,
	DialRotateEvent,
	SingletonAction,
	WillAppearEvent,
	WillDisappearEvent,
	streamDeck,
} from "@elgato/streamdeck";
import { ConnectionManager } from "../adapter/eiscp/connection-manager.ts";
import { COMMAND_REGISTRY } from "../adapter/eiscp/command-registry.ts";
import { type EiscpActionSettings, resolveDeviceIp, formatCommandValue } from "./eiscp-base.ts";

const logger = streamDeck.logger.createScope("EiscpDial");

interface DialSettings extends EiscpActionSettings {
	upParam?: string;
	downParam?: string;
	pressCommand?: string;
	pressParam?: string;
}

@action({ UUID: "de.schwetschke.sd.pioneer-onkyo-remote.eiscp-dial" })
export class EiscpDialAction extends SingletonAction<DialSettings> {
	private unsubscribers: Map<string, (() => void)[]> = new Map();

	private updateFeedback(
		ev: WillAppearEvent<DialSettings>,
		command: string,
		rawValue: string,
	): void {
		if (!ev.action.isDial()) return;

		const cmd = COMMAND_REGISTRY[command];
		const label = formatCommandValue(command, rawValue);

		if (cmd?.actionType === "stepper") {
			const num = parseInt(rawValue, 16);
			const max = command === "MVL" ? 80 : 24;
			const percent = Math.round((num / max) * 100);
			ev.action.setFeedback({
				value: percent,
				title: command,
				indicator: { value: percent },
			});
		} else {
			ev.action.setFeedback({
				value: label,
				title: command,
			});
		}
	}

	override async onWillAppear(ev: WillAppearEvent<DialSettings>): Promise<void> {
		const { command } = ev.payload.settings;
		logger.info(`onWillAppear: command=${command}, settings=${JSON.stringify(ev.payload.settings)}`);
		if (!command) {
			logger.warn("onWillAppear: No command configured, skipping");
			return;
		}

		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();
		const actionId = ev.action.id;
		const unsubs: (() => void)[] = [];

		// Subscribe to main command updates
		unsubs.push(
			mgr.onCommandUpdate(host, command, (rawValue) => {
				this.updateFeedback(ev, command, rawValue);
			}),
		);

		this.unsubscribers.set(actionId, unsubs);

		// Query current state
		try {
			const value = await mgr.queryCommand(host, command);
			logger.info(`onWillAppear: Initial state for ${command}: ${value}`);
			this.updateFeedback(ev, command, value);
		} catch (err) {
			logger.error(`onWillAppear: Query failed for ${command}: ${err}`);
		}
	}

	override async onWillDisappear(ev: WillDisappearEvent<DialSettings>): Promise<void> {
		const unsubs = this.unsubscribers.get(ev.action.id);
		if (unsubs) {
			for (const unsub of unsubs) unsub();
			this.unsubscribers.delete(ev.action.id);
		}
	}

	override async onDialRotate(ev: DialRotateEvent<DialSettings>): Promise<void> {
		const { command } = ev.payload.settings;
		const upParam = ev.payload.settings.upParam ?? "UP";
		const downParam = ev.payload.settings.downParam ?? "DOWN";

		logger.info(`onDialRotate: command=${command}, ticks=${ev.payload.ticks}`);
		if (!command) {
			logger.warn("onDialRotate: No command configured, ignoring rotation");
			return;
		}

		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();
		const ticks = ev.payload.ticks;
		const param = ticks > 0 ? upParam : downParam;
		const count = Math.abs(ticks);

		try {
			logger.debug(`onDialRotate: Sending ${command} ${param} x${count}`);
			for (let i = 0; i < count; i++) {
				await mgr.sendCommand(host, command, param);
			}
		} catch (err) {
			logger.error(`onDialRotate: ${command} ${param} failed: ${err}`);
		}
	}

	override async onDialDown(ev: DialDownEvent<DialSettings>): Promise<void> {
		const pressCommand = ev.payload.settings.pressCommand ?? ev.payload.settings.command;
		const pressParam = ev.payload.settings.pressParam;

		logger.info(`onDialDown: pressCommand=${pressCommand}, pressParam=${pressParam}`);
		if (!pressCommand || !pressParam) {
			logger.warn(`onDialDown: Missing pressCommand=${pressCommand} or pressParam=${pressParam}, ignoring`);
			return;
		}

		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();

		try {
			await mgr.sendCommand(host, pressCommand, pressParam);
			logger.info(`onDialDown: ${pressCommand} ${pressParam} sent successfully`);
		} catch (err) {
			logger.error(`onDialDown: ${pressCommand} ${pressParam} failed: ${err}`);
		}
	}
}
