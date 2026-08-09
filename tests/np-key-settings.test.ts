/**
 * What a Now Playing key's settings resolve to.
 *
 * Two things worth pinning here. The **defaults**, because they changed: a key that
 * has never been configured now shows the cover rather than covering it up, and that
 * has to be true for keys placed before the change as well as after. And the **text
 * rule**, because it is the one piece of state the key keeps — a mode, a deadline and a
 * press override that interact, extracted so they can be exercised without a deck.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NowPlaying } from "../src/adapter/eiscp/now-playing.ts";
import { DEFAULT_SCRIM, MAX_SCRIM } from "../src/actions/cover-image.ts";
import {
	DEFAULT_TEXT_SECONDS,
	faceLogKey,
	glyphFor,
	glyphModeFor,
	MAX_TEXT_SECONDS,
	MIN_TEXT_SECONDS,
	pressActionFor,
	progressStyleFor,
	scrimFor,
	textIsVisible,
	textModeFor,
	textSecondsFor,
} from "../src/actions/np-key-settings.ts";

const withArt: NowPlaying = {
	track: "Cruel Summer",
	timeDisplay: "elapsed-total",
	playStatus: "play",
	art: { type: "jpeg", bytes: Buffer.alloc(64, 0x41), frames: 1, hash: "h" },
};
const withoutArt: NowPlaying = { track: "Cruel Summer", timeDisplay: "elapsed-total", playStatus: "play" };

describe("what an unconfigured Now Playing key does", () => {
	it("shows the cover, the progress ring and nothing else", () => {
		assert.equal(glyphModeFor(undefined), "auto");
		assert.equal(glyphFor(undefined, withArt), undefined, "no glyph over a cover");
		assert.equal(textModeFor(undefined), "onChange");
		assert.equal(progressStyleFor(undefined), "ring");
		assert.equal(pressActionFor(undefined), "playPause");
		assert.equal(scrimFor(undefined), DEFAULT_SCRIM);
		assert.equal(textSecondsFor(undefined), DEFAULT_TEXT_SECONDS);
	});

	it("does the same for a key that only ever had a device picked", () => {
		// Every setting is optional, and most keys carry nothing but a deviceIp.
		assert.equal(glyphModeFor({ deviceIp: "10.0.0.1" }), "auto");
		assert.equal(progressStyleFor({ deviceIp: "10.0.0.1" }), "ring");
	});
});

describe("the glyph, now that it has to earn its place", () => {
	it("appears when there is no cover, because the key would be a dark square", () => {
		assert.equal(glyphFor({}, withoutArt), "play");
		assert.equal(glyphFor({}, undefined), "play");
	});

	it("appears over a cover only when the receiver says playback stopped", () => {
		// A cover cannot say "paused" on its own; that is the one thing worth covering it
		// up for.
		assert.equal(glyphFor({}, { ...withArt, playStatus: "pause" }), "play");
		assert.equal(glyphFor({}, { ...withArt, playStatus: "stop" }), "play");
		assert.equal(glyphFor({}, { ...withArt, playStatus: "play" }), undefined);
	});

	it("draws nothing when the play status is unknown", () => {
		// Guessing would put the glyph back over every cover — which is the whole
		// complaint. Silence is the safe direction here.
		assert.equal(glyphFor({}, { ...withArt, playStatus: undefined }), undefined);
		assert.equal(glyphFor({}, { ...withArt, playStatus: "ff" }), undefined);
	});

	it("obeys an explicit choice over anything it might infer", () => {
		assert.equal(glyphFor({ glyphMode: "always" }, withArt), "play");
		assert.equal(glyphFor({ glyphMode: "never" }, withoutArt), undefined);
		assert.equal(glyphFor({ glyphMode: "never" }, { ...withArt, playStatus: "pause" }), undefined);
	});
});

describe("keys placed before any of this existed", () => {
	it("keeps a switched-off glyph switched off", () => {
		// `showGlyph: false` was somebody deciding; that decision still holds.
		assert.equal(glyphModeFor({ showGlyph: false }), "never");
		assert.equal(glyphFor({ showGlyph: false }, withoutArt), undefined);
	});

	it("does not read the old default as a decision", () => {
		// `showGlyph: true` was also what the panel showed by default, so it cannot be
		// told apart from "never touched". Reading it as "always" would leave every
		// existing key exactly as covered up as before.
		assert.equal(glyphModeFor({ showGlyph: true }), "auto");
		assert.equal(glyphFor({ showGlyph: true }, withArt), undefined);
	});

	it("lets a new choice win over the old one", () => {
		assert.equal(glyphModeFor({ showGlyph: false, glyphMode: "always" }), "always");
		assert.equal(glyphModeFor({ showGlyph: true, glyphMode: "never" }), "never");
	});
});

describe("resolving the rest", () => {
	it("clamps the seconds instead of passing nonsense to a timer", () => {
		// Settings outlive plugin versions and are user input; a NaN here becomes
		// setTimeout(NaN), which fires at once — the text would flicker, not show.
		assert.equal(textSecondsFor({ textSeconds: 12 }), 12);
		assert.equal(textSecondsFor({ textSeconds: 0 }), MIN_TEXT_SECONDS);
		assert.equal(textSecondsFor({ textSeconds: 9999 }), MAX_TEXT_SECONDS);
		assert.equal(textSecondsFor({ textSeconds: 4.6 }), 5, "rounded, not truncated");
		for (const bad of [Number.NaN, undefined, Number.POSITIVE_INFINITY]) {
			assert.equal(textSecondsFor({ textSeconds: bad }), DEFAULT_TEXT_SECONDS, `${bad}`);
		}
	});

	it("clamps the scrim to what the panel offers", () => {
		assert.equal(scrimFor({ scrimOpacity: 0.2 }), 0.2);
		assert.equal(scrimFor({ scrimOpacity: 5 }), MAX_SCRIM);
		assert.equal(scrimFor({ scrimOpacity: -3 }), 0);
		assert.equal(scrimFor({ scrimOpacity: Number.NaN }), DEFAULT_SCRIM);
	});

	it("turns the progress off only when asked, and never returns a bogus shape", () => {
		assert.equal(progressStyleFor({ progressStyle: "off" }), undefined);
		assert.equal(progressStyleFor({ progressStyle: "bar" }), "bar");
		assert.equal(progressStyleFor({ progressStyle: "ring" }), "ring");
		assert.equal(progressStyleFor({ progressStyle: "spiral" as never }), "ring", "an unknown value is not off");
	});

	it("keeps play/pause unless the key was made a text switch", () => {
		assert.equal(pressActionFor({ pressAction: "toggleText" }), "toggleText");
		assert.equal(pressActionFor({ pressAction: "playPause" }), "playPause");
		assert.equal(pressActionFor({ pressAction: "somethingElse" as never }), "playPause");
	});

	it("falls back to onChange for a mode it does not recognise", () => {
		assert.equal(textModeFor({ textMode: "always" }), "always");
		assert.equal(textModeFor({ textMode: "never" }), "never");
		assert.equal(textModeFor({ textMode: "sometimes" as never }), "onChange");
	});
});

describe("whether the track text is on screen", () => {
	it("follows the clock in onChange, and only there", () => {
		assert.equal(textIsVisible("onChange", { until: 1_000 }, 999), true);
		assert.equal(textIsVisible("onChange", { until: 1_000 }, 1_000), false, "the boundary is exclusive");
		assert.equal(textIsVisible("onChange", {}, 999), false, "no window means nothing has changed yet");
	});

	it("ignores the clock in the other two modes", () => {
		// An expired window must not turn "always" off, and an open one must not turn
		// "never" on — the clock is only ever armed in onChange, but a mode change while
		// one is running must not leak.
		assert.equal(textIsVisible("always", { until: 0 }, 5_000), true);
		assert.equal(textIsVisible("never", { until: 10_000 }, 5_000), false);
	});

	it("lets a press override whatever the mode would have said", () => {
		for (const mode of ["always", "never", "onChange"] as const) {
			assert.equal(textIsVisible(mode, { pinned: true, until: 0 }, 5_000), true, `${mode} pinned on`);
			assert.equal(textIsVisible(mode, { pinned: false, until: 10_000 }, 5_000), false, `${mode} pinned off`);
		}
	});

	it("returns to the mode once the press override is cleared", () => {
		// Clearing is what a track change does, so this is the difference between "the
		// user muted the text for this song" and "for good".
		assert.equal(textIsVisible("onChange", { pinned: false, until: 10_000 }, 5_000), false);
		assert.equal(textIsVisible("onChange", { until: 10_000 }, 5_000), true);
	});
});

describe("what reaches the log, and what must not", () => {
	// The key repaints once a second. Everything it records is keyed on this, so what
	// the key leaves out is the load-bearing part.
	const cover = (hash: string): NowPlaying["art"] => ({ type: "jpeg", bytes: Buffer.alloc(8), frames: 1, hash });
	const base: NowPlaying = { timeDisplay: "elapsed-total", elapsed: 10, total: 200, art: cover("a1b2") };

	it("says nothing new while only the clock moves", () => {
		// The whole point. A key of this shape ticking for a five-minute track would
		// otherwise write 300 lines, and the log would be useless for the fault it is
		// meant to explain.
		const first = faceLogKey(base, "ring", 0.45);
		for (const elapsed of [11, 12, 60, 199]) {
			const ticked: NowPlaying = { ...base, elapsed };
			assert.equal(faceLogKey(ticked, "ring", 0.45), first, `elapsed=${elapsed}`);
		}
	});

	it("speaks up when the cover changes", () => {
		assert.notEqual(faceLogKey({ ...base, art: cover("c3d4") }, "ring", 0.45), faceLogKey(base, "ring", 0.45));
		assert.notEqual(faceLogKey({ ...base, art: undefined }, "ring", 0.45), faceLogKey(base, "ring", 0.45));
	});

	it("speaks up when the receiver changes its mind about the time", () => {
		// "Why is there no ring" is the report this answers, so it cannot be silent.
		assert.notEqual(faceLogKey({ ...base, timeDisplay: "off" }, "ring", 0.45), faceLogKey(base, "ring", 0.45));
	});

	it("speaks up when the drawing itself was reconfigured", () => {
		assert.notEqual(faceLogKey(base, "bar", 0.45), faceLogKey(base, "ring", 0.45));
		assert.notEqual(faceLogKey(base, undefined, 0.45), faceLogKey(base, "ring", 0.45));
		assert.notEqual(faceLogKey(base, "ring", 0.2), faceLogKey(base, "ring", 0.45));
	});
});
