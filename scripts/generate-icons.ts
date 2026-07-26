#!/usr/bin/env tsx
/**
 * Generate Stream Deck action icons from Lucide SVGs.
 *
 * Reads the dedicated-action catalog (src/actions/dedicated/catalog.ts) and the
 * Lucide source SVGs (node_modules/lucide-static), then writes per-action images
 * into the plugin's imgs/actions/<id>/ folder:
 *   - icon.svg        small monochrome glyph for the action list
 *   - key.svg         144x144 key image (dark bg + glyph + optional corner badge)
 *   - key-dim.svg     the same, drawn as "the receiver is not listening" — shown
 *                     while it is in standby or unreachable (see keyImageFor)
 *   - key-on.svg      (toggles only) the ON-state key image (accent bg)
 *   - key-on-dim.svg  (toggles only) the dim ON-state image
 *
 * The dim variants exist as files rather than being composed at runtime so the
 * look is reviewable in a diff and the plugin only has to name a path.
 *
 * Lucide glyphs are stroke-based with stroke="currentColor"; we render them with
 * an explicit white stroke because Stream Deck keys have no CSS color context.
 *
 * Usage: npm run generate:icons
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEDICATED_SPECS,
	GENERIC_SPECS,
	keyImageName,
	onStateColor,
	type IconSpec,
} from "../src/actions/dedicated/catalog.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const LUCIDE_DIR = resolve(PROJECT_ROOT, "node_modules/lucide-static/icons");
const SD_PLUGIN = "de.schwetschke.sd.eiscp-avr-remote.sdPlugin";
const ACTIONS_IMG_DIR = resolve(PROJECT_ROOT, SD_PLUGIN, "imgs/actions");

const STROKE = "#FFFFFF";
const BG_DARK = "#1A1A1A";

// The "receiver is not listening" look: the same glyph, drawn as if the light
// were off. Grey rather than translucent, because a key image has no backdrop to
// blend with — 0.4 opacity over nothing is just a lighter grey anyway, and an
// explicit colour is what the SVG renderer treats identically everywhere.
const STROKE_DIM = "#6E6E6E";
const BG_DIM = "#141414";
/** How much of an ON-state accent colour survives in the dim variant. */
const DIM_FACTOR = 0.4;

/** Scale a #rrggbb colour toward black. */
function darken(hex: string, factor: number): string {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) throw new Error(`cannot darken ${hex}`);
	const channel = (part: string): string =>
		Math.round(Number.parseInt(part, 16) * factor)
			.toString(16)
			.padStart(2, "0")
			.toUpperCase();
	return `#${channel(m[1]!)}${channel(m[2]!)}${channel(m[3]!)}`;
}

/** Extract the inner markup (paths/lines/...) of a Lucide SVG, dropping the wrapper. */
function lucideInner(name: string): string {
	const file = resolve(LUCIDE_DIR, `${name}.svg`);
	const raw = readFileSync(file, "utf-8");
	const m = raw.replace(/<!--[\s\S]*?-->/g, "").match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
	if (!m) throw new Error(`Could not parse Lucide icon: ${name}`);
	return m[1]!.replace(/\s+/g, " ").trim();
}

/** A <g> that draws a Lucide glyph (24-unit space) at the given box. */
function glyphGroup(name: string, x: number, y: number, size: number, stroke: string): string {
	const scale = (size / 24).toFixed(4);
	return (
		`<g transform="translate(${x},${y}) scale(${scale})" fill="none" stroke="${stroke}" ` +
		`stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${lucideInner(name)}</g>`
	);
}

/** 144x144 key image: rounded background + main glyph (+ optional corner badge). */
function keyImage(icon: IconSpec, bg: string, onState: boolean, dim = false): string {
	const primary = onState ? icon.onPrimary ?? icon.primary : icon.primary;
	const hasBadge = !!icon.badge;
	const stroke = dim ? STROKE_DIM : STROKE;
	const main = hasBadge ? glyphGroup(primary, 18, 14, 84, stroke) : glyphGroup(primary, 26, 26, 92, stroke);
	const badge = hasBadge ? glyphGroup(icon.badge!, 84, 82, 50, stroke) : "";
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">` +
		`<rect width="144" height="144" rx="18" fill="${bg}"/>${main}${badge}</svg>\n`
	);
}

/** Write both the lit and the dim variant of one key image. */
function writeKeyImages(dir: string, icon: IconSpec, bg: string, onState: boolean): number {
	writeFileSync(resolve(dir, `${keyImageName(onState, false)}.svg`), keyImage(icon, bg, onState), "utf-8");
	writeFileSync(
		resolve(dir, `${keyImageName(onState, true)}.svg`),
		keyImage(icon, onState ? darken(bg, DIM_FACTOR) : BG_DIM, onState, true),
		"utf-8",
	);
	return 2;
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
	written += 1;
	written += writeKeyImages(dir, icon, BG_DARK, false);

	if (spec.states === 2) {
		written += writeKeyImages(dir, icon, onStateColor(spec.command), true);
	}
	console.log(`  ${spec.id}: ${icon.primary}${icon.badge ? " + " + icon.badge : ""}`);
}

// Generic actions: single glyph, no badge, no on-state.
for (const spec of GENERIC_SPECS) {
	const dir = resolve(ACTIONS_IMG_DIR, spec.id);
	mkdirSync(dir, { recursive: true });
	const icon: IconSpec = { primary: spec.iconName };
	writeFileSync(resolve(dir, "icon.svg"), listIcon(icon), "utf-8");
	written += 1;
	written += writeKeyImages(dir, icon, BG_DARK, false);
	// The generic toggle declares two states but paints both from the same file;
	// its ON look comes from the runtime colored background, so no -on variant.
	console.log(`  ${spec.id}: ${spec.iconName}`);
}

// Bundle the Lucide license alongside the icons (ISC requires preserving it).
mkdirSync(resolve(PROJECT_ROOT, SD_PLUGIN, "imgs/icons"), { recursive: true });
copyFileSync(
	resolve(PROJECT_ROOT, "node_modules/lucide-static/LICENSE"),
	resolve(PROJECT_ROOT, SD_PLUGIN, "imgs/icons/LICENSE-lucide.txt"),
);

console.log(`\nGenerated ${written} icon files for ${DEDICATED_SPECS.length} actions in ${ACTIONS_IMG_DIR}`);
