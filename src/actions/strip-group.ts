/**
 * Split one now-playing display across several adjacent touch strips.
 *
 * The Stream Deck SDK offers no drawing surface that spans touch-strip segments:
 * every encoder action owns its own 200x100 canvas and `setFeedback` is addressed
 * per instance. "Spread across strips" therefore has to be N cooperating instances
 * that each work out, from where they sit, which part of the whole they are.
 *
 * Two things make that tractable:
 *
 *   - **Position is knowable.** `DialAction.coordinates` gives `{row, column}`, and
 *     for dials `row` is always 0, so a group is just a run of consecutive columns
 *     on the same device.
 *   - **The strip is physically continuous.** Verified on a Stream Deck + against a
 *     background image that runs across all four segments: it crosses the boundaries
 *     with no visible offset. So slices sit on exact segment multiples and need no
 *     bezel correction (see `STRIP_SEGMENT_WIDTH` in cover-image.ts).
 *
 * Roles are derived deterministically from the sorted columns — no election, no
 * negotiation, no shared mutable state between instances. Every instance computing
 * the same function over the same membership reaches the same answer, so there is no
 * window in which two of them believe they are the cover.
 */

/**
 * What one segment of a group draws.
 *
 * The layout is built around where the space is actually short, and that is **not**
 * the cover: album art is square, so it fits into part of a single segment with room
 * left over. Long titles and artist names are the problem — beside a 92 px cover only
 * ~100 px remain, about eleven characters, and "Taylor Swift" is twelve. Text also
 * cannot flow from one segment to the next, since each is its own canvas.
 *
 * So every segment beyond the first buys **text width**: a line that had ~100 px next
 * to the cover gets a full 200 px of its own, and a group with segments to spare
 * splits one long title across several of them (see `splitTextAcross`).
 */
export type StripRole =
	/** A lone dial: cover, text and progress crammed onto one segment. */
	| "all"
	/** Cover art plus the progress bar and time, which fit in the space beside it. */
	| "cover"
	/** Title and artist together, full width. Used when a group has only two segments. */
	| "text"
	/** The track title, full width. Several adjacent ones share one split title. */
	| "title"
	| "artist"
	| "album";

export interface StripMember {
	/** The action instance id (`action.id`). */
	id: string;
	/** `coordinates.column`; for dials `row` is always 0. */
	column: number;
}

export interface StripAssignment {
	role: StripRole;
	/**
	 * Which part of a split title this segment draws, when a group dedicates more than
	 * one segment to the title. Feed it to `splitTextAcross`.
	 */
	textPart?: { index: number; count: number };
	/** Position within the contiguous group, left to right, and the group's size. */
	position: number;
	groupSize: number;
}

/**
 * No options yet, and one deliberately absent.
 *
 * An earlier draft had `spreadCover`, to stretch one picture across several cover
 * segments. The layout only ever assigns **one** cover segment — a square cover fits
 * inside a single 200x100 with room to spare, so widening it buys nothing — which
 * made the flag unreachable. Unreachable configuration is worse than none, so it is
 * gone. `composeCoverImage` still accepts a slice and is still tested for it, should a
 * deliberate "one big picture" mode ever want it.
 */
export interface AssignOptions {
	/** Reserved; see the note above. */
	readonly _?: never;
}

/**
 * Split members into runs of consecutive columns.
 *
 * A gap means two separate displays: someone put an unrelated key between two dials,
 * and joining them would draw half a picture with a hole in it. Duplicate columns
 * cannot happen on real hardware but are tolerated here rather than trusted — the
 * coordinates come from the app, not from us.
 */
export function contiguousGroups(members: readonly StripMember[]): StripMember[][] {
	const sorted = [...members].sort((a, b) => a.column - b.column || a.id.localeCompare(b.id));
	const groups: StripMember[][] = [];
	for (const member of sorted) {
		const current = groups[groups.length - 1];
		const previous = current?.[current.length - 1];
		if (!current || previous === undefined || member.column - previous.column > 1) {
			groups.push([member]);
		} else {
			current.push(member);
		}
	}
	return groups;
}

/**
 * The role layout for a group of `size` segments.
 *
 * Deliberately a table rather than an algorithm: these are design decisions, and a
 * table is easier to argue with.
 *
 *   1  all
 *   2  cover | title+artist            <- the text line doubles from ~100 to 200 px
 *   3  cover | title | artist
 *   4  cover | title | artist | album
 *   5+ cover | title x (size-3) | artist | album
 *
 * The cover segment carries the progress bar and the time as well, because a square
 * cover leaves half its segment free — there is no reason to spend a whole segment on
 * a bar. Everything above four goes to the title, since that is the string that
 * actually runs out of room; two segments of readable type beat one segment at 10 px.
 */
export function rolesForGroupSize(size: number): StripRole[] {
	// Guard the non-numbers explicitly. Every comparison against NaN is false, so
	// without this a NaN fell through to the general branch, where
	// `Array.from({length: NaN})` yields an empty array — producing a layout with no
	// cover segment at all.
	if (!Number.isFinite(size) || size <= 1) return ["all"];
	if (size === 2) return ["cover", "text"];
	if (size === 3) return ["cover", "title", "artist"];
	if (size === 4) return ["cover", "title", "artist", "album"];
	return [
		"cover",
		...Array.from<unknown, StripRole>({ length: size - 3 }, () => "title"),
		"artist",
		"album",
	];
}

/**
 * Assign a role (and, where relevant, a slice) to every member.
 *
 * Pure: same membership in, same assignment out, regardless of the order the
 * instances appeared in.
 */
export function assignRoles(
	members: readonly StripMember[],
	options: AssignOptions = {},
): Map<string, StripAssignment> {
	void options;
	const out = new Map<string, StripAssignment>();
	for (const group of contiguousGroups(members)) {
		const roles = rolesForGroupSize(group.length);
		const titleCount = roles.filter((r) => r === "title").length;
		let titleSeen = 0;
		for (const [position, member] of group.entries()) {
			const role = roles[position]!;
			// A split title only makes sense when more than one segment carries it;
			// otherwise the segment shows the whole string and needs no part index.
			const splits = role === "title" && titleCount > 1;
			out.set(member.id, {
				role,
				position,
				groupSize: group.length,
				...(splits ? { textPart: { index: titleSeen, count: titleCount } } : {}),
			});
			if (role === "title") titleSeen++;
		}
	}
	return out;
}

/**
 * Per-device membership, so instances can find their neighbours.
 *
 * Nothing here talks to the SDK: the caller feeds it `action.device.id`,
 * `action.id` and `action.coordinates.column` on `willAppear`, and removes the
 * member on `willDisappear`. Kept deliberately small — the interesting logic is the
 * pure function above.
 */
export class StripRegistry {
	private readonly devices = new Map<string, Map<string, number>>();

	/** Returns true when the membership actually changed (i.e. a repaint is due). */
	add(deviceId: string, id: string, column: number): boolean {
		const members = this.devices.get(deviceId) ?? new Map<string, number>();
		this.devices.set(deviceId, members);
		if (members.get(id) === column) return false;
		members.set(id, column);
		return true;
	}

	/** Returns true when the membership actually changed. */
	remove(deviceId: string, id: string): boolean {
		const members = this.devices.get(deviceId);
		if (!members?.delete(id)) return false;
		if (members.size === 0) this.devices.delete(deviceId);
		return true;
	}

	members(deviceId: string): StripMember[] {
		return [...(this.devices.get(deviceId) ?? new Map())].map(([id, column]) => ({ id, column }));
	}

	/** Every device that currently has members; used to repaint a whole group. */
	deviceIds(): string[] {
		return [...this.devices.keys()];
	}

	/** The device a member belongs to, so a removal can find its group again. */
	deviceOf(id: string): string | undefined {
		for (const [deviceId, members] of this.devices) if (members.has(id)) return deviceId;
		return undefined;
	}

	assignments(deviceId: string, options: AssignOptions = {}): Map<string, StripAssignment> {
		return assignRoles(this.members(deviceId), options);
	}
}
