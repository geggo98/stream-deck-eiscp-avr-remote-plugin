/**
 * The permanent now-playing display, and the readout that briefly interrupts it.
 *
 * The cooperating panels next door freeze the receiver's state and show it for a few
 * seconds; this one keeps up with it, which changes what has to be true. It is the only
 * face that draws the clock and the progress bar, the only one that has to survive a
 * receiver with nothing to say, and the only one that lights both halves of the layout
 * at once — so those three are what the tests here are about.
 *
 * No SDK import: this file's subject deliberately has none either (importing
 * `@elgato/streamdeck` rotates its log files as a side effect, which races between
 * parallel test processes).
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ArtImage } from "../src/adapter/eiscp/jacket-art.ts";
import type { NowPlaying } from "../src/adapter/eiscp/now-playing.ts";
import { DEFAULT_SCRIM, PANEL_TEXT_WIDTH } from "../src/actions/cover-image.ts";
import {
	ACTION_SCRIM_FLOOR,
	buildNowPlayingFace,
	buildPanelFace,
	dedupeCover,
	panelItems,
} from "../src/actions/strip-panel.ts";

/** A tiny but structurally valid JPEG; the composer only base64s it. */
function art(): ArtImage {
	return {
		type: "jpeg",
		bytes: Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(64, 0x41), Buffer.from([0xff, 0xd9])]),
		frames: 12,
		hash: "0123456789abcdef",
	};
}

const PLAYING: NowPlaying = {
	track: "Cruel Summer",
	artist: "Taylor Swift",
	album: "Lover",
	elapsed: 68,
	total: 221,
	timeDisplay: "elapsed-total",
	art: art(),
};

describe("the permanent now-playing face", () => {
	it("shows the track over the artist, with the clock and the bar", () => {
		const face = buildNowPlayingFace(PLAYING);
		assert.ok(face);
		assert.equal(face.passive, false);
		assert.deepEqual(
			face.lines.map((l) => l.text),
			["Cruel Summer", "Taylor Swift"],
		);
		assert.equal(face.time, "1:08/3:41");
		// A fraction, not a percentage — the conversion is the layout's business.
		assert.ok(face.progress !== undefined && Math.abs(face.progress - 68 / 221) < 1e-9);
		assert.ok(face.cover?.startsWith("data:image/"), "the cover is composed, not raw markup");
	});

	it("never lets the artist shout louder than the title", () => {
		// A long title shrinks down the ladder; a short artist would otherwise stay where
		// it started and end up the larger of the two, which reads as the wrong emphasis.
		const face = buildNowPlayingFace({
			...PLAYING,
			track: "Everything Everything All At Once Forever And Ever",
			artist: "Q",
		});
		assert.ok(face);
		const [title, artist] = face.lines;
		assert.ok(title && artist);
		assert.ok(artist.fontSize <= title.fontSize, `artist ${artist.fontSize} beats title ${title.fontSize}`);
	});

	it("gives the title the larger size when both fit", () => {
		const face = buildNowPlayingFace(PLAYING);
		const [title, artist] = face!.lines;
		assert.ok(title!.fontSize > artist!.fontSize, "the title is the heading, the artist the subheading");
	});

	it("has no clock and no bar when the receiver says the time means nothing", () => {
		// `NMS` field `t` is the authority, not whether the numbers happen to be there:
		// with the time display off they are meaningless, and a bar drawn from them would
		// be confidently wrong.
		const face = buildNowPlayingFace({ ...PLAYING, timeDisplay: "off" });
		assert.ok(face);
		assert.equal(face.time, undefined);
		assert.equal(face.progress, undefined);
		assert.deepEqual(
			face.lines.map((l) => l.text),
			["Cruel Summer", "Taylor Swift"],
		);
	});

	it("shows text on black rather than a stand-in glyph when there is no cover", () => {
		// The key action substitutes a music note when it would otherwise be blank; here
		// it would sit behind the title as clutter, and black is not clutter.
		const face = buildNowPlayingFace({ track: "BBC Radio 6", timeDisplay: "unknown" });
		assert.ok(face);
		assert.equal(face.cover, undefined);
		assert.deepEqual(
			face.lines.map((l) => l.text),
			["BBC Radio 6"],
		);
	});

	it("declines when nothing is playing at all", () => {
		// The load-bearing case: the dial falls back to its ordinary face — the volume or
		// the input it is set to — instead of going black on a receiver sitting on a menu.
		assert.equal(buildNowPlayingFace({ timeDisplay: "unknown" }), undefined);
		assert.equal(buildNowPlayingFace({ timeDisplay: "off", elapsed: 0, total: 0 }), undefined);
	});

	it("shrinks a long title rather than letting it spill", () => {
		const face = buildNowPlayingFace({
			...PLAYING,
			track: "Goodbye Lullaby Expanded Edition Deluxe Remaster",
		});
		assert.ok(face);
		const [title] = face.lines;
		assert.ok(title);
		// Whatever the fitter settled on has to fit the width it was given.
		assert.ok(title.text.length * title.fontSize * 0.55 <= PANEL_TEXT_WIDTH + 1, title.text);
	});
});

describe("the action readout", () => {
	it("keeps only the cover and hands the rest to the dial", () => {
		const face = buildNowPlayingFace(PLAYING, { actionReadout: true });
		assert.ok(face);
		assert.equal(face.withOwnFace, true);
		assert.deepEqual(face.lines, [], "the title would fight the value that was just set");
		assert.equal(face.time, undefined);
		assert.equal(face.progress, undefined);
		assert.ok(face.cover?.startsWith("data:image/"));
	});

	it("declines when there is no cover to keep", () => {
		// Nothing to put behind the readout, so the dial simply shows its ordinary face —
		// which is what every other dial does and needs no special handling.
		assert.equal(buildNowPlayingFace({ track: "BBC Radio 6", timeDisplay: "unknown" }, { actionReadout: true }), undefined);
	});

	it("darkens the cover further than the standing face does", () => {
		// The standing face puts a 24 px bold title over the art; the readout puts an 18 px
		// value and a thin bar there, which need more help.
		const standing = buildNowPlayingFace(PLAYING, { scrimOpacity: 0.1 });
		const readout = buildNowPlayingFace(PLAYING, { scrimOpacity: 0.1, actionReadout: true });
		assert.ok(standing?.cover && readout?.cover);
		assert.notEqual(readout.cover, standing.cover);
	});

	it("raises the setting to the floor but never lowers it", () => {
		// A floor, not an override: someone who wants the cover almost black keeps it.
		const dark = 0.8;
		assert.ok(dark > ACTION_SCRIM_FLOOR);
		const standing = buildNowPlayingFace(PLAYING, { scrimOpacity: dark });
		const readout = buildNowPlayingFace(PLAYING, { scrimOpacity: dark, actionReadout: true });
		// Same art, same options, so the shared composition cache returns the same string.
		assert.equal(readout?.cover, standing?.cover);
		assert.ok(ACTION_SCRIM_FLOOR > DEFAULT_SCRIM, "the floor only matters if it is above the default");
	});
});

describe("what the permanent face switches on", () => {
	it("lights the clock and the bar, and scales the bar to the layout", () => {
		// A layout bar reads 0…100 unless it declares a `range`, and `np-panel.json` does
		// not. The face speaks in fractions, so something has to convert — and getting it
		// wrong would show a bar permanently at 1 %.
		const items = panelItems(buildNowPlayingFace(PLAYING)!);
		assert.equal(items["time"]!.enabled, true);
		assert.equal((items["time"] as { value?: string }).value, "1:08/3:41");
		assert.equal(items["progress"]!.enabled, true);
		assert.equal((items["progress"] as { value?: number }).value, Math.round((68 / 221) * 100));
	});

	it("still says the dial's own face is off", () => {
		// Everything the layout has is written on every send, in both directions: an item
		// left out is not "unchanged", it is "keep showing the old thing".
		const items = panelItems(buildNowPlayingFace(PLAYING)!);
		for (const key of ["icon", "label", "value", "indicator"]) {
			assert.equal(items[key]!.enabled, false, key);
		}
	});

	it("leaves the clock and the bar off for the cooperating panels", () => {
		// The counterpart to the two above, and the reason they can coexist in one layout:
		// the short display freezes the state at the moment of the change, when the
		// receiver's position is still the previous track's.
		for (const role of ["all", "cover", "text", "title", "artist"] as const) {
			const items = panelItems(buildPanelFace(PLAYING, { role, position: 0, groupSize: 4 }));
			assert.equal(items["time"]!.enabled, false, role);
			assert.equal(items["progress"]!.enabled, false, role);
		}
	});

	it("sends a picture once and then only what changed", () => {
		// A permanent display repaints on the receiver's once-a-second tick. Re-sending
		// the composed cover each time would be ~173 KB per second for a picture that did
		// not move; leaving `enabled` out instead would leave the face stuck.
		const first = { cover: { value: "data:A", enabled: true, opacity: 1 } } as Record<string, unknown>;
		const memo = dedupeCover(first, undefined);
		assert.equal(memo, "data:A");
		assert.equal((first["cover"] as { value?: string }).value, "data:A", "the first send carries it");

		const second = { cover: { value: "data:A", enabled: true, opacity: 1 } } as Record<string, unknown>;
		assert.equal(dedupeCover(second, memo), "data:A");
		assert.equal((second["cover"] as { value?: string }).value, undefined, "the tick does not resend it");
		assert.equal((second["cover"] as { enabled?: boolean }).enabled, true, "but still says it is on");
		assert.equal((second["cover"] as { opacity?: number }).opacity, 1, "and still says how bright");
	});

	it("sends the next track's picture, and forgets nothing in between", () => {
		assert.equal(dedupeCover({ cover: { value: "data:B", enabled: true } }, "data:A"), "data:B");
		// A payload with the cover switched off says nothing about what is on the strip,
		// so the memory has to survive it — otherwise every action readout would be
		// followed by a full re-send of the picture that is still there behind it.
		assert.equal(dedupeCover({ cover: { enabled: false } }, "data:A"), "data:A");
		assert.equal(dedupeCover({}, "data:A"), "data:A");
	});

	it("keeps the cover on for the readout so the dial can draw over it", () => {
		const items = panelItems(buildNowPlayingFace(PLAYING, { actionReadout: true })!);
		assert.equal(items["cover"]!.enabled, true);
		for (const key of ["line1", "line2", "time", "progress"]) {
			assert.equal(items[key]!.enabled, false, key);
		}
	});
});
