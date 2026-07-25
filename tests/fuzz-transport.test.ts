/**
 * Socket-level fuzzing: a hostile receiver against the real transport.
 *
 * The parser fuzzing in fuzz-protocol.test.ts covers pure functions. This file
 * covers the part that only shows up over a socket — accumulation across `data`
 * events, chunk boundaries, framing state carried between frames, and the
 * teardown rules — by driving `EiscpTransport` against a TCP server that sends
 * whatever we want.
 *
 * The invariants are about survival and bounds, not decoded values:
 *
 *  - the process stays up (no unhandled `error` event, no unhandled rejection);
 *  - buffered bytes never exceed MAX_RECEIVE_BUFFER_BYTES;
 *  - a peer cannot make the transport hold a connection open forever while
 *    buffering, nor spin without making progress;
 *  - every emitted frame is internally consistent.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import {
	ConnectionState,
	createTransport,
	MAX_RECEIVE_BUFFER_BYTES,
	type InboundFrame,
} from "../src/adapter/eiscp/transport.ts";
import { MAX_FRAME_BYTES } from "../src/adapter/eiscp/protocol.ts";
import { startMockReceiver, type MockReceiver } from "./helpers/mock-receiver.ts";
import { buildFrame, fuzzConfig, makeRng, randomFrame, randomIscpBody } from "./helpers/fuzz.ts";

const config = fuzzConfig(60);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fail the run if anything escapes to the process level.
 *
 * The plugin installs process-level handlers so a rejection cannot kill it, but
 * in tests we want the opposite: an escape is a finding and must be loud.
 */
const escaped: unknown[] = [];
const onRejection = (reason: unknown) => escaped.push(reason);
const onException = (err: unknown) => escaped.push(err);

before(() => {
	process.on("unhandledRejection", onRejection);
	process.on("uncaughtException", onException);
});

after(() => {
	process.off("unhandledRejection", onRejection);
	process.off("uncaughtException", onException);
});

/**
 * Run `body` against a connected transport, then tear everything down.
 *
 * `error` is always subscribed: an EventEmitter with no `error` listener throws
 * ERR_UNHANDLED_ERROR, which would mask the actual finding.
 */
async function withHostileReceiver(
	body: (ctx: {
		mock: MockReceiver;
		transport: ReturnType<typeof createTransport>;
		frames: InboundFrame[];
		errors: Error[];
	}) => Promise<void>,
): Promise<void> {
	const mock = await startMockReceiver();
	const transport = createTransport({ host: "127.0.0.1", port: mock.port });
	const frames: InboundFrame[] = [];
	const errors: Error[] = [];
	transport.on("data", (frame) => frames.push(frame));
	transport.on("error", (err) => errors.push(err));
	try {
		await transport.connect();
		await mock.waitForClient();
		await body({ mock, transport, frames, errors });
	} finally {
		transport.disconnect();
		await mock.close();
	}
}

/** Every emitted frame must be self-consistent, whatever the peer sent. */
function assertFramesAreSane(frames: InboundFrame[]): void {
	for (const frame of frames) {
		if (frame.kind === "eiscp") {
			assert.equal(frame.packet.header, "ISCP");
			assert.equal(frame.packet.headerSize, 16);
			assert.ok(
				frame.packet.dataSize <= MAX_FRAME_BYTES,
				`emitted a frame declaring ${frame.packet.dataSize} bytes`,
			);
			assert.equal(frame.packet.rawMessage.length, frame.packet.dataSize);
		} else {
			assert.ok(frame.message.length > 0, "raw ISCP frames must not be empty");
		}
	}
}

describe("fuzz: transport against a hostile peer", () => {
	it("survives random frame streams delivered in random chunk sizes", async () => {
		const rng = makeRng(config.seed);

		for (let iteration = 0; iteration < 8; iteration++) {
			await withHostileReceiver(async ({ mock, transport, frames, errors }) => {
				const parts: Buffer[] = [];
				for (let i = 0; i < rng.between(1, 12); i++) {
					parts.push(rng.bool(0.7) ? randomFrame(rng) : rng.bytes(rng.between(0, 48)));
				}
				const stream = Buffer.concat(parts as unknown as Uint8Array[]);

				mock.broadcastRawChunked(stream, rng.between(1, 64));
				await sleep(120);

				assertFramesAreSane(frames);
				// Errors are expected (we sent garbage); crashes are not.
				for (const err of errors) assert.ok(err instanceof Error);
				assert.deepEqual(
					escaped,
					[],
					`something escaped to the process level (seed ${config.seed}, iteration ${iteration})`,
				);
				// Either still connected, or deliberately torn down for a violation.
				assert.ok(
					transport.getState() === ConnectionState.CONNECTED ||
						transport.getState() === ConnectionState.DISCONNECTED,
				);
			});
		}
	});

	it("still decodes valid frames interleaved with garbage", async () => {
		const rng = makeRng(config.seed ^ 0x1234);

		await withHostileReceiver(async ({ mock, frames }) => {
			// Garbage without a '!' or "ISCP" is discarded; a following valid frame
			// must still be found. This is the resync path, driven over a socket.
			for (let i = 0; i < 5; i++) {
				mock.broadcastRaw(Buffer.from("#".repeat(rng.between(1, 40)), "ascii"));
				mock.broadcastRaw(buildFrame({ body: "!1PWR01\r" }));
				await sleep(30);
			}
			await sleep(120);

			assertFramesAreSane(frames);
			const decoded = frames.filter((f) => f.kind === "eiscp");
			assert.ok(decoded.length > 0, "resync failed: no valid frame was decoded after garbage");
		});
	});

	it("keeps buffered bytes under the ceiling and drops the peer instead of growing", async () => {
		await withHostileReceiver(async ({ mock, transport, errors }) => {
			// An ISCP line that is opened and never terminated. Nothing here is
			// malformed — the framing code legitimately needs more data — so only the
			// ceiling stops unbounded growth.
			mock.broadcastRaw(Buffer.from("!1", "ascii"));

			const filler = Buffer.alloc(16 * 1024, 0x41);
			let sent = 0;
			const started = Date.now();
			while (transport.isConnected() && Date.now() - started < 5000) {
				mock.broadcastRaw(filler);
				sent += filler.length;
				await sleep(5);
			}

			assert.equal(transport.isConnected(), false, "peer should have been dropped");
			assert.ok(
				sent >= MAX_RECEIVE_BUFFER_BYTES,
				`dropped before reaching the ceiling (sent ${sent}, ceiling ${MAX_RECEIVE_BUFFER_BYTES})`,
			);
			assert.match(String(errors.at(-1)?.message), /receive buffer limit exceeded/);
			assert.deepEqual(escaped, []);
		});
	});

	it("drops a peer that declares an oversized frame, at every chunk boundary", async () => {
		const rng = makeRng(config.seed ^ 0x99);

		for (const dataSize of [MAX_FRAME_BYTES + 1, 0xffff_ffff, 0x7fff_ffff]) {
			await withHostileReceiver(async ({ mock, transport, errors }) => {
				const header = buildFrame({ dataSize, body: Buffer.alloc(0) });
				// Chunked, so the size field itself can straddle a write boundary.
				mock.broadcastRawChunked(header, rng.between(1, 8));

				const started = Date.now();
				while (transport.isConnected() && Date.now() - started < 3000) await sleep(20);

				assert.equal(
					transport.isConnected(),
					false,
					`peer declaring ${dataSize} bytes should have been dropped`,
				);
				assert.match(String(errors.at(-1)?.message), /exceeds maximum/);
				assert.deepEqual(escaped, []);
			});
		}
	});

	it("makes progress byte-by-byte without stalling or spinning", async () => {
		await withHostileReceiver(async ({ mock, frames }) => {
			// One byte per write across several frames: the framing state has to
			// survive being suspended at every possible offset.
			const stream = Buffer.concat([
				buildFrame({ body: "!1PWR01\r" }) as unknown as Uint8Array,
				Buffer.from("!1MVL0E\r", "ascii") as unknown as Uint8Array,
				buildFrame({ body: "!1AMT00\r" }) as unknown as Uint8Array,
			]);
			mock.broadcastRawChunked(stream, 1);

			const started = Date.now();
			while (frames.length < 3 && Date.now() - started < 3000) await sleep(20);

			assert.equal(frames.length, 3, "byte-by-byte delivery lost or stalled a frame");
			assertFramesAreSane(frames);
			assert.deepEqual(escaped, []);
		});
	});

	it("survives the peer resetting the connection mid-frame", async () => {
		const rng = makeRng(config.seed ^ 0x5a5a);

		for (let iteration = 0; iteration < 5; iteration++) {
			await withHostileReceiver(async ({ mock, transport }) => {
				const frame = buildFrame({ body: randomIscpBody(rng) });
				// Send a prefix only, then destroy the socket without a graceful close.
				mock.broadcastRaw(frame.subarray(0, rng.between(1, Math.max(2, frame.length - 1))));
				await sleep(20);
				mock.resetConnections();
				await sleep(80);

				assert.deepEqual(escaped, [], "a mid-frame reset escaped to the process level");
				// The transport must notice and settle, not sit in CONNECTED forever.
				assert.notEqual(transport.getState(), ConnectionState.CONNECTING);
			});
		}
	});
});
