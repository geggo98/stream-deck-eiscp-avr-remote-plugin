/**
 * Fetch the cover from the receiver's own web server instead of off the wire.
 *
 * Measured on the reference VSX-S520D (2026-07-27): the unit serves
 * `http://<ip>/album_art.cgi` unauthenticated, and it **follows the track
 * immediately** — a skip to the next song and the very first request already
 * returned the new picture (49 742 B -> 119 487 B, both valid JPEG 512x512). The
 * widely repeated claim that this endpoint is "a static, non-refreshing image" is a
 * client-side caching artefact; requesting with `no-store` shows it changing at once.
 *
 * Two reasons to prefer it when it is available:
 *
 *   - **It costs the eISCP link nothing.** In data mode one track change is 368–792
 *     frames of hex at ~1 800 frames/s down the single connection the receiver
 *     allows. Over HTTP it is one request on a separate socket.
 *   - **It works before anything has been pushed.** Inline art only arrives on connect
 *     or on a track change, so a freshly started plugin has no cover until the song
 *     ends. An HTTP request has one straight away.
 *
 * ## The rule about the URL
 *
 * When jacket art is in LINK mode the receiver announces the address itself, in an
 * `NJA` frame with image type `2`. That address is **device-controlled input**, so it
 * is not followed as given: only its path is taken, and the request always goes to the
 * receiver this plugin is already talking to. A receiver that pointed somewhere else —
 * compromised, misconfigured, or simply on a network where the address means something
 * different — would otherwise have the plugin fetching from a host the user never
 * configured.
 */

import { createHash } from "node:crypto";

import { scopedLogger } from "../logging.ts";
import { MAX_ART_BYTES, type ArtImage } from "./jacket-art.ts";

const logger = scopedLogger("ArtHttp");

/** The path this firmware serves the cover from, and the fallback when none is announced. */
export const DEFAULT_ART_PATH = "/album_art.cgi";

/** A slow or hanging web server must not hold up anything else. */
export const ART_FETCH_TIMEOUT_MS = 5_000;

/**
 * Reduce a device-announced URL to a path we are willing to request.
 *
 * Returns the path only — never a host. The caller pairs it with the receiver it is
 * already connected to, which is the whole point: whatever the device claims, the
 * request goes where the user pointed the plugin.
 *
 * Rejects anything that is not a plain http(s) URL, so a `file:`, `data:` or
 * credential-carrying address cannot get through.
 */
export function artPathFrom(announced: string | undefined): string {
	if (!announced) return DEFAULT_ART_PATH;
	let parsed: URL;
	try {
		parsed = new URL(announced.trim());
	} catch {
		// Some firmwares may announce a bare path rather than a full URL.
		const trimmed = announced.trim();
		return trimmed.startsWith("/") && !trimmed.startsWith("//") ? trimmed : DEFAULT_ART_PATH;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return DEFAULT_ART_PATH;
	if (parsed.username || parsed.password) return DEFAULT_ART_PATH;
	return `${parsed.pathname}${parsed.search}`;
}

/**
 * Read a response body, giving up the moment it exceeds the cap.
 *
 * `response.arrayBuffer()` cannot be used here: it buffers the **whole** body before
 * anything can look at the size, so a server that streams without end — or simply one
 * serving something far larger than a cover — decides how much memory this process
 * spends. That is the exact failure the repo's transport already guards against, and
 * a declared `Content-Length` is no substitute: it is a claim, and this firmware does
 * not even send one (it emits a non-standard `Content-size`), so on the real device
 * the streaming cap is the *only* bound.
 *
 * Chunks are collected and joined once at the end rather than concatenated per read —
 * the per-chunk concat is the quadratic pattern already removed from `ReceiveBuffer`.
 */
async function readBounded(response: Response, maxBytes: number, host: string): Promise<Buffer | undefined> {
	const reader = response.body?.getReader();
	if (!reader) {
		// No streaming body (a stubbed response in tests, or a runtime without it).
		// Falling back means trusting the peer, so the cap is applied immediately after
		// and this path stays the exception rather than the rule.
		const buffered = Buffer.from(await response.arrayBuffer());
		if (buffered.length > maxBytes) {
			logger.warn(`${host}: cover of ${buffered.length} bytes exceeds the ${maxBytes}-byte limit`);
			return undefined;
		}
		return buffered;
	}

	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				logger.warn(`${host}: cover stream passed the ${maxBytes}-byte limit; aborting`);
				await reader.cancel().catch(() => {});
				return undefined;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock?.();
	}
	return Buffer.concat(chunks, total);
}

export interface FetchArtOptions {
	/** Injected in tests. */
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	maxBytes?: number;
}

/**
 * The same container check the inline path applies: the bytes decide, not a header.
 *
 * A web server can claim any content type, and this image is about to be handed
 * straight to a renderer.
 */
function verify(bytes: Buffer): ArtImage["type"] | undefined {
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		return bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9 ? "jpeg" : undefined;
	}
	if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
	return undefined;
}

/**
 * Fetch the cover from `host`, using the path the device announced (if any).
 *
 * Resolves to `undefined` on every failure — a missing cover is a cosmetic loss, and
 * this must never be a reason something else breaks. Failures are logged at debug,
 * because a receiver without a web server would otherwise fill the log once per track.
 */
export async function fetchCoverOverHttp(
	host: string,
	announcedUrl?: string,
	options: FetchArtOptions = {},
): Promise<ArtImage | undefined> {
	const doFetch = options.fetchImpl ?? fetch;
	const maxBytes = options.maxBytes ?? MAX_ART_BYTES;
	const path = artPathFrom(announcedUrl);
	// Built from the host we are connected to, never from the announced authority.
	const url = `http://${host}${path}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? ART_FETCH_TIMEOUT_MS);
	timer.unref?.();
	try {
		// `no-store`: the endpoint updates the moment the track does, and a cached
		// response is exactly the "static image" other integrations report.
		const response = await doFetch(url, { signal: controller.signal, cache: "no-store" });
		if (!response.ok) {
			logger.debug(`${host}: cover request returned ${response.status}`);
			return undefined;
		}
		// Check the declared length before reading, so an absurd one costs nothing.
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > maxBytes) {
			logger.warn(`${host}: cover of ${declared} bytes exceeds the ${maxBytes}-byte limit`);
			return undefined;
		}
		const bytes = await readBounded(response, maxBytes, host);
		if (!bytes) return undefined;
		const type = verify(bytes);
		if (!type) {
			logger.debug(`${host}: cover response is not a JPEG or BMP (${bytes.length} bytes)`);
			return undefined;
		}
		return { type, bytes, frames: 0, hash: createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
	} catch (err) {
		logger.debug(`${host}: cover request failed: ${err instanceof Error ? err.message : String(err)}`);
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
