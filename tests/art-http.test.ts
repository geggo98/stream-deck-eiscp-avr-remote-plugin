/**
 * Fetching the cover from the receiver's own web server.
 *
 * Measured on the reference VSX-S520D (2026-07-27): `http://<ip>/album_art.cgi`
 * answers unauthenticated with a valid JPEG and **follows the track immediately** — a
 * skip and the very first request already returned the new picture. The widespread
 * "static, non-refreshing image" report is client-side caching.
 *
 * The tests below are mostly about the URL, because that is the part the *device*
 * controls: in LINK mode the receiver announces where its art lives, and a receiver
 * that named some other host would otherwise have the plugin fetching from an address
 * the user never configured.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { artPathFrom, DEFAULT_ART_PATH, fetchCoverOverHttp } from "../src/adapter/eiscp/art-http.ts";
import { MAX_ART_BYTES } from "../src/adapter/eiscp/jacket-art.ts";

function jpeg(bytes = 64): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(bytes, 0x41), Buffer.from([0xff, 0xd9])]);
}

/** A fetch stand-in that records what was asked for. */
function fakeFetch(body: Buffer | null, init: { status?: number; headers?: Record<string, string> } = {}) {
	const calls: string[] = [];
	const impl = (async (url: string | URL) => {
		calls.push(String(url));
		return {
			ok: (init.status ?? 200) < 400,
			status: init.status ?? 200,
			headers: new Headers(init.headers ?? {}),
			arrayBuffer: async () => (body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)),
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

describe("the announced URL", () => {
	it("keeps only the path, never the host the device named", () => {
		// The security property. The receiver announces "http://10.2.0.32/album_art.cgi"
		// when it is the receiver — but the announcement is device-controlled input, and
		// a request must go to the address the user configured, not to one a device
		// picked.
		assert.equal(artPathFrom("http://10.2.0.32/album_art.cgi"), "/album_art.cgi");
		assert.equal(artPathFrom("http://evil.example.com/steal"), "/steal");
		assert.equal(artPathFrom("http://user:pass@10.2.0.32/x"), DEFAULT_ART_PATH, "credentials are refused outright");
	});

	it("refuses schemes that are not http", () => {
		for (const bad of ["file:///etc/passwd", "data:image/jpeg;base64,AAAA", "ftp://host/a", "javascript:alert(1)"]) {
			assert.equal(artPathFrom(bad), DEFAULT_ART_PATH, bad);
		}
	});

	it("accepts a bare path, which some firmwares may announce instead", () => {
		assert.equal(artPathFrom("/cover.jpg"), "/cover.jpg");
		// Protocol-relative is an authority in disguise, so it is not a path.
		assert.equal(artPathFrom("//evil.example.com/x"), DEFAULT_ART_PATH);
	});

	it("falls back to the measured path when nothing usable is announced", () => {
		for (const nothing of [undefined, "", "   ", "not a url"]) {
			assert.equal(artPathFrom(nothing), DEFAULT_ART_PATH, JSON.stringify(nothing));
		}
	});

	it("keeps a query string, since it may be what selects the image", () => {
		assert.equal(artPathFrom("http://10.2.0.32/art.cgi?id=7"), "/art.cgi?id=7");
	});
});

describe("fetching", () => {
	it("requests the configured receiver, whatever the device announced", async () => {
		const { impl, calls } = fakeFetch(jpeg());
		await fetchCoverOverHttp("10.0.0.5", "http://somewhere.else/album_art.cgi", { fetchImpl: impl });
		assert.deepEqual(calls, ["http://10.0.0.5/album_art.cgi"]);
	});

	it("returns a verified image with the same hash the inline path uses", async () => {
		const body = jpeg(512);
		const { impl } = fakeFetch(body);
		const image = await fetchCoverOverHttp("10.0.0.5", undefined, { fetchImpl: impl });
		assert.ok(image);
		assert.equal(image.type, "jpeg");
		assert.equal(image.bytes.length, body.length);
		assert.match(image.hash, /^[0-9a-f]{16}$/);
		// Frames is 0: this one did not arrive in frames at all.
		assert.equal(image.frames, 0);
	});

	it("checks the bytes, not the content type", async () => {
		// A web server can claim anything, and this goes straight to a renderer.
		const { impl } = fakeFetch(Buffer.from("<html>not an image</html>"), {
			headers: { "content-type": "image/jpeg" },
		});
		assert.equal(await fetchCoverOverHttp("10.0.0.5", undefined, { fetchImpl: impl }), undefined);
	});

	it("rejects a truncated JPEG rather than rendering half of one", async () => {
		const { impl } = fakeFetch(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(32, 0x41)]));
		assert.equal(await fetchCoverOverHttp("10.0.0.5", undefined, { fetchImpl: impl }), undefined);
	});

	it("bounds the download, by the header and by what actually arrives", async () => {
		// The declared length is a claim; this firmware does not even send a standard
		// Content-Length (it sends "Content-size"), so the second check is the real one.
		const lying = fakeFetch(jpeg(MAX_ART_BYTES + 1024), { headers: { "content-length": "10" } });
		assert.equal(await fetchCoverOverHttp("10.0.0.5", undefined, { fetchImpl: lying.impl }), undefined);

		const declared = fakeFetch(jpeg(64), { headers: { "content-length": String(MAX_ART_BYTES + 1) } });
		assert.equal(await fetchCoverOverHttp("10.0.0.5", undefined, { fetchImpl: declared.impl }), undefined);
		assert.deepEqual(declared.calls.length, 1, "refused after the headers, without reading the body");
	});

	it("gives up quietly on an error status or a thrown request", async () => {
		// A missing cover is cosmetic; it must never be why something else breaks.
		const notFound = fakeFetch(null, { status: 404 });
		assert.equal(await fetchCoverOverHttp("10.0.0.5", undefined, { fetchImpl: notFound.impl }), undefined);

		const boom = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		assert.equal(await fetchCoverOverHttp("10.0.0.5", undefined, { fetchImpl: boom }), undefined);
	});

	it("asks for a fresh copy, because a cached one is the reported 'static image'", async () => {
		let seen: RequestInit | undefined;
		const impl = (async (_url: string, init: RequestInit) => {
			seen = init;
			return {
				ok: true,
				status: 200,
				headers: new Headers(),
				arrayBuffer: async () => jpeg().buffer,
			} as unknown as Response;
		}) as unknown as typeof fetch;
		await fetchCoverOverHttp("10.0.0.5", undefined, { fetchImpl: impl });
		assert.equal(seen?.cache, "no-store");
	});
});

describe("the plugin never changes the receiver's jacket-art mode", () => {
	it("sends no NJA command that would switch modes, anywhere in src/", async () => {
		// The requirement, as a test rather than as a comment: the manufacturer's own app
		// very likely uses LINK mode too, and per the vendor workbook the setting is
		// device-wide — "If Jacket Art is disable from one of controllers, All controllers
		// cannot display Jacket Art." A plugin that asserted its preferred mode would
		// fight every other controller on the network for it.
		//
		// So both modes are simply served: a URL frame is fetched over HTTP, inline
		// frames are reassembled, and whatever the device is set to stays set.
		const { readFileSync, readdirSync, statSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const { join } = await import("node:path");

		const root = fileURLToPath(new URL("../src", import.meta.url));
		const files: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir)) {
				const full = join(dir, entry);
				if (statSync(full).isDirectory()) walk(full);
				else if (full.endsWith(".ts")) files.push(full);
			}
		};
		walk(root);

		// The four mode-setting parameters from the spec. `REQ` is deliberately allowed:
		// it asks for the art without changing anything.
		const forbidden = /["'](LINK|BMP|ENA|DIS)["']/;
		const offenders: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf8");
			// Only lines that actually send something.
			for (const line of source.split("\n")) {
				if (!/\bsend\s*\(/.test(line)) continue;
				if (!/NJA/.test(line)) continue;
				if (forbidden.test(line)) offenders.push(`${file}: ${line.trim()}`);
			}
		}
		assert.deepEqual(offenders, [], "the plugin must never set the jacket-art mode");
	});
});
