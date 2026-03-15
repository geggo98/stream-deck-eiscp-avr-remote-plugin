/**
 * EiscpToggleAction - Toggle action for on/off eISCP commands
 *
 * Use for: power, mute, direct mode, cinema filter, etc.
 * Two visual states (off/on) with automatic state tracking.
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
import { COMMAND_REGISTRY } from "../adapter/eiscp/command-registry.ts";
import { type EiscpActionSettings, resolveDeviceIp } from "./eiscp-base.ts";

interface ToggleSettings extends EiscpActionSettings {
	onValue?: string;
	offValue?: string;
}

@action({ UUID: "de.schwetschke.sd.pioneer-onkyo-remote.eiscp-toggle" })
export class EiscpToggleAction extends SingletonAction<ToggleSettings> {
	private unsubscribers: Map<string, () => void> = new Map();

	private getOnValue(settings: ToggleSettings): string {
		if (settings.onValue) return settings.onValue;
		const cmd = settings.command ? COMMAND_REGISTRY[settings.command] : undefined;
		return cmd?.onValue ?? "01";
	}

	private getOffValue(settings: ToggleSettings): string {
		if (settings.offValue) return settings.offValue;
		const cmd = settings.command ? COMMAND_REGISTRY[settings.command] : undefined;
		return cmd?.offValue ?? "00";
	}

	private isOnState(rawValue: string, settings: ToggleSettings): boolean {
		return rawValue === this.getOnValue(settings);
	}

	override async onWillAppear(ev: WillAppearEvent<ToggleSettings>): Promise<void> {
		const { command } = ev.payload.settings;
		if (!command) return;

		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();
		const actionId = ev.action.id;

		// Subscribe to command updates
		const unsub = mgr.onCommandUpdate(host, command, (rawValue) => {
			const isOn = this.isOnState(rawValue, ev.payload.settings);
			if (ev.action.isKey()) {
				ev.action.setState(isOn ? 1 : 0);
			}
		});
		this.unsubscribers.set(actionId, unsub);

		// Query current state
		try {
			const value = await mgr.queryCommand(host, command);
			const isOn = this.isOnState(value, ev.payload.settings);
			if (ev.action.isKey()) {
				await ev.action.setState(isOn ? 1 : 0);
			}
		} catch {
			// Leave in default state
		}
	}

	override async onWillDisappear(ev: WillDisappearEvent<ToggleSettings>): Promise<void> {
		const unsub = this.unsubscribers.get(ev.action.id);
		if (unsub) {
			unsub();
			this.unsubscribers.delete(ev.action.id);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<ToggleSettings>): Promise<void> {
		const { command } = ev.payload.settings;
		if (!command) {
			ev.action.showAlert();
			return;
		}

		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();
		const cmd = COMMAND_REGISTRY[command];

		try {
			// Prefer TG (toggle) command if available
			if (cmd?.toggleValue) {
				await mgr.sendCommand(host, command, cmd.toggleValue);
			} else {
				// Flip based on cached state
				const cached = mgr.getCachedValue(host, command);
				const isOn = cached === this.getOnValue(ev.payload.settings);
				const newValue = isOn
					? this.getOffValue(ev.payload.settings)
					: this.getOnValue(ev.payload.settings);
				await mgr.sendCommand(host, command, newValue);
			}
			if (ev.action.isKey()) ev.action.showOk();
		} catch (err) {
			streamDeck.logger.error(`Toggle action error: ${err}`);
			ev.action.showAlert();
		}
	}
}
