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

/** What one segment of a group draws. */
export type StripRole =
	/** A lone dial: everything on one segment. */
	| "all"
	/** Cover art only. Several adjacent "cover" segments may share one picture. */
	| "cover"
	/** Title, artist, album. */
	| "text"
	/** Progress bar and elapsed/total time. */
	| "progress";

export interface StripMember {
	/** The action instance id (`action.id`). */
	id: string;
	/** `coordinates.column`; for dials `row` is always 0. */
	column: number;
}

export interface StripAssignment {
	role: StripRole;
	/**
	 * Which part of one shared picture this segment draws, when its group spreads a
	 * cover across more than one segment. Absent means "draw the whole picture".
	 */
	slice?: { index: number; count: number };
	/** Position within the contiguous group, left to right, and the group's size. */
	position: number;
	groupSize: number;
}

export interface AssignOptions {
	/**
	 * Stretch one cover across every cover segment of a group instead of repeating it
	 * on each. Off by default: it is the more surprising look, and it is the part that
	 * depends on the SVG slice trick.
	 */
	spreadCover?: boolean;
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
 * Deliberately explicit rather than computed: these are design decisions, and a
 * table is easier to argue with than an algorithm. Beyond three segments the extra
 * room goes to the cover, because that is the part that benefits from width — text
 * and a progress bar do not get better with a second segment.
 */
export function rolesForGroupSize(size: number): StripRole[] {
	// Guard the non-numbers explicitly. Every comparison against NaN is false, so
	// without this a NaN fell through to the last branch and produced a layout with
	// *no* cover segment at all — `Array.from({length: NaN})` is an empty array, so
	// the group would have shown text and a progress bar and nothing else.
	if (!Number.isFinite(size) || size <= 1) return ["all"];
	if (size === 2) return ["cover", "text"];
	if (size === 3) return ["cover", "text", "progress"];
	return [...Array.from<unknown, StripRole>({ length: size - 2 }, () => "cover"), "text", "progress"];
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
	const out = new Map<string, StripAssignment>();
	for (const group of contiguousGroups(members)) {
		const roles = rolesForGroupSize(group.length);
		const coverCount = roles.filter((r) => r === "cover").length;
		let coverSeen = 0;
		for (const [position, member] of group.entries()) {
			const role = roles[position]!;
			const spreads = options.spreadCover === true && role === "cover" && coverCount > 1;
			out.set(member.id, {
				role,
				position,
				groupSize: group.length,
				...(spreads ? { slice: { index: coverSeen, count: coverCount } } : {}),
			});
			if (role === "cover") coverSeen++;
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
