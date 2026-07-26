/**
 * A key that shows what is playing: cover art as the picture, title and artist as
 * the title. Pressing it play/pauses.
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
 */

import { action, type KeyAction } from "@elgato/streamdeck";
import { getNowPlayingTracker, type NowPlaying } from "../../adapter/eiscp/now-playing.ts";
import { composePlaceholder, DEFAULT_SCRIM } from "../cover-image.ts";
import { KeyActionBase, type KeyConfig } from "../eiscp-action-base.ts";
import { type EiscpActionSettings, resolveDeviceIp } from "../eiscp-base.ts";
import { buildOverlayFace } from "../track-overlay.ts";
import { SPEC_BY_ID, uuidFor } from "./catalog.ts";

const SPEC = SPEC_BY_ID["now-playing"];

interface NowPlayingSettings extends EiscpActionSettings {
	/** Draw the play/pause glyph over the cover. On by default: it says it is a button. */
	showGlyph?: boolean;
	/** 0…0.8; only matters with the glyph on, which is what it makes readable. */
	scrimOpacity?: number;
}

@action({ UUID: uuidFor("now-playing") })
export class NowPlayingKeyAction extends KeyActionBase<NowPlayingSettings> {
	/** The settings each instance bound with, so the paint overrides can read options. */
	private readonly settingsById = new Map<string, NowPlayingSettings>();

	constructor() {
		super("NowPlayingKey");
	}

	protected override getKeyConfig(settings: NowPlayingSettings): KeyConfig | undefined {
		void settings;
		return { command: SPEC.command, parameter: SPEC.parameter };
	}

	/**
	 * Subscribe to metadata after the normal bind.
	 *
	 * Deliberately after `super.bindKey`: that is what calls `clearSubs`, so a
	 * subscription added before it would be dropped on every re-bind.
	 */
	protected override async bindKey(action: KeyAction<NowPlayingSettings>, rawSettings: NowPlayingSettings): Promise<NowPlayingSettings> {
		const settings = await super.bindKey(action, rawSettings);
		const host = resolveDeviceIp(settings);
		if (!host) return settings;

		const tracker = getNowPlayingTracker();
		this.trackSub(
			action.id,
			// Every change, including the once-a-second time tick: unlike the short
			// track-change display this key is *meant* to keep up. The image is
			// de-duplicated, so a tick that does not change the cover costs one title
			// write, and the title is a short string.
			tracker.onUpdate(host, () => this.repaint(action, settings)),
		);
		// None of these commands is volunteered on connect — only on a track change —
		// so without this the key would stay blank until the song ends.
		void tracker.prime(host);
		this.repaint(action, settings);
		return settings;
	}

	private repaint(action: KeyAction<NowPlayingSettings>, settings: NowPlayingSettings): void {
		this.settingsById.set(action.id, settings);
		const cfg = this.getKeyConfig(settings);
		this.paintKeyImage(action, cfg?.command, [0]);
		this.paintKeyTitle(action, undefined);
	}

	private faceFor(actionId: string): { image: string; keyTitle: string } | undefined {
		const settings = this.settingsById.get(actionId);
		const state = this.stateFor(actionId);
		if (!state) return undefined;
		const glyph = settings?.showGlyph === false ? undefined : "play";
		const scrim = typeof settings?.scrimOpacity === "number" ? settings.scrimOpacity : DEFAULT_SCRIM;
		const face = buildOverlayFace(state, { glyph, scrimOpacity: scrim });
		if (face?.image) return { image: face.image, keyTitle: face.keyTitle };
		// Nothing playing yet: say so with the placeholder rather than leaving the
		// manifest icon, which looks like the key never bound.
		return { image: composePlaceholder({ glyph: glyph ?? "music" }), keyTitle: "" };
	}

	private stateFor(actionId: string): NowPlaying | undefined {
		const host = this.hostFor(actionId);
		return host ? getNowPlayingTracker().get(host) : undefined;
	}

	protected override paintKeyImage(action: KeyAction<NowPlayingSettings>, command: string | undefined, states: readonly (0 | 1)[]): void {
		// The short track-change display, when configured, still wins — it is the same
		// content anyway, composed at the moment of the change.
		const overlay = this.overlayFace(action.id);
		if (overlay?.image) {
			for (const state of states) this.writeKeyImage(action, overlay.image, state);
			return;
		}
		const face = this.faceFor(action.id);
		if (!face) {
			super.paintKeyImage(action, command, states);
			return;
		}
		// A cover is not dimmed for standby: nothing plays in standby, so the placeholder
		// is what shows there, and the title still carries "Offline" when unreachable.
		for (const state of states) this.writeKeyImage(action, face.image, state);
	}

	protected override paintKeyTitle(action: KeyAction<NowPlayingSettings>, base: string | undefined): void {
		const face = this.faceFor(action.id);
		super.paintKeyTitle(action, face ? face.keyTitle : base);
	}
}
