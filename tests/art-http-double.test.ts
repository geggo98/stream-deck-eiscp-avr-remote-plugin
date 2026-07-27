/**
 * The cover-over-HTTP path against the test double's own web server.
 *
 * `tests/art-http.test.ts` covers the decisions with a stubbed `fetch`; this file
 * runs the same code against a real socket, because two of the properties only exist
 * end to end:
 *
 *   - the receiver sends a **non-standard `Content-size` header** instead of
 *     `Content-Length` (measured on the VSX-S520D), so nothing downstream may rely on
 *     a declared length;
 *   - therefore the only bound on the download is the streaming cap — and a server
 *     that never finishes its body has to be survivable, not merely rejected in
 *     theory.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { fetchCoverOverHttp } from "../src/adapter/eiscp/art-http.ts";
import { startMockReceiver } from "./helpers/mock-receiver.ts";

function jpeg(payload = 256): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(payload, 0x41), Buffer.from([0xff, 0xd9])]);
}

/** The double listens on 127.0.0.1 with a random port, so the host carries it. */
function hostOf(url: string): string {
	return url.replace(/^https?:\/\//, "");
}

describe("cover over HTTP, against the double", () => {
	it("fetches and verifies a real response", async () => {
		const art = jpeg(1024);
		const mock = await startMockReceiver({ http: { art } });
		try {
			const image = await fetchCoverOverHttp(hostOf(mock.httpUrl!));
			assert.ok(image, "expected an image");
			assert.equal(image.type, "jpeg");
			assert.deepEqual(image.bytes, art);
		} finally {
			await mock.close();
		}
	});

	it("works although the device sends Content-size instead of Content-Length", async () => {
		// The measured quirk. A client that insisted on Content-Length would either
		// refuse this or mis-frame it; the plugin must simply read the body.
		const mock = await startMockReceiver({ http: { art: jpeg(512) } });
		try {
			const res = await fetch(`${mock.httpUrl}/album_art.cgi`);
			assert.equal(res.headers.get("content-length"), null, "the double reproduces the missing header");
			assert.ok(res.headers.get("content-size"), "and sends the non-standard one");
			await res.arrayBuffer();

			assert.ok(await fetchCoverOverHttp(hostOf(mock.httpUrl!)), "the fetch still works");
		} finally {
			await mock.close();
		}
	});

	it("survives a server that never finishes the body", async () => {
		// The DoS case, and the reason arrayBuffer() is not used: without a declared
		// length there is nothing to check up front, so an endless stream would decide
		// how much memory this process spends. The read has to abort itself.
		const mock = await startMockReceiver({ http: { art: jpeg(4096), neverEnds: true } });
		try {
			const started = Date.now();
			const image = await fetchCoverOverHttp(hostOf(mock.httpUrl!), undefined, { maxBytes: 64 * 1024 });
			assert.equal(image, undefined, "an unbounded body yields no image");
			// It must give up on the cap, long before the request timeout.
			assert.ok(Date.now() - started < 4_000, `took ${Date.now() - started} ms — did it wait for the timeout?`);
		} finally {
			await mock.close();
		}
	});

	it("refuses a body that overruns the cap even when the headers lie", async () => {
		const mock = await startMockReceiver({ http: { art: jpeg(8192), declaredLength: 10 } });
		try {
			assert.equal(await fetchCoverOverHttp(hostOf(mock.httpUrl!), undefined, { maxBytes: 1024 }), undefined);
		} finally {
			await mock.close();
		}
	});

	it("gives up quietly when the endpoint is not there", async () => {
		// A receiver whose web server has no cover, or none at all.
		const mock = await startMockReceiver({ http: {} });
		try {
			assert.equal(await fetchCoverOverHttp(hostOf(mock.httpUrl!)), undefined);
		} finally {
			await mock.close();
		}
	});

	it("announces LINK mode the way the receiver does", async () => {
		// The double can be put in either mode, because the plugin must serve whichever
		// it finds and never switch it. Measured payload shape: image type 2, then the
		// device's own URL.
		const mock = await startMockReceiver({ http: { art: jpeg(128) }, jacketArtMode: "link" });
		try {
			assert.ok(mock.httpUrl, "the double has a web server");
			assert.equal(typeof mock.announceArtUrl, "function");
		} finally {
			await mock.close();
		}
	});
});
