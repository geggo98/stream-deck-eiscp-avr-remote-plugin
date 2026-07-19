#!/usr/bin/env tsx
/**
 * Generate Stream Deck action icons from Lucide SVGs.
 *
 * Reads the dedicated-action catalog (src/actions/dedicated/catalog.ts) and the
 * Lucide source SVGs (node_modules/lucide-static), then writes per-action images
 * into the plugin's imgs/actions/<id>/ folder:
 *   - icon.svg   small monochrome glyph for the action list
 *   - key.svg    144x144 key image (dark bg + glyph + optional corner badge)
 *   - key-on.svg (toggles only) the ON-state key image (accent bg)
 *
 * Lucide glyphs are stroke-based with stroke="currentColor"; we render them with
 * an explicit white stroke because Stream Deck keys have no CSS color context.
 *
 * Usage: npm run generate:icons
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEDICATED_SPECS, GENERIC_SPECS, onStateColor, type IconSpec } from "../src/actions/dedicated/catalog.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const LUCIDE_DIR = resolve(PROJECT_ROOT, "node_modules/lucide-static/icons");
const SD_PLUGIN = "de.schwetschke.sd.eiscp-avr-remote.sdPlugin";
const ACTIONS_IMG_DIR = resolve(PROJECT_ROOT, SD_PLUGIN, "imgs/actions");

const STROKE = "#FFFFFF";
const BG_DARK = "#1A1A1A";

/** Extract the inner markup (paths/lines/...) of a Lucide SVG, dropping the wrapper. */
function lucideInner(name: string): string {
	const file = resolve(LUCIDE_DIR, `${name}.svg`);
	const raw = readFileSync(file, "utf-8");
	const m = raw.replace(/<!--[\s\S]*?-->/g, "").match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
	if (!m) throw new Error(`Could not parse Lucide icon: ${name}`);
	return m[1]!.replace(/\s+/g, " ").trim();
}

/** A <g> that draws a Lucide glyph (24-unit space) at the given box, white stroke. */
function glyphGroup(name: string, x: number, y: number, size: number): string {
	const scale = (size / 24).toFixed(4);
	return (
		`<g transform="translate(${x},${y}) scale(${scale})" fill="none" stroke="${STROKE}" ` +
		`stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${lucideInner(name)}</g>`
	);
}

/** 144x144 key image: rounded background + main glyph (+ optional corner badge). */
function keyImage(icon: IconSpec, bg: string, onState: boolean): string {
	const primary = onState ? icon.onPrimary ?? icon.primary : icon.primary;
	const hasBadge = !!icon.badge;
	const main = hasBadge ? glyphGroup(primary, 18, 14, 84) : glyphGroup(primary, 26, 26, 92);
	const badge = hasBadge ? glyphGroup(icon.badge!, 84, 82, 50) : "";
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
		`<rect width="144" height="144" rx="18" fill="${bg}"/>${main}${badge}</svg>\n`
	);
}

/** Small action-list icon: transparent, single white glyph in a 24 viewBox. */
function listIcon(icon: IconSpec): string {
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ` +
		`fill="none" stroke="${STROKE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
		`${lucideInner(icon.primary)}</svg>\n`
	);
}

let written = 0;
for (const spec of DEDICATED_SPECS) {
	const dir = resolve(ACTIONS_IMG_DIR, spec.id);
	mkdirSync(dir, { recursive: true });

	// Widen the as-const catalog literal so optional IconSpec fields are accessible.
	const icon: IconSpec = spec.icon;
	writeFileSync(resolve(dir, "icon.svg"), listIcon(icon), "utf-8");
	writeFileSync(resolve(dir, "key.svg"), keyImage(icon, BG_DARK, false), "utf-8");
	written += 2;

	if (spec.states === 2) {
		writeFileSync(resolve(dir, "key-on.svg"), keyImage(icon, onStateColor(spec.command), true), "utf-8");
		written += 1;
	}
	console.log(`  ${spec.id}: ${icon.primary}${icon.badge ? " + " + icon.badge : ""}`);
}

// Generic actions: single glyph, no badge, no on-state.
for (const spec of GENERIC_SPECS) {
	const dir = resolve(ACTIONS_IMG_DIR, spec.id);
	mkdirSync(dir, { recursive: true });
	const icon: IconSpec = { primary: spec.iconName };
	writeFileSync(resolve(dir, "icon.svg"), listIcon(icon), "utf-8");
	writeFileSync(resolve(dir, "key.svg"), keyImage(icon, BG_DARK, false), "utf-8");
	written += 2;
	console.log(`  ${spec.id}: ${spec.iconName}`);
}

// Bundle the Lucide license alongside the icons (ISC requires preserving it).
mkdirSync(resolve(PROJECT_ROOT, SD_PLUGIN, "imgs/icons"), { recursive: true });
copyFileSync(
	resolve(PROJECT_ROOT, "node_modules/lucide-static/LICENSE"),
	resolve(PROJECT_ROOT, SD_PLUGIN, "imgs/icons/LICENSE-lucide.txt"),
);

console.log(`\nGenerated ${written} icon files for ${DEDICATED_SPECS.length} actions in ${ACTIONS_IMG_DIR}`);
