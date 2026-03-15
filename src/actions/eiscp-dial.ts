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
		if (!command) return;

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
			this.updateFeedback(ev, command, value);
		} catch {
			// Leave as default
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

		if (!command) {
			return;
		}

		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();
		const ticks = ev.payload.ticks;
		const param = ticks > 0 ? upParam : downParam;
		const count = Math.abs(ticks);

		try {
			for (let i = 0; i < count; i++) {
				await mgr.sendCommand(host, command, param);
			}
		} catch (err) {
			streamDeck.logger.error(`Dial rotate error: ${err}`);
		}
	}

	override async onDialDown(ev: DialDownEvent<DialSettings>): Promise<void> {
		const pressCommand = ev.payload.settings.pressCommand ?? ev.payload.settings.command;
		const pressParam = ev.payload.settings.pressParam;

		if (!pressCommand || !pressParam) {
			return;
		}

		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();

		try {
			await mgr.sendCommand(host, pressCommand, pressParam);
		} catch (err) {
			streamDeck.logger.error(`Dial press error: ${err}`);
		}
	}
}
