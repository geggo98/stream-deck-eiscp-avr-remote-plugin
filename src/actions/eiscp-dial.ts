/**
 * EiscpDialAction - Encoder/dial for text-based eISCP values
 *
 * Use for: input selector, listening mode, HDMI output, dimmer, etc.
 * Shows the current value as text on the dial display (no progress bar).
 * Subscribes to press command for status display (e.g. mute indicator).
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
import { type EiscpActionSettings, resolveDeviceIp, resolveParam, formatCommandValue } from "./eiscp-base.ts";

const logger = streamDeck.logger.createScope("EiscpDial");

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
export class EiscpDialAction extends SingletonAction<DialSettings> {
	private unsubscribers: Map<string, (() => void)[]> = new Map();
	private pressState: Map<string, string> = new Map();

	private isPressOn(actionId: string, settings: DialSettings): boolean {
		const pressCmd = settings.pressCommand;
		if (!pressCmd || pressCmd === settings.command) return false;
		const raw = this.pressState.get(actionId);
		if (!raw) return false;
		const def = COMMAND_REGISTRY[pressCmd];
		return raw === (def?.onValue ?? "01");
	}

	private updateFeedback(
		ev: WillAppearEvent<DialSettings>,
		command: string,
		rawValue: string,
	): void {
		if (!ev.action.isDial()) return;

		const label = formatCommandValue(command, rawValue);
		const pressOn = this.isPressOn(ev.action.id, ev.payload.settings);
		const pressCmd = ev.payload.settings.pressCommand;
		const pressDef = pressCmd ? COMMAND_REGISTRY[pressCmd] : undefined;

		const title = pressOn && pressDef
			? pressDef.name.toUpperCase()
			: command;

		ev.action.setFeedback({
			value: label,
			title: title,
		});
	}

	override async onWillAppear(ev: WillAppearEvent<DialSettings>): Promise<void> {
		const { command, pressCommand } = ev.payload.settings;
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

		// Subscribe to press command updates if different from main command
		if (pressCommand && pressCommand !== command) {
			unsubs.push(
				mgr.onCommandUpdate(host, pressCommand, (rawValue) => {
					this.pressState.set(actionId, rawValue);
					const mainValue = mgr.getCachedValue(host, command);
					if (mainValue) this.updateFeedback(ev, command, mainValue);
				}),
			);
			mgr.queryCommand(host, pressCommand)
				.then((val) => {
					this.pressState.set(actionId, val);
				})
				.catch((err) => logger.debug(`Press command query failed: ${err}`));
		}

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
		this.pressState.delete(ev.action.id);
	}

	override async onDialRotate(ev: DialRotateEvent<DialSettings>): Promise<void> {
		const { command } = ev.payload.settings;
		const upParam = resolveParam(ev.payload.settings.upParam, ev.payload.settings.customUpParam, "UP");
		const downParam = resolveParam(ev.payload.settings.downParam, ev.payload.settings.customDownParam, "DOWN");

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
		const pressParam = resolveParam(ev.payload.settings.pressParam, ev.payload.settings.customPressParam);

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
