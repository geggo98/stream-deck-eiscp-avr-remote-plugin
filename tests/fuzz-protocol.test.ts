/**
 * Fuzzing for the eISCP protocol layer — the code that sees raw bytes from the
 * network first.
 *
 * These tests assert invariants rather than specific outputs, because the input
 * is generated: a parser fed hostile bytes must either produce a well-formed
 * result or reject with a deliberate `Error`. A `TypeError`/`RangeError` means an
 * unchecked access reachable from the network, and a hang or an unbounded
 * allocation is a denial-of-service primitive.
 *
 * Deliberately avoids the cases already covered by eiscp-protocol.test.ts and
 * targets what was uncovered: headers that lie about their length, header sizes
 * other than 16, non-0x01 versions, NUL and high-bit payloads, very long
 * parameters, and truncated multi-frame tails.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	decodeMultiplePackets,
	decodePacket,
	encodePacket,
	MAX_FRAME_BYTES,
	MAX_PARAMETER_LENGTH,
	parseIscpMessage,
	stripTerminators,
} from "../src/adapter/eiscp/protocol.ts";
import {
	buildFrame,
	expectFastCompletion,
	expectOnlyDeliberateErrors,
	fuzzConfig,
	fuzzEach,
	mutate,
	randomAscii,
	randomFrame,
	randomIscpBody,
} from "./helpers/fuzz.ts";

const config = fuzzConfig();

describe("fuzz: decodePacket", () => {
	it("either decodes or rejects deliberately, never with an unchecked access", () => {
		fuzzEach(
			config,
			(rng) => (rng.bool(0.7) ? randomFrame(rng) : rng.bytes(rng.between(0, 128))),
			(input) => {
				const packet = expectOnlyDeliberateErrors(() => decodePacket(input), "decodePacket");
				if (!packet) return;

				// A successful decode must be internally consistent with the bytes.
				assert.equal(packet.header, "ISCP");
				assert.equal(packet.headerSize, 16);
				assert.ok(packet.dataSize <= MAX_FRAME_BYTES, `dataSize ${packet.dataSize} above the cap`);
				assert.equal(packet.rawMessage.length, packet.dataSize);
				assert.ok(
					input.length >= 16 + packet.dataSize,
					"decoded a body longer than the buffer it came from",
				);
			},
		);
	});

	it("never accepts a frame declaring more than the frame cap", () => {
		fuzzEach(
			config,
			(rng) => ({
				dataSize: rng.between(MAX_FRAME_BYTES + 1, 0xffffffff),
				body: rng.bytes(rng.between(0, 64)),
			}),
			({ dataSize, body }) => {
				const frame = buildFrame({ dataSize, body });
				assert.throws(
					() => decodePacket(frame),
					/exceeds maximum frame size/,
					"an oversized declared size must be rejected, not waited on",
				);
			},
		);
	});

	it("walks outward from a valid frame by mutation without breaking the invariants", () => {
		const seedFrame = buildFrame({ body: "!1PWR01\r" });
		fuzzEach(
			config,
			(rng) => {
				let buf = seedFrame;
				for (let i = 0; i < rng.between(1, 4); i++) buf = mutate(rng, buf);
				return buf;
			},
			(input) => {
				const packet = expectOnlyDeliberateErrors(() => decodePacket(input), "decodePacket(mutated)");
				if (!packet) return;
				assert.equal(packet.rawMessage.length, packet.dataSize);
				assert.ok(packet.dataSize <= MAX_FRAME_BYTES);
			},
		);
	});
});

describe("fuzz: parseIscpMessage", () => {
	it("either parses or rejects deliberately, and a parse is always well-formed", () => {
		fuzzEach(
			config,
			(rng) => randomIscpBody(rng).toString("latin1"),
			(input) => {
				const message = expectOnlyDeliberateErrors(
					() => parseIscpMessage(input),
					"parseIscpMessage",
				);
				if (!message) return;

				assert.equal(message.command.length, 3, "command must be exactly 3 characters");
				assert.equal(message.unit.length, 1, "unit must be exactly 1 character");
				assert.ok(message.raw.startsWith("!"), "raw must retain the ! prefix");
				// The parsed pieces must reconstruct the message they came from, so no
				// downstream consumer can be handed a value the peer did not send.
				assert.equal(`!${message.unit}${message.command}${message.parameter}`, message.raw);
			},
		);
	});

	it("does not blow up on very long parameters", () => {
		fuzzEach(
			config,
			(rng) => `!1FLD${randomAscii(rng, rng.between(1000, 20000))}`,
			(input) => {
				const message = expectOnlyDeliberateErrors(
					() => parseIscpMessage(input),
					"parseIscpMessage(long)",
				);
				// Long is legal at this layer (the cap is enforced when framing and
				// when storing); it must simply not corrupt or hang.
				if (message) assert.equal(message.command, "FLD");
			},
		);
	});

	it("strips terminators in linear time even on pathological input", () => {
		// stripTerminators is an anchored trailing-run regex, the classic shape for
		// quadratic backtracking.
		for (const input of [
			`!1FLD${"\r".repeat(50000)}`,
			`!1FLD${"\r\n\x1a\x19".repeat(20000)}`,
			`!1FLD${"\r".repeat(50000)}x`,
			`${" ".repeat(50000)}!1FLD01`,
		]) {
			expectFastCompletion(() => void stripTerminators(input), 250, "stripTerminators");
			expectFastCompletion(
				() => void expectOnlyDeliberateErrors(() => parseIscpMessage(input), "parseIscpMessage"),
				250,
				"parseIscpMessage",
			);
		}
	});
});

describe("fuzz: decodeMultiplePackets", () => {
	it("terminates and returns consistent packets for any byte stream", () => {
		fuzzEach(
			config,
			(rng) => {
				const parts: Buffer[] = [];
				for (let i = 0; i < rng.between(0, 4); i++) {
					parts.push(rng.bool(0.7) ? randomFrame(rng) : rng.bytes(rng.between(0, 24)));
				}
				return Buffer.concat(parts as unknown as Uint8Array[]);
			},
			(input) => {
				const packets = expectOnlyDeliberateErrors(
					() => decodeMultiplePackets(input),
					"decodeMultiplePackets",
				);
				if (!packets) return;

				// Every emitted packet is 16 bytes of header plus its own body, so the
				// total can never exceed the input — a violation would mean the loop
				// re-read the same bytes and could fail to advance.
				const consumed = packets.reduce((sum, p) => sum + 16 + p.dataSize, 0);
				assert.ok(
					consumed <= input.length,
					`emitted ${consumed} bytes of packets from a ${input.length}-byte buffer`,
				);
				assert.ok(packets.length <= Math.ceil(input.length / 16) || input.length === 0);
			},
		);
	});

	it("makes progress on a truncated tail instead of looping", () => {
		const two = Buffer.concat([
			buildFrame({ body: "!1PWR01\r" }) as unknown as Uint8Array,
			buildFrame({ body: "!1MVL28\r" }) as unknown as Uint8Array,
		]);
		fuzzEach(
			config,
			(rng) => two.subarray(0, rng.between(0, two.length)),
			(input) => {
				expectFastCompletion(
					() =>
						void expectOnlyDeliberateErrors(
							() => decodeMultiplePackets(input),
							"decodeMultiplePackets(truncated)",
						),
					250,
					"decodeMultiplePackets(truncated)",
				);
			},
		);
	});
});

describe("fuzz: encodePacket", () => {
	it("round-trips everything it accepts", () => {
		fuzzEach(
			config,
			(rng) => ({
				command: rng.bool(0.8)
					? rng.pick(["PWR", "MVL", "AMT", "SLI", "LMD", "NTC"])
					: randomAscii(rng, rng.between(0, 5)),
				parameter: rng.bool(0.8)
					? rng.pick(["01", "QSTN", "UP", "DOWN", "TG", ""])
					: randomAscii(rng, rng.between(0, 80)),
				unit: rng.bool(0.9) ? rng.pick(["1", "p"]) : randomAscii(rng, rng.between(0, 2)),
			}),
			({ command, parameter, unit }) => {
				const encoded = expectOnlyDeliberateErrors(
					() => encodePacket(command, parameter, unit),
					"encodePacket",
				);
				if (!encoded) return;

				// Anything accepted must decode back to exactly what went out —
				// otherwise validation let through a value that corrupts the frame.
				// Compared against the canonical (trailing-space-trimmed) form,
				// because that is what encodePacket puts on the wire: parseIscpMessage
				// trims, so an untrimmed parameter could not survive the round-trip.
				const packet = decodePacket(encoded.bytes);
				const message = parseIscpMessage(packet.message);
				assert.equal(message.command, command);
				assert.equal(message.parameter, parameter.trimEnd());
				assert.equal(message.unit, unit);
				// The bytes sent must match the message we claim to have sent.
				assert.ok(encoded.iscpMessage.includes(parameter.trimEnd()));
			},
		);
	});

	it("refuses any value that would split the frame", () => {
		fuzzEach(
			config,
			(rng) => {
				const injected = rng.pick(["\r", "\n", "\x1a", "\x00", "\x1b"]);
				const at = rng.int(3);
				return `${at === 0 ? injected : ""}01${at === 1 ? injected : ""}!1PWR00${at === 2 ? injected : ""}`;
			},
			(parameter) => {
				assert.throws(
					() => encodePacket("PWR", parameter),
					/control or non-ASCII|parameter too long/,
					"a parameter containing a terminator must be refused",
				);
			},
		);
	});

	it("enforces the parameter length cap exactly", () => {
		fuzzEach(
			config,
			(rng) => rng.between(MAX_PARAMETER_LENGTH + 1, MAX_PARAMETER_LENGTH + 500),
			(length) => {
				assert.throws(() => encodePacket("PWR", "0".repeat(length)), /parameter too long/);
			},
		);
	});
});
