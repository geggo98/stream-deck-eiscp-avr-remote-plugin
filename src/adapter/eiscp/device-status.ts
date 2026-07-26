/**
 * Track what a receiver currently is: on, in standby, or not there at all.
 *
 * The three cases look identical to a Stream Deck key today, yet they mean very
 * different things (measured on a VSX-S520D, see
 * `tests/fixtures/standby-behaviour-capture.json`):
 *
 *  - **on** – everything works.
 *  - **standby** – queries are still answered, but a SET is *silently* dropped:
 *    no echo, no state change, nothing on the display. The one exception is
 *    `SLI`, which powers the unit on. So a key press in standby usually looks
 *    successful (the TCP write went through) and does nothing at all.
 *  - **offline** – unplugged or unreachable; not even the internal state moves.
 *
 * Two halves, split so the decisions are testable without timers or sockets:
 * `nextState` is a pure reducer over everything we can observe, and
 * `DeviceStatusTracker` wires it to the ConnectionManager's message and
 * connection observers plus a `PWR` heartbeat.
 *
 * The heartbeat is NOT how state changes become visible: a `PWR` frame — including
 * the one the receiver sends after we power it on ourselves — reaches the message
 * observer and flips the status immediately. The heartbeat exists for the case
 * nothing announces: a receiver that vanishes mid-session leaves a half-open
 * socket, and kernel TCP keep-alive takes minutes to notice
 * (`transport.ts`: `setKeepAlive(true, 1000)`, then OS defaults).
 */

import { scopedLogger } from "../logging.ts";
import { ConnectionManager, type ConnectionEvent } from "./connection-manager.ts";

const logger = scopedLogger("DeviceStatus");

export type DeviceStatus = "unknown" | "on" | "standby" | "offline";

/** Everything that can tell us something about a receiver's state. */
export type StatusEvent =
	| { kind: "power"; raw: string }
	| { kind: "message" }
	| { kind: "connected" }
	| { kind: "disconnected" }
	| { kind: "connect-failed" }
	| { kind: "probe-failed" };

export interface HostState {
	status: DeviceStatus;
	/**
	 * Last power value we actually saw. Kept across an outage so that a host
	 * coming back is restored to what it was rather than to "unknown" — the
	 * receiver does not re-announce its power state on reconnect.
	 */
	lastPower?: "on" | "standby";
}

export const INITIAL_STATE: HostState = { status: "unknown" };

/**
 * Fold one observation into the host's state.
 *
 * `raw` is unvalidated wire data: only the two documented values mean something,
 * everything else (including the `ALL` used by the standby-all *command*) makes
 * the state honestly unknown rather than guessing a side.
 */
export function nextState(state: HostState, ev: StatusEvent): HostState {
	switch (ev.kind) {
		case "power":
			if (ev.raw === "01") return { status: "on", lastPower: "on" };
			if (ev.raw === "00") return { status: "standby", lastPower: "standby" };
			return { status: "unknown" };
		case "message":
		case "connected":
			// Anything arriving proves the receiver is reachable. What it *is* we
			// only know from PWR, so fall back to the last value we saw; the tracker
			// re-queries PWR on connect to settle it.
			if (state.status !== "offline") return state;
			return { ...state, status: state.lastPower ?? "unknown" };
		case "disconnected":
		case "connect-failed":
		case "probe-failed":
			if (state.status === "offline") return state;
			return { ...state, status: "offline" };
	}
}

/** How often a subscribed host is probed while it answers. */
export const HEARTBEAT_MS = 30_000;
/** Delays between reconnect probes while a host is offline; the last one repeats. */
export const OFFLINE_BACKOFF_MS: readonly number[] = [5_000, 10_000, 30_000, 60_000];
/**
 * Hosts kept in the map. Entries are created for every host we exchange messages
 * with, and while those come from user-configured addresses only, this map is
 * fed from the wire like every other one here — so it is bounded.
 */
export const MAX_TRACKED_HOSTS = 32;

/** The slice of ConnectionManager the tracker needs (structurally compatible). */
export interface StatusTrackerDeps {
	queryCommand(host: string, command: string): Promise<string>;
	addMessageObserver(cb: (host: string, command: string, parameter: string) => void): () => void;
	addConnectionObserver(cb: (host: string, event: ConnectionEvent) => void): () => void;
}

export interface StatusTrackerOptions {
	heartbeatMs?: number;
	offlineBackoffMs?: readonly number[];
	maxHosts?: number;
}

type StatusListener = (status: DeviceStatus) => void;

interface HostEntry extends HostState {
	listeners: Set<StatusListener>;
	timer?: ReturnType<typeof setTimeout>;
	/** Index into the backoff table while offline. */
	backoff: number;
	/** A probe is in flight; do not start a second one. */
	probing: boolean;
}

/**
 * Per-host power/reachability state, shared by every action bound to that host.
 *
 * Subscribing is also how interest is declared: the `PWR` heartbeat for a host
 * runs while at least one listener is attached and stops with the last one, so a
 * profile the user never opens costs nothing.
 */
export class DeviceStatusTracker {
	private readonly hosts = new Map<string, HostEntry>();
	private readonly deps: StatusTrackerDeps;
	private readonly heartbeatMs: number;
	private readonly backoffMs: readonly number[];
	private readonly maxHosts: number;
	private unsubscribe: (() => void)[] = [];

	// Written out rather than declared as constructor parameter properties: the
	// tests run these files through Node's strip-only type removal, which rejects
	// that syntax outright (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
	constructor(deps: StatusTrackerDeps, options: StatusTrackerOptions = {}) {
		this.deps = deps;
		this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
		this.backoffMs = options.offlineBackoffMs?.length ? options.offlineBackoffMs : OFFLINE_BACKOFF_MS;
		this.maxHosts = options.maxHosts ?? MAX_TRACKED_HOSTS;
	}

	/** Attach to the ConnectionManager. Idempotent. */
	start(): void {
		if (this.unsubscribe.length) return;
		this.unsubscribe.push(
			this.deps.addMessageObserver((host, command, parameter) => {
				// Every message proves reachability; PWR additionally says which side.
				this.apply(host, command === "PWR" ? { kind: "power", raw: parameter } : { kind: "message" });
			}),
			this.deps.addConnectionObserver((host, event) => {
				this.apply(host, { kind: event === "connected" ? "connected" : event });
				// A fresh session says nothing about the power state, and the receiver
				// does not volunteer it — ask, so a key does not sit on "unknown".
				if (event === "connected") this.probe(host);
			}),
		);
	}

	/** Detach and drop every timer (tests, shutdown). */
	stop(): void {
		this.unsubscribe.forEach((u) => u());
		this.unsubscribe = [];
		for (const entry of this.hosts.values()) this.clearTimer(entry);
		this.hosts.clear();
	}

	getStatus(host: string): DeviceStatus {
		return this.hosts.get(host)?.status ?? "unknown";
	}

	/**
	 * Watch a host. The returned function detaches; when the last listener for a
	 * host goes, its heartbeat stops.
	 */
	onStatus(host: string, listener: StatusListener): () => void {
		const entry = this.entry(host);
		entry.listeners.add(listener);
		this.schedule(entry, host);
		// A key that just appeared needs the state now, not at the next heartbeat.
		if (entry.status === "unknown") this.probe(host);
		return () => {
			entry.listeners.delete(listener);
			if (entry.listeners.size === 0) this.clearTimer(entry);
		};
	}

	/**
	 * Wait until a host reports `status`, or give up after `timeoutMs`.
	 *
	 * Resolves either way (`true` if it got there): used before sending a command
	 * to a receiver we just woke, where the command should still be attempted even
	 * if the confirmation is late — the receiver answers `PWR01` within about a
	 * second, but a slow one must not swallow the key press entirely.
	 */
	waitForStatus(host: string, status: DeviceStatus, timeoutMs: number): Promise<boolean> {
		if (this.getStatus(host) === status) return Promise.resolve(true);
		return new Promise((resolve) => {
			const done = (result: boolean): void => {
				clearTimeout(timer);
				off();
				resolve(result);
			};
			const timer = setTimeout(() => done(false), timeoutMs);
			timer.unref?.();
			const off = this.onStatus(host, (next) => {
				if (next === status) done(true);
			});
		});
	}

	private entry(host: string): HostEntry {
		let entry = this.hosts.get(host);
		if (!entry) {
			if (this.hosts.size >= this.maxHosts) {
				// Insertion order: drop the oldest entry that nobody is watching, so
				// an idle host cannot push out one that is on screen.
				for (const [key, value] of this.hosts) {
					if (value.listeners.size === 0) {
						this.clearTimer(value);
						this.hosts.delete(key);
						break;
					}
				}
			}
			entry = { ...INITIAL_STATE, listeners: new Set(), backoff: 0, probing: false };
			this.hosts.set(host, entry);
		}
		return entry;
	}

	private apply(host: string, ev: StatusEvent): void {
		const entry = this.entry(host);
		const before = entry.status;
		const next = nextState({ status: entry.status, lastPower: entry.lastPower }, ev);
		entry.status = next.status;
		entry.lastPower = next.lastPower;
		if (next.status !== "offline") entry.backoff = 0;
		if (before === next.status) return;
		logger.debug(`${host}: ${before} -> ${next.status} (${ev.kind})`);
		// Re-pace the timer: offline probes and heartbeats run at different rates.
		this.schedule(entry, host);
		for (const listener of entry.listeners) {
			try {
				listener(next.status);
			} catch (err) {
				logger.error(`status listener for ${host} threw: ${err}`);
			}
		}
	}

	/** Ask the receiver for its power state. Failure is itself an answer. */
	private probe(host: string): void {
		const entry = this.entry(host);
		if (entry.probing) return;
		entry.probing = true;
		this.deps
			.queryCommand(host, "PWR")
			.then((raw) => this.apply(host, { kind: "power", raw }))
			.catch((err) => {
				logger.debug(`${host}: power probe failed: ${err}`);
				this.apply(host, { kind: "probe-failed" });
			})
			.finally(() => {
				entry.probing = false;
				// Advance the backoff only after a probe actually completed, so a slow
				// timeout does not also burn a backoff step.
				if (entry.status === "offline" && entry.backoff < this.backoffMs.length - 1) entry.backoff++;
				this.schedule(entry, host);
			});
	}

	/** (Re-)arm the single timer for a host, at the rate its status calls for. */
	private schedule(entry: HostEntry, host: string): void {
		this.clearTimer(entry);
		if (entry.listeners.size === 0) return;
		const delay = entry.status === "offline" ? (this.backoffMs[entry.backoff] ?? this.heartbeatMs) : this.heartbeatMs;
		const timer = setTimeout(() => {
			entry.timer = undefined;
			this.probe(host);
		}, delay);
		// Never keep the process alive for a heartbeat (tests, scripts).
		timer.unref?.();
		entry.timer = timer;
	}

	private clearTimer(entry: HostEntry): void {
		if (entry.timer) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
	}
}

let instance: DeviceStatusTracker | undefined;

/**
 * The tracker every action shares, attached to the pooled ConnectionManager.
 *
 * Started on first use and by `plugin.ts` at startup, so the message observer is
 * in place before the first frame arrives. Tests construct their own instance
 * with injected deps instead of touching this.
 */
export function getDeviceStatusTracker(): DeviceStatusTracker {
	if (!instance) {
		instance = new DeviceStatusTracker(ConnectionManager.getInstance());
		instance.start();
	}
	return instance;
}
