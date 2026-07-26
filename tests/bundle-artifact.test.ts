/**
 * Tests for the **built bundle**, which nothing else in this suite looks at.
 *
 * The gap this closes: every other test imports TypeScript sources directly (Node
 * 24 strips the types), so the bundler is never exercised. A bundler that emitted
 * *legacy* decorators, or silently lowered class fields because `target` slipped,
 * would leave all 520 other tests green and break the plugin at runtime — which is
 * exactly the failure mode that made the choice of transpiler load-bearing (see
 * docs/bundler-analysis-2026-07.md).
 *
 * The checks are deliberately toolchain-neutral, so they keep meaning if the bundle
 * step ever moves off Rollup:
 *
 *  1. the bundle parses under this Node (`node --check`),
 *  2. it carries the *standard* decorator context (`addInitializer`, `kind:"class"`),
 *     property literals that survive minification and that legacy emit has no
 *     equivalent for,
 *  3. it evaluates far enough to register all 25 actions.
 *
 * And (4) the harness proves its own signal: the same probe against a deliberately
 * broken setup must fail. Without that, (3) would be a test that cannot fail — the
 * exit code is useless here, because the plugin's own uncaughtException net swallows
 * a failed registration and still exits 0.
 *
 * CI builds before it tests, so the artifact is there. Locally it may not be; the
 * suite then reports that rather than passing quietly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGIN_DIR = resolve(import.meta.dirname, "../de.schwetschke.sd.eiscp-avr-remote.sdPlugin");
const BUNDLE = join(PLUGIN_DIR, "bin/plugin.js");
const MANIFEST = join(PLUGIN_DIR, "manifest.json");

const built = existsSync(BUNDLE);

/**
 * Run the bundle in a throwaway directory. The SDK resolves `manifest.json` from
 * the working directory and writes its log next to it, so this both isolates the
 * run from the real plugin's logs and lets the manifest be withheld on purpose.
 */
function runBundle(options: { withManifest: boolean }): { status: number | null; log: string } {
	const dir = mkdtempSync(join(tmpdir(), "eiscp-bundle-"));
	try {
		if (options.withManifest) copyFileSync(MANIFEST, join(dir, "manifest.json"));
		const result = spawnSync(process.execPath, [BUNDLE], { cwd: dir, encoding: "utf-8", timeout: 30_000 });
		const logDir = join(dir, "logs");
		const log = existsSync(logDir)
			? readdirSync(logDir)
					.map((file) => readFileSync(join(logDir, file), "utf-8"))
					.join("\n")
			: "";
		return { status: result.status, log };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("built bundle", { skip: built ? false : "run `npm run build` first" }, () => {
	it("parses under this Node", () => {
		// Catches an emit the runtime cannot even read — a real failure mode: a
		// transpiler without a standard-decorator transform leaves `@action(...) class`
		// in the output and still exits 0.
		const check = spawnSync(process.execPath, ["--check", BUNDLE], { encoding: "utf-8" });
		assert.equal(check.status, 0, `node --check failed:\n${check.stderr}`);
	});

	it("applies decorators with a standard context object", () => {
		// Standard decorators are called with (value, context); legacy emit passes the
		// target alone and has no context, so neither literal below can appear. Both
		// survive minification because they are property/string literals, and both are
		// emitted by tslib and by esbuild's lowering — so this holds across bundlers.
		const bundle = readFileSync(BUNDLE, "utf-8");
		assert.ok(bundle.includes("addInitializer"), "no decorator context — legacy decorator emit?");
		assert.ok(
			bundle.includes('kind:"class"') || bundle.includes('kind: "class"'),
			"no class-decorator context kind — legacy decorator emit?",
		);
	});

	it("registers all 25 actions when it runs", () => {
		// `registerAction` throws for a UUID that is not in the manifest, and the
		// "passive name discovery registered" line comes *after* every registration in
		// plugin.ts — so reaching it is proof that all of them succeeded. A decorator
		// regression that lost the UUIDs would stop short of it.
		const { log } = runBundle({ withManifest: true });
		assert.match(log, /passive name discovery registered/, `registration did not complete:\n${log}`);
		assert.doesNotMatch(log, /uncaught exception/i, `the bundle threw while loading:\n${log}`);
		// Not connecting is expected: there is no Stream Deck to talk to here.
		assert.match(log, /missing command line arguments/, "expected the connection to fail without Stream Deck");
	});

	it("would notice if registration broke", () => {
		// The self-check. Same probe, manifest withheld, so `registerAction` throws:
		// the assertions above must be able to see that. Note the exit code stays 0
		// either way — the plugin's own uncaughtException handler keeps it alive — which
		// is precisely why the test above reads the log rather than the status.
		const { status, log } = runBundle({ withManifest: false });
		assert.match(log, /uncaught exception/i, "expected the missing manifest to surface as an exception");
		assert.doesNotMatch(log, /passive name discovery registered/, "registration must not complete without a manifest");
		assert.equal(status, 0, "and the exit code is 0 regardless — so it is not a usable signal");
	});
});

describe("built bundle (not built)", { skip: built ? "the bundle is present" : false }, () => {
	it("is missing, so the artifact checks were skipped", () => {
		// Loud rather than silent: CI builds before testing, so this only fires locally.
		assert.ok(!built);
	});
});
