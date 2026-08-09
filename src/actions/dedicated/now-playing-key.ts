/**
 * A key that shows what is playing: the cover art as the picture, the track and artist
 * as the title, and how far through it is as a ring around the edge.
 *
 * Built on `KeyActionBase` rather than beside it, so it inherits the parts that took
 * measuring to get right — device-IP adoption, bind generations, the standby/offline
 * decoration, and wake-on-press. What it replaces is only the *picture and title*,
 * which it does by overriding the two paint funnels; the de-duplication in
 * `writeKeyImage` still applies, so a ~173 KB composed cover is not re-sent for an
 * update that did not change it.
 *
 * The command it is configured with (`NTC P/P`) has no readable value, hence
 * `showsState: false` in the catalog: the display comes from the metadata tracker,
 * not from a command's state.
 *
 * ## Getting out of the cover's way
 *
 * The decorations used to be unconditional, and between them they left very little of
 * the artwork visible. Now each has to earn its place: the glyph appears only when
 * there is no cover or the receiver says playback stopped (`glyphFor`), and the text
 * appears for a few seconds after a track change and then goes away again
 * (`textIsVisible`). Both are switchable; what changed is the default.
 *
 * ## Why it no longer joins the shared track-change display
 *
 * `watchTrackChanges` is deliberately inert here. The generic short display would paint
 * a *different* face over this key for a few seconds — no progress, its own rule about
 * the glyph — which reads as a fault rather than a feature on the one key that already
 * shows the track. Its Property Inspector hides the setting for the same reason.
 */

import { action, type KeyAction, type KeyDownEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { getNowPlayingTracker, type NowPlaying } from "../../adapter/eiscp/now-playing.ts";
import { composePlaceholder } from "../cover-image.ts";
import { KeyActionBase, type KeyConfig } from "../eiscp-action-base.ts";
import { resolveDeviceIp } from "../eiscp-base.ts";
import { lumaGrid } from "../image-luma.ts";
import {
	glyphFor,
	faceLogKey,
	glyphModeFor,
	type NowPlayingKeySettings,
	pressActionFor,
	progressStyleFor,
	scrimFor,
	textIsVisible,
	textModeFor,
	textSecondsFor,
	type TextWindow,
} from "../np-key-settings.ts";
import { chooseProgressColour } from "../progress-colour.ts";
import { buildOverlayFace, overlayProgress } from "../track-overlay.ts";
import { SPEC_BY_ID, uuidFor } from "./catalog.ts";

const SPEC = SPEC_BY_ID["now-playing"];

@action({ UUID: uuidFor("now-playing") })
export class NowPlayingKeyAction extends KeyActionBase<NowPlayingKeySettings> {
	/** The settings each instance bound with, so the paint overrides can read options. */
	private readonly settingsById = new Map<string, NowPlayingKeySettings>();
	/** When each instance's track text is due to disappear, and whether a press pinned it. */
	private readonly windows = new Map<string, TextWindow>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	/**
	 * What was last written to the log for each instance, so nothing repeats.
	 *
	 * This key repaints once a second and none of that may reach the log. Everything it
	 * records is therefore keyed on a *change*: the configuration it bound with, and the
	 * picture-and-time situation it is drawing from. A fault on someone else's machine
	 * has to be readable from the log, and a log full of ticks is not readable at all.
	 */
	private readonly loggedBind = new Map<string, string>();
	private readonly loggedFace = new Map<string, string>();

	constructor() {
		super("NowPlayingKey");
		// Taken from the spec rather than typed again, because typing it again is
		// exactly what went wrong: the catalog said `showsState: false` and this class
		// silently kept the base default of `true`, so every bind queried `NTC QSTN` —
		// a command that has no QSTN — and sat through a 5 s timeout before showing
		// anything. Visible in the log as
		// "bindKey: query NTC failed: … timed out after 5000 ms".
		this.showsState = SPEC.showsState;
	}

	protected override getKeyConfig(settings: NowPlayingKeySettings): KeyConfig | undefined {
		void settings;
		return { command: SPEC.command, parameter: SPEC.parameter };
	}

	/**
	 * The shared short track-change display, switched off for this key.
	 *
	 * Not merely redundant: it paints a different face, so a user who turned it on for
	 * their other keys would see this one flicker into a stripped-down version of itself
	 * once per track.
	 */
	protected override watchTrackChanges(): void {}

	/**
	 * Subscribe to metadata after the normal bind.
	 *
	 * Deliberately after `super.bindKey`: that is what calls `clearSubs`, so a
	 * subscription added before it would be dropped on every re-bind.
	 */
	protected override async bindKey(
		action: KeyAction<NowPlayingKeySettings>,
		rawSettings: NowPlayingKeySettings,
	): Promise<NowPlayingKeySettings> {
		const settings = await super.bindKey(action, rawSettings);
		const host = resolveDeviceIp(settings);
		if (!host) return settings;

		const tracker = getNowPlayingTracker();
		this.trackSub(
			action.id,
			// Every change, including the once-a-second time tick: unlike the short
			// track-change display this key is *meant* to keep up. The image is
			// de-duplicated and the progress is rounded to a step the eye can tell apart,
			// so most ticks cost nothing at all.
			tracker.onUpdate(host, () => this.repaint(action, settings)),
		);
		this.trackSub(
			action.id,
			tracker.onTrackChange(host, () => {
				this.openTextWindow(action, settings);
				this.repaint(action, settings);
			}),
		);
		// None of these commands is volunteered on connect — only on a track change —
		// so without this the key would stay blank until the song ends.
		void tracker.prime(host);
		// A bind opens the window too. `onTrackChange` never fires for the first track it
		// sees (by design: a display that flashed on every connect would be worse), so a
		// freshly placed key would otherwise show a cover and nothing else — and since
		// every Property Inspector change is a re-bind, this is also what lets someone
		// see the setting they just changed.
		this.openTextWindow(action, settings);
		this.noteBind(action.id, settings, host);
		this.repaint(action, settings);
		return settings;
	}

	/**
	 * Record the configuration this key is running on, when it changes.
	 *
	 * On a machine nobody can look at, every later line about this key is unreadable
	 * without it — "no glyph" means one thing at `auto` and something else at `never`.
	 * Only on a change, because dragging a slider in the Property Inspector is a stream
	 * of re-binds and each one would otherwise be a line.
	 */
	private noteBind(actionId: string, settings: NowPlayingKeySettings, host: string): void {
		const line =
			`${host}: glyph=${glyphModeFor(settings)} text=${textModeFor(settings)}/${textSecondsFor(settings)}s ` +
			`progress=${progressStyleFor(settings) ?? "off"} press=${pressActionFor(settings)} scrim=${scrimFor(settings)}`;
		if (this.loggedBind.get(actionId) === line) return;
		this.loggedBind.set(actionId, line);
		this.logger.info(line);
	}

	private repaint(action: KeyAction<NowPlayingKeySettings>, settings: NowPlayingKeySettings): void {
		this.settingsById.set(action.id, settings);
		const cfg = this.getKeyConfig(settings);
		this.paintKeyImage(action, cfg?.command, [0]);
		this.paintKeyTitle(action, undefined);
		this.noteFace(action.id, settings);
	}

	/**
	 * Record what the key has to work with, whenever that changes.
	 *
	 * The two questions a report about this key always comes down to — "why is there no
	 * ring" and "why is the ring that colour" — are both answered here, and neither can
	 * be answered from anywhere else afterwards. Keyed on the cover, the receiver's
	 * statement about the time and the settings that affect the drawing; **not** on the
	 * elapsed value, so a ticking clock writes nothing.
	 */
	private noteFace(actionId: string, settings: NowPlayingKeySettings): void {
		const host = this.hostFor(actionId);
		const state = this.stateFor(actionId);
		if (!host || !state) return;
		const shape = progressStyleFor(settings);
		const scrim = scrimFor(settings);
		const key = faceLogKey(state, shape, scrim);
		if (this.loggedFace.get(actionId) === key) return;
		this.loggedFace.set(actionId, key);

		const cover = state.art
			? `cover ${state.art.bytes.length} B (${state.art.hash})`
			: "no cover, drawing the placeholder";
		let progress: string;
		if (!shape) {
			progress = "progress off";
		} else if (overlayProgress(state) === undefined) {
			// By far the most common "the ring is missing" report: the receiver says its
			// time readout means nothing, so there is deliberately nothing to draw.
			progress = `no ${shape}: the receiver reports timeDisplay=${state.timeDisplay}`;
		} else {
			const choice = chooseProgressColour(state.art ? lumaGrid(state.art) : undefined, shape, scrim);
			const band =
				choice.bandMean === undefined
					? "no readable cover"
					: `band ${choice.bandMean.toFixed(3)} → ${choice.bandOnScreen!.toFixed(3)} at scrim ${scrim}`;
			progress = `${shape} ${choice.colour} (${band})`;
		}
		this.logger.info(`${host}: ${cover}, ${progress}`);
	}

	/** Start (or restart) the "just changed" window and drop any press override. */
	private openTextWindow(action: KeyAction<NowPlayingKeySettings>, settings: NowPlayingKeySettings): void {
		const ms = textSecondsFor(settings) * 1000;
		this.windows.set(action.id, { until: Date.now() + ms });
		// Debug, not info: this is once per track and the track change itself is already
		// recorded by the tracker, so at info it would be a second line saying the same.
		this.logger.debug(`track info shown for ${ms} ms`);
		this.armTimer(action, settings, ms);
	}

	/**
	 * Repaint once the window closes.
	 *
	 * Only in `onChange`: the other two modes ignore the clock entirely, so a timer
	 * there would be a repaint that changes nothing. `unref` so a pending one never
	 * holds the process open.
	 */
	private armTimer(action: KeyAction<NowPlayingKeySettings>, settings: NowPlayingKeySettings, ms: number): void {
		clearTimeout(this.timers.get(action.id));
		this.timers.delete(action.id);
		if (textModeFor(settings) !== "onChange") return;
		const timer = setTimeout(() => {
			this.timers.delete(action.id);
			const window = this.windows.get(action.id);
			// A press override expires with the window it was granted for; without this a
			// press would hide or show the text until the next track change, which is a
			// long time on an album track.
			if (window) this.windows.set(action.id, { until: window.until });
			this.logger.debug("track info hidden again");
			this.repaint(action, settings);
		}, ms);
		timer.unref?.();
		this.timers.set(action.id, timer);
	}

	private textVisible(actionId: string, settings = this.settingsById.get(actionId)): boolean {
		return textIsVisible(textModeFor(settings), this.windows.get(actionId) ?? {}, Date.now());
	}

	private faceFor(actionId: string): { image: string; keyTitle: string } | undefined {
		const settings = this.settingsById.get(actionId);
		const state = this.stateFor(actionId);
		if (!state) return undefined;
		const glyph = glyphFor(settings, state);
		const face = buildOverlayFace(state, {
			glyph,
			scrimOpacity: scrimFor(settings),
			progressStyle: progressStyleFor(settings),
		});
		if (face?.image) return { image: face.image, keyTitle: face.keyTitle };
		// Nothing playing yet: say so with the placeholder rather than leaving the
		// manifest icon, which looks like the key never bound.
		return { image: composePlaceholder({ glyph: glyph ?? "music" }), keyTitle: "" };
	}

	private stateFor(actionId: string): NowPlaying | undefined {
		const host = this.hostFor(actionId);
		return host ? getNowPlayingTracker().get(host) : undefined;
	}

	protected override paintKeyImage(
		action: KeyAction<NowPlayingKeySettings>,
		command: string | undefined,
		states: readonly (0 | 1)[],
	): void {
		const face = this.faceFor(action.id);
		if (!face) {
			super.paintKeyImage(action, command, states);
			return;
		}
		// A cover is not dimmed for standby: nothing plays in standby, so the placeholder
		// is what shows there, and the title still carries "Offline" when unreachable.
		for (const state of states) this.writeKeyImage(action, face.image, state);
	}

	protected override paintKeyTitle(action: KeyAction<NowPlayingKeySettings>, base: string | undefined): void {
		const face = this.faceFor(action.id);
		// An empty string rather than `base`, so hiding the track does not hand the key
		// back to whatever it would otherwise have said. `super` still applies the
		// status decoration on top, which is what keeps "Offline" visible with the
		// track text switched off.
		const text = face ? (this.textVisible(action.id) ? face.keyTitle : "") : base;
		super.paintKeyTitle(action, text);
	}

	override async onKeyDown(ev: KeyDownEvent<NowPlayingKeySettings>): Promise<void> {
		// The bound settings when there are any: those are the ones `syncDeviceMemory` may
		// have completed with an adopted device IP. The event's copy is the fallback for a
		// press that somehow beats the bind.
		const settings = this.settingsById.get(ev.action.id) ?? ev.payload.settings;
		if (pressActionFor(settings) !== "toggleText") {
			// Scoped to this key rather than added to `KeyActionBase`, where it would
			// apply to every action in the plugin. The base logs a press only when it
			// fails, so without this a working press and a press that never arrived look
			// identical in a log.
			this.logger.info(`press: ${SPEC.command} ${SPEC.parameter}`);
			await super.onKeyDown(ev);
			return;
		}
		if (!ev.action.isKey()) return;
		// Nothing is sent: this press is a way to read the title, not to control the
		// receiver. No `showOk` either — the key repainting is the acknowledgement, and a
		// checkmark would be claiming the receiver did something.
		const showing = this.textVisible(ev.action.id, settings);
		const window = this.windows.get(ev.action.id) ?? {};
		this.windows.set(ev.action.id, { ...window, pinned: !showing });
		if (!showing) this.armTimer(ev.action, settings, textSecondsFor(settings) * 1000);
		// A press is human-paced, so one line each is not spam — and it is the only
		// evidence that a press did anything at all, since this path deliberately sends
		// nothing to the receiver.
		this.logger.info(`press: track info ${showing ? "hidden" : "shown"} (nothing sent)`);
		this.repaint(ev.action, settings);
	}

	override async onWillDisappear(ev: WillDisappearEvent<NowPlayingKeySettings>): Promise<void> {
		clearTimeout(this.timers.get(ev.action.id));
		this.timers.delete(ev.action.id);
		this.windows.delete(ev.action.id);
		this.settingsById.delete(ev.action.id);
		this.loggedBind.delete(ev.action.id);
		this.loggedFace.delete(ev.action.id);
		await super.onWillDisappear(ev);
	}
}
