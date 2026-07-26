/**
 * The shared global-settings write funnel (src/actions/eiscp-base.ts).
 *
 * Stream Deck keeps the learned-name map and the remembered device in one
 * object, so every writer merges over the others' values. Both ways of getting
 * that merge wrong have already cost real data, which is what these tests pin
 * down. SDK-free like the module under test: the writer is injected.
 *
 * Order matters here — the load gate opens once per process, so the "refuses
 * before the load" case has to run before anything opens it.
 */
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	areGlobalSettingsLoaded,
	getCachedGlobalSettings,
	markGlobalSettingsLoaded,
	setCachedGlobalSettings,
	setGlobalSettingsWriter,
	updateGlobalSettings,
	type GlobalSettings,
} from "../src/actions/eiscp-base.ts";

const NAMES_BEFORE = { "10.2.0.32": { SLI: { "01": "Chromecast" } } };
const NAMES_AFTER = { "10.2.0.32": { SLI: { "01": "Chromecast", "02": "Apple TV" } } };

describe("updateGlobalSettings", () => {
	it("refuses to write before the initial load has landed", async () => {
		let writes = 0;
		setGlobalSettingsWriter(async () => {
			writes++;
		});
		assert.equal(areGlobalSettingsLoaded(), false);
		// Until the load lands the cache is empty, so any write would persist an
		// object with every other key missing — that wiped a user's learned names.
		await assert.rejects(
			updateGlobalSettings((current) => ({ ...current, lastDevice: { host: "10.2.0.32" } }), 20),
			/never loaded/,
		);
		assert.equal(writes, 0, "nothing may be persisted while the settings are unknown");
	});

	it("keeps two independent writers from reverting each other", async () => {
		// The regression this funnel exists for: name-store persisted `names`
		// without putting the result back into the cache, so the next lastDevice
		// write merged over a superseded snapshot and rolled the learned names back
		// to their startup state. Stream Deck does not echo a plugin's own write
		// back, so nothing repaired the cache in between.
		const persisted: GlobalSettings[] = [];
		setGlobalSettingsWriter(async (gs) => {
			persisted.push(structuredClone(gs));
		});
		setCachedGlobalSettings({ names: NAMES_BEFORE });
		markGlobalSettingsLoaded();

		await updateGlobalSettings((current) => ({ ...current, names: NAMES_AFTER }));
		await updateGlobalSettings((current) => ({
			...current,
			lastDevice: { host: "10.2.0.32", model: "VSX-S520D" },
		}));

		const written = persisted.at(-1);
		assert.deepEqual(written?.lastDevice, { host: "10.2.0.32", model: "VSX-S520D" });
		assert.deepEqual(written?.names, NAMES_AFTER, "the second write must not revert the first");
		assert.deepEqual(getCachedGlobalSettings().names, NAMES_AFTER);
	});

	it("skips the round trip when the patch returns undefined", async () => {
		let writes = 0;
		setGlobalSettingsWriter(async () => {
			writes++;
		});
		await updateGlobalSettings(() => undefined);
		assert.equal(writes, 0);
	});

	it("serialises writes, so a queued patch sees the one before it", async () => {
		const persisted: GlobalSettings[] = [];
		setGlobalSettingsWriter(async (gs) => {
			// Slow enough that an unserialised second patch would read the old cache.
			await new Promise((resolve) => {
				setTimeout(resolve, 20).unref?.();
			});
			persisted.push(structuredClone(gs));
		});
		setCachedGlobalSettings({});

		const first = updateGlobalSettings((current) => ({ ...current, deviceIp: "10.0.0.1" }));
		const second = updateGlobalSettings((current) => ({ ...current, lastDevice: { host: "10.0.0.2" } }));
		await Promise.all([first, second]);

		assert.equal(persisted.length, 2);
		assert.deepEqual(persisted[1], { deviceIp: "10.0.0.1", lastDevice: { host: "10.0.0.2" } });
	});

	it("carries the values of a failed write into the next one", async () => {
		// A failure must not resurrect old data: the cache keeps the new values, so
		// the next successful write persists them and the failure self-heals.
		const persisted: GlobalSettings[] = [];
		let failNext = true;
		setGlobalSettingsWriter(async (gs) => {
			if (failNext) {
				failNext = false;
				throw new Error("websocket closed");
			}
			persisted.push(structuredClone(gs));
		});
		setCachedGlobalSettings({ names: NAMES_AFTER });

		await assert.rejects(updateGlobalSettings((current) => ({ ...current, deviceIp: "10.0.0.1" })));
		// The queue must survive the rejection.
		await updateGlobalSettings((current) => ({ ...current, lastDevice: { host: "10.0.0.2" } }));

		assert.deepEqual(persisted, [
			{ names: NAMES_AFTER, deviceIp: "10.0.0.1", lastDevice: { host: "10.0.0.2" } },
		]);
	});

	it("reports a missing writer instead of silently dropping the write", async () => {
		setGlobalSettingsWriter(undefined);
		await assert.rejects(updateGlobalSettings((current) => ({ ...current, deviceIp: "10.0.0.1" })), /writer/);
	});
});

describe("global-settings write funnel is the only writer", () => {
	/**
	 * The funnel only protects what goes through it. A second caller of
	 * `settings.setGlobalSettings` merges over its own idea of the object again —
	 * which is exactly how the learned-name map was lost twice. Cheaper to assert
	 * here than to rediscover in a review.
	 */
	it("no source file outside plugin.ts calls setGlobalSettings directly", () => {
		const src = fileURLToPath(new URL("../src", import.meta.url));
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(full);
					continue;
				}
				if (!entry.name.endsWith(".ts")) continue;
				// plugin.ts holds the single SDK binding injected into the funnel.
				if (full.endsWith(`${sep}plugin.ts`)) continue;
				if (/\bsetGlobalSettings\s*\(/.test(readFileSync(full, "utf8"))) {
					offenders.push(full.slice(src.length + 1));
				}
			}
		};
		walk(src);
		assert.deepEqual(offenders, [], "these must go through updateGlobalSettings instead");
	});
});
