/**
 * Shared base classes for eISCP actions.
 *
 * These capture the lifecycle that every action repeats: subscribe to live
 * state, query the initial value, render, and tear the subscription down. Both
 * the generic configurable actions (eiscp-button/toggle/dial/dial-indicator)
 * and the pre-built dedicated actions (Power, Mute, Volume, ...) extend them.
 *
 * Each concrete action supplies its behavior through a `get*Config()` hook:
 * generic actions read it from the user's settings, dedicated actions return a
 * fixed literal and ignore settings.
 */

import {
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type SendToPluginEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
	streamDeck,
} from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { ConnectionManager } from "../adapter/eiscp/connection-manager.ts";
import { COMMAND_REGISTRY } from "../adapter/eiscp/command-registry.ts";
import { handleDeviceListMessage } from "./pi-devices.ts";
import {
	type EiscpActionSettings,
	fireAndLog,
	nextToggleValue,
	resolveDeviceIp,
	formatCommandValue,
	generateColoredBg,
	getToggleColor,
	UNCONFIGURED_TITLE,
} from "./eiscp-base.ts";

/** Behavior for a two-state on/off command (power, mute, ...). */
export interface ToggleConfig {
	command: string;
	onValue: string;
	offValue: string;
	/** If the command supports a hardware toggle (TG), prefer it over a soft flip. */
	toggleValue?: string;
}

/** Behavior for a one-shot key (transport key, prev/next cycler, up/down step). */
export interface KeyConfig {
	command: string;
	/** Optional so a generic button can show live state before a value is picked. */
	parameter?: string;
}

/** Behavior for an encoder (volume, input cycle, ...). */
export interface DialConfig {
	command: string;
	upParam: string;
	downParam: string;
	/** Optional secondary command sent on press, e.g. AMT to mute. */
	pressCommand?: string;
	pressParam?: string;
	/** Raw value of pressCommand that means "on" (defaults to its registry onValue, then "01"). */
	pressOnValue?: string;
	/** Title shown while the press command reads on (e.g. "MUTED"); falls back to "ON". */
	pressLabel?: string;
}

/** Common plumbing: scoped logger + per-action subscription bookkeeping. */
abstract class EiscpActionBase<TSettings extends EiscpActionSettings> extends SingletonAction<TSettings> {
	protected readonly logger: ReturnType<typeof streamDeck.logger.createScope>;
	private readonly subs = new Map<string, (() => void)[]>();

	// Explicit scope string (class names are mangled by terser in release builds).
	constructor(scope: string) {
		super();
		this.logger = streamDeck.logger.createScope(scope);
	}

	protected trackSub(actionId: string, unsub: () => void): void {
		const arr = this.subs.get(actionId) ?? [];
		arr.push(unsub);
		this.subs.set(actionId, arr);
	}

	protected clearSubs(actionId: string): void {
		this.subs.get(actionId)?.forEach((u) => u());
		this.subs.delete(actionId);
	}

	override async onWillDisappear(ev: WillDisappearEvent<TSettings>): Promise<void> {
		this.clearSubs(ev.action.id);
	}

	/**
	 * Answer the PI's Device IP data-source request. Every action's PI shows the
	 * device dropdown, so it lives on the shared base; subclasses that override
	 * onSendToPlugin (e.g. the learned-name cyclers) must call super.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, TSettings>): Promise<void> {
		await handleDeviceListMessage(ev);
	}
}

// ---------------------------------------------------------------------------

export abstract class ToggleActionBase<TSettings extends EiscpActionSettings> extends EiscpActionBase<TSettings> {
	/** Set false on dedicated toggles that ship distinct on/off State images. */
	protected coloredBackground = true;
	/** Whether to overlay the current value as the key title. */
	protected showTitle = true;

	protected abstract getToggleConfig(settings: TSettings): ToggleConfig | undefined;

	protected render(action: KeyAction<TSettings>, cfg: ToggleConfig, rawValue: string): void {
		const isOn = rawValue === cfg.onValue;
		this.logger.debug(`render ${cfg.command}: ${rawValue} -> isOn=${isOn}`);
		fireAndLog(action.setState(isOn ? 1 : 0), this.logger, "setState");
		if (this.coloredBackground) {
			fireAndLog(action.setImage(generateColoredBg(getToggleColor(cfg.command, isOn))), this.logger, "setImage");
		}
		if (this.showTitle) {
			fireAndLog(action.setTitle(formatCommandValue(cfg.command, rawValue)), this.logger, "setTitle");
		}
	}

	override async onWillAppear(ev: WillAppearEvent<TSettings>): Promise<void> {
		const cfg = this.getToggleConfig(ev.payload.settings);
		if (!cfg) {
			this.logger.warn("onWillAppear: no command configured, skipping");
			return;
		}
		if (!ev.action.isKey()) return;
		const action = ev.action;
		// Stream Deck may re-fire onWillAppear without an intervening
		// onWillDisappear (profile switch, reconnect); drop stale subs first.
		this.clearSubs(action.id);
		const host = resolveDeviceIp(ev.payload.settings);
		if (!host) {
			this.logger.warn("onWillAppear: no device IP configured");
			if (this.showTitle) await action.setTitle(UNCONFIGURED_TITLE);
			return;
		}
		const mgr = ConnectionManager.getInstance();

		this.trackSub(
			action.id,
			mgr.onCommandUpdate(host, cfg.command, (raw) => this.render(action, cfg, raw)),
		);

		try {
			const value = await mgr.queryCommand(host, cfg.command);
			this.render(action, cfg, value);
		} catch (err) {
			this.logger.error(`onWillAppear: query ${cfg.command} on ${host} failed: ${err}`);
			// Degrade visibly instead of showing a stale/empty key.
			if (this.showTitle) await action.setTitle("?");
		}
	}

	override async onKeyDown(ev: KeyDownEvent<TSettings>): Promise<void> {
		const cfg = this.getToggleConfig(ev.payload.settings);
		if (!cfg) {
			await ev.action.showAlert();
			return;
		}
		const host = resolveDeviceIp(ev.payload.settings);
		if (!host) {
			this.logger.warn("onKeyDown: no device IP configured");
			await ev.action.showAlert();
			return;
		}
		const mgr = ConnectionManager.getInstance();
		try {
			if (cfg.toggleValue) {
				await mgr.sendCommand(host, cfg.command, cfg.toggleValue);
			} else {
				// Soft flip needs the real current state. With a cold cache,
				// blindly assuming "off" would send onValue and report success
				// for a command that may not even be deliverable — query first.
				let current = mgr.getCachedValue(host, cfg.command);
				if (current === undefined) {
					current = await mgr.queryCommand(host, cfg.command);
				}
				await mgr.sendCommand(host, cfg.command, nextToggleValue(current, cfg));
			}
			await ev.action.showOk();
		} catch (err) {
			this.logger.error(`onKeyDown: toggle ${cfg.command} on ${host} failed: ${err}`);
			await ev.action.showAlert();
		}
	}
}

// ---------------------------------------------------------------------------

export abstract class KeyActionBase<TSettings extends EiscpActionSettings> extends EiscpActionBase<TSettings> {
	/**
	 * Whether the key reflects live state as its title. Cyclers (Next Input)
	 * benefit from it; fire-and-forget keys (transport) have no queryable state.
	 */
	protected showsState = true;

	protected abstract getKeyConfig(settings: TSettings): KeyConfig | undefined;

	protected render(action: KeyAction<TSettings>, cfg: KeyConfig, rawValue: string): void {
		if (this.showsState) fireAndLog(action.setTitle(formatCommandValue(cfg.command, rawValue)), this.logger, "setTitle");
	}

	override async onWillAppear(ev: WillAppearEvent<TSettings>): Promise<void> {
		const cfg = this.getKeyConfig(ev.payload.settings);
		if (!cfg) {
			this.logger.warn("onWillAppear: no command configured");
			if (ev.action.isKey()) await ev.action.setTitle("?");
			return;
		}
		if (!this.showsState || !ev.action.isKey()) return;
		const action = ev.action;
		this.clearSubs(action.id); // drop stale subs on a repeated onWillAppear
		const host = resolveDeviceIp(ev.payload.settings);
		if (!host) {
			this.logger.warn("onWillAppear: no device IP configured");
			await action.setTitle(UNCONFIGURED_TITLE);
			return;
		}
		const mgr = ConnectionManager.getInstance();

		this.trackSub(
			action.id,
			mgr.onCommandUpdate(host, cfg.command, (raw) => this.render(action, cfg, raw)),
		);
		try {
			const value = await mgr.queryCommand(host, cfg.command);
			this.render(action, cfg, value);
		} catch (err) {
			this.logger.error(`onWillAppear: query ${cfg.command} failed: ${err}`);
			await action.setTitle(cfg.command);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<TSettings>): Promise<void> {
		const cfg = this.getKeyConfig(ev.payload.settings);
		if (!cfg || !cfg.parameter) {
			this.logger.warn("onKeyDown: missing command/parameter");
			await ev.action.showAlert();
			return;
		}
		const host = resolveDeviceIp(ev.payload.settings);
		if (!host) {
			this.logger.warn("onKeyDown: no device IP configured");
			await ev.action.showAlert();
			return;
		}
		const mgr = ConnectionManager.getInstance();
		try {
			await mgr.sendCommand(host, cfg.command, cfg.parameter);
			await ev.action.showOk();
		} catch (err) {
			this.logger.error(`onKeyDown: ${cfg.command} ${cfg.parameter} failed: ${err}`);
			await ev.action.showAlert();
		}
	}
}

// ---------------------------------------------------------------------------

export abstract class DialActionBase<TSettings extends EiscpActionSettings> extends EiscpActionBase<TSettings> {
	private readonly pressState = new Map<string, string>();

	protected abstract getDialConfig(settings: TSettings): DialConfig | undefined;

	/** Render the touch-strip feedback. Implemented per layout ($A1 text vs $B1 bar). */
	protected abstract updateFeedback(
		action: DialAction<TSettings>,
		cfg: DialConfig,
		rawValue: string,
		settings: TSettings,
		pressOn: boolean,
	): void;

	protected isPressOn(actionId: string, cfg: DialConfig): boolean {
		const pressCmd = cfg.pressCommand;
		if (!pressCmd || pressCmd === cfg.command) return false;
		const raw = this.pressState.get(actionId);
		if (!raw) return false;
		const def = COMMAND_REGISTRY[pressCmd];
		const registryOn = def?.actionType === "toggle" ? def.onValue : undefined;
		return raw === (cfg.pressOnValue ?? registryOn ?? "01");
	}

	/**
	 * Extra commands that should ALSO trigger a re-render of the touch strip,
	 * re-using the cached value of `cfg.command`. Used by learned-name dials that
	 * must redraw when an "FLD" name-learning event arrives even though the
	 * SLI/LMD value itself did not change. Defaults to none.
	 */
	protected extraRerenderCommands(_cfg: DialConfig): string[] {
		return [];
	}

	override async onWillAppear(ev: WillAppearEvent<TSettings>): Promise<void> {
		if (ev.action.isDial()) await this.bind(ev.action, ev.payload.settings);
	}

	/**
	 * Re-bind when settings change in the PI (e.g. the press action was switched):
	 * the SDK does not re-fire onWillAppear, so re-subscribe to the (possibly new)
	 * press command and re-render. onDialDown already reads fresh settings.
	 */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TSettings>): Promise<void> {
		if (ev.action.isDial()) await this.bind(ev.action, ev.payload.settings);
	}

	/** Wire up live subscriptions and render the initial value. Idempotent. */
	private async bind(action: DialAction<TSettings>, settings: TSettings): Promise<void> {
		const cfg = this.getDialConfig(settings);
		if (!cfg) {
			this.logger.warn("bind: no command configured, skipping");
			return;
		}
		const host = resolveDeviceIp(settings);
		const actionId = action.id;
		// Drop stale subs/press-state on a repeated bind (no disappear).
		this.clearSubs(actionId);
		this.pressState.delete(actionId);
		if (!host) {
			this.logger.warn("bind: no device IP configured");
			await action.setFeedback({ title: UNCONFIGURED_TITLE, value: "" });
			return;
		}
		const mgr = ConnectionManager.getInstance();

		const rerender = (raw: string) =>
			this.updateFeedback(action, cfg, raw, settings, this.isPressOn(actionId, cfg));

		this.trackSub(actionId, mgr.onCommandUpdate(host, cfg.command, rerender));

		// Learned-name dials redraw when an FLD name event arrives, even though the
		// main SLI/LMD value is unchanged — re-render from the cached main value.
		for (const extra of this.extraRerenderCommands(cfg)) {
			if (extra === cfg.command || extra === cfg.pressCommand) continue;
			this.trackSub(
				actionId,
				mgr.onCommandUpdate(host, extra, () => {
					const mainValue = mgr.getCachedValue(host, cfg.command);
					if (mainValue) rerender(mainValue);
				}),
			);
		}

		if (cfg.pressCommand && cfg.pressCommand !== cfg.command) {
			this.trackSub(
				actionId,
				mgr.onCommandUpdate(host, cfg.pressCommand, (raw) => {
					this.pressState.set(actionId, raw);
					const mainValue = mgr.getCachedValue(host, cfg.command);
					if (mainValue) rerender(mainValue);
				}),
			);
			mgr.queryCommand(host, cfg.pressCommand)
				.then((val) => this.pressState.set(actionId, val))
				.catch((err) => this.logger.warn(`press query ${cfg.pressCommand} on ${host} failed: ${err}`));
		}

		try {
			const value = await mgr.queryCommand(host, cfg.command);
			rerender(value);
		} catch (err) {
			this.logger.error(`bind: query ${cfg.command} on ${host} failed: ${err}`);
			// Degrade visibly; the next live update overwrites this.
			await action.setFeedback({ title: "?", value: "" });
		}
	}

	override async onWillDisappear(ev: WillDisappearEvent<TSettings>): Promise<void> {
		await super.onWillDisappear(ev);
		this.pressState.delete(ev.action.id);
	}

	override async onDialRotate(ev: DialRotateEvent<TSettings>): Promise<void> {
		const cfg = this.getDialConfig(ev.payload.settings);
		if (!cfg) return;
		const host = resolveDeviceIp(ev.payload.settings);
		if (!host) {
			await ev.action.showAlert();
			return;
		}
		const mgr = ConnectionManager.getInstance();
		const ticks = ev.payload.ticks;
		const param = ticks > 0 ? cfg.upParam : cfg.downParam;
		const count = Math.abs(ticks);
		try {
			for (let i = 0; i < count; i++) {
				await mgr.sendCommand(host, cfg.command, param);
			}
		} catch (err) {
			this.logger.error(`onDialRotate: ${cfg.command} ${param} on ${host} failed: ${err}`);
			// showAlert works on dials too (only showOk is keypad-only).
			await ev.action.showAlert();
		}
	}

	override async onDialDown(ev: DialDownEvent<TSettings>): Promise<void> {
		const cfg = this.getDialConfig(ev.payload.settings);
		if (!cfg) return;
		const pressCommand = cfg.pressCommand ?? cfg.command;
		const pressParam = cfg.pressParam;
		if (!pressParam) {
			this.logger.warn(`onDialDown: no press parameter for ${pressCommand}, ignoring`);
			return;
		}
		const host = resolveDeviceIp(ev.payload.settings);
		if (!host) {
			await ev.action.showAlert();
			return;
		}
		const mgr = ConnectionManager.getInstance();
		try {
			await mgr.sendCommand(host, pressCommand, pressParam);
		} catch (err) {
			this.logger.error(`onDialDown: ${pressCommand} ${pressParam} on ${host} failed: ${err}`);
			await ev.action.showAlert();
		}
	}
}
