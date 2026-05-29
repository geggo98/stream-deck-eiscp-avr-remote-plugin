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
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
	streamDeck,
} from "@elgato/streamdeck";
import { ConnectionManager } from "../adapter/eiscp/connection-manager.ts";
import { COMMAND_REGISTRY } from "../adapter/eiscp/command-registry.ts";
import {
	type EiscpActionSettings,
	resolveDeviceIp,
	formatCommandValue,
	generateColoredBg,
	getToggleColor,
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
		action.setState(isOn ? 1 : 0);
		if (this.coloredBackground) {
			action.setImage(generateColoredBg(getToggleColor(cfg.command, isOn)));
		}
		if (this.showTitle) {
			action.setTitle(formatCommandValue(cfg.command, rawValue));
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
		}
	}

	override async onKeyDown(ev: KeyDownEvent<TSettings>): Promise<void> {
		const cfg = this.getToggleConfig(ev.payload.settings);
		if (!cfg) {
			ev.action.showAlert();
			return;
		}
		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();
		try {
			if (cfg.toggleValue) {
				await mgr.sendCommand(host, cfg.command, cfg.toggleValue);
			} else {
				const isOn = mgr.getCachedValue(host, cfg.command) === cfg.onValue;
				await mgr.sendCommand(host, cfg.command, isOn ? cfg.offValue : cfg.onValue);
			}
			ev.action.showOk();
		} catch (err) {
			this.logger.error(`onKeyDown: toggle ${cfg.command} failed: ${err}`);
			ev.action.showAlert();
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
		if (this.showsState) action.setTitle(formatCommandValue(cfg.command, rawValue));
	}

	override async onWillAppear(ev: WillAppearEvent<TSettings>): Promise<void> {
		const cfg = this.getKeyConfig(ev.payload.settings);
		if (!cfg) {
			this.logger.warn("onWillAppear: no command configured");
			if (ev.action.isKey()) ev.action.setTitle("?");
			return;
		}
		if (!this.showsState || !ev.action.isKey()) return;
		const action = ev.action;
		this.clearSubs(action.id); // drop stale subs on a repeated onWillAppear
		const host = resolveDeviceIp(ev.payload.settings);
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
			action.setTitle(cfg.command);
		}
	}

	override async onKeyDown(ev: KeyDownEvent<TSettings>): Promise<void> {
		const cfg = this.getKeyConfig(ev.payload.settings);
		if (!cfg || !cfg.parameter) {
			this.logger.warn("onKeyDown: missing command/parameter");
			ev.action.showAlert();
			return;
		}
		const host = resolveDeviceIp(ev.payload.settings);
		const mgr = ConnectionManager.getInstance();
		try {
			await mgr.sendCommand(host, cfg.command, cfg.parameter);
			ev.action.showOk();
		} catch (err) {
			this.logger.error(`onKeyDown: ${cfg.command} ${cfg.parameter} failed: ${err}`);
			ev.action.showAlert();
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
		return raw === (def?.onValue ?? "01");
	}

	override async onWillAppear(ev: WillAppearEvent<TSettings>): Promise<void> {
		const cfg = this.getDialConfig(ev.payload.settings);
		if (!cfg) {
			this.logger.warn("onWillAppear: no command configured, skipping");
			return;
		}
		if (!ev.action.isDial()) return;
		const action = ev.action;
		const settings = ev.payload.settings;
		const host = resolveDeviceIp(settings);
		const mgr = ConnectionManager.getInstance();
		const actionId = action.id;
		// Drop stale subs/press-state on a repeated onWillAppear (no disappear).
		this.clearSubs(actionId);
		this.pressState.delete(actionId);

		const rerender = (raw: string) =>
			this.updateFeedback(action, cfg, raw, settings, this.isPressOn(actionId, cfg));

		this.trackSub(actionId, mgr.onCommandUpdate(host, cfg.command, rerender));

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
				.catch((err) => this.logger.debug(`press query failed: ${err}`));
		}

		try {
			const value = await mgr.queryCommand(host, cfg.command);
			rerender(value);
		} catch (err) {
			this.logger.error(`onWillAppear: query ${cfg.command} failed: ${err}`);
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
		const mgr = ConnectionManager.getInstance();
		const ticks = ev.payload.ticks;
		const param = ticks > 0 ? cfg.upParam : cfg.downParam;
		const count = Math.abs(ticks);
		try {
			for (let i = 0; i < count; i++) {
				await mgr.sendCommand(host, cfg.command, param);
			}
		} catch (err) {
			this.logger.error(`onDialRotate: ${cfg.command} ${param} failed: ${err}`);
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
		const mgr = ConnectionManager.getInstance();
		try {
			await mgr.sendCommand(host, pressCommand, pressParam);
		} catch (err) {
			this.logger.error(`onDialDown: ${pressCommand} ${pressParam} failed: ${err}`);
		}
	}
}
