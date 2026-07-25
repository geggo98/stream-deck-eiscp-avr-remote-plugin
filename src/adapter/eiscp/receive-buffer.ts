/**
 * Bounded, amortised-O(1) byte accumulator for the eISCP receive path.
 *
 * The transport used to hold a plain `Buffer` and do
 * `receiveBuffer = Buffer.concat([receiveBuffer, chunk])` on every socket
 * `data` event. That has three problems against a hostile or malfunctioning
 * peer, all of which this class fixes:
 *
 * 1. **Unbounded growth.** Nothing capped the accumulated size, so a peer that
 *    declares a huge `dataSize` (or opens an ISCP line and never terminates it)
 *    makes the plugin buffer until the process dies. `maxBytes` is a hard
 *    ceiling; `append` refuses rather than growing past it.
 * 2. **Quadratic copying.** Re-concatenating the whole accumulation per event
 *    copies O(n) bytes each time. Here appends write into spare capacity, and
 *    the backing store only grows by doubling, so N bytes cost O(N) total.
 * 3. **Retained allocations.** Consuming via `buf = buf.subarray(n)` keeps the
 *    entire original ArrayBuffer alive as long as any view exists, so freeing
 *    memory required dropping every derived view. Here consumption advances a
 *    read offset inside a reused buffer and hands out copies.
 *
 * Not a general-purpose ring buffer: the bytes stay contiguous (the read window
 * is compacted to the front when more room is needed), because the framing code
 * needs to read a big-endian length field and scan for delimiters.
 */
export class ReceiveBuffer {
	private buf: Buffer;
	/** Start of the unconsumed window. */
	private start = 0;
	/** End of the unconsumed window (exclusive). */
	private end = 0;
	// Declared as a field rather than a constructor parameter property: Node's
	// type-stripping loader (how the test suite runs .ts directly) rejects
	// parameter properties, since erasing them would change runtime behaviour.
	private readonly maxBytes: number;

	/**
	 * @param maxBytes - Hard ceiling on buffered bytes; `append` refuses beyond it.
	 * @param initialCapacity - Starting allocation, grown by doubling as needed.
	 */
	constructor(maxBytes: number, initialCapacity = 1024) {
		if (maxBytes <= 0) throw new Error(`maxBytes must be positive, got ${maxBytes}`);
		this.maxBytes = maxBytes;
		this.buf = Buffer.alloc(Math.min(Math.max(initialCapacity, 1), maxBytes));
	}

	/** Number of buffered, not-yet-consumed bytes. */
	get length(): number {
		return this.end - this.start;
	}

	/** The configured ceiling, so callers can report it in errors. */
	get limit(): number {
		return this.maxBytes;
	}

	/**
	 * Append received bytes.
	 *
	 * @returns `false` when the chunk would exceed `maxBytes`. The buffer is
	 * left untouched in that case; the caller is expected to treat it as a
	 * protocol violation and tear the connection down, because there is no
	 * correct way to keep framing a stream we have started dropping bytes from.
	 */
	append(chunk: Buffer): boolean {
		if (chunk.length === 0) return true;
		if (this.length + chunk.length > this.maxBytes) return false;

		this.ensureRoom(chunk.length);
		chunk.copy(this.buf as unknown as Uint8Array, this.end);
		this.end += chunk.length;
		return true;
	}

	/** Byte at `offset` within the unconsumed window, or `undefined` past the end. */
	byteAt(offset: number): number | undefined {
		if (offset < 0 || offset >= this.length) return undefined;
		return this.buf[this.start + offset];
	}

	/** Big-endian uint32 at `offset` within the unconsumed window. */
	readUInt32BE(offset: number): number {
		if (offset < 0 || offset + 4 > this.length) {
			throw new RangeError(`readUInt32BE(${offset}) out of range (length ${this.length})`);
		}
		return this.buf.readUInt32BE(this.start + offset);
	}

	/**
	 * Index of the first occurrence of `byte`, relative to the window start, or
	 * -1. Scanning is bounded by `maxBytes` by construction.
	 */
	indexOfByte(byte: number, fromOffset = 0): number {
		const from = this.start + Math.max(fromOffset, 0);
		if (from >= this.end) return -1;
		const found = this.buf.indexOf(byte, from);
		return found === -1 || found >= this.end ? -1 : found - this.start;
	}

	/** Index of the first byte satisfying `pred`, relative to the window start, or -1. */
	findIndex(pred: (byte: number) => boolean): number {
		for (let i = this.start; i < this.end; i++) {
			if (pred(this.buf[i]!)) return i - this.start;
		}
		return -1;
	}

	/**
	 * Copy of the first `n` buffered bytes, without consuming them. A copy
	 * rather than a view so callers cannot pin the backing allocation.
	 */
	peek(n: number): Buffer {
		const count = Math.min(Math.max(n, 0), this.length);
		return Buffer.from(this.buf.subarray(this.start, this.start + count));
	}

	/**
	 * Remove the first `n` bytes and return them as a copy.
	 *
	 * @throws RangeError when `n` exceeds the buffered length, since consuming
	 * bytes that were never received would desynchronise framing silently.
	 */
	consume(n: number): Buffer {
		if (n < 0 || n > this.length) {
			throw new RangeError(`consume(${n}) out of range (length ${this.length})`);
		}
		const out = Buffer.from(this.buf.subarray(this.start, this.start + n));
		this.discard(n);
		return out;
	}

	/** Drop the first `n` bytes without copying them out. */
	discard(n: number): void {
		if (n < 0 || n > this.length) {
			throw new RangeError(`discard(${n}) out of range (length ${this.length})`);
		}
		this.start += n;
		if (this.start === this.end) {
			this.start = 0;
			this.end = 0;
		}
	}

	/** Drop everything. */
	clear(): void {
		this.start = 0;
		this.end = 0;
	}

	/** Make room for `extra` more bytes, compacting before growing. */
	private ensureRoom(extra: number): void {
		if (this.end + extra <= this.buf.length) return;

		// Slide the live window to the front first — usually enough, and it keeps
		// the allocation from ratcheting up just because reads trail writes.
		if (this.start > 0) {
			this.buf.copy(this.buf as unknown as Uint8Array, 0, this.start, this.end);
			this.end -= this.start;
			this.start = 0;
		}
		if (this.end + extra <= this.buf.length) return;

		let capacity = this.buf.length;
		while (capacity < this.end + extra) capacity *= 2;
		// `append` already refused chunks that would exceed the ceiling, so the
		// required capacity is always within it.
		capacity = Math.min(capacity, this.maxBytes);

		const grown = Buffer.alloc(capacity);
		this.buf.copy(grown as unknown as Uint8Array, 0, 0, this.end);
		this.buf = grown;
	}
}
