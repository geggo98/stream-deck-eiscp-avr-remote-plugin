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
	actionType: CommandActionType;
	values: CommandValueDef[];
	hasQuery: boolean;
	hasUpDown: boolean;
	onValue?: string;
	offValue?: string;
	toggleValue?: string;
}

// Commands to include in the registry (main zone, most useful)
const INCLUDED_COMMANDS = [
	"PWR", "AMT", "MVL", "SLI", "LMD", "DIM", "HDO",
	"SPA", "SPB", "DIR", "LTN", "RAS", "CTL",
	"ADY", "ADQ", "PMB",
];

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
	if (hasUP && hasDOWN && (hasNumericRange || code === "MVL" || code === "CTL")) {
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

function normalizeParam(param: string): string {
	// YAML may parse "08" as integer 8. Ensure hex-like params are zero-padded.
	const num = Number(param);
	if (!isNaN(num) && param === String(num) && num >= 0 && num <= 255) {
		return num.toString(16).toUpperCase().padStart(2, "0");
	}
	return String(param);
}

function extractValues(values: Record<string, YamlValue>): CommandValueDef[] {
	const result: CommandValueDef[] = [];

	for (const [param, def] of Object.entries(values)) {
		// Skip range keys (numeric arrays)
		if (isRangeKey(param)) continue;

		// Skip QSTN (it's metadata, not a sendable value in the action sense)
		if (param === "QSTN") continue;

		const name = normalizeName(def.name ?? param);
		const normalizedParam = normalizeParam(param);
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

	const mainCommands = parsed.main as Record<string, YamlCommand>;
	const registry: CommandDef[] = [];

	for (const code of INCLUDED_COMMANDS) {
		const cmd = mainCommands[code];
		if (!cmd) {
			console.warn(`Warning: Command ${code} not found in YAML`);
			continue;
		}

		const values = cmd.values ?? {};
		const keys = Object.keys(values);
		const actionType = classifyCommand(code, values);
		const extractedValues = extractValues(values);

		const hasQuery = keys.includes("QSTN");
		const hasUP = keys.includes("UP");
		const hasDOWN = keys.includes("DOWN");
		const hasUpDown = hasUP || hasDOWN;

		const def: CommandDef = {
			code,
			name: normalizeName(cmd.name),
			description: cmd.description,
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

// Main
const registry = generateRegistry();
const output = generateTypeScript(registry);
const outputPath = resolve(PROJECT_ROOT, "src/adapter/eiscp/command-registry.ts");
writeFileSync(outputPath, output, "utf-8");

console.log(`Generated command registry with ${registry.length} commands:`);
for (const cmd of registry) {
	console.log(`  ${cmd.code} (${cmd.actionType}): ${cmd.name} - ${cmd.values.length} values`);
}
console.log(`\nOutput: ${outputPath}`);
