/**
 * Reassemble the cover art the receiver streams as `NJA` frames.
 *
 * This is the first place in the plugin where device-controlled *bytes* are
 * accumulated and later rendered, so it is written as a bounded state machine with
 * a pure core: `nextArtState` folds one frame into the state and says what
 * happened, and `JacketArtAccumulator` adds nothing but a per-host map and a clock.
 *
 * Wire format (vendor spec, `docs/eiscp-commands.yaml` → `NJA`):
 *
 *     !1NJA <t> <p> <hex…>
 *       t = 0 BMP, 1 JPEG, 2 URL, n No Image
 *       p = 0 Start, 1 Next, 2 End, "-" not used (URL / no-image forms)
 *       hex = image data, "1024 ASCII HEX letters max" per frame
 *
 * Measured against the reference VSX-S520D under AirPlay, because every constant
 * below comes from that measurement rather than from the spec's maxima:
 *
 *   - the receiver sends a full transfer **unsolicited** on connect and on every
 *     track change (`NJAREQ` triggers an extra one),
 *   - one image is **45 217 B or 97 357 B** (two samples, both JPEG 512×512) —
 *     note the pre-existing `raw-dump.bin` fixture at 20 752 B is the *smallest*
 *     of three, not the typical one,
 *   - it arrives in **368 / 792 frames** of 246 hex characters (123 bytes) each,
 *     back to back: 792 frames in 443 ms, median inter-frame gap 0 ms,
 *   - the flag sequence is exactly one `0`, n × `1`, one `2`, and the End frame
 *     carries data too.
 *
 * Two consequences that shape the design:
 *
 *   - **Nothing may be rendered or logged per frame.** ~1 800 frames/s would swamp
 *     both the deck and the log files, so the only output is one `complete` event.
 *   - **The transfer is the unbounded thing, not the frame.** A single frame is
 *     0.4 % of `MAX_FRAME_BYTES`; it is this accumulator that a peer could grow
 *     without limit by sending `p=1` forever, so the caps live here.
 */

import { scopedLogger } from "../logging.ts";

const logger = scopedLogger("JacketArt");

/** Image container the receiver claims — and that we verify ourselves. */
export type ArtImageType = "jpeg" | "bmp";

export interface ArtImage {
	type: ArtImageType;
	bytes: Buffer;
	/** How many frames it took; useful for logging without touching the payload. */
	frames: number;
}

/** One decoded `NJA` parameter. */
export interface ArtFrame {
	/** Raw type character as sent; not trusted, only compared for consistency. */
	type: string;
	/** Raw packet flag as sent. */
	flag: string;
	/** Everything after the two leading characters. */
	payload: string;
}

interface PendingTransfer {
	type: string;
	chunks: Buffer[];
	bytes: number;
	frames: number;
	lastAt: number;
}

export interface ArtState {
	pending?: PendingTransfer;
}

export const INITIAL_ART_STATE: ArtState = {};

/**
 * Largest image we will assemble. Measured maximum is 97 357 B; this leaves 5×
 * headroom for a higher-resolution cover from another source while still bounding
 * what one peer can make the plugin hold.
 */
export const MAX_ART_BYTES = 512 * 1024;
/** Frames per transfer. Measured maximum is 792. */
export const MAX_ART_FRAMES = 8192;
/**
 * A partial transfer is discarded after this long without a frame. A Start frame
 * with no End would otherwise pin its allocation for the life of the process, and
 * the measured whole-transfer time is 443–752 ms, so this is an order of magnitude
 * of slack rather than a guess.
 */
export const ART_IDLE_MS = 5_000;
/** Hosts accumulating at once; bounded like every other map fed from the wire. */
export const MAX_ART_HOSTS = 8;

/** What one frame did. Anything other than `complete` produces no render. */
export type ArtOutcome =
	| { kind: "progress" }
	/** A finished, self-verified image. */
	| { kind: "complete"; image: ArtImage }
	/** The receiver says there is no art (`t = "n"`); drop whatever we showed. */
	| { kind: "cleared" }
	/** Not an error: a frame that carries nothing for us (URL mode, stray flag). */
	| { kind: "ignored"; reason: string }
	/** A limit was exceeded or the data was malformed; the transfer is dropped. */
	| { kind: "rejected"; reason: string };

export interface ArtStep {
	state: ArtState;
	outcome: ArtOutcome;
}

/**
 * Split an `NJA` parameter into its three fields.
 *
 * Returns `undefined` for anything too short to have the two leading fields —
 * `NJA` also answers `QSTN` with an enable token (measured: `"BMP"`), and that is
 * not a data frame.
 */
export function parseArtFrame(parameter: string): ArtFrame | undefined {
	if (parameter.length < 2) return undefined;
	return { type: parameter[0]!, flag: parameter[1]!, payload: parameter.slice(2) };
}

/** Hex, and decodable as such. */
const HEX_ONLY = /^[0-9A-Fa-f]*$/;

/**
 * Decode a hex chunk, or fail.
 *
 * `Buffer.from(x, "hex")` does **not** throw on invalid input — it silently stops
 * at the first bad pair and returns a short buffer. Accepting that would mean
 * assembling a truncated image and calling it a success, so the validation has to
 * happen before the decode, not after.
 */
function decodeHex(payload: string): Buffer | undefined {
	if (payload.length % 2 !== 0) return undefined;
	if (!HEX_ONLY.test(payload)) return undefined;
	return Buffer.from(payload, "hex");
}

/**
 * Verify the container from the bytes themselves.
 *
 * The `t` field is a claim by the peer. The older spec variant in the vendor
 * workbook lists only `0:BMP, 1:JPEG` while the newer one adds `2:URL, n:No Image`,
 * so an unknown `t` means "this firmware speaks a dialect we do not", not "assume
 * JPEG". Checking the magic bytes instead means a mislabelled or corrupt transfer
 * is dropped rather than handed to a renderer.
 */
function verifyImage(bytes: Buffer): ArtImageType | undefined {
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		// JPEG must also end in EOI; a truncated transfer that happens to start
		// correctly is exactly what we must not render.
		if (bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return "jpeg";
		return undefined;
	}
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
	return undefined;
}

/**
 * Fold one frame into the transfer state.
 *
 * Pure: `now` is passed in, nothing is logged, and the returned state shares no
 * mutable structure with the input.
 */
export function nextArtState(state: ArtState, frame: ArtFrame, now: number): ArtStep {
	// "No image" is a statement about the present, so it applies whether or not a
	// transfer is running — and it cancels one.
	if (frame.type === "n") return { state: {}, outcome: { kind: "cleared" } };

	// URL mode. Deliberately not followed: the payload is a peer-supplied address,
	// and fetching it would turn a display feature into an outbound request to an
	// origin the receiver chose. The value is not even parsed here.
	if (frame.type === "2") {
		return { state, outcome: { kind: "ignored", reason: "URL mode (t=2) is not rendered" } };
	}

	if (frame.type !== "0" && frame.type !== "1") {
		return { state, outcome: { kind: "ignored", reason: `unknown image type ${JSON.stringify(frame.type)}` } };
	}

	// Drop a stalled transfer before doing anything else, so a resumed stream after
	// a long gap starts clean instead of splicing two images together.
	let pending = state.pending;
	if (pending && now - pending.lastAt > ART_IDLE_MS) pending = undefined;

	const isStart = frame.flag === "0";
	if (!isStart && frame.flag !== "1" && frame.flag !== "2") {
		return { state: { pending }, outcome: { kind: "ignored", reason: `unknown packet flag ${JSON.stringify(frame.flag)}` } };
	}

	// A continuation with nothing to continue: the plugin connected mid-transfer, or
	// the Start frame was dropped. Waiting for the next Start is the only safe move.
	if (!isStart && !pending) {
		return { state: {}, outcome: { kind: "ignored", reason: "continuation without a start frame" } };
	}
	// A type switch mid-transfer means the two halves are not one image.
	if (!isStart && pending && pending.type !== frame.type) {
		return { state: {}, outcome: { kind: "rejected", reason: "image type changed mid-transfer" } };
	}

	const chunk = decodeHex(frame.payload);
	if (chunk === undefined) {
		return { state: {}, outcome: { kind: "rejected", reason: "payload is not even-length hex" } };
	}

	// A Start frame always begins a fresh transfer, discarding any partial one.
	const base: PendingTransfer = isStart
		? { type: frame.type, chunks: [], bytes: 0, frames: 0, lastAt: now }
		: pending!;

	const bytes = base.bytes + chunk.length;
	const frames = base.frames + 1;
	if (bytes > MAX_ART_BYTES) {
		return { state: {}, outcome: { kind: "rejected", reason: `image exceeds ${MAX_ART_BYTES} bytes` } };
	}
	if (frames > MAX_ART_FRAMES) {
		return { state: {}, outcome: { kind: "rejected", reason: `transfer exceeds ${MAX_ART_FRAMES} frames` } };
	}

	const next: PendingTransfer = {
		type: base.type,
		chunks: [...base.chunks, chunk],
		bytes,
		frames,
		lastAt: now,
	};

	if (frame.flag !== "2") return { state: { pending: next }, outcome: { kind: "progress" } };

	// End frame: one concat for the whole transfer (per-frame Buffer.concat is the
	// quadratic pattern that was removed from the receive buffer), then verify.
	const assembled = Buffer.concat(next.chunks, next.bytes);
	const type = verifyImage(assembled);
	if (type === undefined) {
		return { state: {}, outcome: { kind: "rejected", reason: "assembled data is not a valid JPEG or BMP" } };
	}
	return {
		state: {},
		outcome: { kind: "complete", image: { type, bytes: assembled, frames: next.frames } },
	};
}

/**
 * Per-host accumulation on top of the reducer.
 *
 * Deliberately thin: a bounded map, a clock, and logging that never touches the
 * payload. A completed image is handed to the caller once; nothing is cached here,
 * because whoever renders it owns how long it lives.
 */
export class JacketArtAccumulator {
	private readonly states = new Map<string, ArtState>();
	private readonly maxHosts: number;

	constructor(options: { maxHosts?: number } = {}) {
		this.maxHosts = options.maxHosts ?? MAX_ART_HOSTS;
	}

	/**
	 * Feed one raw `NJA` parameter. Returns the completed image on the frame that
	 * finishes a transfer, `null` when the receiver reports no art, and `undefined`
	 * the rest of the time.
	 */
	accept(host: string, parameter: string, now = Date.now()): ArtImage | null | undefined {
		const frame = parseArtFrame(parameter);
		if (frame === undefined) return undefined; // e.g. the QSTN reply ("BMP")

		const current = this.states.get(host) ?? INITIAL_ART_STATE;
		const { state, outcome } = nextArtState(current, frame, now);

		if (state.pending === undefined) this.states.delete(host);
		else this.setState(host, state);

		switch (outcome.kind) {
			case "complete":
				logger.debug(`${host}: cover art assembled (${outcome.image.frames} frames, ${outcome.image.bytes.length} B, ${outcome.image.type})`);
				return outcome.image;
			case "cleared":
				logger.debug(`${host}: receiver reports no cover art`);
				return null;
			case "rejected":
				// Loud, because a rejection means either a broken peer or a bug here —
				// and quiet truncation is exactly what this class exists to prevent.
				logger.warn(`${host}: discarded cover art transfer: ${outcome.reason}`);
				return undefined;
			case "ignored":
			case "progress":
				return undefined;
		}
	}

	/** Drop a host's partial transfer (on disconnect, or when nothing is watching). */
	forget(host: string): void {
		this.states.delete(host);
	}

	/** Bytes currently held for a host; for tests and diagnostics. */
	pendingBytes(host: string): number {
		return this.states.get(host)?.pending?.bytes ?? 0;
	}

	private setState(host: string, state: ArtState): void {
		if (!this.states.has(host) && this.states.size >= this.maxHosts) {
			// Evict the oldest insertion (Map preserves it) rather than refuse: the
			// interesting host is normally the one that just spoke.
			const oldest = this.states.keys().next().value;
			if (oldest !== undefined) this.states.delete(oldest);
		}
		this.states.set(host, state);
	}
}
