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

	it("splits two, three and more the way the design says", () => {
		assert.deepEqual(rolesForGroupSize(2), ["cover", "text"]);
		assert.deepEqual(rolesForGroupSize(3), ["cover", "text", "progress"]);
		// Beyond three, the extra room goes to the cover: text and a progress bar do
		// not get better with a second segment, a picture does.
		assert.deepEqual(rolesForGroupSize(4), ["cover", "cover", "text", "progress"]);
		assert.deepEqual(rolesForGroupSize(6), ["cover", "cover", "cover", "cover", "text", "progress"]);
	});

	it("always assigns exactly one text and one progress segment above size one", () => {
		for (let size = 2; size <= 8; size++) {
			const roles = rolesForGroupSize(size);
			assert.equal(roles.length, size, `size ${size}`);
			assert.equal(roles.filter((r) => r === "text").length, 1, `size ${size}: one text segment`);
			assert.equal(roles.filter((r) => r === "progress").length, size === 2 ? 0 : 1, `size ${size}`);
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
		assert.deepEqual(rolesOf(assigned, ["dial-0", "dial-1", "dial-2"]), ["cover", "text", "progress"]);
	});

	it("gives every member a position and the group size", () => {
		const assigned = assignRoles(members(5, 6, 7));
		assert.deepEqual(assigned.get("dial-5"), { role: "cover", position: 0, groupSize: 3 });
		assert.deepEqual(assigned.get("dial-7"), { role: "progress", position: 2, groupSize: 3 });
	});

	it("assigns each disjoint group independently", () => {
		const assigned = assignRoles(members(0, 1, 5));
		assert.deepEqual(rolesOf(assigned, ["dial-0", "dial-1"]), ["cover", "text"]);
		// The isolated one is its own display and shows everything.
		assert.deepEqual(assigned.get("dial-5"), { role: "all", position: 0, groupSize: 1 });
	});

	it("does not spread the cover unless asked", () => {
		// Spreading is the more surprising look and it depends on the SVG slice trick,
		// so it stays off by default.
		const assigned = assignRoles(members(0, 1, 2, 3));
		assert.equal(assigned.get("dial-0")!.slice, undefined);
		assert.equal(assigned.get("dial-1")!.slice, undefined);
	});

	it("slices one picture across the cover segments when spreading", () => {
		const assigned = assignRoles(members(0, 1, 2, 3), { spreadCover: true });
		assert.deepEqual(assigned.get("dial-0")!.slice, { index: 0, count: 2 });
		assert.deepEqual(assigned.get("dial-1")!.slice, { index: 1, count: 2 });
		// Only the cover segments slice; the text and progress ones have nothing to cut.
		assert.equal(assigned.get("dial-2")!.slice, undefined);
		assert.equal(assigned.get("dial-3")!.slice, undefined);
	});

	it("covers a spread picture exactly once: contiguous indices, no repeats", () => {
		// The property that would show up as a duplicated or missing strip of cover.
		const assigned = assignRoles(members(0, 1, 2, 3, 4, 5), { spreadCover: true });
		const slices = [...assigned.values()].flatMap((a) => (a.slice ? [a.slice] : []));
		assert.equal(slices.length, 4, "six segments -> four cover segments");
		assert.ok(
			slices.every((s) => s.count === 4),
			"every slice must agree on how many pieces there are",
		);
		assert.deepEqual(
			slices.map((s) => s.index).sort((a, b) => a - b),
			[0, 1, 2, 3],
		);
	});

	it("does not slice when a group has only one cover segment", () => {
		// Slicing 1-of-1 would be a no-op that still went through the stretch path.
		for (const size of [2, 3]) {
			const assigned = assignRoles(members(...Array.from({ length: size }, (_, i) => i)), { spreadCover: true });
			assert.equal(assigned.get("dial-0")!.slice, undefined, `size ${size}`);
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
		assert.deepEqual(rolesOf(reg.assignments("dev"), ["a", "b", "c"]), ["cover", "text", "progress"]);

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
