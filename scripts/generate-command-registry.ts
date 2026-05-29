#!/usr/bin/env tsx
/**
 * Generate command registry from eiscp-commands.yaml
 *
 * Reads docs/eiscp-commands.yaml and outputs a typed TypeScript registry
 * of eISCP commands with classification (toggle/stepper/selector).
 *
 * Usage: npm run generate:commands
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

interface YamlValue {
	name: string | string[];
	description: string;
	models?: string;
}

interface YamlCommand {
	name: string | string[];
	aliases?: string[];
	description: string;
	values: Record<string, YamlValue>;
}

type CommandActionType = "toggle" | "stepper" | "selector";

interface CommandValueDef {
	param: string;
	name: string;
	description: string;
}

interface CommandDef {
	code: string;
	name: string;
	description: string;
	category: string;
	actionType: CommandActionType;
	values: CommandValueDef[];
	hasQuery: boolean;
	hasUpDown: boolean;
	onValue?: string;
	offValue?: string;
	toggleValue?: string;
}

// Commands to include in the registry (most useful for an AV remote).
const INCLUDED_COMMANDS = [
	"PWR", "AMT", "MVL", "SLI", "LMD", "DIM", "HDO",
	"SPA", "SPB", "DIR", "LTN", "RAS", "CTL",
	"ADY", "ADQ", "PMB",
	// Added: tone, preset, transport, Zone 2.
	"TFR", "PRS", "NTC", "ZPW", "ZMT", "ZVL", "SLZ",
];

// Most commands live in the `main` section. A few of the included codes also
// (or only) exist in other sections; pin those explicitly so lookup is
// deterministic. NTC's richest copy is in the `dock` (network) section.
const ZONE_OVERRIDE: Record<string, string> = {
	NTC: "dock",
	ZPW: "zone2",
	ZMT: "zone2",
	ZVL: "zone2",
	SLZ: "zone2",
};

// Human-readable grouping used for Property-Inspector optgroups.
const CODE_CATEGORY: Record<string, string> = {
	PWR: "Power / Mute", AMT: "Power / Mute",
	MVL: "Volume", CTL: "Volume",
	SLI: "Input / Mode", LMD: "Input / Mode",
	TFR: "Tone",
	PRS: "Tuner",
	NTC: "Transport",
	DIM: "Display / Video", HDO: "Display / Video",
	SPA: "Speaker", SPB: "Speaker",
	DIR: "Audio Processing", LTN: "Audio Processing", RAS: "Audio Processing",
	ADY: "Audio Processing", ADQ: "Audio Processing", PMB: "Audio Processing",
	ZPW: "Zone 2", ZMT: "Zone 2", ZVL: "Zone 2", SLZ: "Zone 2",
};

// Commands whose numeric value keys are literal digits (e.g. network-menu
// number entry), NOT hex byte codes — their params must pass through verbatim.
const NO_HEX_PAD = new Set(["NTC"]);

function classifyCommand(code: string, values: Record<string, YamlValue>): CommandActionType {
	const keys = Object.keys(values);
	// YAML may parse '00' as number 0, '01' as number 1
	const has00 = keys.includes("00") || keys.includes("'00'") || keys.includes("0");
	const has01 = keys.includes("01") || keys.includes("'01'") || keys.includes("1");
	const hasTG = keys.includes("TG");
	const hasUP = keys.includes("UP");
	const hasDOWN = keys.includes("DOWN");

	// Check for numeric range keys (arrays like [0, 80])
	const hasNumericRange = keys.some((k) => {
		try {
			const parsed = JSON.parse(k);
			return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "number";
		} catch {
			return false;
		}
	});

	// Stepper: has UP/DOWN + numeric range + QSTN (volume-like controls)
	if (hasUP && hasDOWN && (hasNumericRange || ["MVL", "CTL", "ZVL"].includes(code))) {
		return "stepper";
	}

	// Toggle: has 00+01 values (on/off pattern)
	if (has00 && has01) {
		// Count named (non-special) values
		const namedValues = keys.filter(
			(k) => !["QSTN", "UP", "DOWN", "TG", "DIM"].includes(k) && !isRangeKey(k),
		);
		// If only 2-3 named values and one is 00/01, it's a toggle
		if (namedValues.length <= 3 && (hasTG || !hasUP)) {
			return "toggle";
		}
	}

	// Selector: multiple named values
	return "selector";
}

function isRangeKey(key: string): boolean {
	try {
		const parsed = JSON.parse(key);
		return Array.isArray(parsed) && parsed.length === 2;
	} catch {
		return false;
	}
}

function normalizeName(name: string | string[]): string {
	if (Array.isArray(name)) {
		return name[0];
	}
	return name;
}

function normalizeParam(param: string, code: string): string {
	// eISCP value keys are already 2-char hex strings in the YAML (quoted, e.g.
	// '10', '23', '2B'). The only damage YAML does is strip the leading zero
	// from unquoted single-digit keys (`08` -> 8, `09` -> 9). So we only left-pad
	// a lone digit to two chars; we must NOT convert decimal -> hex (that turned
	// CD '23' into '17', FM '24' into '18', etc.).
	if (NO_HEX_PAD.has(code)) return String(param); // literal digits, pass through
	if (/^[0-9]$/.test(param)) return param.padStart(2, "0");
	return String(param);
}

// Template placeholder keys like `B{xx}` / `T{xx}` / `{xx}` are not sendable
// literals — they describe a value range, not a concrete parameter.
function isTemplateKey(key: string): boolean {
	return /[{}]/.test(key);
}

function extractValues(values: Record<string, YamlValue>, code: string): CommandValueDef[] {
	const result: CommandValueDef[] = [];

	for (const [param, def] of Object.entries(values)) {
		// Skip range keys (numeric arrays, e.g. "[ 0, 200 ]") and templates.
		if (isRangeKey(param) || isTemplateKey(param)) continue;

		// Skip QSTN (it's metadata, not a sendable value in the action sense)
		if (param === "QSTN") continue;

		const name = normalizeName(def.name ?? param);
		const normalizedParam = normalizeParam(param, code);
		result.push({
			param: normalizedParam,
			name: String(name),
			description: def.description ?? "",
		});
	}

	return result;
}

function generateRegistry(): CommandDef[] {
	const yamlPath = resolve(PROJECT_ROOT, "docs/eiscp-commands.yaml");
	const yamlContent = readFileSync(yamlPath, "utf-8");
	const parsed = parse(yamlContent);

	const sections: Record<string, Record<string, YamlCommand>> = {
		main: (parsed.main ?? {}) as Record<string, YamlCommand>,
		zone2: (parsed.zone2 ?? {}) as Record<string, YamlCommand>,
		dock: (parsed.dock ?? {}) as Record<string, YamlCommand>,
	};
	const registry: CommandDef[] = [];

	for (const code of INCLUDED_COMMANDS) {
		const section = ZONE_OVERRIDE[code] ?? "main";
		const cmd = sections[section]?.[code];
		if (!cmd) {
			console.warn(`Warning: Command ${code} not found in YAML section "${section}"`);
			continue;
		}

		const values = cmd.values ?? {};
		const keys = Object.keys(values);
		const actionType = classifyCommand(code, values);
		const extractedValues = extractValues(values, code);

		const hasQuery = keys.includes("QSTN");
		const hasUP = keys.includes("UP");
		const hasDOWN = keys.includes("DOWN");
		const hasUpDown = hasUP || hasDOWN;

		const def: CommandDef = {
			code,
			name: normalizeName(cmd.name),
			description: cmd.description,
			category: CODE_CATEGORY[code] ?? "Other",
			actionType,
			values: extractedValues,
			hasQuery,
			hasUpDown,
		};

		// For toggles, identify on/off/toggle values
		if (actionType === "toggle") {
			if (keys.includes("01") || keys.includes("'01'") || keys.includes("1")) def.onValue = "01";
			if (keys.includes("00") || keys.includes("'00'") || keys.includes("0")) def.offValue = "00";
			if (keys.includes("TG")) def.toggleValue = "TG";
		}

		registry.push(def);
	}

	return registry;
}

function generateTypeScript(registry: CommandDef[]): string {
	const lines: string[] = [];

	lines.push(`// Auto-generated by scripts/generate-command-registry.ts`);
	lines.push(`// Do not edit manually. Re-generate with: npm run generate:commands`);
	lines.push(``);
	lines.push(`export type CommandActionType = "toggle" | "stepper" | "selector";`);
	lines.push(``);
	lines.push(`export interface CommandValueDef {`);
	lines.push(`\tparam: string;`);
	lines.push(`\tname: string;`);
	lines.push(`\tdescription: string;`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`export interface CommandDef {`);
	lines.push(`\tcode: string;`);
	lines.push(`\tname: string;`);
	lines.push(`\tdescription: string;`);
	lines.push(`\tcategory: string;`);
	lines.push(`\tactionType: CommandActionType;`);
	lines.push(`\tvalues: CommandValueDef[];`);
	lines.push(`\thasQuery: boolean;`);
	lines.push(`\thasUpDown: boolean;`);
	lines.push(`\tonValue?: string;`);
	lines.push(`\toffValue?: string;`);
	lines.push(`\ttoggleValue?: string;`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`export const COMMAND_REGISTRY: Record<string, CommandDef> = {`);

	for (const cmd of registry) {
		lines.push(`\t${cmd.code}: {`);
		lines.push(`\t\tcode: ${JSON.stringify(cmd.code)},`);
		lines.push(`\t\tname: ${JSON.stringify(cmd.name)},`);
		lines.push(`\t\tdescription: ${JSON.stringify(cmd.description)},`);
		lines.push(`\t\tcategory: ${JSON.stringify(cmd.category)},`);
		lines.push(`\t\tactionType: ${JSON.stringify(cmd.actionType)},`);
		lines.push(`\t\tvalues: [`);
		for (const v of cmd.values) {
			lines.push(
				`\t\t\t{ param: ${JSON.stringify(v.param)}, name: ${JSON.stringify(v.name)}, description: ${JSON.stringify(v.description)} },`,
			);
		}
		lines.push(`\t\t],`);
		lines.push(`\t\thasQuery: ${cmd.hasQuery},`);
		lines.push(`\t\thasUpDown: ${cmd.hasUpDown},`);
		if (cmd.onValue !== undefined) lines.push(`\t\tonValue: ${JSON.stringify(cmd.onValue)},`);
		if (cmd.offValue !== undefined)
			lines.push(`\t\toffValue: ${JSON.stringify(cmd.offValue)},`);
		if (cmd.toggleValue !== undefined)
			lines.push(`\t\ttoggleValue: ${JSON.stringify(cmd.toggleValue)},`);
		lines.push(`\t},`);
	}

	lines.push(`};`);
	lines.push(``);

	// Helper functions
	lines.push(`export function getCommandDef(code: string): CommandDef | undefined {`);
	lines.push(`\treturn COMMAND_REGISTRY[code];`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`export function getCommandsByType(type: CommandActionType): CommandDef[] {`);
	lines.push(`\treturn Object.values(COMMAND_REGISTRY).filter((cmd) => cmd.actionType === type);`);
	lines.push(`}`);
	lines.push(``);
	lines.push(`export function getValueName(code: string, param: string): string | undefined {`);
	lines.push(`\tconst cmd = COMMAND_REGISTRY[code];`);
	lines.push(`\tif (!cmd) return undefined;`);
	lines.push(`\tconst value = cmd.values.find((v) => v.param.toLowerCase() === param.toLowerCase());`);
	lines.push(`\treturn value?.name;`);
	lines.push(`}`);
	lines.push(``);

	return lines.join("\n");
}

const SD_PLUGIN = "de.schwetschke.sd.pioneer-onkyo-remote.sdPlugin";

/**
 * Emit a browser-loadable copy of the registry for the Property Inspectors.
 * The PI is a webview; a plain `<script>` that sets a global avoids any
 * fetch/CORS concerns. Kept in sync with the TS registry on every generate.
 */
function generateCommandsJs(registry: CommandDef[]): string {
	const payload = registry.map((c) => ({
		code: c.code,
		name: c.name,
		description: c.description,
		category: c.category,
		actionType: c.actionType,
		values: c.values.map((v) => ({ param: v.param, name: v.name })),
		hasQuery: c.hasQuery,
		hasUpDown: c.hasUpDown,
		onValue: c.onValue,
		offValue: c.offValue,
		toggleValue: c.toggleValue,
	}));
	return (
		`// Auto-generated by scripts/generate-command-registry.ts\n` +
		`// Do not edit manually. Re-generate with: npm run generate:commands\n` +
		`window.EISCP_COMMANDS = ${JSON.stringify(payload, null, 2)};\n`
	);
}

// Main
const registry = generateRegistry();

const outputPath = resolve(PROJECT_ROOT, "src/adapter/eiscp/command-registry.ts");
writeFileSync(outputPath, generateTypeScript(registry), "utf-8");

const commandsJsPath = resolve(PROJECT_ROOT, SD_PLUGIN, "ui/commands.js");
writeFileSync(commandsJsPath, generateCommandsJs(registry), "utf-8");

console.log(`Generated command registry with ${registry.length} commands:`);
for (const cmd of registry) {
	console.log(`  ${cmd.code} (${cmd.actionType}, ${cmd.category}): ${cmd.name} - ${cmd.values.length} values`);
}
console.log(`\nOutput: ${outputPath}`);
console.log(`Output: ${commandsJsPath}`);
