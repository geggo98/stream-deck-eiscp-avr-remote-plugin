/**
 * The short "what just started playing" display, as far as it can be tested without
 * a Stream Deck.
 *
 * The interception itself lives in `eiscp-action-base.ts`, which imports the SDK, so
 * tests may not reach it (importing the SDK rotates its log files as a module side
 * effect and races between parallel test processes). The two rules that decide
 * *whether* it shows — expiry and "status beats metadata" — are therefore extracted
 * into this module, together with everything about what the face looks like.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NowPlaying } from "../src/adapter/eiscp/now-playing.ts";
import {
	buildOverlayFace,
	DEFAULT_TRACK_CHANGE_SECONDS,
	formatTime,
	MAX_TRACK_CHANGE_SECONDS,
	MIN_TRACK_CHANGE_SECONDS,
	overlayIsActive,
	overlayProgress,
	trackOverlayEnabled,
	trackOverlaySeconds,
} from "../src/actions/track-overlay.ts";

/** A state shaped like the measured one: "Cruel Summer" / Taylor Swift / Lover. */
function playing(over: Partial<NowPlaying> = {}): NowPlaying {
	return {
		track: "Cruel Summer",
		artist: "Taylor Swift",
		album: "Lover",
		elapsed: 68,
		total: 221,
		playStatus: "play",
		timeDisplay: "elapsed-total",
		...over,
	};
}

function art(bytes = 512): NowPlaying["art"] {
	return { type: "jpeg", bytes: Buffer.alloc(bytes, 0x41), frames: 2 };
}

describe("track overlay settings", () => {
	it("is off unless explicitly switched on", () => {
		// It changes what an unrelated key looks like, so opting in has to be deliberate.
		assert.equal(trackOverlayEnabled(undefined), false);
		assert.equal(trackOverlayEnabled({}), false);
		assert.equal(trackOverlayEnabled({ showOnTrackChange: false }), false);
		assert.equal(trackOverlayEnabled({ showOnTrackChange: true }), true);
	});

	it("clamps the duration and survives nonsense from stored settings", () => {
		// Settings are user input and outlive plugin upgrades; a NaN here would become
		// setTimeout(NaN), which fires immediately — the display would flicker instead
		// of showing.
		assert.equal(trackOverlaySeconds(undefined), DEFAULT_TRACK_CHANGE_SECONDS);
		assert.equal(trackOverlaySeconds({}), DEFAULT_TRACK_CHANGE_SECONDS);
		assert.equal(trackOverlaySeconds({ trackChangeSeconds: 8 }), 8);
		assert.equal(trackOverlaySeconds({ trackChangeSeconds: 0 }), MIN_TRACK_CHANGE_SECONDS);
		assert.equal(trackOverlaySeconds({ trackChangeSeconds: 9999 }), MAX_TRACK_CHANGE_SECONDS);
		assert.equal(trackOverlaySeconds({ trackChangeSeconds: 4.6 }), 5, "rounded, not truncated");
		for (const bad of [Number.NaN, undefined]) {
			assert.equal(trackOverlaySeconds({ trackChangeSeconds: bad }), DEFAULT_TRACK_CHANGE_SECONDS);
		}
	});
});

describe("when the overlay shows", () => {
	it("shows until it expires, then stops", () => {
		assert.equal(overlayIsActive(1_000, 999, "on"), true);
		assert.equal(overlayIsActive(1_000, 1_000, "on"), false, "the boundary is exclusive");
		assert.equal(overlayIsActive(1_000, 5_000, "on"), false);
	});

	it("never shows when there is no overlay at all", () => {
		assert.equal(overlayIsActive(undefined, 0, "on"), false);
	});

	it("lets the receiver's status win", () => {
		// An unreachable receiver has to keep saying Offline, and nothing plays in
		// standby. Evaluated per render, so a receiver that vanishes mid-overlay stops
		// showing it at once rather than at the end of the window.
		for (const status of ["offline", "standby", "unknown"] as const) {
			assert.equal(overlayIsActive(1_000, 500, status), false, status);
		}
		assert.equal(overlayIsActive(1_000, 500, "on"), true);
	});
});

describe("progress", () => {
	it("comes from the receiver's own statement, not from the numbers being present", () => {
		// NMS field t says whether the time readout means anything. With it disabled the
		// values are meaningless and a bar drawn from them would be confidently wrong.
		assert.equal(overlayProgress(playing()), 68 / 221);
		assert.equal(overlayProgress(playing({ timeDisplay: "off" })), undefined);
		assert.equal(overlayProgress(playing({ timeDisplay: "elapsed" })), undefined, "elapsed-only has no total");
		assert.equal(overlayProgress(playing({ timeDisplay: "unknown" })), undefined);
	});

	it("refuses to divide by an unknown or zero total", () => {
		assert.equal(overlayProgress(playing({ total: undefined })), undefined);
		assert.equal(overlayProgress(playing({ elapsed: undefined })), undefined);
		assert.equal(overlayProgress(playing({ total: 0 })), undefined);
	});

	it("stays inside 0…1 even if the receiver contradicts itself", () => {
		// Measured devices are not always consistent; a bar value over 100 is a defect
		// the layout would render as a full bar with a warning in the logs at best.
		const over = overlayProgress(playing({ elapsed: 500, total: 221 }))!;
		assert.equal(over, 1);
		assert.ok(Number.isFinite(over));
	});

	it("formats times the way a listener reads them", () => {
		assert.equal(formatTime(68), "1:08");
		assert.equal(formatTime(221), "3:41");
		assert.equal(formatTime(0), "0:00");
		assert.equal(formatTime(3_800), "1:03:20", "past an hour the hours appear");
		assert.equal(formatTime(-5), "0:00", "never negative");
	});
});

describe("the overlay face", () => {
	it("uses the track as the headline and the artist beneath it", () => {
		const face = buildOverlayFace(playing());
		assert.ok(face);
		assert.equal(face.primary, "Cruel Summer");
		assert.equal(face.secondary, "Taylor Swift");
		assert.equal(face.keyTitle, "Cruel Summer\nTaylor Swift");
		assert.equal(face.time, "1:08/3:41");
		assert.equal(face.progress, 68 / 221);
	});

	it("falls back through the fields it has rather than showing blanks", () => {
		// Sources differ in what they report; a station may give only an artist.
		assert.equal(buildOverlayFace(playing({ track: undefined }))!.primary, "Taylor Swift");
		assert.equal(buildOverlayFace(playing({ track: undefined, artist: undefined }))!.primary, "Lover");
		// With a track but no artist, the album takes the second line.
		assert.equal(buildOverlayFace(playing({ artist: undefined }))!.secondary, "Lover");
	});

	it("produces nothing at all when there is nothing to show", () => {
		// The important negative: an element that hid its own useful content behind an
		// empty box would be strictly worse than one that did nothing.
		const empty = buildOverlayFace({ timeDisplay: "unknown" });
		assert.equal(empty, undefined);
	});

	it("shows a cover when there is one, and a placeholder when there is not", () => {
		const withArt = buildOverlayFace(playing({ art: art() }))!;
		const withoutArt = buildOverlayFace(playing())!;
		assert.ok(withArt.image?.startsWith("data:image/svg+xml;base64,"));
		assert.ok(withoutArt.image?.startsWith("data:image/svg+xml;base64,"));
		assert.ok(withArt.image!.length > withoutArt.image!.length, "the cover is the bigger payload");
	});

	it("still says something when the cover is too big to send", () => {
		// Over budget the composer refuses; falling back to the placeholder keeps the
		// element saying "something is playing" instead of going blank.
		const huge = buildOverlayFace(playing({ art: art(600 * 1024) }))!;
		assert.ok(huge.image, "a face is still produced");
		assert.ok(huge.image.length < 4_000, "and it is the small placeholder, not the cover");
	});

	it("carries a face even with art but no text at all", () => {
		const artOnly = buildOverlayFace({ timeDisplay: "unknown", art: art() });
		assert.ok(artOnly, "a cover on its own is worth showing");
		assert.equal(artOnly.primary, "");
		assert.equal(artOnly.keyTitle, "");
	});

	it("composes at the size it is told, for the strip as well as the key", () => {
		const strip = buildOverlayFace(playing({ art: art() }), { width: 200, height: 100 })!;
		const svg = Buffer.from(strip.image!.split(",")[1]!, "base64").toString("utf8");
		assert.match(svg, /width="200" height="100"/);
	});

	it("passes a slice through, so one picture can span adjacent strips", () => {
		const face = buildOverlayFace(playing({ art: art() }), {
			width: 200,
			height: 100,
			slice: { index: 1, count: 2 },
		})!;
		const svg = Buffer.from(face.image!.split(",")[1]!, "base64").toString("utf8");
		assert.match(svg, /<image x="-200" y="0" width="400"/);
	});

	it("omits the time when the receiver says the time means nothing", () => {
		const face = buildOverlayFace(playing({ timeDisplay: "off" }))!;
		assert.equal(face.time, undefined);
		assert.equal(face.progress, undefined);
	});
});

describe("composing is shared, not repeated per element", () => {
	it("returns the identical string for the same cover and the same size", () => {
		// One track change notifies every configured element at once, and each used to
		// compose its own copy: for a 97 KB cover that is two base64 passes over ~100
		// and ~260 KB, per element, at the exact moment the receiver is streaming ~1 800
		// frames a second. Identity — not just equality — is the assertion, because that
		// is what proves the work was done once.
		const shared = art(4096);
		const first = buildOverlayFace(playing({ art: shared }))!;
		const second = buildOverlayFace(playing({ art: shared }))!;
		assert.equal(first.image, second.image);
		assert.ok(first.image === second.image, "the same string instance, i.e. composed once");
	});

	it("still distinguishes a key from a strip", () => {
		// Sharing must not collapse genuinely different compositions.
		const shared = art(4096);
		const key = buildOverlayFace(playing({ art: shared }), { width: 144, height: 144 })!;
		const strip = buildOverlayFace(playing({ art: shared }), { width: 200, height: 100 })!;
		assert.notEqual(key.image, strip.image);
	});

	it("composes a different cover separately", () => {
		const a = buildOverlayFace(playing({ art: art(1024) }))!;
		const b = buildOverlayFace(playing({ art: art(2048) }))!;
		assert.notEqual(a.image, b.image);
	});
});
