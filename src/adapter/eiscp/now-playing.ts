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
import { fetchCoverOverHttp, type FetchArtOptions } from "./art-http.ts";
import { ConnectionManager, type ConnectionEvent } from "./connection-manager.ts";
import { sanitiseDeviceText } from "./device-text.ts";
import { JacketArtAccumulator, type ArtImage } from "./jacket-art.ts";

const logger = scopedLogger("NowPlaying");

/** Unref'd: a pending settle window must never be the reason a process stays alive. */
function defaultSchedule(fn: () => void, ms: number): () => void {
	const timer = setTimeout(fn, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
}

/** Spec: "64 Unicode letters [UTF-8 encoded] max" for NTI/NAT/NAL. */
export const MAX_TEXT_LENGTH = 64;
/** Hosts tracked at once; bounded like every other map fed from the wire. */
export const MAX_NOW_PLAYING_HOSTS = 8;
/**
 * A track change is announced by several commands in a row. Measured spread for one
 * change: art at +0 ms, then NTI +761, NAL +773, NAT +848 — plus NMS/NFI/NTR/FLD
 * within another 300 ms. Without coalescing, one change would fire four or more
 * times; this window collapses them into one.
 */
export const TRACK_CHANGE_COOLDOWN_MS = 1_500;

/**
 * How long to let the announcement finish before telling anyone about it.
 *
 * This used to fire on the **leading** edge, "so a display reacts immediately rather
 * than a second late" — and that was wrong, in a way only the hardware showed. The
 * fields do not arrive together: measured 87 ms between `NTI` (title) and `NAT`
 * (artist). A consumer that *freezes* the state — which the track-change display does,
 * deliberately — therefore captured the new title beside the **previous song's
 * artist**. Seen in the wild: "Sweet About Me" credited to the artist before it.
 *
 * So the edge is now trailing. 300 ms is ~3.4x the measured spread and far below what
 * anyone reads as a delay; being right matters more here than being early, because the
 * wrong answer is not "late", it is a plausible-looking lie.
 */
export const TRACK_CHANGE_SETTLE_MS = 300;

/**
 * Longest the display may be held back waiting for an announcement to finish.
 *
 * The settle window is re-armed by every field, so without a bound a source that sent
 * one field a second would postpone the display forever. Past this the state that has
 * arrived is what gets shown, and a later field simply starts a fresh burst — which
 * corrects a display that is still up rather than leaving it wrong.
 */
export const TRACK_CHANGE_MAX_WAIT_MS = 2_000;

/** Command each text field came from, for the diagnostic line only. */
const COMMAND_OF = { track: "NTI", artist: "NAT", album: "NAL" } as const;

/** The three fields, and the command that answers for each. */
const TEXT_QUERIES = [
	["track", "NTI"],
	["artist", "NAT"],
	["album", "NAL"],
] as const satisfies readonly (readonly ["track" | "artist" | "album", string])[];

/**
 * Shortest gap between two cover downloads for one receiver.
 *
 * The cover cannot change more often than the track does, and the trigger is
 * device-driven, so this bounds what a chatty or misbehaving source can make the
 * plugin do. Deliberately below a plausible track length, so a genuine change is never
 * the one that gets dropped.
 */
export const ART_FETCH_MIN_INTERVAL_MS = 2_000;

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
	settleMs?: number;
	maxWaitMs?: number;
	/** Injected for tests; production uses `Date.now`. */
	now?: () => number;
	/**
	 * Injected for tests; production uses `setTimeout`. Returns the canceller.
	 *
	 * The tracker runs on an injected clock, so a real timer would make the settle
	 * window untestable — and untested is exactly what let the leading edge ship.
	 */
	schedule?: (fn: () => void, ms: number) => () => void;
	/**
	 * Whether the cover may be fetched from the receiver's web server.
	 *
	 * A function rather than a flag, because the user can change it while the plugin
	 * runs and the tracker must not hold a stale copy.
	 */
	httpEnabled?: () => boolean;
	/** Injected for tests. */
	fetchOptions?: FetchArtOptions;
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
	/** While the initial fill is still arriving, nothing is announced. */
	suppressUntil: number;
	/** When the current announcement burst began, for the max-wait bound. */
	burstStartedAt?: number;
	/** Which commands arrived and when, for the diagnostic line. Never their values. */
	burstShape?: string[];
	/** Cancels the pending settle window, if one is armed. */
	cancelSettle?: () => void;
}

/** Commands that are queried once when a host is first watched. */
const PRIME_COMMANDS = ["NTI", "NAT", "NAL", "NTM", "NST", "NMS"] as const;

/**
 * How long a completed pre-fill counts as current.
 *
 * Long, because it only has to cover the burst of elements binding together at
 * startup or on a profile switch; after that the receiver pushes changes by itself
 * and there is nothing to ask for.
 */
export const PRIME_COOLDOWN_MS = 60_000;

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
	/** In-flight pre-fills, so simultaneous binds share one round of queries. */
	private readonly priming = new Map<string, Promise<void>>();
	private readonly primedAt = new Map<string, number>();
	/** Hosts with a cover request in flight, so a burst does not start several. */
	private readonly fetching = new Set<string>();
	/** When each host was last asked, for the rate limit. */
	private readonly lastFetchAt = new Map<string, number>();
	private readonly httpEnabled: () => boolean;
	private readonly fetchOptions: FetchArtOptions;
	private readonly deps: NowPlayingDeps;
	private readonly maxHosts: number;
	private readonly cooldownMs: number;
	private readonly settleMs: number;
	private readonly maxWaitMs: number;
	private readonly schedule: (fn: () => void, ms: number) => () => void;
	private readonly now: () => number;
	private unsubscribe: (() => void)[] = [];
	/**
	 * The most recent announcement, so a test can await the confirmation round trip.
	 * Production never needs it: the listeners fire when it resolves.
	 */
	private settled: Promise<void> = Promise.resolve();

	constructor(deps: NowPlayingDeps, options: NowPlayingOptions = {}) {
		this.deps = deps;
		this.maxHosts = options.maxHosts ?? MAX_NOW_PLAYING_HOSTS;
		this.cooldownMs = options.cooldownMs ?? TRACK_CHANGE_COOLDOWN_MS;
		this.settleMs = options.settleMs ?? TRACK_CHANGE_SETTLE_MS;
		this.maxWaitMs = options.maxWaitMs ?? TRACK_CHANGE_MAX_WAIT_MS;
		this.schedule = options.schedule ?? defaultSchedule;
		this.now = options.now ?? Date.now;
		this.httpEnabled = options.httpEnabled ?? (() => true);
		this.fetchOptions = options.fetchOptions ?? {};
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

	/**
	 * Resolves once the pending announcement (including its confirmation queries) is
	 * out. For tests; production has no reason to wait for it.
	 */
	whenSettled(): Promise<void> {
		return this.settled;
	}

	stop(): void {
		this.unsubscribe.forEach((u) => u());
		this.unsubscribe = [];
		for (const entry of this.hosts.values()) entry.cancelSettle?.();
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
	 * Ask the receiver for the current metadata once **per host**.
	 *
	 * Needed because none of these commands is volunteered on connect — only on a
	 * track change — so a freshly placed key would otherwise stay blank until the
	 * song ends.
	 *
	 * The de-duplication is not tidiness. Every element that watches metadata calls
	 * this when it binds, and they all bind at once when the plugin starts or a
	 * profile is switched: eight elements meant **48 simultaneous queries** at a
	 * receiver that answers one connection. Repeats are folded into the in-flight
	 * request, and a completed prime is not repeated within `PRIME_COOLDOWN_MS` —
	 * after that the pushed updates have long taken over anyway.
	 *
	 * Queries are issued **one at a time** for the same reason. Failures are ignored
	 * on purpose: a missing pre-fill costs one blank display, and this must never be
	 * why a key fails to bind.
	 */
	async prime(host: string): Promise<void> {
		this.entry(host);
		const inFlight = this.priming.get(host);
		if (inFlight) return inFlight;
		const last = this.primedAt.get(host);
		if (last !== undefined && this.now() - last < PRIME_COOLDOWN_MS) return;

		const run = (async () => {
			// A cover, immediately. Neither the text nor the art is volunteered on
			// connect, and over HTTP one request settles it without waiting for the
			// track to end. Independent of the queries, so a receiver without a web
			// server simply falls back to whatever gets pushed later.
			if (this.httpEnabled()) void this.fetchArtOverHttp(host);
			for (const command of PRIME_COMMANDS) {
				try {
					await this.deps.queryCommand(host, command);
				} catch {
					// A command this source does not implement simply times out; the next
					// one is still worth asking for.
				}
			}
		})();
		this.priming.set(host, run);
		try {
			await run;
		} finally {
			this.priming.delete(host);
			this.primedAt.set(host, this.now());
		}
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
				// LINK mode: the receiver announces a URL instead of streaming the bytes.
				// Measured: one frame with image type 2 carrying
				// "http://<ip>/album_art.cgi", where data mode would have sent 368-792
				// frames of hex. Fetching is asynchronous and the result arrives through
				// the same `art` notification, so nothing here waits.
				if (parameter.startsWith("2") && this.httpEnabled()) {
					void this.fetchArtOverHttp(host, parameter.slice(2));
					return;
				}
				const image = this.art.accept(host, parameter, this.now());
				if (image === undefined) return; // still assembling, or nothing for us
				// The receiver retransmits the whole cover on every connect, and the
				// offline backoff reconnects at 5/10/30/60 s — so the identical ~97 KB
				// arrives again and again on a flapping link. Keeping the *existing*
				// object when the content matches makes the whole downstream chain a
				// no-op: the composition cache is keyed on the buffer, so nothing is
				// re-encoded, and the resulting data URI is identical, so the paint
				// de-duplication suppresses the write too.
				if (image !== null && entry.state.art?.hash === image.hash) {
					logger.debug(`${host}: cover unchanged (${image.hash}), nothing to redraw`);
					return;
				}
				entry.state = { ...entry.state, art: image ?? undefined };
				return this.notify(entry, "art");
			}
			default:
				return;
		}
	}

	/**
	 * Take a cover from the receiver's web server and publish it like any other.
	 *
	 * Serialised per host: a track change can produce a URL announcement while an
	 * earlier fetch is still running, and two in flight would race to set the state.
	 * The same content hash as the inline path means an unchanged picture costs
	 * nothing downstream.
	 */
	private async fetchArtOverHttp(host: string, announcedUrl?: string): Promise<void> {
		if (this.fetching.has(host)) return;
		// Rate limit, on top of the in-flight guard. The announcement is device-driven:
		// a source that flaps, or a receiver re-announcing on every metadata event, would
		// otherwise mean one download per event. The cover cannot change faster than the
		// track does, so a floor of a second or two costs nothing real.
		const last = this.lastFetchAt.get(host);
		if (last !== undefined && this.now() - last < ART_FETCH_MIN_INTERVAL_MS) return;
		this.lastFetchAt.set(host, this.now());
		this.fetching.add(host);
		try {
			const image = await fetchCoverOverHttp(host, announcedUrl, this.fetchOptions);
			const entry = this.hosts.get(host);
			// The element may have gone away while the request was in flight.
			if (!entry || !image) return;
			if (entry.state.art?.hash === image.hash) return;
			// Info, not debug: once per track change at most, and it is the one line that
			// tells a user which of the two cover paths their receiver is actually using.
			logger.info(`${host}: cover taken over HTTP (${image.bytes.length} B, ${image.hash})`);
			entry.state = { ...entry.state, art: image };
			this.notify(entry, "art");
		} finally {
			this.fetching.delete(host);
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
			entry.suppressUntil = now + this.cooldownMs;
			logger.debug(`${host}: now playing "${value ?? ""}" (initial, no notification)`);
			return;
		}
		// The rest of the initial fill, which is a burst like any other.
		if (now < entry.suppressUntil) return;

		// Re-armed by **every** field of the burst, not just the first. A fixed window
		// started by the title assumes the artist is inside it, and the whole point of
		// this code is that that assumption is what went wrong: the fields arrive apart,
		// and how far apart is the receiver's business, not ours. Bounded from the first
		// field so a source that dribbles cannot postpone the display indefinitely.
		if (entry.burstStartedAt === undefined) {
			entry.burstStartedAt = now;
			entry.burstShape = [];
		}
		entry.burstShape?.push(`${COMMAND_OF[field]}@${now - entry.burstStartedAt}`);
		const wait = Math.max(0, Math.min(this.settleMs, entry.burstStartedAt + this.maxWaitMs - now));
		entry.cancelSettle?.();
		entry.cancelSettle = this.schedule(() => {
			const startedAt = entry.burstStartedAt ?? now;
			const shape = (entry.burstShape ?? []).join(" ");
			entry.cancelSettle = undefined;
			entry.burstStartedAt = undefined;
			entry.burstShape = undefined;
			this.settled = this.announce(host, entry, startedAt, shape);
		}, wait);
	}

	/**
	 * Confirm what is playing, then tell everyone.
	 *
	 * The pushed fields are **fragments**: they arrive separately, at a spacing the
	 * receiver chooses, and this display freezes whatever it is handed. Waiting longer
	 * made that less likely but could not make it certain — and it cannot help at all
	 * with a field the receiver simply does not push for a given track, which leaves the
	 * *previous* song's value sitting in the state.
	 *
	 * So the state is confirmed against the device before it goes out. `NTI`/`NAT`/`NAL`
	 * all answer `QSTN` (measured; `prime` already relies on it), which makes this a
	 * question rather than an assembly. Three queries per track change, behind the
	 * ConnectionManager's per-host rate limit.
	 *
	 * Best-effort throughout: a query that fails leaves the pushed value in place, which
	 * is exactly what would have been shown anyway.
	 */
	private async announce(host: string, entry: HostEntry, startedAt: number, shape: string): Promise<void> {
		// Nobody is looking; the queries would be pure cost.
		if (entry.trackChanges.size === 0) return;
		const before = trackIdentity(entry.state);
		await this.confirmText(host, entry);
		const after = trackIdentity(entry.state);
		// Content-free on purpose: which commands arrived and when, never what they said.
		// `corrected` is the interesting bit — it says the pushed fragments alone would
		// have been wrong.
		logger.info(
			`${host}: track change after ${this.now() - startedAt} ms [${shape}]${before === after ? "" : " corrected by query"}`,
		);
		for (const listener of entry.trackChanges) {
			try {
				listener(entry.state);
			} catch (err) {
				logger.warn(`track-change listener threw: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/**
	 * Read the three text fields back from the receiver and apply the answers.
	 *
	 * Deliberately not routed through `applyText`: that is the push path, and re-entering
	 * it would start a fresh burst for the very announcement being made. The identity is
	 * re-stamped afterwards so a later push of the same value is correctly seen as no
	 * change.
	 */
	private async confirmText(host: string, entry: HostEntry): Promise<void> {
		const answers = await Promise.allSettled(TEXT_QUERIES.map(([, command]) => this.deps.queryCommand(host, command)));
		// Deliberately text only. `NTM` was in here briefly, to stop a frozen progress bar
		// showing the previous track's position — and it did not fix it: at the moment of
		// a change the receiver has no useful elapsed time to give, pushed or asked for.
		// The display now leaves the bar out instead (see `buildPanelFace`), which is also
		// the more honest answer, since a track that just started is at zero anyway.
		answers.forEach((answer, i) => {
			if (answer.status !== "fulfilled") return;
			const field = TEXT_QUERIES[i]![0];
			const value = sanitiseDeviceText(answer.value, MAX_TEXT_LENGTH) || undefined;
			// An empty answer never clears a value the receiver pushed. "The device said
			// nothing" is weaker evidence than "the device announced this a moment ago" —
			// a firmware that does not implement the query, or a reply lost in the middle
			// of a cover transfer, would otherwise wipe a perfectly good artist. A track
			// that genuinely has none arrives as an empty *push*, which does clear it.
			if (value === undefined) return;
			if (entry.state[field] === value) return;
			entry.state = { ...entry.state, [field]: value };
			this.notify(entry, "text");
		});
		entry.identity = trackIdentity(entry.state);
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
				this.hosts.get(victim)?.cancelSettle?.();
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
			suppressUntil: 0,
		};
		this.hosts.set(host, entry);
		return entry;
	}

	private dropIfUnwatched(host: string, entry: HostEntry): void {
		if (entry.updates.size > 0 || entry.trackChanges.size > 0) return;
		// Nothing is looking any more, so stop paying for the cover-art stream.
		entry.cancelSettle?.();
		this.hosts.delete(host);
		this.art.forget(host);
	}
}

/**
 * Whether covers may be fetched over HTTP.
 *
 * Injected rather than imported, because the setting lives in the action layer and
 * the adapter must not depend on it — the same reason `setAdapterLogger` and
 * `setGlobalSettingsWriter` exist. Defaults to on, so a tracker created before
 * `plugin.ts` has wired anything still behaves the way the setting's default says.
 */
let coverHttpPolicy: () => boolean = () => true;

export function setCoverHttpPolicy(policy: () => boolean): void {
	coverHttpPolicy = policy;
}

let singleton: NowPlayingTracker | undefined;

/**
 * Process-wide tracker.
 *
 * Created on first use against the real ConnectionManager, exactly like
 * `getDeviceStatusTracker` — no explicit wiring step in `plugin.ts`, because the
 * tracker costs nothing until an action subscribes (hosts nobody watches are dropped
 * before any work happens).
 */
export function getNowPlayingTracker(deps: NowPlayingDeps = ConnectionManager.getInstance()): NowPlayingTracker {
	if (!singleton) {
		// Read through a function, not captured: the user can toggle it while running.
		singleton = new NowPlayingTracker(deps, { httpEnabled: () => coverHttpPolicy() });
		singleton.start();
	}
	return singleton;
}

/** Tests only: drop the singleton so each file starts clean. */
export function resetNowPlayingTracker(): void {
	singleton?.stop();
	singleton = undefined;
}
