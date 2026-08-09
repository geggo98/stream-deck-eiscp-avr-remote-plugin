/**
 * NowPlayingDialAction — an encoder that shows what is playing, permanently.
 *
 * The counterpart to the short track-change display: that one interrupts a dial's own
 * face for a few seconds, this one *is* the dial's face — cover as a darkened backdrop,
 * title, artist, elapsed/total and a progress bar. Turning or pressing it briefly shows
 * what that did (the volume bar, the input it selected) and then goes back.
 *
 * ## Why it always has a command
 *
 * Every other dial returns `undefined` from `getDialConfig` when nothing is configured,
 * and `bind` then stops before it draws anything. That is right for them and wrong here:
 * this dial's job is the display, and a display that waits for a command to be picked
 * would be blank for the one thing it exists to do. So rotate and press are *pre-filled*
 * with volume and mute — what a dial on a receiver is for — and remain freely
 * changeable, exactly like the generic eISCP Dial.
 *
 * ## Where the pieces live
 *
 * Almost nothing here is new. `buildNowPlayingFace` (`strip-panel.ts`) turns the
 * receiver's state into layout items, `DialActionBase.standingFace` is the hook that
 * puts them on the strip ahead of any track-change display, and the cover composition
 * is shared and cached with every other element showing the same art. What this file
 * owns is the two decisions that are its own: what counts as "just now" after a turn,
 * and whether the cover survives it.
 */

import {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DidReceiveSettingsEvent,
	type FeedbackPayload,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import { COMMAND_REGISTRY } from "../adapter/eiscp/command-registry.ts";
import { ConnectionManager } from "../adapter/eiscp/connection-manager.ts";
import { getNowPlayingTracker } from "../adapter/eiscp/now-playing.ts";
import { uuidFor } from "./dedicated/catalog.ts";
import { DialActionBase, type DialConfig } from "./eiscp-action-base.ts";
import { formatCommandValue } from "./eiscp-base.ts";
import type { CropFocus } from "./face-crop.ts";
import {
	keepFacesWhole,
	npDialConfig,
	readoutEnabled,
	readoutKeepsCover,
	readoutSeconds,
	scrimFor,
	type NowPlayingDialSettings,
} from "./np-dial-settings.ts";
import { buildNowPlayingFace, type PanelFace } from "./strip-panel.ts";

/** Bar colours, matching the dedicated volume dial so the two look alike side by side. */
const BAR_COLOR = "#4CAF50";
const BAR_PRESSED_COLOR = "#F44336";
/** Registry fallback for a stepper with no curated range, as in the generic indicator dial. */
const DEFAULT_MAX_VALUE = 24;

@action({ UUID: uuidFor("now-playing-dial") })
export class NowPlayingDialAction extends DialActionBase<NowPlayingDialSettings> {
	/**
	 * Settings per action, because `standingFace` is called from the render path.
	 *
	 * `getSettings()` is not an option: it is a WebSocket round trip whose reply also
	 * reaches this action's own handler, so asking for settings mid-render would
	 * re-enter `onDidReceiveSettings` and re-bind.
	 */
	private readonly settingsById = new Map<string, NowPlayingDialSettings>();
	/** When each dial's action readout expires; absent means the track is showing. */
	private readonly readoutUntil = new Map<string, number>();
	private readonly readoutTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** `bind`'s repaint closure, so a readout that starts or expires can redraw. */
	private readonly repaints = new Map<string, () => void>();
	/** The last crop decision written to the log, so a 1 Hz repaint writes nothing. */
	private readonly loggedFocus = new Map<string, string>();

	constructor() {
		super("NowPlayingDial");
	}

	/** Always on the panel layout: it is the only one with the items this dial draws into. */
	protected override wantsPanelLayout(): boolean {
		return true;
	}

	protected getDialConfig(settings: NowPlayingDialSettings): DialConfig {
		return npDialConfig(settings);
	}

	/**
	 * The dial's own face — what a turn or a press produced.
	 *
	 * Only ever seen inside the readout window; the rest of the time `standingFace`
	 * takes the whole segment. Deliberately the same shapes the other dials use, so a
	 * Now Playing dial and a Volume dial next to it read the same while both are showing
	 * a volume.
	 */
	protected buildFeedback(
		cfg: DialConfig,
		rawValue: string,
		_settings: NowPlayingDialSettings,
		pressOn: boolean,
	): FeedbackPayload {
		const cmd = COMMAND_REGISTRY[cfg.command];
		const pressDef = cfg.pressCommand ? COMMAND_REGISTRY[cfg.pressCommand] : undefined;
		const title = pressOn && pressDef ? pressDef.name.toUpperCase() : (cmd?.description?.split(" ")[0] ?? cfg.command);

		if (cmd?.actionType === "stepper") {
			const num = parseInt(rawValue, 16);
			const max = cmd.maxValue || DEFAULT_MAX_VALUE;
			const percent = Math.round(((Number.isNaN(num) ? 0 : num) / max) * 100);
			return {
				value: Number.isNaN(num) ? rawValue : `${num}`,
				title,
				indicator: { value: Math.min(percent, 100), bar_fill_c: pressOn ? BAR_PRESSED_COLOR : BAR_COLOR },
			};
		}
		return { value: formatCommandValue(cfg.command, rawValue), title, indicator: { value: 0, enabled: false } };
	}

	/**
	 * What is playing, unless the dial was just touched.
	 *
	 * Returning `undefined` hands the segment back to `buildFeedback`, and there are
	 * three ways to get there, all of them wanted:
	 *
	 *   - **The receiver is not on.** Nothing plays in standby and nothing is knowable
	 *     while it is unreachable, so the ordinary face takes over — and with it the
	 *     dimming and the `Offline` title, which a panel face has nowhere to put.
	 *   - **Nothing is playing.** Radio, a menu, a receiver that just woke: no track and
	 *     no art. A dial that went black for that would look broken.
	 *   - **The readout is up and is not to keep the cover**, or there is no cover to keep.
	 */
	protected override standingFace(action: DialAction<NowPlayingDialSettings>): PanelFace | undefined {
		if (this.statusFor(action.id) !== "on") return undefined;
		const host = this.hostFor(action.id);
		if (!host) return undefined;
		const settings = this.settingsById.get(action.id);
		const readout = this.readoutIsUp(action.id);
		if (readout && !readoutKeepsCover(settings)) return undefined;
		const face = buildNowPlayingFace(getNowPlayingTracker().get(host), {
			scrimOpacity: scrimFor(settings),
			...(readout ? { actionReadout: true } : {}),
			...(keepFacesWhole(settings) ? { keepFacesWhole: true } : {}),
		});
		if (face?.focus) this.noteFocus(action.id, host, face.focus);
		return face;
	}

	/**
	 * Record where the crop ended up, once per cover rather than once per repaint.
	 *
	 * This dial repaints every second, so anything written per render would bury the very
	 * line it is meant to explain. The decision only changes with the picture, so keying
	 * on the decision itself is the same as keying on the track — without having to know
	 * which track it is.
	 *
	 * It earns its keep on somebody else's machine: "the cover sits oddly on my strip" is
	 * otherwise unanswerable, and this says in one line whether anything was found, whether
	 * it moved, and whether it had to give something up.
	 */
	private noteFocus(actionId: string, host: string, focus: CropFocus): void {
		const line = `${host}: cover crop ${focus.y.toFixed(2)} (${focus.reason}, ${focus.regions} region(s), ${focus.cut} cut)`;
		if (this.loggedFocus.get(actionId) === line) return;
		this.loggedFocus.set(actionId, line);
		this.logger.info(line);
	}

	/**
	 * Subscribe to the metadata after the normal bind has wired everything else.
	 *
	 * Every update, including the once-a-second time tick: that tick *is* the progress
	 * bar. It costs one small payload — the cover is de-duplicated in `sendFeedback`, so
	 * a second that changes nothing but the clock does not re-send 173 KB of picture.
	 */
	protected override bindExtras(
		action: DialAction<NowPlayingDialSettings>,
		cfg: DialConfig,
		settings: NowPlayingDialSettings,
		host: string,
		repaint: () => void,
	): void {
		this.settingsById.set(action.id, settings);
		this.repaints.set(action.id, repaint);

		const tracker = getNowPlayingTracker();
		this.trackSub(action.id, tracker.onUpdate(host, repaint));
		// None of the metadata commands is volunteered on connect, only on a track
		// change, so without this the dial would show nothing until the song ends.
		void tracker.prime(host);

		// Extends a readout that is already up; never starts one. A value arriving from
		// the receiver is not evidence the user did anything — it may be the infrared
		// remote — and interrupting the track display for someone else's volume change
		// was explicitly not wanted. What it does buy is the case where the echo of a
		// long turn arrives after the window would have closed.
		this.trackSub(
			action.id,
			ConnectionManager.getInstance().onCommandUpdate(host, cfg.command, () => {
				if (this.readoutIsUp(action.id)) this.showActionReadout(action.id, this.settingsById.get(action.id));
			}),
		);
	}

	/**
	 * Drop what belongs to the *previous* bind before a new one starts.
	 *
	 * `bindExtras` only runs when a bind gets all the way through, and a bind that stops
	 * early — the device IP was cleared, so it prints "No IP" and returns — used to leave
	 * the old closure in this map. A turn then armed the readout, the stale closure
	 * repainted the *previous* receiver's cached volume, and the strip showed a
	 * confident, working-looking face for a dial that is not connected to anything.
	 *
	 * Both overrides go through here because they are the only two ways into `bind`.
	 */
	private forgetBinding(actionId: string): void {
		this.repaints.delete(actionId);
		this.clearReadout(actionId);
	}

	override async onWillAppear(ev: WillAppearEvent<NowPlayingDialSettings>): Promise<void> {
		this.forgetBinding(ev.action.id);
		await super.onWillAppear(ev);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<NowPlayingDialSettings>): Promise<void> {
		this.forgetBinding(ev.action.id);
		await super.onDidReceiveSettings(ev);
	}

	override async onDialRotate(ev: DialRotateEvent<NowPlayingDialSettings>): Promise<void> {
		this.settingsById.set(ev.action.id, ev.payload.settings);
		this.showActionReadout(ev.action.id, ev.payload.settings);
		await super.onDialRotate(ev);
	}

	override async onDialDown(ev: DialDownEvent<NowPlayingDialSettings>): Promise<void> {
		this.settingsById.set(ev.action.id, ev.payload.settings);
		this.showActionReadout(ev.action.id, ev.payload.settings);
		await super.onDialDown(ev);
	}

	override async onWillDisappear(ev: WillDisappearEvent<NowPlayingDialSettings>): Promise<void> {
		await super.onWillDisappear(ev);
		this.clearReadout(ev.action.id);
		this.settingsById.delete(ev.action.id);
		this.repaints.delete(ev.action.id);
		this.loggedFocus.delete(ev.action.id);
	}

	/**
	 * Put the action readout up, or push its expiry back if it is already there.
	 *
	 * Repaints immediately rather than waiting for the receiver's echo: the point of the
	 * readout is that it appears when the dial is touched, and the value it will settle
	 * on arrives a moment later through the ordinary render path.
	 */
	private showActionReadout(actionId: string, settings: NowPlayingDialSettings | undefined): void {
		if (!readoutEnabled(settings)) return;
		const ms = readoutSeconds(settings) * 1000;
		this.readoutUntil.set(actionId, Date.now() + ms);
		const previous = this.readoutTimers.get(actionId);
		if (previous) clearTimeout(previous);
		const timer = setTimeout(() => {
			this.readoutTimers.delete(actionId);
			this.readoutUntil.delete(actionId);
			this.repaints.get(actionId)?.();
		}, ms);
		// The plugin must not be held open by a display that will be redrawn anyway.
		timer.unref?.();
		this.readoutTimers.set(actionId, timer);
		this.repaints.get(actionId)?.();
	}

	private readoutIsUp(actionId: string): boolean {
		const until = this.readoutUntil.get(actionId);
		if (until === undefined) return false;
		// Checked against the clock as well as the timer: a render can happen between the
		// expiry and the callback, and showing a stale bar for one frame is exactly the
		// class of bug the standing display is meant to end.
		if (Date.now() >= until) {
			this.readoutUntil.delete(actionId);
			return false;
		}
		return true;
	}

	private clearReadout(actionId: string): void {
		const timer = this.readoutTimers.get(actionId);
		if (timer) clearTimeout(timer);
		this.readoutTimers.delete(actionId);
		this.readoutUntil.delete(actionId);
	}

}
