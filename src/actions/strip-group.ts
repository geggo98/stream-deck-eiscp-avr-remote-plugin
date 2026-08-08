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

import { PANEL_PREFERRED_FONT_SIZE, PANEL_TEXT_LINES, PANEL_TEXT_WIDTH } from "./cover-image.ts";
import { charBudget } from "./text-fit.ts";

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
	| "album"
	/**
	 * Nothing left to give this segment: it keeps its own face while the others show
	 * the track.
	 *
	 * Only reachable when the group has more segments than the receiver has text —
	 * a one-word title with neither artist nor album. Splitting a single word across
	 * panels would cut it, and a blank panel in the middle of a group reads as a
	 * failure, so the honest answer is to leave that dial alone.
	 */
	| "none";

export interface StripMember {
	/** The action instance id (`action.id`). */
	id: string;
	/** `coordinates.column`; for dials `row` is always 0. */
	column: number;
	/**
	 * The receiver this dial is bound to.
	 *
	 * Two receivers on one deck is a supported setup (every action carries its own
	 * IP), and dials pointed at different ones must never share a display: they would
	 * be showing two different tracks as though they were one.
	 */
	host?: string;
	/** This member's configured display duration, in seconds. */
	seconds?: number;
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

/** The strings a plan is made against; absent fields simply make no demand. */
export interface PanelTexts {
	track?: string;
	artist?: string;
	album?: string;
}

/**
 * No cover spreading, deliberately.
 *
 * An earlier draft had `spreadCover`, to stretch one picture across several cover
 * segments. The layout assigns exactly **one** cover segment: a square cover fits
 * inside a single 200x100 with room to spare, and the slice path stretches with
 * `preserveAspectRatio="none"`, so two segments would show a 4:1 smear of an album
 * cover rather than a bigger one. `composeCoverImage` still accepts a slice and is
 * still tested for it, should a deliberate full-strip background ever want it.
 */
export interface AssignOptions {
	/**
	 * What is playing. Given, the plan follows the actual strings — a long title takes
	 * a second panel instead of shrinking. Omitted, only the group size decides.
	 */
	texts?: PanelTexts;
	/** Characters one panel holds at a readable size; defaults to the layout's own. */
	capacity?: number;
}

/**
 * Split members into runs of consecutive columns on the same receiver.
 *
 * A gap means two separate displays: someone put an unrelated key between two dials,
 * and joining them would draw half a picture with a hole in it. A change of `host` is
 * the same thing for a different reason — the two dials are watching different
 * receivers, so there is no single "what is playing" for them to share. Duplicate
 * columns cannot happen on real hardware but are tolerated here rather than trusted —
 * the coordinates come from the app, not from us.
 */
export function contiguousGroups(members: readonly StripMember[]): StripMember[][] {
	const sorted = [...members].sort((a, b) => a.column - b.column || a.id.localeCompare(b.id));
	const groups: StripMember[][] = [];
	for (const member of sorted) {
		const current = groups[groups.length - 1];
		const previous = current?.[current.length - 1];
		const breaks = !current || previous === undefined || member.column - previous.column > 1 || previous.host !== member.host;
		if (breaks) groups.push([member]);
		else current.push(member);
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

/** Characters one panel holds at `PANEL_PREFERRED_FONT_SIZE`, over both its lines. */
export function panelCapacity(width: number = PANEL_TEXT_WIDTH): number {
	return PANEL_TEXT_LINES * charBudget(width, PANEL_PREFERRED_FONT_SIZE);
}

/**
 * How many panels a string wants before it has to shrink.
 *
 * Capped at three: no group is wider than four on any shipping hardware, and the
 * allocator below bounds it again by what is actually free. Anything longer than
 * three panels' worth is a string that will be clipped whatever we do.
 */
function segmentsNeeded(text: string | undefined, capacity: number): number {
	if (!text || capacity <= 0) return 1;
	return Math.min(3, Math.max(1, Math.ceil(text.trim().length / capacity)));
}

/** Words available to split across panels; a single word cannot be divided. */
function wordCount(text: string | undefined): number {
	return text ? text.trim().split(/\s+/).filter(Boolean).length : 0;
}

/**
 * Plan a group's panels against what is actually playing.
 *
 * `rolesForGroupSize` alone cannot do this, and that is the reason this exists: it
 * gives the title a second segment only from **five** panels up, while a Stream Deck +
 * has **four** — so on the hardware this plugin targets, a long title never spread at
 * all. It shrank and then clipped instead.
 *
 * The allocation, in strict priority order:
 *
 *   1. one panel each to the title and (if there is one) the artist;
 *   2. surplus to whichever of them the strings say is too long — this is what pushes
 *      the album off a four-panel group rather than squeezing the title;
 *   3. one panel to the album, if anything is still free;
 *   4. anything still free to the title, bounded by its word count, because two
 *      panels of large type beat one of small.
 *
 * Whatever is left over after that is `"none"`: a group can be wider than the
 * receiver has text, and cutting a one-word title in half is worse than leaving a dial
 * showing its own face.
 */
export function planPanels(size: number, texts?: PanelTexts, capacity: number = panelCapacity()): StripRole[] {
	if (!Number.isFinite(size) || size <= 1) return ["all"];
	if (size === 2) return ["cover", "text"];
	if (!texts) return rolesForGroupSize(size);

	const slots = size - 1; // everything after the single cover panel
	const granted = new Map<StripRole, number>();
	let used = 0;
	const give = (role: StripRole, n = 1): void => {
		granted.set(role, (granted.get(role) ?? 0) + n);
		used += n;
	};

	// The title always claims a panel, even with no track: its stand-in (artist, then
	// album) is what `buildOverlayFace` already falls back to, so the panel is never
	// empty in practice.
	const wants: { role: StripRole; want: number }[] = [{ role: "title", want: segmentsNeeded(texts.track, capacity) }];
	if (texts.artist) wants.push({ role: "artist", want: segmentsNeeded(texts.artist, capacity) });

	for (const w of wants) if (used < slots) give(w.role);
	for (const w of wants) while (used < slots && (granted.get(w.role) ?? 0) < w.want) give(w.role);
	if (used < slots && texts.album) give("album");
	while (used < slots && (granted.get("title") ?? 0) < wordCount(texts.track)) give("title");

	const roles: StripRole[] = ["cover"];
	for (const role of ["title", "artist", "album"] as const) {
		for (let i = 0; i < (granted.get(role) ?? 0); i++) roles.push(role);
	}
	while (roles.length < size) roles.push("none");
	return roles;
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
		const roles = planPanels(group.length, options.texts, options.capacity);
		// Both the title and the artist can end up spread, so the part index is counted
		// per role rather than for the title alone.
		const total = new Map<StripRole, number>();
		for (const role of roles) total.set(role, (total.get(role) ?? 0) + 1);
		const seen = new Map<StripRole, number>();
		for (const [position, member] of group.entries()) {
			const role = roles[position]!;
			const count = total.get(role) ?? 1;
			const index = seen.get(role) ?? 0;
			// A split only makes sense when more than one segment carries the string;
			// otherwise the segment shows the whole thing and needs no part index.
			const splits = count > 1 && (role === "title" || role === "artist" || role === "album");
			out.set(member.id, {
				role,
				position,
				groupSize: group.length,
				...(splits ? { textPart: { index, count } } : {}),
			});
			seen.set(role, index + 1);
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
	private readonly devices = new Map<string, Map<string, Omit<StripMember, "id">>>();
	private readonly listeners = new Map<string, Set<() => void>>();

	/** Returns true when the membership actually changed (i.e. a repaint is due). */
	add(deviceId: string, id: string, column: number, meta: Omit<StripMember, "id" | "column"> = {}): boolean {
		const members = this.devices.get(deviceId) ?? new Map<string, Omit<StripMember, "id">>();
		this.devices.set(deviceId, members);
		const previous = members.get(id);
		const next = { column, ...meta };
		if (previous && previous.column === column && previous.host === meta.host && previous.seconds === meta.seconds) {
			return false;
		}
		members.set(id, next);
		this.notify(deviceId);
		return true;
	}

	/** Returns true when the membership actually changed. */
	remove(deviceId: string, id: string): boolean {
		const members = this.devices.get(deviceId);
		if (!members?.delete(id)) return false;
		if (members.size === 0) this.devices.delete(deviceId);
		this.notify(deviceId);
		return true;
	}

	/**
	 * Be told when this device's membership changes, because that changes every
	 * member's role: a dial that was the artist becomes the cover when its neighbour
	 * to the left goes away. Returns the unsubscribe.
	 */
	onGroupChange(deviceId: string, listener: () => void): () => void {
		const set = this.listeners.get(deviceId) ?? new Set<() => void>();
		this.listeners.set(deviceId, set);
		set.add(listener);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.listeners.delete(deviceId);
		};
	}

	private notify(deviceId: string): void {
		// Copied first: a listener may unsubscribe itself from inside the callback.
		for (const listener of [...(this.listeners.get(deviceId) ?? [])]) listener();
	}

	/**
	 * How long this member's group should hold its panels, in milliseconds.
	 *
	 * The longest of the group, not each member's own: a display that came up together
	 * and then fell apart panel by panel — cover already gone, title still there —
	 * reads as a fault rather than as a setting. The price is that a dial set to three
	 * seconds shows for ten when it sits next to one set to ten, which is the lesser
	 * surprise.
	 */
	groupDurationMs(deviceId: string, id: string): number | undefined {
		const group = contiguousGroups(this.members(deviceId)).find((g) => g.some((m) => m.id === id));
		const seconds = group?.map((m) => m.seconds).filter((s): s is number => typeof s === "number" && s > 0);
		return seconds?.length ? Math.max(...seconds) * 1000 : undefined;
	}

	members(deviceId: string): StripMember[] {
		return [...(this.devices.get(deviceId) ?? new Map<string, Omit<StripMember, "id">>())].map(([id, rest]) => ({
			id,
			...rest,
		}));
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

/**
 * The registry the dials share.
 *
 * A module singleton rather than a field, because the members are spread across eight
 * separate `SingletonAction` subclasses (six dedicated dials plus the two generic
 * ones): a per-class registry would put the volume dial and the input dial next to
 * each other on the deck and in different worlds in the code.
 */
let registry: StripRegistry | undefined;

export function getStripRegistry(): StripRegistry {
	registry ??= new StripRegistry();
	return registry;
}
