/**
 * Deterministic fuzzing harness.
 *
 * Zero dependencies on purpose: the plugin ships with a single runtime
 * dependency, and adding a property-testing library would widen the lockfile
 * (and the osv-scanner surface) for something a seeded PRNG plus a few
 * structure-aware generators covers.
 *
 * Determinism is the point. Every run derives from a seed that is reported on
 * failure, so a finding is replayable: rerun with `FUZZ_SEED=<seed>`. In CI the
 * seed is fixed and the iteration count small, so the normal suite can never go
 * flaky; the nightly workflow raises both.
 *
 * Generators are structure-aware because uniformly random bytes barely reach
 * past the first magic-byte check — to exercise the length-field and framing
 * logic you have to emit things that look like eISCP frames but lie.
 */

/**
 * Small, fast, seedable PRNG (mulberry32).
 *
 * Not cryptographic — it only needs to be reproducible and well-distributed.
 */
export function makeRng(seed: number): Rng {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (maxExclusive) => Math.floor(next() * maxExclusive),
		below: (maxExclusive) => Math.floor(next() * maxExclusive),
		between: (min, maxInclusive) => min + Math.floor(next() * (maxInclusive - min + 1)),
		bool: (probability = 0.5) => next() < probability,
		pick: (items) => items[Math.floor(next() * items.length)]!,
		bytes: (length) => {
			const buf = Buffer.allocUnsafe(length);
			for (let i = 0; i < length; i++) buf[i] = Math.floor(next() * 256);
			return buf;
		},
	};
}

export interface Rng {
	/** Float in [0, 1). */
	next(): number;
	/** Integer in [0, maxExclusive). */
	int(maxExclusive: number): number;
	/** Integer in [0, maxExclusive). Alias of `int`, reads better in some places. */
	below(maxExclusive: number): number;
	/** Integer in [min, maxInclusive]. */
	between(min: number, maxInclusive: number): number;
	bool(probability?: number): boolean;
	pick<T>(items: readonly T[]): T;
	bytes(length: number): Buffer;
}

export interface FuzzConfig {
	seed: number;
	iterations: number;
}

/**
 * Resolve the fuzz budget from the environment.
 *
 * Defaults are deliberately small so `npm test` stays fast and deterministic.
 * `FUZZ_SEED=random` picks a fresh seed (what the nightly workflow does); any
 * integer pins it, which is how you replay a reported failure.
 *
 * @param defaultIterations - Per-case iteration count when FUZZ_ITERATIONS is unset.
 */
export function fuzzConfig(defaultIterations = 250): FuzzConfig {
	const rawSeed = process.env.FUZZ_SEED;
	let seed: number;
	if (rawSeed === undefined) {
		seed = 0x5eed;
	} else if (rawSeed === "random") {
		// Only reachable when explicitly requested; the seed is printed below so
		// the run stays reproducible.
		seed = (Math.random() * 0xffffffff) >>> 0;
	} else {
		const parsed = Number.parseInt(rawSeed, 10);
		if (!Number.isFinite(parsed)) throw new Error(`Invalid FUZZ_SEED: ${rawSeed}`);
		seed = parsed >>> 0;
	}

	const rawIterations = process.env.FUZZ_ITERATIONS;
	let iterations = defaultIterations;
	if (rawIterations !== undefined) {
		const parsed = Number.parseInt(rawIterations, 10);
		if (!Number.isFinite(parsed) || parsed < 1) {
			throw new Error(`Invalid FUZZ_ITERATIONS: ${rawIterations}`);
		}
		iterations = parsed;
	}

	return { seed, iterations };
}

/**
 * Human-readable reproduction hint, attached to every fuzz failure message.
 *
 * Without this a failing nightly run is nearly useless: the input is random and
 * the report has to carry enough to reproduce it locally.
 */
export function reproHint(config: FuzzConfig, iteration: number, input: unknown): string {
	return [
		`\n  reproduce with: FUZZ_SEED=${config.seed} FUZZ_ITERATIONS=${config.iterations} npm run test:fuzz`,
		`  iteration: ${iteration}`,
		`  input: ${describeInput(input)}`,
	].join("\n");
}

/** Compact, copy-pasteable rendering of a fuzz input. */
export function describeInput(input: unknown): string {
	if (Buffer.isBuffer(input)) {
		const hex = input.subarray(0, 256).toString("hex");
		return `Buffer(${input.length}) ${hex}${input.length > 256 ? "…" : ""}`;
	}
	if (typeof input === "string") {
		return JSON.stringify(input.length > 512 ? `${input.slice(0, 512)}…` : input);
	}
	return JSON.stringify(input);
}

/**
 * Run `body` for every iteration, converting any failure into an assertion-style
 * error that carries the seed, the iteration and the offending input.
 *
 * The wrapper exists so no individual fuzz test has to remember to report the
 * reproduction details — a fuzz failure that cannot be replayed is noise.
 *
 * @param config - Seed and iteration budget.
 * @param generate - Builds the input for an iteration.
 * @param body - Exercises the code under test; throw to fail.
 */
export function fuzzEach<T>(
	config: FuzzConfig,
	generate: (rng: Rng, iteration: number) => T,
	body: (input: T, iteration: number) => void,
): void {
	const rng = makeRng(config.seed);
	for (let i = 0; i < config.iterations; i++) {
		const input = generate(rng, i);
		try {
			body(input, i);
		} catch (err) {
			const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
			throw new Error(`${message}${reproHint(config, i, input)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Invariant helpers
// ---------------------------------------------------------------------------

/**
 * Assert that a parser either succeeds or fails with a deliberate `Error`.
 *
 * The distinction matters: a plain `Error` is the parser rejecting bad input,
 * whereas a `TypeError`/`RangeError` almost always means an unchecked access
 * (reading past a buffer, calling a method on undefined) — i.e. a bug reachable
 * from the network rather than a validation path.
 *
 * @returns The parser's result, or undefined when it rejected.
 */
export function expectOnlyDeliberateErrors<T>(fn: () => T, what: string): T | undefined {
	try {
		return fn();
	} catch (err) {
		if (err instanceof RangeError || err instanceof TypeError || err instanceof ReferenceError) {
			throw new Error(`${what} threw ${err.constructor.name} (expected a deliberate Error): ${err.message}`);
		}
		if (!(err instanceof Error)) {
			throw new Error(`${what} threw a non-Error value: ${describeInput(err)}`);
		}
		return undefined;
	}
}

/**
 * Assert that `fn` completes within `budgetMs`.
 *
 * Guards the anchored trailing-run and greedy-group regexes in the parsers,
 * where a crafted input can otherwise cost quadratic time. Deliberately
 * generous: this must catch algorithmic blowups, not fail on a loaded CI runner.
 */
export function expectFastCompletion(fn: () => void, budgetMs: number, what: string): void {
	const started = process.hrtime.bigint();
	fn();
	const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
	if (elapsedMs > budgetMs) {
		throw new Error(`${what} took ${elapsedMs.toFixed(1)} ms (budget ${budgetMs} ms)`);
	}
}

// ---------------------------------------------------------------------------
// eISCP structure-aware generators
// ---------------------------------------------------------------------------

const MAGIC = "ISCP";

export interface FrameOptions {
	/** Magic bytes; defaults to "ISCP". Wrong values exercise the resync path. */
	magic?: string | Buffer;
	/** Header-size field. The decoder requires exactly 16. */
	headerSize?: number;
	/** Data-size field. Set independently of `body` to make the frame lie. */
	dataSize?: number;
	/** Version field (4 bytes). */
	version?: Buffer;
	/** Payload appended after the 16-byte header. */
	body?: string | Buffer;
}

/**
 * Build an eISCP frame with every header field individually controllable,
 * including inconsistently — a header that claims a size its body does not have
 * is exactly the interesting case.
 */
export function buildFrame(options: FrameOptions = {}): Buffer {
	const body = Buffer.isBuffer(options.body)
		? options.body
		: Buffer.from(options.body ?? "!1PWR01\r", "ascii");
	const magic = Buffer.isBuffer(options.magic)
		? options.magic
		: Buffer.from((options.magic ?? MAGIC).padEnd(4, "\0").slice(0, 4), "ascii");

	const header = Buffer.alloc(16);
	magic.copy(header as unknown as Uint8Array, 0, 0, Math.min(4, magic.length));
	header.writeUInt32BE(clampUInt32(options.headerSize ?? 16), 4);
	header.writeUInt32BE(clampUInt32(options.dataSize ?? body.length), 8);
	(options.version ?? Buffer.from([0x01, 0x00, 0x00, 0x00])).copy(header as unknown as Uint8Array, 12);

	return Buffer.concat([header as unknown as Uint8Array, body as unknown as Uint8Array]);
}

function clampUInt32(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(Math.floor(value), 0xffffffff));
}

/**
 * A frame whose header fields are randomly (and often inconsistently) chosen.
 *
 * Biased toward near-valid frames: fully random bytes are rejected at the magic
 * check and never reach the length handling, which is where the interesting
 * behaviour lives.
 */
export function randomFrame(rng: Rng): Buffer {
	const body = randomIscpBody(rng);
	return buildFrame({
		magic: rng.bool(0.8) ? MAGIC : rng.bytes(4).toString("latin1"),
		headerSize: rng.bool(0.8) ? 16 : rng.pick([0, 1, 8, 15, 17, 32, 0xffffffff]),
		dataSize: rng.bool(0.6)
			? body.length
			: rng.pick([0, 1, body.length - 1, body.length + 1, 0xffff, 0xffffff, 0xffffffff]),
		version: rng.bool(0.8)
			? Buffer.from([0x01, 0x00, 0x00, 0x00])
			: rng.bytes(4),
		body,
	});
}

/** An ISCP message body: mostly plausible, sometimes truncated or corrupted. */
export function randomIscpBody(rng: Rng): Buffer {
	if (rng.bool(0.15)) return rng.bytes(rng.between(0, 64));

	const unit = rng.pick(["1", "p", "x", "", "\x00", "!"]);
	const command = rng.bool(0.7)
		? rng.pick(["PWR", "MVL", "AMT", "SLI", "LMD", "FLD", "NLS", "ECN", "NLT", "AEQ"])
		: randomAscii(rng, rng.between(0, 5));
	const parameter = rng.bool(0.7)
		? rng.pick(["01", "00", "QSTN", "UP", "DOWN", "TG", "N/A", "FF", "FFFFFFFFFF", "2E", ""])
		: randomAscii(rng, rng.between(0, 96));
	const terminator = rng.pick(["\r", "\n", "\x1a", "\r\n", "\x19\r\n", "", "\x00\x00"]);

	return Buffer.from(`${rng.bool(0.9) ? "!" : ""}${unit}${command}${parameter}${terminator}`, "latin1");
}

/** An ECN discovery body, including the malformed shapes a peer could send. */
export function randomEcnBody(rng: Rng): Buffer {
	if (rng.bool(0.1)) return rng.bytes(rng.between(0, 64));

	const model = rng.bool(0.7)
		? rng.pick(["VSX-S520D", "TX-NR609", "TX-8270", ""])
		: randomAscii(rng, rng.between(0, 300));
	const port = rng.bool(0.6)
		? "60128"
		: rng.pick(["0", "-5", "65536", "99999999", "ABC", "", "60128junk", "0x10", " 60128"]);
	const area = rng.pick(["DX", "XX", "JJ", "", "D"]);
	const id = rng.bool(0.7) ? "0009B0F0EE61" : randomAscii(rng, rng.between(0, 40));
	// Real devices pad the datagram with NULs; keep that in the corpus.
	const padding = rng.bool(0.3) ? "\x00".repeat(rng.between(1, 200)) : "";
	const separator = rng.bool(0.5) ? "/" : "";

	return Buffer.from(
		`!${rng.pick(["1", "p"])}ECN${model}/${port}/${area}${separator}${id}\x19\r\n${padding}`,
		"latin1",
	);
}

/** Random printable-ish ASCII, with control characters mixed in on purpose. */
export function randomAscii(rng: Rng, length: number): string {
	let out = "";
	for (let i = 0; i < length; i++) {
		out += rng.bool(0.85)
			? String.fromCharCode(rng.between(0x20, 0x7e))
			: String.fromCharCode(rng.between(0, 0x1f));
	}
	return out;
}

/**
 * Mutate a buffer in place-ish (returns a copy): bit flips, truncation,
 * splices, and length-field corruption.
 *
 * Used to walk outward from known-good inputs, which reaches states a from-scratch
 * generator rarely produces.
 */
export function mutate(rng: Rng, input: Buffer): Buffer {
	const buf = Buffer.from(input);
	switch (rng.int(5)) {
		case 0: {
			// Bit flip
			if (buf.length === 0) return buf;
			const index = rng.int(buf.length);
			buf[index] = buf[index]! ^ (1 << rng.int(8));
			return buf;
		}
		case 1:
			// Truncate
			return buf.subarray(0, rng.int(buf.length + 1));
		case 2:
			// Append garbage
			return Buffer.concat([
				buf as unknown as Uint8Array,
				rng.bytes(rng.between(1, 32)) as unknown as Uint8Array,
			]);
		case 3: {
			// Corrupt the declared data size
			if (buf.length < 12) return buf;
			buf.writeUInt32BE(rng.pick([0, 1, 0xff, 0xffff, 0xffffff, 0xffffffff]), 8);
			return buf;
		}
		default: {
			// Byte splice
			if (buf.length === 0) return buf;
			const index = rng.int(buf.length);
			buf[index] = rng.int(256);
			return buf;
		}
	}
}
