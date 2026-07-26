/**
 * Splitting a now-playing display across adjacent touch strips.
 *
 * Everything here is a pure function over `{id, column}` pairs, which is the point:
 * the SDK gives no surface spanning strip segments, so the coordination has to be
 * "every instance computes the same answer from the same membership" rather than a
 * negotiation. If that function is order-dependent, two dials can both believe they
 * are the cover — so several tests attack exactly that.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	assignRoles,
	contiguousGroups,
	rolesForGroupSize,
	StripRegistry,
	type StripMember,
	type StripRole,
} from "../src/actions/strip-group.ts";

function members(...columns: number[]): StripMember[] {
	return columns.map((column) => ({ id: `dial-${column}`, column }));
}

function rolesOf(assigned: Map<string, { role: StripRole }>, ids: string[]): StripRole[] {
	return ids.map((id) => assigned.get(id)!.role);
}

describe("contiguous groups", () => {
	it("treats a run of consecutive columns as one display", () => {
		const groups = contiguousGroups(members(0, 1, 2, 3));
		assert.equal(groups.length, 1);
		assert.deepEqual(
			groups[0]!.map((m) => m.column),
			[0, 1, 2, 3],
		);
	});

	it("splits on a gap, because a hole would draw half a picture", () => {
		// Someone put an unrelated dial between two of ours.
		const groups = contiguousGroups(members(0, 1, 3));
		assert.deepEqual(
			groups.map((g) => g.map((m) => m.column)),
			[[0, 1], [3]],
		);
	});

	it("does not depend on the order instances appeared in", () => {
		// willAppear order is whatever Stream Deck feels like; the grouping must not be.
		const forwards = contiguousGroups(members(0, 1, 2));
		const backwards = contiguousGroups(members(2, 1, 0));
		assert.deepEqual(forwards, backwards);
	});

	it("tolerates duplicate columns rather than trusting the input", () => {
		// Cannot happen on real hardware, but the coordinates come from the app.
		const groups = contiguousGroups([
			{ id: "a", column: 1 },
			{ id: "b", column: 1 },
		]);
		assert.equal(groups.length, 1, "same column is not a gap");
		assert.equal(groups[0]!.length, 2);
	});

	it("has nothing to group when there is nothing", () => {
		assert.deepEqual(contiguousGroups([]), []);
	});
});

describe("role layout", () => {
	it("gives a lone dial everything", () => {
		assert.deepEqual(rolesForGroupSize(1), ["all"]);
	});

	it("spends every extra segment on text, not on the cover", () => {
		// The design point: a square cover fits inside one segment with room left over
		// for the progress bar, so widening it buys nothing. Titles are what run out of
		// space — beside a 92 px cover only ~100 px remain, about eleven characters.
		assert.deepEqual(rolesForGroupSize(2), ["cover", "text"]);
		assert.deepEqual(rolesForGroupSize(3), ["cover", "title", "artist"]);
		assert.deepEqual(rolesForGroupSize(4), ["cover", "title", "artist", "album"]);
		// Beyond four the surplus goes to the title, which is the string that actually
		// overflows: two segments of readable type beat one segment at 10 px.
		assert.deepEqual(rolesForGroupSize(5), ["cover", "title", "title", "artist", "album"]);
		assert.deepEqual(rolesForGroupSize(6), ["cover", "title", "title", "title", "artist", "album"]);
	});

	it("always has exactly one cover segment and never wastes one on a bar alone", () => {
		for (let size = 1; size <= 8; size++) {
			const roles = rolesForGroupSize(size);
			assert.equal(roles.length, size, `size ${size}`);
			const covers = roles.filter((r) => r === "cover").length;
			assert.equal(covers, size === 1 ? 0 : 1, `size ${size}: one cover segment (or "all")`);
			assert.ok(
				!roles.includes("text") || size === 2,
				`size ${size}: the combined text line is only for a two-segment group`,
			);
		}
	});

	it("gives the title at least one full-width segment from three upwards", () => {
		for (let size = 3; size <= 8; size++) {
			assert.ok(rolesForGroupSize(size).includes("title"), `size ${size}`);
		}
	});

	it("never returns an empty layout, whatever it is handed", () => {
		for (const size of [0, -1, Number.NaN]) {
			assert.deepEqual(rolesForGroupSize(size), ["all"], `size ${size}`);
		}
	});
});

describe("assignRoles", () => {
	it("assigns left to right by column, not by arrival", () => {
		const assigned = assignRoles(members(2, 0, 1));
		assert.deepEqual(rolesOf(assigned, ["dial-0", "dial-1", "dial-2"]), ["cover", "title", "artist"]);
	});

	it("gives every member a position and the group size", () => {
		const assigned = assignRoles(members(5, 6, 7));
		assert.deepEqual(assigned.get("dial-5"), { role: "cover", position: 0, groupSize: 3 });
		assert.deepEqual(assigned.get("dial-7"), { role: "artist", position: 2, groupSize: 3 });
	});

	it("splits a long title across the segments that carry it", () => {
		// The answer to the actual problem: a five-segment group gives the title two
		// full-width segments instead of shrinking it to fit one.
		const assigned = assignRoles(members(0, 1, 2, 3, 4));
		assert.deepEqual(assigned.get("dial-1")!.textPart, { index: 0, count: 2 });
		assert.deepEqual(assigned.get("dial-2")!.textPart, { index: 1, count: 2 });
		// Non-title segments have nothing to split.
		assert.equal(assigned.get("dial-0")!.textPart, undefined);
		assert.equal(assigned.get("dial-3")!.textPart, undefined);
	});

	it("does not split a title that has a segment to itself", () => {
		// A part index of 0-of-1 would send the whole string through the splitter for
		// no reason.
		for (const size of [3, 4]) {
			const assigned = assignRoles(members(...Array.from({ length: size }, (_, i) => i)));
			assert.equal(assigned.get("dial-1")!.textPart, undefined, `size ${size}`);
		}
	});

	it("assigns each disjoint group independently", () => {
		const assigned = assignRoles(members(0, 1, 5));
		assert.deepEqual(rolesOf(assigned, ["dial-0", "dial-1"]), ["cover", "text"]);
		// The isolated one is its own display and shows everything.
		assert.deepEqual(assigned.get("dial-5"), { role: "all", position: 0, groupSize: 1 });
	});

	it("no longer offers cover spreading, because the layout cannot reach it", () => {
		// An earlier draft stretched one picture across several cover segments. The
		// layout assigns exactly one cover segment — a square cover fits inside a single
		// 200x100 with room to spare — so the option was unreachable configuration.
		// composeCoverImage still slices and is still tested for it, should a deliberate
		// "one big picture" mode ever want it.
		for (let size = 1; size <= 6; size++) {
			const assigned = assignRoles(members(...Array.from({ length: size }, (_, i) => i)));
			assert.ok(
				[...assigned.values()].every((a) => !("slice" in a)),
				`size ${size}: no assignment carries a cover slice`,
			);
		}
	});

	it("assigns nothing for an empty membership", () => {
		assert.equal(assignRoles([]).size, 0);
	});
});

describe("StripRegistry", () => {
	it("reports whether the membership actually changed, so repaints are not gratuitous", () => {
		const reg = new StripRegistry();
		assert.equal(reg.add("dev", "a", 0), true);
		assert.equal(reg.add("dev", "a", 0), false, "re-announcing the same position is not a change");
		assert.equal(reg.add("dev", "a", 1), true, "moving is");
		assert.equal(reg.remove("dev", "a"), true);
		assert.equal(reg.remove("dev", "a"), false, "removing twice is not a change");
	});

	it("keeps devices apart", () => {
		const reg = new StripRegistry();
		reg.add("plus", "a", 0);
		reg.add("plus", "b", 1);
		reg.add("other", "c", 0);

		assert.equal(reg.members("plus").length, 2);
		assert.deepEqual(rolesOf(reg.assignments("plus"), ["a", "b"]), ["cover", "text"]);
		assert.deepEqual(reg.assignments("other").get("c")!.role, "all", "a lone dial on its own device");
	});

	it("re-splits a group when a middle member goes away", () => {
		// The verification case from the plan: pull a dial out from between two others
		// and neither of the survivors may be left drawing half a picture.
		const reg = new StripRegistry();
		for (const [id, column] of [["a", 0], ["b", 1], ["c", 2]] as const) reg.add("dev", id, column);
		assert.deepEqual(rolesOf(reg.assignments("dev"), ["a", "b", "c"]), ["cover", "title", "artist"]);

		reg.remove("dev", "b");
		const after = reg.assignments("dev");
		assert.deepEqual(after.get("a"), { role: "all", position: 0, groupSize: 1 });
		assert.deepEqual(after.get("c"), { role: "all", position: 0, groupSize: 1 });
		assert.equal(after.size, 2, "the removed member is gone, not stale");
	});

	it("forgets a device once its last member leaves", () => {
		const reg = new StripRegistry();
		reg.add("dev", "a", 0);
		reg.remove("dev", "a");
		assert.deepEqual(reg.deviceIds(), []);
		assert.deepEqual(reg.members("dev"), []);
	});

	it("can find the device a member belongs to, so a removal can repaint its group", () => {
		const reg = new StripRegistry();
		reg.add("plus", "a", 0);
		assert.equal(reg.deviceOf("a"), "plus");
		assert.equal(reg.deviceOf("nope"), undefined);
	});
});
