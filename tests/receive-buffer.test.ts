/**
 * Unit tests for ReceiveBuffer: the bounded accumulator that replaced the
 * transport's unbounded `Buffer.concat` receive path.
 *
 * The security-relevant properties are the ceiling (a peer must not be able to
 * make us buffer without limit) and that consumption actually releases memory
 * rather than retaining the parent allocation via views.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ReceiveBuffer } from "../src/adapter/eiscp/receive-buffer.ts";

describe("ReceiveBuffer", () => {
	it("rejects a non-positive ceiling", () => {
		assert.throws(() => new ReceiveBuffer(0), /maxBytes must be positive/);
		assert.throws(() => new ReceiveBuffer(-1), /maxBytes must be positive/);
	});

	it("appends and consumes in order", () => {
		const rb = new ReceiveBuffer(1024);
		assert.equal(rb.length, 0);
		assert.equal(rb.append(Buffer.from("ISCP")), true);
		assert.equal(rb.append(Buffer.from("rest")), true);
		assert.equal(rb.length, 8);
		assert.equal(rb.consume(4).toString(), "ISCP");
		assert.equal(rb.length, 4);
		assert.equal(rb.consume(4).toString(), "rest");
		assert.equal(rb.length, 0);
	});

	it("refuses an append that would exceed the ceiling, leaving the buffer intact", () => {
		const rb = new ReceiveBuffer(8);
		assert.equal(rb.append(Buffer.alloc(6, 0x41)), true);
		// 6 + 4 > 8, so this must be refused and must not partially apply.
		assert.equal(rb.append(Buffer.alloc(4, 0x42)), false);
		assert.equal(rb.length, 6);
		assert.equal(rb.peek(6).toString(), "AAAAAA");
		// Exactly filling the ceiling is still allowed.
		assert.equal(rb.append(Buffer.alloc(2, 0x42)), true);
		assert.equal(rb.length, 8);
	});

	it("stays within the ceiling across many append/consume cycles", () => {
		const rb = new ReceiveBuffer(64);
		for (let i = 0; i < 1000; i++) {
			assert.equal(rb.append(Buffer.alloc(16, i & 0xff)), true);
			assert.ok(rb.length <= 64, `length ${rb.length} exceeded ceiling at i=${i}`);
			assert.equal(rb.consume(16).length, 16);
		}
		assert.equal(rb.length, 0);
	});

	it("reports a zero-length append as accepted without changing state", () => {
		const rb = new ReceiveBuffer(4);
		assert.equal(rb.append(Buffer.alloc(4)), true);
		assert.equal(rb.append(Buffer.alloc(0)), true);
		assert.equal(rb.length, 4);
	});

	it("reads a big-endian uint32 at an offset and range-checks it", () => {
		const rb = new ReceiveBuffer(64);
		const frame = Buffer.alloc(12);
		frame.writeUInt32BE(0xdeadbeef, 4);
		rb.append(frame);
		assert.equal(rb.readUInt32BE(4), 0xdeadbeef);
		assert.throws(() => rb.readUInt32BE(9), RangeError);
		assert.throws(() => rb.readUInt32BE(-1), RangeError);
	});

	it("keeps offsets relative to the window after consuming", () => {
		const rb = new ReceiveBuffer(64);
		rb.append(Buffer.from("XXXX"));
		const frame = Buffer.alloc(8);
		frame.writeUInt32BE(0x11223344, 0);
		rb.append(frame);
		rb.discard(4); // drop the "XXXX" prefix
		assert.equal(rb.readUInt32BE(0), 0x11223344);
		assert.equal(rb.byteAt(0), 0x11);
	});

	it("finds bytes and predicates relative to the window, ignoring consumed bytes", () => {
		const rb = new ReceiveBuffer(64);
		rb.append(Buffer.from("!abc\r!def\r"));
		assert.equal(rb.indexOfByte(0x21), 0);
		assert.equal(rb.findIndex((b) => b === 0x0d), 4);
		rb.discard(5); // past the first line
		assert.equal(rb.indexOfByte(0x21), 0);
		assert.equal(rb.findIndex((b) => b === 0x0d), 4);
		// A byte that only exists in the already-consumed region is not found.
		rb.discard(5);
		assert.equal(rb.indexOfByte(0x21), -1);
		assert.equal(rb.findIndex((b) => b === 0x0d), -1);
	});

	it("returns undefined for byteAt past the end", () => {
		const rb = new ReceiveBuffer(64);
		rb.append(Buffer.from("ab"));
		assert.equal(rb.byteAt(1), 0x62);
		assert.equal(rb.byteAt(2), undefined);
		assert.equal(rb.byteAt(-1), undefined);
	});

	it("range-checks consume and discard", () => {
		const rb = new ReceiveBuffer(64);
		rb.append(Buffer.from("abc"));
		assert.throws(() => rb.consume(4), RangeError);
		assert.throws(() => rb.discard(4), RangeError);
		assert.throws(() => rb.consume(-1), RangeError);
		assert.equal(rb.length, 3, "failed calls must not consume anything");
	});

	it("clamps peek instead of throwing", () => {
		const rb = new ReceiveBuffer(64);
		rb.append(Buffer.from("abc"));
		assert.equal(rb.peek(100).toString(), "abc");
		assert.equal(rb.peek(0).length, 0);
		assert.equal(rb.peek(-5).length, 0);
		assert.equal(rb.length, 3, "peek must not consume");
	});

	it("hands out copies, so callers cannot pin or mutate the backing store", () => {
		const rb = new ReceiveBuffer(64);
		rb.append(Buffer.from("abcd"));
		const taken = rb.peek(4);
		taken.write("ZZZZ");
		assert.equal(rb.peek(4).toString(), "abcd", "peek returned a live view");

		const consumed = rb.consume(4);
		assert.equal(consumed.toString(), "abcd");
		rb.append(Buffer.from("wxyz"));
		assert.equal(consumed.toString(), "abcd", "consumed buffer aliased reused storage");
	});

	it("clear drops everything and allows reuse", () => {
		const rb = new ReceiveBuffer(16);
		rb.append(Buffer.alloc(16));
		rb.clear();
		assert.equal(rb.length, 0);
		assert.equal(rb.append(Buffer.alloc(16)), true, "capacity must be reusable after clear");
	});

	it("exposes its ceiling", () => {
		assert.equal(new ReceiveBuffer(1234).limit, 1234);
	});

	it("grows to the ceiling without losing data", () => {
		// Start well below the ceiling so the doubling path is exercised.
		const rb = new ReceiveBuffer(4096, 8);
		const expected: number[] = [];
		for (let i = 0; i < 64; i++) {
			const chunk = Buffer.alloc(64, i & 0xff);
			assert.equal(rb.append(chunk), true);
			expected.push(...chunk);
		}
		assert.equal(rb.length, 4096);
		assert.deepEqual([...rb.peek(4096)], expected);
		assert.equal(rb.append(Buffer.alloc(1)), false, "ceiling must hold after growth");
	});
});
