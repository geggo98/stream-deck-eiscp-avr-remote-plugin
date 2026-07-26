/**
 * The cover-art reassembler.
 *
 * This is the plugin's first accumulator over device-controlled bytes and its first
 * binary decoder, so the tests are mostly about what it *refuses*. The shapes come
 * from the measured VSX-S520D (one `0`, n × `1`, one `2`; 246 hex characters per
 * frame; End frame carries data) and from the failure modes the repo has already
 * been bitten by — above all `Buffer.from(x, "hex")` truncating in silence.
 *
 * SDK-free by construction: `jacket-art.ts` lives in the adapter layer.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	ART_IDLE_MS,
	INITIAL_ART_STATE,
	JacketArtAccumulator,
	MAX_ART_BYTES,
	MAX_ART_FRAMES,
	nextArtState,
	parseArtFrame,
	type ArtOutcome,
	type ArtState,
} from "../src/adapter/eiscp/jacket-art.ts";

/** A JPEG as far as the verifier is concerned: SOI … EOI. */
function jpegBytes(payloadLength: number): Buffer {
	const middle = Buffer.alloc(payloadLength, 0x41);
	return Buffer.concat([Buffer.from([0xff, 0xd8]), middle, Buffer.from([0xff, 0xd9])]);
}

function hex(buf: Buffer): string {
	return buf.toString("hex").toUpperCase();
}

/** Split a buffer into `!1NJA`-style parameters, 123 bytes each like the real unit. */
function framesFor(image: Buffer, chunkBytes = 123): string[] {
	const out: string[] = [];
	for (let i = 0; i < image.length; i += chunkBytes) {
		out.push(hex(image.subarray(i, i + chunkBytes)));
	}
	return out.map((payload, i) => {
		const flag = i === 0 ? "0" : i === out.length - 1 ? "2" : "1";
		return `1${flag}${payload}`;
	});
}

/** Fold a list of parameters through the reducer, returning the final outcome. */
function feed(parameters: string[], startAt = 1_000): { state: ArtState; outcomes: ArtOutcome[] } {
	let state = INITIAL_ART_STATE;
	const outcomes: ArtOutcome[] = [];
	let now = startAt;
	for (const parameter of parameters) {
		const frame = parseArtFrame(parameter);
		assert.ok(frame, `unparseable test parameter ${JSON.stringify(parameter)}`);
		const step = nextArtState(state, frame, now);
		state = step.state;
		outcomes.push(step.outcome);
		now += 1;
	}
	return { state, outcomes };
}

describe("cover art reassembly (nextArtState)", () => {
	it("assembles a transfer shaped like the real device's", () => {
		const image = jpegBytes(400);
		const parameters = framesFor(image);
		// Sanity-check the fixture itself, so a broken helper cannot make the real
		// assertion vacuous.
		assert.ok(parameters.length > 3, "needs a start, at least one middle, and an end");
		assert.equal(parameters[0]![1], "0");
		assert.equal(parameters[parameters.length - 1]![1], "2");

		const { state, outcomes } = feed(parameters);
		const last = outcomes[outcomes.length - 1]!;

		assert.equal(last.kind, "complete");
		assert.ok(last.kind === "complete");
		assert.deepEqual(last.image.bytes, image);
		assert.equal(last.image.type, "jpeg");
		assert.equal(last.image.frames, parameters.length);
		// Nothing retained once a transfer finishes.
		assert.equal(state.pending, undefined);
		assert.ok(
			outcomes.slice(0, -1).every((o) => o.kind === "progress"),
			"no frame before the end should produce a render",
		);
	});

	it("keeps the End frame's data, which the real device uses", () => {
		// Measured: the last NJA frame of a transfer is shorter than the rest and still
		// carries bytes — the JPEG's FFD9 arrives in it. Dropping it would corrupt every
		// image by a few bytes and still "look" like a JPEG at the start.
		const image = jpegBytes(200);
		const { outcomes } = feed(framesFor(image, 64));
		const last = outcomes[outcomes.length - 1]!;
		assert.ok(last.kind === "complete");
		assert.equal(last.image.bytes.length, image.length);
	});

	it("discards a partial transfer when a new Start arrives", () => {
		const first = framesFor(jpegBytes(400));
		const second = framesFor(jpegBytes(200));
		// Cut the first transfer off mid-stream, then start the second one.
		const { outcomes } = feed([...first.slice(0, 2), ...second]);
		const last = outcomes[outcomes.length - 1]!;

		assert.ok(last.kind === "complete");
		assert.equal(last.image.frames, second.length, "the abandoned frames must not be counted");
		assert.deepEqual(last.image.bytes, jpegBytes(200));
	});

	it("ignores a continuation with no Start, rather than inventing one", () => {
		// Happens for real: the plugin can connect in the middle of a transfer.
		const { state, outcomes } = feed(["11" + hex(Buffer.alloc(8, 0x41))]);
		assert.deepEqual(outcomes[0], { kind: "ignored", reason: "continuation without a start frame" });
		assert.equal(state.pending, undefined);
	});

	it("rejects a payload that is not even-length hex instead of truncating it", () => {
		// The whole reason this check exists: Buffer.from(x, "hex") does not throw, it
		// stops at the first bad pair. Accepting that would assemble a short image and
		// report success.
		assert.equal(Buffer.from("FFD8ZZ", "hex").length, 2, "Node truncates rather than throwing");

		for (const bad of ["10FFD8Z", "10FFD", "10 FFD8"]) {
			const { state, outcomes } = feed([bad]);
			assert.deepEqual(outcomes[0], { kind: "rejected", reason: "payload is not even-length hex" });
			assert.equal(state.pending, undefined, "a rejected transfer must not linger");
		}
	});

	it("takes the container from the bytes and ignores the declared type", () => {
		// t = "1" claims JPEG; the bytes are a BMP. The bytes win, and deliberately so:
		// the vendor workbook ships two different `t` enumerations (one with only
		// 0:BMP/1:JPEG, one adding 2:URL/n:No Image), so a firmware that mislabels is
		// more likely than one that lies about the content. Detecting from the magic
		// bytes also means the MIME type we later put in the data URI is always the
		// real one — trusting `t` could produce a data URI no renderer can read.
		const bmp = Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(32, 0x41)]);
		const { outcomes } = feed([`10${hex(bmp.subarray(0, 16))}`, `12${hex(bmp.subarray(16))}`]);

		const last = outcomes[1]!;
		assert.ok(last.kind === "complete");
		assert.equal(last.image.type, "bmp", "declared JPEG, detected BMP — detection decides");
		assert.deepEqual(last.image.bytes, bmp);
	});

	it("accepts a real BMP when that is what arrives", () => {
		const bmp = Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(64, 0x41)]);
		const { outcomes } = feed([`00${hex(bmp.subarray(0, 32))}`, `02${hex(bmp.subarray(32))}`]);
		const last = outcomes[1]!;
		assert.ok(last.kind === "complete");
		assert.equal(last.image.type, "bmp");
	});

	it("rejects a JPEG that never reached its end marker", () => {
		// A transfer can be cut short and still start with FFD8. Rendering that gives a
		// half-drawn image; refusing it gives the previous cover, which is better.
		const truncated = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(32, 0x41)]);
		const { outcomes } = feed([`10${hex(truncated.subarray(0, 16))}`, `12${hex(truncated.subarray(16))}`]);
		assert.deepEqual(outcomes[1], { kind: "rejected", reason: "assembled data is not a valid JPEG or BMP" });
	});

	it("rejects a transfer that changes image type midway", () => {
		const { outcomes } = feed([`10${hex(Buffer.from([0xff, 0xd8]))}`, `01${hex(Buffer.alloc(4))}`]);
		assert.deepEqual(outcomes[1], { kind: "rejected", reason: "image type changed mid-transfer" });
	});

	it("clears the cover when the receiver says there is none", () => {
		// t = "n" applies whether or not a transfer is running, and cancels one.
		const started = framesFor(jpegBytes(400)).slice(0, 2);
		const { state, outcomes } = feed([...started, "n-"]);
		assert.deepEqual(outcomes[outcomes.length - 1], { kind: "cleared" });
		assert.equal(state.pending, undefined);
	});

	it("does not follow a URL the device supplies", () => {
		// t = "2" is a peer-chosen address. Fetching it would turn a display feature
		// into an outbound request to an origin we did not choose, so it is not even
		// parsed — and a running transfer is left alone.
		const { outcomes } = feed(["2-http://192.0.2.1/art.jpg"]);
		assert.equal(outcomes[0]!.kind, "ignored");
		assert.match((outcomes[0] as { reason: string }).reason, /URL mode/);
	});

	it("ignores an unknown image type or packet flag without dropping state", () => {
		const start = framesFor(jpegBytes(400))[0]!;
		const { state, outcomes } = feed([start, "1Xdeadbeef"]);
		assert.equal(outcomes[1]!.kind, "ignored");
		assert.ok(state.pending, "an unrelated oddity must not discard a healthy transfer");

		const unknownType = feed(["9-00"]);
		assert.equal(unknownType.outcomes[0]!.kind, "ignored");
	});

	it("bounds the assembled size", () => {
		// Build past the cap with legal frames: a peer can otherwise stream `p=1`
		// forever and the accumulator is the only thing standing in the way.
		const chunk = hex(Buffer.alloc(1024, 0x41));
		const parameters = ["10" + hex(Buffer.from([0xff, 0xd8]))];
		for (let bytes = 2; bytes <= MAX_ART_BYTES + 1024; bytes += 1024) parameters.push("11" + chunk);

		const { state, outcomes } = feed(parameters);
		const rejected = outcomes.find((o) => o.kind === "rejected");
		assert.ok(rejected, "the byte cap must fire");
		assert.match((rejected as { reason: string }).reason, /exceeds \d+ bytes/);
		assert.equal(state.pending, undefined, "the oversized transfer is released, not kept");
	});

	it("bounds the frame count even when every frame is tiny", () => {
		// The byte cap alone is not enough: 8 192 empty frames cost nothing in bytes
		// but still make the plugin do unbounded work.
		const parameters = ["10" + hex(Buffer.from([0xff, 0xd8]))];
		for (let i = 0; i < MAX_ART_FRAMES + 2; i++) parameters.push("11");

		const { outcomes } = feed(parameters);
		const rejected = outcomes.find((o) => o.kind === "rejected");
		assert.ok(rejected);
		assert.match((rejected as { reason: string }).reason, /exceeds \d+ frames/);
	});

	it("drops a stalled transfer instead of splicing two images together", () => {
		const image = jpegBytes(400);
		const parameters = framesFor(image);
		let state = INITIAL_ART_STATE;

		// Start a transfer…
		state = nextArtState(state, parseArtFrame(parameters[0]!)!, 1_000).state;
		assert.ok(state.pending);

		// …then let it go quiet past the idle window and continue it. The continuation
		// must not extend the stale transfer: after the timeout there is nothing to
		// continue, so it is ignored and the memory is gone.
		const step = nextArtState(state, parseArtFrame(parameters[1]!)!, 1_000 + ART_IDLE_MS + 1);
		assert.deepEqual(step.outcome, { kind: "ignored", reason: "continuation without a start frame" });
		assert.equal(step.state.pending, undefined);
	});

	it("treats the QSTN reply as what it is, not as image data", () => {
		// Measured: `NJA QSTN` answers "BMP" on this firmware — an enable token, not a
		// frame. It parses as type "B", flag "M", payload "P", which must not become a
		// transfer.
		const frame = parseArtFrame("BMP");
		assert.ok(frame);
		const step = nextArtState(INITIAL_ART_STATE, frame, 1_000);
		assert.equal(step.outcome.kind, "ignored");
		assert.equal(step.state.pending, undefined);
	});

	it("has nothing to parse in a parameter shorter than the two header fields", () => {
		assert.equal(parseArtFrame(""), undefined);
		assert.equal(parseArtFrame("1"), undefined);
	});
});

describe("JacketArtAccumulator (per-host wiring)", () => {
	it("returns the image exactly once, on the frame that completes it", () => {
		const acc = new JacketArtAccumulator();
		const image = jpegBytes(400);
		const parameters = framesFor(image);
		const results = parameters.map((p, i) => acc.accept("10.0.0.1", p, 1_000 + i));

		assert.equal(results.filter((r) => r != null).length, 1);
		assert.deepEqual(results[results.length - 1]?.bytes, image);
		assert.equal(acc.pendingBytes("10.0.0.1"), 0, "nothing retained afterwards");
	});

	it("returns null for 'no art' so a caller can tell it apart from 'nothing yet'", () => {
		const acc = new JacketArtAccumulator();
		assert.equal(acc.accept("10.0.0.1", "n-"), null);
		assert.equal(acc.accept("10.0.0.1", "11" + hex(Buffer.alloc(4))), undefined);
	});

	it("keeps hosts apart", () => {
		const acc = new JacketArtAccumulator();
		const a = framesFor(jpegBytes(400));
		const b = framesFor(jpegBytes(120));

		// Interleave two transfers frame by frame; each must assemble its own image.
		let doneA: Buffer | undefined;
		let doneB: Buffer | undefined;
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			if (a[i]) doneA = acc.accept("10.0.0.1", a[i]!, 1_000 + i)?.bytes ?? doneA;
			if (b[i]) doneB = acc.accept("10.0.0.2", b[i]!, 1_000 + i)?.bytes ?? doneB;
		}
		assert.deepEqual(doneA, jpegBytes(400));
		assert.deepEqual(doneB, jpegBytes(120));
	});

	it("bounds the number of hosts it accumulates for", () => {
		const acc = new JacketArtAccumulator({ maxHosts: 2 });
		const start = framesFor(jpegBytes(400))[0]!;
		acc.accept("10.0.0.1", start, 1_000);
		acc.accept("10.0.0.2", start, 1_001);
		acc.accept("10.0.0.3", start, 1_002);

		const held = ["10.0.0.1", "10.0.0.2", "10.0.0.3"].filter((h) => acc.pendingBytes(h) > 0);
		assert.equal(held.length, 2, "the oldest host is evicted rather than growing the map");
		assert.ok(held.includes("10.0.0.3"), "the host that just spoke is the one worth keeping");
	});

	it("forgets a host on request", () => {
		const acc = new JacketArtAccumulator();
		acc.accept("10.0.0.1", framesFor(jpegBytes(400))[0]!, 1_000);
		assert.ok(acc.pendingBytes("10.0.0.1") > 0);
		acc.forget("10.0.0.1");
		assert.equal(acc.pendingBytes("10.0.0.1"), 0);
	});
});
