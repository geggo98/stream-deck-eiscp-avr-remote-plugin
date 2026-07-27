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
import type { FeedbackPayload } from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";
import { ConnectionManager } from "../adapter/eiscp/connection-manager.ts";
import { COMMAND_REGISTRY } from "../adapter/eiscp/command-registry.ts";
import { getDeviceStatusTracker, type DeviceStatus } from "../adapter/eiscp/device-status.ts";
import { getNowPlayingTracker } from "../adapter/eiscp/now-playing.ts";
import { BindCoordinator, REBIND_DEBOUNCE_MS } from "./bind-coordinator.ts";
import { STRIP_HEIGHT, STRIP_SEGMENT_WIDTH } from "./cover-image.ts";
import {
	buildOverlayFace,
	overlayIsActive,
	trackOverlayEnabled,
	trackOverlaySeconds,
	type OverlayFace,
	type OverlayFaceOptions,
} from "./track-overlay.ts";
import { handleDeviceListMessage, rememberDevice } from "./pi-devices.ts";
import { handleWakeSettingMessage } from "./pi-wake.ts";
import {
	deviceIpToAdopt,
	dialIconFor,
	type EiscpActionSettings,
	explicitDeviceIp,
	feedbackStatusStyle,
	fireAndLog,
	forgetActionSettings,
	getCachedGlobalSettings,
	keyImageFor,
	nextToggleValue,
	pressIsSwallowed,
	wakeOnPressEnabled,
	readLastDevice,
	rememberActionSettings,
	resolveDeviceIp,
	formatCommandValue,
	generateColoredBg,
	getToggleColor,
	statusTitle,
	UNCONFIGURED_TITLE,
	waitForGlobalSettings,
} from "./eiscp-base.ts";

/**
 * How long to wait for the receiver's own `PWR01` after waking it. Measured at
 * ~1 s on a VSX-S520D; the unit also needs a moment before it accepts the next
 * command, which this wait doubles as.
 */
const WAKE_TIMEOUT_MS = 3000;

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
	/** Receiver each action is currently bound to, so a render can ask for its status. */
	private readonly hosts = new Map<string, string>();
	/**
	 * Last image written per action and state, so an unchanged one is not re-sent.
	 *
	 * Renders run on every value update — turning a volume dial writes a title per
	 * tick — and the status image is the same for all of them. Skipping the repeats
	 * keeps a rotation from also sending a `setImage` frame per tick.
	 */
	private readonly paintedImages = new Map<string, string>();
	/**
	 * The short "what just started playing" face, per action, while it is up.
	 *
	 * Held as state rather than written directly, because the display must be a
	 * *function of the current state inside the normal render* rather than a second
	 * writer. Two stuck-title regressions in this repo (`3e0b685`) came from a
	 * separate write path that needed its own clearing path; here an expired overlay
	 * cannot leave anything behind, because the next render simply stops finding one.
	 */
	private readonly overlays = new Map<string, { face: OverlayFace; until: number }>();
	private readonly overlayTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
		// Called exactly once at the start of every bind funnel, which makes it the
		// one place that knows a fresh paint is about to happen: forget what was
		// last drawn, so an appear after a profile switch (where Stream Deck resets
		// the key to its manifest image) always writes rather than being skipped as
		// unchanged.
		this.forgetPaintedImages(actionId);
		return this.binds.nextGeneration(actionId);
	}

	private forgetPaintedImages(actionId: string): void {
		for (const state of [0, 1]) this.paintedImages.delete(`${actionId}:${state}`);
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

	/**
	 * Follow the receiver's power/reachability state for as long as this action is
	 * bound to `host`, re-painting whenever it changes.
	 *
	 * `repaint` must render from what is already known (the ConnectionManager's
	 * cache) rather than query: a status change is not a value change, and a
	 * receiver that just went offline would only make the query time out.
	 */
	protected watchStatus(actionId: string, host: string, repaint: () => void): void {
		this.hosts.set(actionId, host);
		this.trackSub(
			actionId,
			getDeviceStatusTracker().onStatus(host, () => repaint()),
		);
	}

	/** The receiver this action is bound to, if it has bound to one yet. */
	protected hostFor(actionId: string): string | undefined {
		return this.hosts.get(actionId);
	}

	/** Current status of the receiver this action is bound to. */
	protected statusFor(actionId: string): DeviceStatus {
		const host = this.hosts.get(actionId);
		return host ? getDeviceStatusTracker().getStatus(host) : "unknown";
	}

	/**
	 * Show the now-playing metadata briefly when the track changes, if this action
	 * is configured to.
	 *
	 * Called from the bind funnels next to `watchStatus`, and it subscribes **only**
	 * when enabled: the tracker treats a subscription as the declaration of interest,
	 * and during a cover transfer the receiver pushes ~1 800 frames per second. Off
	 * means genuinely free.
	 *
	 * `repaint` is the same closure `watchStatus` uses — it re-renders from the
	 * ConnectionManager's cache — so the fall-back at the end of the window goes
	 * through the ordinary path and cannot leave a stale face behind.
	 */
	protected watchTrackChanges(
		actionId: string,
		host: string,
		settings: TSettings,
		repaint: () => void,
		faceOptions: OverlayFaceOptions = {},
	): void {
		if (!trackOverlayEnabled(settings)) return;
		const tracker = getNowPlayingTracker();
		const seconds = trackOverlaySeconds(settings);

		this.trackSub(
			actionId,
			tracker.onTrackChange(host, (state) => {
				const face = buildOverlayFace(state, faceOptions);
				// Nothing worth showing: leave the element's own content alone rather
				// than hiding it behind an empty box.
				if (!face) return;
				this.overlays.set(actionId, { face, until: Date.now() + seconds * 1000 });
				this.armOverlayTimer(actionId, seconds * 1000, repaint);
				repaint();
			}),
		);
		// A pre-fill so the very first change has a track title and a cover to show;
		// failures are ignored (see NowPlayingTracker.prime).
		void tracker.prime(host);
	}

	private armOverlayTimer(actionId: string, ms: number, repaint: () => void): void {
		clearTimeout(this.overlayTimers.get(actionId));
		const timer = setTimeout(() => {
			this.overlayTimers.delete(actionId);
			this.overlays.delete(actionId);
			repaint();
		}, ms);
		timer.unref?.();
		this.overlayTimers.set(actionId, timer);
	}

	/**
	 * The overlay face to draw instead of this action's own, or `undefined`.
	 *
	 * **Status beats metadata.** An unreachable receiver must still say `Offline`, and
	 * nothing is playing in standby, so the overlay only applies while the receiver is
	 * actually on. Checked here rather than at trigger time so a receiver that goes
	 * away mid-overlay stops showing it immediately.
	 */
	protected overlayFace(actionId: string): OverlayFace | undefined {
		const active = this.overlays.get(actionId);
		if (!active) return undefined;
		const now = Date.now();
		// Expired: drop it so a later render need not re-check the clock.
		if (now >= active.until) {
			this.overlays.delete(actionId);
			return undefined;
		}
		return overlayIsActive(active.until, now, this.statusFor(actionId)) ? active.face : undefined;
	}

	private clearOverlay(actionId: string): void {
		clearTimeout(this.overlayTimers.get(actionId));
		this.overlayTimers.delete(actionId);
		this.overlays.delete(actionId);
	}

	/**
	 * Power the receiver on if this command would otherwise be slept through.
	 *
	 * A receiver in standby drops most sets without a word (measured; see
	 * `STANDBY_HONOURED_COMMANDS`), so the press would look successful and do
	 * nothing. Waking first is what the user asked the key to do — switchable off
	 * in the Property Inspector for anyone who does not want a key press to power
	 * up their amplifier.
	 *
	 * Deliberately best-effort: a failed or slow wake still lets the command
	 * through, so this never becomes a new way for a press to be swallowed.
	 */
	protected async wakeIfNeeded(host: string, command: string): Promise<void> {
		const tracker = getDeviceStatusTracker();
		if (!pressIsSwallowed(tracker.getStatus(host), command)) return;
		if (!wakeOnPressEnabled()) return;
		this.logger.debug(`waking ${host} before ${command}`);
		try {
			await ConnectionManager.getInstance().sendCommand(host, "PWR", "01");
		} catch (err) {
			this.logger.warn(`wake before ${command} failed: ${err}`);
			return;
		}
		// The receiver announces the change itself; the tracker turns that frame into
		// a status, so this waits for the device rather than for a fixed delay.
		if (!(await tracker.waitForStatus(host, "on", WAKE_TIMEOUT_MS))) {
			this.logger.warn(`${host} did not confirm power-on within ${WAKE_TIMEOUT_MS} ms; sending anyway`);
		}
	}

	/**
	 * Press feedback that does not lie: the checkmark means "the receiver acted on
	 * it", not "the write succeeded". With waking switched off, a set sent into
	 * standby is dropped silently, and `showOk` used to claim otherwise.
	 */
	protected reportPress(action: KeyAction<TSettings> | DialAction<TSettings>, command: string): void {
		const swallowed = pressIsSwallowed(this.statusFor(action.id), command);
		if (swallowed) {
			this.logger.info(`${command} was sent while the receiver is in standby; it will be ignored`);
			fireAndLog(action.showAlert(), this.logger, "showAlert");
			return;
		}
		// showOk is keypad-only.
		if (action.isKey()) fireAndLog(action.showOk(), this.logger, "showOk");
	}

	/**
	 * Paint a key's status image. `state` matters for two-state actions: the state
	 * that is not currently shown can become visible without another render, so
	 * both have to be written.
	 */
	protected paintKeyImage(action: KeyAction<TSettings>, command: string | undefined, states: readonly (0 | 1)[]): void {
		const status = this.statusFor(action.id);
		const overlay = this.overlayFace(action.id);
		for (const state of states) {
			// While the short track-change display is up it replaces the picture for
			// every state, so switching state underneath it cannot reveal the normal one.
			const image = overlay ? overlay.image : keyImageFor(this.manifestId, status, command, state);
			this.writeKeyImage(action, image, state);
		}
	}

	/**
	 * Write one key image, skipping an unchanged one.
	 *
	 * Separate from `paintKeyImage` so subclasses that compute their own picture (the
	 * now-playing key composes a cover) get the same de-duplication. Renders run on
	 * every value update, and a ~173 KB composed cover re-sent per update would be
	 * expensive for nothing.
	 */
	protected writeKeyImage(action: KeyAction<TSettings>, image: string | undefined, state: 0 | 1): void {
		const key = `${action.id}:${state}`;
		// "" stands for the manifest image, so "no image yet" and "back to the
		// manifest image" are distinguishable.
		if (this.paintedImages.get(key) === (image ?? "")) return;
		this.paintedImages.set(key, image ?? "");
		// undefined restores the manifest image, i.e. the normal, lit look.
		fireAndLog(action.setImage(image, { state }), this.logger, "setImage");
	}

	/** A key's title, with the "Offline" decoration applied. */
	protected paintKeyTitle(action: KeyAction<TSettings>, base: string | undefined): void {
		const overlay = this.overlayFace(action.id);
		const text = overlay ? overlay.keyTitle : statusTitle(base, this.statusFor(action.id));
		fireAndLog(action.setTitle(text), this.logger, "setTitle");
	}

	override async onWillDisappear(ev: WillDisappearEvent<TSettings>): Promise<void> {
		this.clearSubs(ev.action.id);
		// Invalidate pending binds and cancel a queued re-bind.
		this.binds.invalidate(ev.action.id);
		forgetActionSettings(ev.action.id);
		this.hosts.delete(ev.action.id);
		this.forgetPaintedImages(ev.action.id);
		this.clearOverlay(ev.action.id);
	}

	/**
	 * Answer the PI's Device IP data-source request. Every action's PI shows the
	 * device dropdown, so it lives on the shared base; subclasses that override
	 * onSendToPlugin (e.g. the learned-name cyclers) must call super.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, TSettings>): Promise<void> {
		if (await handleWakeSettingMessage(ev)) return;
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
		this.paintToggleImage(action, cfg, isOn);
		// A title-less toggle (Power/Mute) passes undefined, which restores the
		// user's own title — and clears a degraded one. statusTitle still gets to
		// overrule it with "Offline".
		this.paintKeyTitle(action, this.showTitle ? formatCommandValue(cfg.command, rawValue) : undefined);
	}

	/**
	 * The key's picture, in whichever of the two styles this toggle uses: a flat
	 * colour generated here, or the two State images from the manifest.
	 */
	private paintToggleImage(action: KeyAction<TSettings>, cfg: ToggleConfig, isOn: boolean): void {
		const status = this.statusFor(action.id);
		// The coloured-background branch writes setImage itself, so it has to ask about
		// the overlay too; paintKeyImage already does.
		if (this.overlayFace(action.id)) {
			this.paintKeyImage(action, cfg.command, [0, 1]);
			return;
		}
		if (this.coloredBackground) {
			const color = getToggleColor(cfg.command, isOn);
			fireAndLog(action.setImage(generateColoredBg(color, status, cfg.command)), this.logger, "setImage");
			return;
		}
		// Both states: Stream Deck keeps a per-state image, and the state we are not
		// showing right now becomes visible on the next value change without a
		// render of its own.
		this.paintKeyImage(action, cfg.command, [0, 1]);
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
		// Re-paint on a power/reachability change, from the cached value: the status
		// changed, the value did not, and querying an offline receiver only stalls.
		const repaint = (): void => {
			const cached = mgr.getCachedValue(host, cfg.command);
			if (cached !== undefined) this.render(action, cfg, cached);
			else this.renderWithoutValue(action, cfg);
		};
		this.watchStatus(action.id, host, repaint);
		// Same closure for the short track-change display, so its fall-back goes
		// through the ordinary render rather than a second writer.
		this.watchTrackChanges(action.id, host, settings, repaint);

		try {
			const value = await mgr.queryCommand(host, cfg.command);
			if (!fresh()) return; // a newer bind owns the key now
			this.render(action, cfg, value);
		} catch (err) {
			this.logger.error(`bindKey: query ${cfg.command} on ${host} failed: ${err}`);
			if (!fresh()) return;
			// Degrade visibly instead of showing a stale/empty key; render()
			// restores the configured title on the next successful update.
			this.renderWithoutValue(action, cfg);
		}
	}

	/**
	 * The key when its value is unknown — the initial query failed, or a status
	 * change arrived before any value did. Shows the state decoration and a "?"
	 * where a value would be, so the key never looks like a working one.
	 */
	private renderWithoutValue(action: KeyAction<TSettings>, cfg: ToggleConfig): void {
		if (!this.coloredBackground) this.paintKeyImage(action, cfg.command, [0, 1]);
		this.paintKeyTitle(action, "?");
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
			await this.wakeIfNeeded(host, cfg.command);
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
			this.reportPress(ev.action, cfg.command);
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

	/**
	 * Title for a key that shows no live state. `undefined` means "the user's own
	 * title"; the transport key overrides this with its function's label.
	 */
	protected statelessTitle(_settings: TSettings): string | undefined {
		return undefined;
	}

	protected render(action: KeyAction<TSettings>, cfg: KeyConfig, rawValue: string): void {
		this.paintKeyImage(action, cfg.command, [0]);
		if (this.showsState) this.paintKeyTitle(action, formatCommandValue(cfg.command, rawValue));
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
			// No value to show, but the receiver's state still applies: a transport
			// key or a tone stepper is just as useless in standby as any other.
			// Painting through the same helper also clears a lingering "No IP".
			const paint = (): void => {
				this.paintKeyImage(action, cfg.command, [0]);
				this.paintKeyTitle(action, this.statelessTitle(settings));
			};
			this.watchStatus(action.id, host, paint);
			this.watchTrackChanges(action.id, host, settings, paint);
			paint();
			return settings;
		}
		const mgr = ConnectionManager.getInstance();

		this.trackSub(
			action.id,
			mgr.onCommandUpdate(host, cfg.command, (raw) => this.render(action, cfg, raw)),
		);
		// See ToggleActionBase.bindKey: re-paint from the cache, never re-query.
		const repaint = (): void => {
			const cached = mgr.getCachedValue(host, cfg.command);
			if (cached !== undefined) this.render(action, cfg, cached);
			else this.renderWithoutValue(action, cfg);
		};
		this.watchStatus(action.id, host, repaint);
		this.watchTrackChanges(action.id, host, settings, repaint);
		try {
			const value = await mgr.queryCommand(host, cfg.command);
			if (!fresh()) return settings; // a newer bind owns the key now
			this.render(action, cfg, value);
		} catch (err) {
			this.logger.error(`bindKey: query ${cfg.command} failed: ${err}`);
			if (!fresh()) return settings;
			this.renderWithoutValue(action, cfg);
		}
		return settings;
	}

	/** The key with its value unknown; the command name is the honest placeholder. */
	private renderWithoutValue(action: KeyAction<TSettings>, cfg: KeyConfig): void {
		this.paintKeyImage(action, cfg.command, [0]);
		this.paintKeyTitle(action, cfg.command);
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
			await this.wakeIfNeeded(host, cfg.command);
			await mgr.sendCommand(host, cfg.command, cfg.parameter);
			this.reportPress(ev.action, cfg.command);
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

	/**
	 * Build the touch-strip feedback. Implemented per layout ($A1 text vs $B1 bar).
	 *
	 * Returns the payload instead of sending it, so the single sender below can
	 * apply the receiver's state to every dial without five call sites having to
	 * remember to.
	 */
	protected abstract buildFeedback(
		cfg: DialConfig,
		rawValue: string,
		settings: TSettings,
		pressOn: boolean,
	): FeedbackPayload;

	/**
	 * Send a dial's feedback with the receiver's state applied.
	 *
	 * Every item gets an explicit opacity, including the normal one: the layout
	 * keeps what it was last given, so returning to normal has to be said out loud
	 * or a dimmed strip stays dimmed forever.
	 */
	protected sendFeedback(action: DialAction<TSettings>, cfg: DialConfig, payload: FeedbackPayload): void {
		const { opacity, title } = feedbackStatusStyle(this.statusFor(action.id), cfg.command);
		const overlay = this.overlayFace(action.id);
		// The short track-change display works inside whatever layout the dial already
		// has: $A1 gives icon/title/value, $B1 adds the bar. Deliberately no
		// setFeedbackLayout here — swapping layouts once per track change would flicker.
		const effective: FeedbackPayload = overlay
			? {
					...payload,
					title: overlay.primary,
					value: overlay.time ?? overlay.secondary,
					// Only touch the bar on a layout that has one ($B1), and only with the
					// value at the moment of the change: this is a snapshot, so it does not
					// creep forward while it is up.
					...(overlay.progress !== undefined && payload["indicator"] !== undefined
						? { indicator: { value: Math.round(overlay.progress * 100) } }
						: {}),
				}
			: payload;
		// The icon slot needs a value in BOTH directions, and getting that wrong is how
		// a cover stuck to the touch strip for good: a layout item keeps whatever it was
		// last given, so there is no way to *unset* the picture — writing only
		// `{ opacity }` left the previous image in place forever. The way back is to
		// write the action's own icon again.
		const iconValue = overlay?.image ?? dialIconFor(this.manifestId, this.statusFor(action.id), cfg.command);
		const decorated: FeedbackPayload = {
			// When the id cannot be resolved we leave the slot alone rather than blanking
			// it: `""` would clear the layout's own icon with no way back.
			...effective,
			icon: iconValue ? { value: iconValue, opacity } : { opacity },
		};
		for (const key of ["title", "value"] as const) {
			const item = effective[key];
			// The five implementations all pass plain strings; wrap them so the opacity
			// can ride along, and let "Offline" take over the title. An item that is
			// already an object keeps its other properties.
			const base = typeof item === "object" && item !== null ? item : typeof item === "string" ? { value: item } : {};
			const override = key === "title" && title !== undefined ? { value: title } : {};
			decorated[key] = { ...base, ...override, opacity };
		}
		const indicator = effective["indicator"];
		if (indicator !== undefined && typeof indicator === "object") {
			decorated["indicator"] = { ...indicator, opacity };
		}
		fireAndLog(action.setFeedback(decorated), this.logger, "setFeedback");
	}

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
			this.sendFeedback(action, cfg, this.buildFeedback(cfg, raw, settings, this.isPressOn(actionId, cfg)));

		this.trackSub(actionId, mgr.onCommandUpdate(host, cfg.command, rerender));
		// Power/reachability changed: redraw from the cached value (see the key bases).
		const repaint = (): void => {
			const cached = mgr.getCachedValue(host, cfg.command);
			if (cached !== undefined) rerender(cached);
			else this.sendFeedback(action, cfg, { title: "?", value: "" });
		};
		this.watchStatus(actionId, host, repaint);
		// The strip is 200x100, so the overlay composes at that size rather than at
		// the key's 144x144.
		this.watchTrackChanges(actionId, host, settings, repaint, {
			width: STRIP_SEGMENT_WIDTH,
			height: STRIP_HEIGHT,
		});

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
			this.sendFeedback(action, cfg, { title: "?", value: "" });
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
			// Once for the whole rotation, not per tick: waking takes seconds and the
			// ticks of one turn are a single user gesture.
			await this.wakeIfNeeded(host, cfg.command);
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
			await this.wakeIfNeeded(host, pressCommand);
			await mgr.sendCommand(host, pressCommand, pressParam);
			// Dials have no checkmark, but they do have the alert — so a press the
			// receiver is going to ignore still says so instead of looking fine.
			this.reportPress(ev.action, pressCommand);
		} catch (err) {
			this.logger.error(`onDialDown: ${pressCommand} ${pressParam} on ${host} failed: ${err}`);
			fireAndLog(ev.action.showAlert(), this.logger, "showAlert");
		}
	}
}
