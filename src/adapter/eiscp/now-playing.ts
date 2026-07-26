/**
 * What is playing right now: title, artist, album, elapsed/total time, play state,
 * and the cover art.
 *
 * Split the same way as `device-status.ts` — pure parsers that can be tested
 * without a socket, plus a thin tracker that wires them to the ConnectionManager's
 * observers. There is no polling anywhere: everything here is pushed by the
 * receiver.
 *
 * Measured on the reference VSX-S520D under AirPlay (`npm run capture:jacket-art`),
 * because several of the decisions below only make sense against real timing:
 *
 *   - `NTI`/`NAT`/`NAL` arrive **unsolicited on a track change**, ~90 ms apart, and
 *     also answer `QSTN`. (The older repo note that this firmware "never sends
 *     NTI/NAT/NAL" came from a capture taken while browsing a list, not playing.)
 *   - The **cover arrives first**, roughly 760 ms *before* the text. So by the time
 *     a track change is detectable from the text, the art is already in hand.
 *   - `NTM` ticks once per second; `NMS` field `t` says whether a time readout is
 *     meaningful at all, and field `s` whether seeking is permitted (measured `x`
 *     under AirPlay — i.e. not permitted).
 *   - The AirPlay-specific command family from the vendor spec (`ATI`/`AAT`/`AAL`/
 *     `ATM`/`AST`, "Airplay Model Only") is **not implemented on this unit** — all
 *     five time out. The NET/USB commands are the ones that work.
 */

import { scopedLogger } from "../logging.ts";
import type { ConnectionEvent } from "./connection-manager.ts";
import { sanitiseDeviceText } from "./device-text.ts";
import { JacketArtAccumulator, type ArtImage } from "./jacket-art.ts";

const logger = scopedLogger("NowPlaying");

/** Spec: "64 Unicode letters [UTF-8 encoded] max" for NTI/NAT/NAL. */
export const MAX_TEXT_LENGTH = 64;
/** Hosts tracked at once; bounded like every other map fed from the wire. */
export const MAX_NOW_PLAYING_HOSTS = 8;
/**
 * A track change is announced by several commands in a row. Measured spread for one
 * change: art at +0 ms, then NTI +761, NAL +773, NAT +848 — plus NMS/NFI/NTR/FLD
 * within another 300 ms. Without coalescing, one change would fire four or more
 * times; this window collapses them into one, leading edge first so a display
 * reacts immediately rather than a second late.
 */
export const TRACK_CHANGE_COOLDOWN_MS = 1_500;

export type PlayStatus = "play" | "pause" | "stop" | "ff" | "rew" | "eof";

/** What `NMS` field `t` says about the time readout. */
export type TimeDisplay = "elapsed-total" | "elapsed" | "off" | "unknown";

export interface NowPlaying {
	track?: string;
	artist?: string;
	album?: string;
	/** Seconds; absent when the receiver reports the time as unknown. */
	elapsed?: number;
	total?: number;
	playStatus?: PlayStatus;
	art?: ArtImage;
	timeDisplay: TimeDisplay;
	/** `NMS` field `s`: whether `NTS` (time seek) will be honoured. */
	seekEnabled?: boolean;
	/** `NMS` field `ii`. Kept raw: this firmware reports `44`, which the spec does not assign. */
	serviceIcon?: string;
}

export const EMPTY_NOW_PLAYING: NowPlaying = { timeDisplay: "unknown" };

/** Which part changed, so a consumer can ignore the once-a-second tick. */
export type NowPlayingChange = "text" | "time" | "art" | "status" | "menu";

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

/** Largest time the spec allows (99:59:59), used to reject nonsense outright. */
const MAX_SECONDS = 99 * 3600 + 59 * 60 + 59;

const TIME_PART = /^(\d{1,2}):([0-5]\d)(?::([0-5]\d))?$/;

/**
 * Parse one `mm:ss` or `hh:mm:ss` field into seconds.
 *
 * Returns `undefined` for the documented "unknown" form (`--:--`) and for anything
 * malformed. Nothing here may produce `NaN`: the result feeds a progress bar, and a
 * `NaN` reaching `setFeedback` was a real finding in this repo (M10).
 */
export function parseTimeField(field: string): number | undefined {
	const m = TIME_PART.exec(field);
	if (!m) return undefined;
	const [h, min, s] = m[3] !== undefined ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, Number(m[1]), Number(m[2])];
	const total = h * 3600 + min * 60 + s;
	return Number.isFinite(total) && total >= 0 && total <= MAX_SECONDS ? total : undefined;
}

/** Parse an `NTM` parameter (`elapsed/total`, either time form). */
export function parseTimeInfo(parameter: string): { elapsed?: number; total?: number } {
	const slash = parameter.indexOf("/");
	if (slash === -1) return { elapsed: parseTimeField(parameter) };
	return {
		elapsed: parseTimeField(parameter.slice(0, slash)),
		total: parseTimeField(parameter.slice(slash + 1)),
	};
}

const PLAY_STATUS: Record<string, PlayStatus> = {
	S: "stop",
	P: "play",
	p: "pause",
	F: "ff",
	R: "rew",
	E: "eof",
};

/** Parse an `NST` parameter (`prs`); only the play field is used today. */
export function parsePlayStatus(parameter: string): PlayStatus | undefined {
	return PLAY_STATUS[parameter[0] ?? ""];
}

/**
 * Parse an `NMS` parameter (`maabbstii`, 9 characters).
 *
 * Fields, per the vendor workbook: `m` track menu, `aa`/`bb` the two soft-key
 * icons, `s` time seek (`S` enabled / `x` disabled), `t` time display (`1`
 * elapsed+total, `2` elapsed only, `x` disabled), `ii` service icon. Measured under
 * AirPlay: `xxxxxx144` → no menu, no seek, elapsed+total, service `44`.
 */
export function parseMenuStatus(parameter: string): {
	timeDisplay: TimeDisplay;
	seekEnabled?: boolean;
	serviceIcon?: string;
} {
	if (parameter.length < 9) return { timeDisplay: "unknown" };
	const seek = parameter[5];
	const time = parameter[6];
	return {
		timeDisplay: time === "1" ? "elapsed-total" : time === "2" ? "elapsed" : time === "x" ? "off" : "unknown",
		seekEnabled: seek === "S" ? true : seek === "x" ? false : undefined,
		serviceIcon: sanitiseDeviceText(parameter.slice(7, 9), 2) || undefined,
	};
}

/**
 * The three fields that identify a track, joined for change detection.
 *
 * NUL is the separator on purpose: `sanitiseDeviceText` strips C0 controls from
 * every device string, so no title can contain one and no combination of fields can
 * be made to collide with another. Written as an escape, because a raw NUL in the
 * source makes git treat the file as binary.
 */
export function trackIdentity(state: NowPlaying): string {
	return [state.track ?? "", state.artist ?? "", state.album ?? ""].join("\u0000");
}

/** True when a state carries no identifying text at all. */
export function hasNoIdentity(state: NowPlaying): boolean {
	return !state.track && !state.artist && !state.album;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/** The slice of ConnectionManager the tracker needs (structurally compatible). */
export interface NowPlayingDeps {
	addMessageObserver(cb: (host: string, command: string, parameter: string) => void): () => void;
	addConnectionObserver(cb: (host: string, event: ConnectionEvent) => void): () => void;
	queryCommand(host: string, command: string): Promise<string>;
}

export interface NowPlayingOptions {
	maxHosts?: number;
	cooldownMs?: number;
	/** Injected for tests; production uses `Date.now`. */
	now?: () => number;
}

type UpdateListener = (state: NowPlaying, change: NowPlayingChange) => void;
type TrackChangeListener = (state: NowPlaying) => void;

interface HostEntry {
	state: NowPlaying;
	updates: Set<UpdateListener>;
	trackChanges: Set<TrackChangeListener>;
	/** Identity at the last notification, for change detection. */
	identity: string;
	/** Whether this host has ever reported a track; see applyText. */
	primed: boolean;
	/** Leading-edge cooldown timestamp. */
	lastTrackChangeAt: number;
}

/** Commands that are queried once when a host is first watched. */
const PRIME_COMMANDS = ["NTI", "NAT", "NAL", "NTM", "NST", "NMS"] as const;

/**
 * Per-host now-playing state, shared by every action bound to that host.
 *
 * Subscribing is how interest is declared, and here that is not just tidiness: the
 * receiver pushes ~1 800 cover-art frames per second during a transfer, so a plugin
 * with no now-playing action on the deck must not accumulate them. Hosts nobody
 * watches are skipped before any work is done.
 */
export class NowPlayingTracker {
	private readonly hosts = new Map<string, HostEntry>();
	private readonly art = new JacketArtAccumulator();
	private readonly deps: NowPlayingDeps;
	private readonly maxHosts: number;
	private readonly cooldownMs: number;
	private readonly now: () => number;
	private unsubscribe: (() => void)[] = [];

	constructor(deps: NowPlayingDeps, options: NowPlayingOptions = {}) {
		this.deps = deps;
		this.maxHosts = options.maxHosts ?? MAX_NOW_PLAYING_HOSTS;
		this.cooldownMs = options.cooldownMs ?? TRACK_CHANGE_COOLDOWN_MS;
		this.now = options.now ?? Date.now;
	}

	/** Attach to the ConnectionManager. Idempotent. */
	start(): void {
		if (this.unsubscribe.length) return;
		this.unsubscribe.push(
			this.deps.addMessageObserver((host, command, parameter) => this.handle(host, command, parameter)),
			this.deps.addConnectionObserver((host, event) => {
				// A partial cover transfer cannot survive the socket that was carrying it.
				if (event !== "connected") this.art.forget(host);
			}),
		);
	}

	stop(): void {
		this.unsubscribe.forEach((u) => u());
		this.unsubscribe = [];
		this.hosts.clear();
	}

	get(host: string): NowPlaying {
		return this.hosts.get(host)?.state ?? EMPTY_NOW_PLAYING;
	}

	/** Watch every change for a host. The returned function detaches. */
	onUpdate(host: string, listener: UpdateListener): () => void {
		const entry = this.entry(host);
		entry.updates.add(listener);
		return () => {
			entry.updates.delete(listener);
			this.dropIfUnwatched(host, entry);
		};
	}

	/**
	 * Watch only track changes — coalesced, and never fired for the initial fill.
	 *
	 * A display that flashes on every connect would be worse than one that misses
	 * the first track, so the very first identity a host reports is recorded
	 * silently. Only a change *from* a known track counts.
	 */
	onTrackChange(host: string, listener: TrackChangeListener): () => void {
		const entry = this.entry(host);
		entry.trackChanges.add(listener);
		return () => {
			entry.trackChanges.delete(listener);
			this.dropIfUnwatched(host, entry);
		};
	}

	/**
	 * Ask the receiver for the current metadata once.
	 *
	 * Needed because none of these commands is volunteered on connect — only on a
	 * track change — so a freshly placed key would otherwise stay blank until the
	 * song ends. Failures are ignored on purpose: a missing pre-fill costs one blank
	 * display, and this must not become a reason a key fails to bind.
	 */
	async prime(host: string): Promise<void> {
		this.entry(host);
		await Promise.allSettled(PRIME_COMMANDS.map((command) => this.deps.queryCommand(host, command)));
	}

	private handle(host: string, command: string, parameter: string): void {
		// Interest gate. Deliberately the very first thing: during a cover transfer
		// this runs ~1 800 times a second.
		const entry = this.hosts.get(host);
		if (!entry) return;

		switch (command) {
			case "NTI":
				return this.applyText(host, entry, "track", parameter);
			case "NAT":
				return this.applyText(host, entry, "artist", parameter);
			case "NAL":
				return this.applyText(host, entry, "album", parameter);
			case "NTM": {
				const { elapsed, total } = parseTimeInfo(parameter);
				if (entry.state.elapsed === elapsed && entry.state.total === total) return;
				entry.state = { ...entry.state, elapsed, total };
				return this.notify(entry, "time");
			}
			case "NST": {
				const playStatus = parsePlayStatus(parameter);
				if (entry.state.playStatus === playStatus) return;
				entry.state = { ...entry.state, playStatus };
				return this.notify(entry, "status");
			}
			case "NMS": {
				const menu = parseMenuStatus(parameter);
				if (
					entry.state.timeDisplay === menu.timeDisplay &&
					entry.state.seekEnabled === menu.seekEnabled &&
					entry.state.serviceIcon === menu.serviceIcon
				) {
					return;
				}
				entry.state = { ...entry.state, ...menu };
				return this.notify(entry, "menu");
			}
			case "NJA": {
				const image = this.art.accept(host, parameter, this.now());
				if (image === undefined) return; // still assembling, or nothing for us
				entry.state = { ...entry.state, art: image ?? undefined };
				return this.notify(entry, "art");
			}
			default:
				return;
		}
	}

	private applyText(host: string, entry: HostEntry, field: "track" | "artist" | "album", raw: string): void {
		const value = sanitiseDeviceText(raw, MAX_TEXT_LENGTH) || undefined;
		if (entry.state[field] === value) return;

		entry.state = { ...entry.state, [field]: value };
		this.notify(entry, "text");

		const identity = trackIdentity(entry.state);
		if (identity === entry.identity) return;
		entry.identity = identity;

		const now = this.now();

		// The first identity a host reports is the pre-fill, not a change — a display
		// that flashed on every connect would be worse than one that misses the very
		// first track.
		//
		// `primed` has to be a flag rather than "was the state empty", and that cost a
		// red test to notice: the fill is *three* messages (NTI, NAL, NAT, ~90 ms
		// apart), so only the first of them looks empty and the other two would have
		// registered as track changes. Stamping the cooldown here makes the rest of the
		// arriving burst fall into the same window that coalesces a real change.
		if (!entry.primed) {
			entry.primed = true;
			entry.lastTrackChangeAt = now;
			logger.debug(`${host}: now playing "${value ?? ""}" (initial, no notification)`);
			return;
		}

		if (now - entry.lastTrackChangeAt < this.cooldownMs) return;
		entry.lastTrackChangeAt = now;
		for (const listener of entry.trackChanges) {
			try {
				listener(entry.state);
			} catch (err) {
				logger.warn(`track-change listener threw: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	private notify(entry: HostEntry, change: NowPlayingChange): void {
		for (const listener of entry.updates) {
			try {
				listener(entry.state, change);
			} catch (err) {
				logger.warn(`now-playing listener threw: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	private entry(host: string): HostEntry {
		const existing = this.hosts.get(host);
		if (existing) return existing;

		if (this.hosts.size >= this.maxHosts) {
			// Prefer evicting a host nobody watches; only then the oldest entry.
			const idle = [...this.hosts].find(([, e]) => e.updates.size === 0 && e.trackChanges.size === 0);
			const victim = idle?.[0] ?? this.hosts.keys().next().value;
			if (victim !== undefined) {
				this.hosts.delete(victim);
				this.art.forget(victim);
			}
		}
		const entry: HostEntry = {
			state: EMPTY_NOW_PLAYING,
			updates: new Set(),
			trackChanges: new Set(),
			identity: trackIdentity(EMPTY_NOW_PLAYING),
			primed: false,
			lastTrackChangeAt: 0,
		};
		this.hosts.set(host, entry);
		return entry;
	}

	private dropIfUnwatched(host: string, entry: HostEntry): void {
		if (entry.updates.size > 0 || entry.trackChanges.size > 0) return;
		// Nothing is looking any more, so stop paying for the cover-art stream.
		this.hosts.delete(host);
		this.art.forget(host);
	}
}

let singleton: NowPlayingTracker | undefined;

/** Process-wide tracker, wired in `plugin.ts` next to the status tracker. */
export function getNowPlayingTracker(deps?: NowPlayingDeps): NowPlayingTracker {
	if (!singleton) {
		if (!deps) throw new Error("getNowPlayingTracker: first call must supply deps");
		singleton = new NowPlayingTracker(deps);
		singleton.start();
	}
	return singleton;
}

/** Tests only: drop the singleton so each file starts clean. */
export function resetNowPlayingTracker(): void {
	singleton?.stop();
	singleton = undefined;
}
