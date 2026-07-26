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
import { BindCoordinator, REBIND_DEBOUNCE_MS } from "./bind-coordinator.ts";
import { handleDeviceListMessage, rememberDevice } from "./pi-devices.ts";
import {
	deviceIpToAdopt,
	type EiscpActionSettings,
	explicitDeviceIp,
	fireAndLog,
	forgetActionSettings,
	getCachedGlobalSettings,
	nextToggleValue,
	readLastDevice,
	rememberActionSettings,
	resolveDeviceIp,
	formatCommandValue,
	generateColoredBg,
	getToggleColor,
	UNCONFIGURED_TITLE,
	waitForGlobalSettings,
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
	/** Per-action bind generations + re-bind debounce (SDK-free, unit-tested). */
	private readonly binds = new BindCoordinator(REBIND_DEBOUNCE_MS);

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

	/**
	 * Start a new bind generation for this action. A bind captures the
	 * returned token and checks isCurrentBind() after every await: a stale
	 * continuation (its query outlived a newer bind triggered by a settings
	 * change) must not touch the key any more, or it would clobber the fresh
	 * bind's title/state with results from the old configuration.
	 */
	protected nextBindGeneration(actionId: string): number {
		return this.binds.nextGeneration(actionId);
	}

	protected isCurrentBind(actionId: string, generation: number): boolean {
		return this.binds.isCurrent(actionId, generation);
	}

	/**
	 * Debounced re-bind for settings changes: typing in the Custom IP field
	 * persists partial values, and re-binding each one would open TCP
	 * connections to unintended hosts. Only the last change within the
	 * debounce window binds.
	 */
	protected scheduleRebind(actionId: string, run: () => Promise<void>): void {
		this.binds.scheduleRebind(actionId, run, (err) => this.logger.error(`re-bind failed: ${err}`));
	}

	/**
	 * Keep the "last used receiver" memory and this action in step. Called first
	 * in every bind funnel, which is where both appear and settings changes land.
	 *
	 * A freshly dropped action adopts the remembered receiver into its *own*
	 * settings, so the key works right away and the PI's Device IP dropdown shows
	 * which device it talks to. Anything the user configured explicitly is left
	 * alone and instead becomes the new memory.
	 *
	 * @returns The settings to bind with — the adopted IP is returned directly
	 * rather than waited for via onDidReceiveSettings, so the key never flashes
	 * "No IP" first.
	 */
	protected async syncDeviceMemory(
		action: KeyAction<TSettings> | DialAction<TSettings>,
		settings: TSettings,
	): Promise<TSettings> {
		// Recorded before the first await: the PI can ask for the device list while
		// this bind is still waiting, and it pins the action's own selection from here.
		rememberActionSettings(action.id, settings);
		// Binds start before the initial settings load; without this wait a freshly
		// added action would decide "nothing remembered" on an empty cache and stay
		// on "No IP" until it was re-bound. Bounded, so a failed load cannot stall it.
		await waitForGlobalSettings();
		const last = readLastDevice(getCachedGlobalSettings());
		const adopt = deviceIpToAdopt(settings, last);
		if (adopt) {
			const next = { ...settings, deviceIp: adopt };
			rememberActionSettings(action.id, next);
			try {
				await action.setSettings(next);
			} catch (err) {
				// Binding with the adopted IP is still right; it just won't persist.
				this.logger.error(`could not persist the adopted device IP: ${err}`);
			}
			this.logger.debug(`adopted remembered device ${adopt}`);
			return next;
		}
		// Bootstrap only. Binds also run on every appear (profile load, deck
		// reconnect), so writing here unconditionally would leave the memory
		// pointing at whichever action happened to bind last rather than at the
		// device the user actually picked — noticeable with two receivers.
		if (!last) this.noteDevicePick(settings);
		return settings;
	}

	/**
	 * A settings change in the PI is a deliberate choice: make it the memory that
	 * freshly added actions adopt. No-op when the address is unchanged or absent.
	 */
	protected noteDevicePick(settings: TSettings): void {
		const own = explicitDeviceIp(settings);
		if (own) rememberDevice(own);
	}

	override async onWillDisappear(ev: WillDisappearEvent<TSettings>): Promise<void> {
		this.clearSubs(ev.action.id);
		// Invalidate pending binds and cancel a queued re-bind.
		this.binds.invalidate(ev.action.id);
		forgetActionSettings(ev.action.id);
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
		} else {
			// Title-less toggles (Power/Mute) may carry an error title from a
			// degraded state; restore the user's configured title.
			fireAndLog(action.setTitle(), this.logger, "setTitle");
		}
	}

	override async onWillAppear(ev: WillAppearEvent<TSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		await this.bindKey(ev.action, ev.payload.settings);
	}

	/**
	 * Settings changes (e.g. the device IP picked in the PI after the key
	 * showed "No IP") must re-run the appear wiring — the SDK does not
	 * re-fire onWillAppear, so a degraded title would otherwise stick.
	 */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		const action = ev.action;
		const settings = ev.payload.settings;
		rememberActionSettings(action.id, settings);
		this.scheduleRebind(action.id, async () => {
			this.noteDevicePick(settings);
			await this.bindKey(action, settings);
		});
	}

	private async bindKey(action: KeyAction<TSettings>, rawSettings: TSettings): Promise<void> {
		// Taken before the first await: syncDeviceMemory waits for the settings
		// load, and onWillDisappear (page/profile switch) invalidates pending binds
		// during that window. A generation taken afterwards would survive that
		// invalidation and subscribe on behalf of a key that is already gone.
		const generation = this.nextBindGeneration(action.id);
		const fresh = () => this.isCurrentBind(action.id, generation);
		const settings = await this.syncDeviceMemory(action, rawSettings);
		if (!fresh()) return;
		const cfg = this.getToggleConfig(settings);
		if (!cfg) {
			this.logger.warn("bindKey: no command configured, skipping");
			return;
		}
		// Stream Deck may re-fire onWillAppear without an intervening
		// onWillDisappear (profile switch, reconnect); drop stale subs first.
		this.clearSubs(action.id);
		const host = resolveDeviceIp(settings);
		if (!host) {
			this.logger.warn("bindKey: no device IP configured");
			// Unconditional: title-less toggles (Power/Mute) would otherwise
			// look fully functional with no IP configured at all.
			fireAndLog(action.setTitle(UNCONFIGURED_TITLE), this.logger, "setTitle");
			return;
		}
		const mgr = ConnectionManager.getInstance();

		this.trackSub(
			action.id,
			mgr.onCommandUpdate(host, cfg.command, (raw) => this.render(action, cfg, raw)),
		);

		try {
			const value = await mgr.queryCommand(host, cfg.command);
			if (!fresh()) return; // a newer bind owns the key now
			this.render(action, cfg, value);
		} catch (err) {
			this.logger.error(`bindKey: query ${cfg.command} on ${host} failed: ${err}`);
			if (!fresh()) return;
			// Degrade visibly instead of showing a stale/empty key; render()
			// restores the configured title on the next successful update.
			fireAndLog(action.setTitle("?"), this.logger, "setTitle");
		}
	}

	override async onKeyDown(ev: KeyDownEvent<TSettings>): Promise<void> {
		const cfg = this.getToggleConfig(ev.payload.settings);
		if (!cfg) {
			fireAndLog(ev.action.showAlert(), this.logger, "showAlert");
			return;
		}
		const host = resolveDeviceIp(ev.payload.settings);
		if (!host) {
			this.logger.warn("onKeyDown: no device IP configured");
			fireAndLog(ev.action.showAlert(), this.logger, "showAlert");
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
			fireAndLog(ev.action.showOk(), this.logger, "showOk");
		} catch (err) {
			this.logger.error(`onKeyDown: toggle ${cfg.command} on ${host} failed: ${err}`);
			fireAndLog(ev.action.showAlert(), this.logger, "showAlert");
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
		if (!ev.action.isKey()) return;
		await this.bindKey(ev.action, ev.payload.settings);
	}

	/** See ToggleActionBase.onDidReceiveSettings: clears stuck degraded titles. */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		const action = ev.action;
		const settings = ev.payload.settings;
		rememberActionSettings(action.id, settings);
		this.scheduleRebind(action.id, async () => {
			this.noteDevicePick(settings);
			await this.bindKey(action, settings);
		});
	}

	/**
	 * @returns The settings the key was bound with — the same object overrides
	 * must reason about, since syncDeviceMemory may have adopted an IP that the
	 * raw settings do not carry yet.
	 */
	protected async bindKey(action: KeyAction<TSettings>, rawSettings: TSettings): Promise<TSettings> {
		// See ToggleActionBase.bindKey: the generation must predate the first await.
		const generation = this.nextBindGeneration(action.id);
		const fresh = () => this.isCurrentBind(action.id, generation);
		const settings = await this.syncDeviceMemory(action, rawSettings);
		if (!fresh()) return settings;
		const cfg = this.getKeyConfig(settings);
		if (!cfg) {
			this.logger.warn("bindKey: no command configured");
			fireAndLog(action.setTitle("?"), this.logger, "setTitle");
			return settings;
		}
		this.clearSubs(action.id); // drop stale subs on a repeated bind
		const host = resolveDeviceIp(settings);
		if (!host) {
			// Even state-less keys (transport, tone steppers) must reveal a
			// missing IP; they would otherwise look functional until pressed.
			this.logger.warn("bindKey: no device IP configured");
			fireAndLog(action.setTitle(UNCONFIGURED_TITLE), this.logger, "setTitle");
			return settings;
		}
		if (!this.showsState) {
			// Clear a possible lingering "No IP" title now that an IP exists.
			fireAndLog(action.setTitle(), this.logger, "setTitle");
			return settings;
		}
		const mgr = ConnectionManager.getInstance();

		this.trackSub(
			action.id,
			mgr.onCommandUpdate(host, cfg.command, (raw) => this.render(action, cfg, raw)),
		);
		try {
			const value = await mgr.queryCommand(host, cfg.command);
			if (!fresh()) return settings; // a newer bind owns the key now
			this.render(action, cfg, value);
		} catch (err) {
			this.logger.error(`bindKey: query ${cfg.command} failed: ${err}`);
			if (!fresh()) return settings;
			fireAndLog(action.setTitle(cfg.command), this.logger, "setTitle");
		}
		return settings;
	}

	override async onKeyDown(ev: KeyDownEvent<TSettings>): Promise<void> {
		const cfg = this.getKeyConfig(ev.payload.settings);
		if (!cfg || !cfg.parameter) {
			this.logger.warn("onKeyDown: missing command/parameter");
			fireAndLog(ev.action.showAlert(), this.logger, "showAlert");
			return;
		}
		const host = resolveDeviceIp(ev.payload.settings);
		if (!host) {
			this.logger.warn("onKeyDown: no device IP configured");
			fireAndLog(ev.action.showAlert(), this.logger, "showAlert");
			return;
		}
		const mgr = ConnectionManager.getInstance();
		try {
			await mgr.sendCommand(host, cfg.command, cfg.parameter);
			fireAndLog(ev.action.showOk(), this.logger, "showOk");
		} catch (err) {
			this.logger.error(`onKeyDown: ${cfg.command} ${cfg.parameter} failed: ${err}`);
			fireAndLog(ev.action.showAlert(), this.logger, "showAlert");
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
	 * Debounced: the Custom IP textfield flushes partial values while typing.
	 */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		const action = ev.action;
		const settings = ev.payload.settings;
		rememberActionSettings(action.id, settings);
		this.scheduleRebind(action.id, async () => {
			this.noteDevicePick(settings);
			await this.bind(action, settings);
		});
	}

	/** Wire up live subscriptions and render the initial value. Idempotent. */
	private async bind(action: DialAction<TSettings>, rawSettings: TSettings): Promise<void> {
		const actionId = action.id;
		// See ToggleActionBase.bindKey: the generation must predate the first await.
		const generation = this.nextBindGeneration(actionId);
		const fresh = () => this.isCurrentBind(actionId, generation);
		const settings = await this.syncDeviceMemory(action, rawSettings);
		if (!fresh()) return;
		const cfg = this.getDialConfig(settings);
		if (!cfg) {
			this.logger.warn("bind: no command configured, skipping");
			return;
		}
		const host = resolveDeviceIp(settings);
		// Drop stale subs/press-state on a repeated bind (no disappear).
		this.clearSubs(actionId);
		this.pressState.delete(actionId);
		if (!host) {
			this.logger.warn("bind: no device IP configured");
			fireAndLog(action.setFeedback({ title: UNCONFIGURED_TITLE, value: "" }), this.logger, "setFeedback");
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
				.then((val) => {
					// A stale continuation must not seed press state for a
					// newer bind (possibly a different host/press command).
					if (fresh()) this.pressState.set(actionId, val);
				})
				.catch((err) => this.logger.warn(`press query ${cfg.pressCommand} on ${host} failed: ${err}`));
		}

		try {
			const value = await mgr.queryCommand(host, cfg.command);
			if (!fresh()) return; // a newer bind owns the dial now
			rerender(value);
		} catch (err) {
			this.logger.error(`bind: query ${cfg.command} on ${host} failed: ${err}`);
			if (!fresh()) return;
			// Degrade visibly; the next live update overwrites this.
			fireAndLog(action.setFeedback({ title: "?", value: "" }), this.logger, "setFeedback");
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
			fireAndLog(ev.action.showAlert(), this.logger, "showAlert");
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
			fireAndLog(ev.action.showAlert(), this.logger, "showAlert");
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
			fireAndLog(ev.action.showAlert(), this.logger, "showAlert");
			return;
		}
		const mgr = ConnectionManager.getInstance();
		try {
			await mgr.sendCommand(host, pressCommand, pressParam);
		} catch (err) {
			this.logger.error(`onDialDown: ${pressCommand} ${pressParam} on ${host} failed: ${err}`);
			fireAndLog(ev.action.showAlert(), this.logger, "showAlert");
		}
	}
}
