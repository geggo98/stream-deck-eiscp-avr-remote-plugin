/**
 * The custom encoder layout, checked here rather than only at pack time.
 *
 * `streamdeck validate` does look at layouts — but it runs in `npm run pack` and in CI,
 * long after the mistake was made, and it cannot know about the *other* half of the
 * contract: that every item key `strip-panel.ts` writes to actually exists. A key
 * typo is silent at runtime. Stream Deck ignores an unknown key in a `setFeedback`
 * payload, so the panel would simply not appear, with nothing in any log.
 *
 * The geometry rules come from the schema (`@elgato/schemas/streamdeck/plugins/layout.json`):
 * a 200x100 canvas, unique keys, and — the one that is easy to trip over — items that
 * share a `zOrder` must not overlap. This layout deliberately *does* overlap across
 * z-orders, because that is what lets one layout carry both the dial's own face and
 * the cooperating panel.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { NowPlaying } from "../src/adapter/eiscp/now-playing.ts";
import { encoderLayoutFor } from "../src/actions/dedicated/catalog.ts";
import type { StripRole } from "../src/actions/strip-group.ts";
import { buildPanelFace, NORMAL_ITEM_KEYS, PANEL_ITEM_KEYS, PANEL_LAYOUT, panelItems } from "../src/actions/strip-panel.ts";

const PLUGIN_DIR = fileURLToPath(new URL("../de.schwetschke.sd.eiscp-avr-remote.sdPlugin/", import.meta.url));

interface Item {
	key: string;
	type: string;
	rect: [number, number, number, number];
	zOrder?: number;
	value?: unknown;
}

// PANEL_LAYOUT is the path Stream Deck is given, relative to the plugin folder — so
// reading it this way also proves the path the plugin sends actually resolves.
const layout = JSON.parse(readFileSync(join(PLUGIN_DIR, PANEL_LAYOUT), "utf8")) as { id: string; items: Item[] };

const CANVAS_WIDTH = 200;
const CANVAS_HEIGHT = 100;

function overlaps(a: Item, b: Item): boolean {
	const [ax, ay, aw, ah] = a.rect;
	const [bx, by, bw, bh] = b.rect;
	return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
}

describe("the np-panel layout", () => {
	it("is loadable and identifies itself", () => {
		assert.equal(typeof layout.id, "string");
		assert.ok(layout.items.length > 0);
	});

	it("keeps every item inside the 200x100 canvas", () => {
		for (const item of layout.items) {
			const [x, y, w, h] = item.rect;
			assert.ok(w > 0 && h > 0, `${item.key}: empty rect`);
			assert.ok(x >= 0 && y >= 0, `${item.key}: negative origin`);
			assert.ok(x + w <= CANVAS_WIDTH, `${item.key}: ${x}+${w} runs past ${CANVAS_WIDTH}`);
			assert.ok(y + h <= CANVAS_HEIGHT, `${item.key}: ${y}+${h} runs past ${CANVAS_HEIGHT}`);
		}
	});

	it("uses each key once, since the key is how setFeedback addresses it", () => {
		const keys = layout.items.map((i) => i.key);
		assert.equal(new Set(keys).size, keys.length, `duplicate key in ${keys.join(", ")}`);
	});

	it("never overlaps two items that share a zOrder", () => {
		// The schema's rule, and the one that makes the two-faces-in-one-layout trick
		// legal: overlapping is fine as long as the stacking order says which wins.
		for (let i = 0; i < layout.items.length; i++) {
			for (let j = i + 1; j < layout.items.length; j++) {
				const a = layout.items[i]!;
				const b = layout.items[j]!;
				if ((a.zOrder ?? 0) !== (b.zOrder ?? 0)) continue;
				assert.ok(!overlaps(a, b), `${a.key} and ${b.key} overlap at zOrder ${a.zOrder ?? 0}`);
			}
		}
	});

	it("keeps the zOrder inside the range the schema allows", () => {
		for (const item of layout.items) {
			const z = item.zOrder ?? 0;
			assert.ok(Number.isInteger(z) && z >= 0 && z <= 700, `${item.key}: zOrder ${z}`);
		}
	});

	it("gives every bar the value the schema requires", () => {
		for (const item of layout.items.filter((i) => i.type === "bar" || i.type === "gbar")) {
			assert.equal(typeof item.value, "number", `${item.key} needs a numeric value`);
		}
	});

	it("carries every item the panel code writes to", () => {
		// The half `streamdeck validate` cannot see. An unknown key in a setFeedback
		// payload is ignored without a word, so a typo here shows up as "the panel just
		// does not appear".
		const present = new Set(layout.items.map((i) => i.key));
		for (const key of [...PANEL_ITEM_KEYS, ...NORMAL_ITEM_KEYS]) {
			assert.ok(present.has(key), `layout is missing "${key}"`);
		}
	});

	it("draws the cover beneath everything else", () => {
		// It is the background; anything at or below its zOrder would disappear under it.
		const cover = layout.items.find((i) => i.key === "cover")!;
		const coverZ = cover.zOrder ?? 0;
		for (const item of layout.items) {
			if (item.key === "cover") continue;
			assert.ok((item.zOrder ?? 0) > coverZ, `${item.key} would be hidden by the cover`);
		}
		assert.deepEqual(cover.rect, [0, 0, CANVAS_WIDTH, CANVAS_HEIGHT], "the cover is full-bleed");
	});

	it("starts with the panel items switched off", () => {
		// A dial that never shows a panel must look exactly like it did before, so the
		// panel half of the layout has to be invisible until something enables it.
		for (const key of PANEL_ITEM_KEYS) {
			const item = layout.items.find((i) => i.key === key) as (Item & { enabled?: boolean }) | undefined;
			assert.equal(item?.enabled, false, `${key} must start disabled`);
		}
		for (const key of NORMAL_ITEM_KEYS) {
			const item = layout.items.find((i) => i.key === key) as (Item & { enabled?: boolean }) | undefined;
			assert.notEqual(item?.enabled, false, `${key} must start enabled`);
		}
	});
});

describe("restoring a dial's own layout", () => {
	// `setFeedbackLayout` has no "revert to the manifest" — switching the panels on has
	// to be undone by naming the original layout. So the runtime's idea of it must be
	// the manifest's, or a dial would come back on a layout it never had: a $B1 dial
	// restored to $A1 loses its progress bar for good.
	const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8")) as {
		Actions: { UUID: string; Encoder?: { layout?: string } }[];
	};

	it("agrees with the manifest for every encoder action", () => {
		const encoders = manifest.Actions.filter((a) => a.Encoder?.layout);
		assert.ok(encoders.length >= 8, `expected the eight dials, found ${encoders.length}`);
		for (const entry of encoders) {
			const id = entry.UUID.split(".").pop();
			assert.equal(encoderLayoutFor(id), entry.Encoder!.layout, `${id}`);
		}
	});

	it("knows nothing about actions that have no touch strip", () => {
		assert.equal(encoderLayoutFor("power"), undefined);
		assert.equal(encoderLayoutFor(undefined), undefined);
	});
});

describe("what a face actually switches on", () => {
	// The rule the schema states is per-layout: items sharing a zOrder must not overlap.
	// But this layout carries two faces, so the question that matters is per-*face*:
	// whatever one role enables at the same moment must not collide. It caught a real
	// one — the lone-dial role shows an artist line and an elapsed time together, and
	// those two rects sat on top of each other.
	const PLAYING: NowPlaying = {
		track: "Cruel Summer",
		artist: "Taylor Swift",
		album: "Lover",
		elapsed: 68,
		total: 221,
		timeDisplay: "elapsed-total",
	};

	const byKey = new Map(layout.items.map((i) => [i.key, i]));

	for (const role of ["all", "cover", "text", "title", "artist", "album"] as StripRole[]) {
		it(`draws the ${role} panel without items on top of each other`, () => {
			const face = buildPanelFace(PLAYING, { role, position: 0, groupSize: 4 });
			const on = Object.entries(panelItems(face))
				.filter(([, item]) => item.enabled)
				.map(([key]) => byKey.get(key))
				.filter((item): item is Item => item !== undefined);
			assert.ok(on.length > 0, "a face that enables nothing would be a blank strip");
			for (let i = 0; i < on.length; i++) {
				for (let j = i + 1; j < on.length; j++) {
					// The cover is the background and is meant to sit under everything.
					if (on[i]!.key === "cover" || on[j]!.key === "cover") continue;
					assert.ok(!overlaps(on[i]!, on[j]!), `${on[i]!.key} sits on ${on[j]!.key} in the ${role} panel`);
				}
			}
		});
	}
});
