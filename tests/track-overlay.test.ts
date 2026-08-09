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
	KEY_TITLE_CHARS,
	keyTitleFor,
	DEFAULT_TRACK_CHANGE_SECONDS,
	compositionsHeld,
	formatTime,
	MAX_COMPOSITIONS_PER_ART,
	MAX_TRACK_CHANGE_SECONDS,
	MIN_TRACK_CHANGE_SECONDS,
	overlayIsActive,
	overlayProgress,
	trackOverlayEnabled,
	trackOverlaySeconds,
} from "../src/actions/track-overlay.ts";
import { tinyJpeg } from "./helpers/tiny-jpeg.ts";

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
	const data = Buffer.alloc(bytes, 0x41);
	return { type: "jpeg", bytes: data, frames: 2, hash: `h${bytes}` };
}

let coverCounter = 0;
/** A real, decodable JPEG of one flat brightness — for the colour rule to look at. */
function coverOfLuma(mean: number): NonNullable<NowPlaying["art"]> {
	return { type: "jpeg", bytes: tinyJpeg({ width: 64, height: 64, luma: () => mean }), frames: 1, hash: `c${coverCounter++}` };
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
	it("refuses the numbers when the receiver says they mean nothing", () => {
		// NMS field t. Disabled means the values are meaningless, and a bar drawn from
		// them would be confidently wrong; elapsed-only means there is no total at all,
		// so a stale one left in the state must not be believed either.
		assert.equal(overlayProgress(playing()), 68 / 221);
		assert.equal(overlayProgress(playing({ timeDisplay: "off" })), undefined);
		assert.equal(overlayProgress(playing({ timeDisplay: "elapsed" })), undefined, "elapsed-only has no total");
	});

	it("believes the clock while the receiver has said nothing at all", () => {
		// `unknown` is the initial value, not a statement — and on the reference device it
		// is a *lasting* one: `NMS` cannot be obtained by asking, only volunteered on a
		// track change. Reading it as "no progress" left a plugin restarted mid-track with
		// no ring until the song ended, which is exactly what the key exists to show.
		// Observed in the plugin's own log on 2026-08-09: a cover at 11:18:57 with
		// timeDisplay=unknown and no ring, and no second chance until 11:20:36.
		assert.equal(overlayProgress(playing({ timeDisplay: "unknown" })), 68 / 221);
	});

	it("still invents nothing when the clock has nothing to say", () => {
		// The safety net for the case above: a source with no track length reports
		// `--:--`, which `parseTimeInfo` already turns into absent.
		assert.equal(overlayProgress(playing({ timeDisplay: "unknown", total: undefined })), undefined);
		assert.equal(overlayProgress(playing({ timeDisplay: "unknown", elapsed: undefined })), undefined);
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
		// The key title is wrapped, not the raw strings: see `keyTitleFor`.
		assert.equal(face.keyTitle, "Cruel\nSummer\nTaylor…");
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
		// frames a second. Equality alone would not prove anything — two strings built
		// separately compare equal — so the cache is asked how many it is holding.
		const shared = art(4096)!;
		const first = buildOverlayFace(playing({ art: shared }))!;
		const second = buildOverlayFace(playing({ art: shared }))!;
		assert.equal(first.image, second.image);
		assert.equal(compositionsHeld(shared), 1, "one composition, however many elements asked");
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

describe("the key title", () => {
	// Measured on a real Stream Deck +: the app draws key titles in the user's own font
	// and neither wraps nor shrinks them, so "Cruel Summer / Taylor Swift" ran off the
	// key and painted over the Play key next to it. Nothing here can ask how wide a
	// character is — the only lever is handing over a string that is already short.

	it("never lets a line exceed the budget, whatever it is given", () => {
		const cases: [string, string][] = [
			["Cruel Summer", "Taylor Swift"],
			["Lover", ""],
			["Supercalifragilisticexpialidocious", "X"],
			["Everything I Wanted But Never Really Needed At All", "Billie Eilish"],
			["   ", "   "],
			["Björk Guðmundsdóttir", "Homogenic"],
		];
		for (const [track, artist] of cases) {
			for (const line of keyTitleFor(track, artist).split("\n")) {
				assert.ok(line.length <= KEY_TITLE_CHARS, `"${line}" (${line.length}) from "${track}"`);
			}
		}
	});

	it("wraps on a word before it cuts one", () => {
		assert.equal(keyTitleFor("Bohemian Rhapsody", ""), "Bohemian\nRhapsody");
	});

	it("keeps to three lines, so the title cannot grow past the key", () => {
		const long = keyTitleFor("Everything I Wanted But Never Really Needed", "Billie Eilish Connell");
		assert.ok(long.split("\n").length <= 3, long);
	});

	it("cuts a single unsplittable word rather than letting it run", () => {
		const out = keyTitleFor("Supercalifragilisticexpialidocious", "");
		assert.ok(out.length < "Supercalifragilisticexpialidocious".length);
		assert.ok(out.includes("…"), out);
	});

	it("has nothing to show for nothing", () => {
		assert.equal(keyTitleFor(undefined, ""), "");
		assert.equal(keyTitleFor("   ", "  "), "");
	});
});

describe("drawing the progress into the image", () => {
	/** Decode a composed data URI back to its SVG. */
	function svgOf(image: string | undefined): string {
		const prefix = "data:image/svg+xml;base64,";
		assert.ok(image !== undefined && image.startsWith(prefix), "expected a composed SVG");
		return Buffer.from(image.slice(prefix.length), "base64").toString("utf8");
	}

	it("draws nothing unless an element asked for it", () => {
		// Every other element composed the same way before this existed, and must still.
		assert.doesNotMatch(svgOf(buildOverlayFace(playing({ art: art() }))!.image), /stroke-dasharray|rx="3"/);
	});

	it("obeys the receiver, not the numbers", () => {
		// `NMS` field t is the only thing that says whether the time means anything. With
		// it off the elapsed/total pair is still populated and still meaningless, so a bar
		// drawn from it would be confidently wrong.
		const off = playing({ art: art(), timeDisplay: "off" });
		assert.equal(overlayProgress(off), undefined, "the premise");
		assert.doesNotMatch(svgOf(buildOverlayFace(off, { progressStyle: "ring" })!.image), /stroke-dasharray/);
		assert.match(
			svgOf(buildOverlayFace(playing({ art: art() }), { progressStyle: "ring" })!.image),
			/stroke-dasharray/,
		);
	});

	it("keeps the picture identical across ticks inside one step", () => {
		// This is what lets writeKeyImage keep dropping repaints while the clock ticks
		// once a second. Two elapsed values a fraction of a step apart must compose to
		// the same string, or nothing is ever de-duplicated again.
		const shared = art(4096);
		const at = (elapsed: number): string =>
			buildOverlayFace(playing({ art: shared, elapsed, total: 1000 }), { progressStyle: "ring" })!.image!;
		assert.equal(at(300), at(302), "0.300 and 0.302 land in the same step");
		assert.notEqual(at(300), at(320), "but a whole step apart must not");
	});

	it("colours the ring from the cover it will sit on", () => {
		// Real JPEGs, so this exercises the decoder and the colour rule together — the
		// pair is what a user actually sees, and either half being right on its own is
		// no comfort.
		const dark = svgOf(buildOverlayFace(playing({ art: coverOfLuma(20) }), { progressStyle: "ring" })!.image);
		assert.match(dark, /stroke="#FFFFFF"/, "a dark sleeve wants a white ring");
		const bright = svgOf(
			buildOverlayFace(playing({ art: coverOfLuma(250) }), { progressStyle: "ring", scrimOpacity: 0 })!.image,
		);
		assert.match(bright, /stroke="#000000"/, "and a bright one a black ring");
	});

	it("chooses the colour against the darkened cover, not the raw one", () => {
		// The scrim is applied before the ring is drawn, so a white sleeve at the default
		// darkening is really a mid-grey backdrop. Picking black there would be exactly
		// backwards, and the composer's own clamp is what decides how dark it gets.
		const white = coverOfLuma(250);
		assert.match(
			svgOf(buildOverlayFace(playing({ art: white }), { progressStyle: "ring", scrimOpacity: 0 })!.image),
			/stroke="#000000"/,
		);
		assert.match(
			svgOf(buildOverlayFace(playing({ art: white }), { progressStyle: "ring", scrimOpacity: 0.8 })!.image),
			/stroke="#FFFFFF"/,
		);
		// And an element that names no scrim still gets one. This cover is chosen to sit
		// where that matters: bright enough for a black ring on its own, dark enough for a
		// white one once the composer's default 0.45 has been applied. Reading the raw
		// setting here would pick the colour for a picture that never reaches the screen.
		const middling = coverOfLuma(153);
		assert.match(
			svgOf(buildOverlayFace(playing({ art: middling }), { progressStyle: "ring", scrimOpacity: 0 })!.image),
			/stroke="#000000"/,
		);
		assert.match(
			svgOf(buildOverlayFace(playing({ art: middling }), { progressStyle: "ring" })!.image),
			/stroke="#FFFFFF"/,
		);
	});

	it("carries the progress onto the placeholder when there is no cover", () => {
		const svg = svgOf(buildOverlayFace(playing(), { progressStyle: "bar" })!.image);
		assert.match(svg, /fill="#1A1A1A"/, "the placeholder backdrop");
		assert.match(svg, /rx="3"/, "and the bar on top of it");
	});

	it("keeps the compositions per cover bounded as the progress moves", () => {
		// Without a limit a five-minute track leaves a hundred ~173 KB strings behind, per
		// cover, for as long as the cover is alive.
		const shared = art(4096)!;
		for (let step = 0; step <= 100; step++) {
			buildOverlayFace(playing({ art: shared, elapsed: step, total: 100 }), { progressStyle: "ring" });
		}
		assert.equal(compositionsHeld(shared), MAX_COMPOSITIONS_PER_ART);
	});

	it("still caches, rather than evicting on principle", () => {
		// The other half: a bound that dropped everything would also pass the test above
		// and would recompose ~173 KB on every single tick.
		const shared = art(8192)!;
		for (let step = 0; step < 5; step++) {
			buildOverlayFace(playing({ art: shared, elapsed: step, total: 100 }), { progressStyle: "ring" });
		}
		assert.equal(compositionsHeld(shared), 5);
		buildOverlayFace(playing({ art: shared, elapsed: 3, total: 100 }), { progressStyle: "ring" });
		assert.equal(compositionsHeld(shared), 5, "asking again for a step it already has adds nothing");
	});
});
