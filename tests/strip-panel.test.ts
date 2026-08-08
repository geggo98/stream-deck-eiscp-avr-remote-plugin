/**
 * What one cooperating touch-strip panel draws.
 *
 * The interesting property is not any single panel but the group: several dials each
 * compute their own face from the same state, and the pieces have to add back up to
 * the whole. So the tests that matter here re-assemble a split title and check it is
 * still the title, and check that a panel with nothing to say declines rather than
 * going blank.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ArtImage } from "../src/adapter/eiscp/jacket-art.ts";
import type { NowPlaying } from "../src/adapter/eiscp/now-playing.ts";
import { PANEL_TEXT_LINES } from "../src/actions/cover-image.ts";
import { assignRoles, panelCapacity, StripRegistry, type StripAssignment } from "../src/actions/strip-group.ts";
import { buildPanelFace, NORMAL_ITEM_KEYS, PANEL_ITEM_KEYS, panelItems } from "../src/actions/strip-panel.ts";

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

function role(name: StripAssignment["role"], textPart?: StripAssignment["textPart"]): StripAssignment {
	return { role: name, position: 0, groupSize: 4, ...(textPart ? { textPart } : {}) };
}

/** Plan a real group and build every panel, the way the dials do. */
function group(state: NowPlaying, size: number): { role: string; face: ReturnType<typeof buildPanelFace> }[] {
	const members = Array.from({ length: size }, (_, column) => ({ id: `d${column}`, column, host: "h" }));
	const assigned = assignRoles(members, {
		texts: { track: state.track, artist: state.artist, album: state.album },
	});
	return members.map((m) => {
		const a = assigned.get(m.id)!;
		return { role: a.role, face: buildPanelFace(state, a) };
	});
}

describe("the cover panel", () => {
	it("carries the picture and nothing else", () => {
		// The text belongs to the neighbours; repeating it here would waste the one panel
		// that has the picture. No elapsed time and no bar either — at the moment of a
		// change the receiver's position is still the previous track's, and a frozen bar
		// showing where the *last* song had got to is worse than none (see `PanelFace`).
		const face = buildPanelFace(PLAYING, role("cover"));
		assert.equal(face.passive, false);
		assert.deepEqual(face.lines, []);
		assert.ok(face.cover);
	});

	it("hands the cover over as a data URI, never as markup", () => {
		// The device controls these bytes. They enter the composition as base64 inside
		// an attribute and nowhere else; a face carrying a raw "<svg" would mean the
		// rule in cover-image.ts had been undone.
		const face = buildPanelFace(PLAYING, role("cover"));
		assert.match(face.cover!, /^data:image\/svg\+xml;base64,/);
		assert.ok(!face.cover!.includes("<"), "no markup escapes into the payload");
	});

	it("shows the picture whatever the receiver says about the time", () => {
		// The time is not part of this display at all any more, so the NMS time flag
		// cannot cost the cover.
		const face = buildPanelFace({ ...PLAYING, timeDisplay: "off" }, role("cover"));
		assert.equal(face.cover !== undefined, true);
	});

	it("falls back to the placeholder rather than going passive with no art", () => {
		const { art: _dropped, ...noArt } = PLAYING;
		const face = buildPanelFace(noArt, role("cover"));
		assert.equal(face.passive, false);
		assert.ok(face.cover, "a 'nothing is playing here' picture is still a picture");
	});
});

describe("text panels", () => {
	it("shows its own field and nothing else", () => {
		assert.deepEqual(
			buildPanelFace(PLAYING, role("artist")).lines.map((l) => l.text),
			["Taylor Swift"],
		);
		assert.deepEqual(
			buildPanelFace(PLAYING, role("album")).lines.map((l) => l.text),
			["Lover"],
		);
	});

	it("puts the title above the artist on a two-panel group, at one size", () => {
		// Two lines of the same block at different sizes reads as a fault, not emphasis.
		const face = buildPanelFace(PLAYING, role("text"));
		assert.deepEqual(
			face.lines.map((l) => l.text),
			["Cruel Summer", "Taylor Swift"],
		);
		assert.equal(new Set(face.lines.map((l) => l.fontSize)).size, 1);
	});

	it("never exceeds the lines the layout has", () => {
		const long = { ...PLAYING, track: "A ".repeat(120).trim() };
		for (const r of ["title", "text", "all"] as const) {
			assert.ok(buildPanelFace(long, role(r)).lines.length <= PANEL_TEXT_LINES, r);
		}
	});

	it("declines instead of drawing an empty panel", () => {
		// Defensive: planPanels only hands out roles it has text for, but the plan and
		// the state are read at different moments.
		const face = buildPanelFace({ timeDisplay: "unknown" }, role("artist"));
		assert.equal(face.passive, true);
		assert.deepEqual(face.lines, []);
	});

	it("keeps a dial with role 'none' on its own face", () => {
		const face = buildPanelFace(PLAYING, role("none"));
		assert.equal(face.passive, true);
		assert.equal(face.cover, undefined);
	});
});

describe("a whole group", () => {
	it("puts the cover on one panel and the fields on the others", () => {
		const panels = group(PLAYING, 4);
		assert.deepEqual(
			panels.map((p) => p.role),
			["cover", "title", "artist", "album"],
		);
		assert.equal(panels.filter((p) => p.face.cover).length, 1, "exactly one picture");
		assert.ok(panels.every((p) => !p.face.passive), "every dial takes part");
	});

	it("re-assembles a split title into the title it started as", () => {
		// The one property that cannot be checked panel by panel: the pieces have to add
		// back up. A splitter that dropped or duplicated a word would pass every
		// single-panel test above.
		const title = "Everything I Wanted But Never Really Needed At All";
		assert.ok(title.length > panelCapacity(), "long enough to need a second panel");
		const panels = group({ ...PLAYING, track: title }, 4);
		assert.deepEqual(
			panels.map((p) => p.role),
			["cover", "title", "title", "artist"],
			"the album gives way to the overflow",
		);
		const rebuilt = panels
			.filter((p) => p.role === "title")
			.flatMap((p) => p.face.lines.map((l) => l.text))
			.join(" ");
		assert.equal(rebuilt, title);
	});

	it("shows the picture exactly once across the whole group", () => {
		const panels = group(PLAYING, 4);
		assert.equal(panels.filter((p) => p.face.cover !== undefined).length, 1);
		assert.equal(panels.find((p) => p.face.cover !== undefined)!.role, "cover");
	});

	it("leaves the spare dials alone when the receiver sent almost nothing", () => {
		const panels = group({ track: "Lover", timeDisplay: "unknown" }, 4);
		assert.deepEqual(
			panels.map((p) => p.face.passive),
			[false, false, true, true],
		);
	});
});

describe("panelItems", () => {
	it("says what is off as plainly as what is on, in both directions", () => {
		// The rule the cover-stuck-to-the-strip bug was made of: a layout item keeps
		// whatever it was last given, so leaving one out of the payload is not "no
		// change", it is "keep showing the old thing forever". Every key of both lists
		// therefore appears every time.
		const shown = panelItems(buildPanelFace(PLAYING, role("cover")));
		const passive = panelItems(buildPanelFace(PLAYING, role("none")));
		for (const items of [shown, passive]) {
			for (const key of [...PANEL_ITEM_KEYS, ...NORMAL_ITEM_KEYS]) {
				assert.equal(typeof items[key]?.enabled, "boolean", `${key} is missing`);
			}
		}
	});

	it("hides the dial's own face while the panel is up, and restores it after", () => {
		const shown = panelItems(buildPanelFace(PLAYING, role("title")));
		for (const key of NORMAL_ITEM_KEYS) assert.equal(shown[key]!.enabled, false, key);

		const back = panelItems(buildPanelFace(PLAYING, role("none")));
		for (const key of NORMAL_ITEM_KEYS) assert.equal(back[key]!.enabled, true, key);
		for (const key of PANEL_ITEM_KEYS) assert.equal(back[key]!.enabled, false, key);
	});

	it("carries the text and the size the fitter chose", () => {
		const items = panelItems(buildPanelFace(PLAYING, role("text")));
		const line1 = items["line1"]!;
		assert.equal(line1.kind, "text", "a text item, so the size can ride along");
		assert.equal(line1.value, "Cruel Summer");
		assert.equal(items["line2"]!.value, "Taylor Swift");
		assert.ok(line1.kind === "text" && (line1.font?.size ?? 0) > 0);
	});

	it("keeps the bar and the clock switched off in every case", () => {
		// They belong to a permanent display, not to this one: a bar parked at the
		// previous track's position is a claim, and it was the wrong one. The items still
		// have to be *named* on every send, or a later feature that enables them would
		// leave them stuck on.
		for (const state of [PLAYING, { ...PLAYING, timeDisplay: "off" as const }]) {
			const items = panelItems(buildPanelFace(state, role("cover")));
			assert.equal(items["progress"]!.enabled, false);
			assert.equal(items["time"]!.enabled, false);
		}
	});

	it("only ever enables a line it has text for", () => {
		const items = panelItems(buildPanelFace(PLAYING, role("album")));
		assert.equal(items["line1"]!.enabled, true);
		assert.equal(items["line2"]!.enabled, false, "no second line means no stale second line");
	});
});

describe("a neighbour appearing or disappearing", () => {
	/** What one dial would draw right now, straight through the registry. */
	function faceOf(reg: StripRegistry, id: string) {
		const assignment = reg
			.assignments("deck", { texts: { track: PLAYING.track, artist: PLAYING.artist, album: PLAYING.album } })
			.get(id);
		return buildPanelFace(PLAYING, assignment ?? { role: "all", position: 0, groupSize: 1 });
	}

	it("hands the cover to whoever is leftmost now", () => {
		// The reason the role is looked up at render time rather than frozen when the
		// track changed: pull the cover dial out mid-display and its neighbour has to
		// become the cover, not keep showing the artist beside an empty space.
		const reg = new StripRegistry();
		for (const [id, column] of [
			["a", 0],
			["b", 1],
			["c", 2],
		] as const) {
			reg.add("deck", id, column, { host: "10.0.0.1", seconds: 5 });
		}
		assert.ok(faceOf(reg, "a").cover, "a is the cover");
		assert.equal(faceOf(reg, "b").cover, undefined, "b is a text panel");

		assert.deepEqual(
			faceOf(reg, "c").lines.map((l) => l.text),
			["Taylor Swift"],
			"and c is the artist",
		);

		reg.remove("deck", "a");
		assert.ok(faceOf(reg, "b").cover, "b took the cover over");
		// Three panels became two, so the remaining text panel carries both lines
		// rather than leaving the title nowhere to go.
		assert.deepEqual(
			faceOf(reg, "c").lines.map((l) => l.text),
			["Cruel Summer", "Taylor Swift"],
		);
	});

	it("leaves a dial on the other receiver out of it", () => {
		// Adjacent, but watching a different amplifier: it has its own track, so joining
		// the two would present two of them as one.
		const reg = new StripRegistry();
		reg.add("deck", "a", 0, { host: "10.0.0.1", seconds: 5 });
		reg.add("deck", "b", 1, { host: "10.0.0.2", seconds: 5 });
		assert.ok(faceOf(reg, "a").cover, "each is its own display");
		assert.ok(faceOf(reg, "b").cover);
	});
});
