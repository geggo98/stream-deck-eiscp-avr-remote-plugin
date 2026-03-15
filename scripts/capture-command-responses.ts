#!/usr/bin/env tsx
/**
 * Capture eISCP command responses from a real device
 *
 * SAFE: Only sends QSTN (query) commands - does NOT change any settings.
 *
 * Usage: EISCP_HOST=10.2.0.32 npm run capture:responses
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "../src/adapter/eiscp/client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const host = process.env.EISCP_HOST ?? "10.2.0.32";
const port = parseInt(process.env.EISCP_PORT ?? "60128", 10);

// Only QSTN queries - completely safe, read-only
const COMMANDS_TO_QUERY = [
	"PWR", "MVL", "AMT", "SLI", "LMD", "DIM",
	"SPA", "SPB", "IFA", "IFV",
];

interface CapturedResponse {
	command: string;
	response: string;
	timestamp: string;
}

async function main() {
	console.log(`Connecting to receiver at ${host}:${port}...`);
	console.log("SAFETY: Only sending QSTN (query) commands - no state changes.\n");

	const client = createClient({
		host,
		port,
		autoQuery: false,
		debugLog: false,
		commandTimeoutMs: 5000,
	});

	const responses: CapturedResponse[] = [];

	try {
		await client.connect();
		console.log("Connected.\n");

		for (const command of COMMANDS_TO_QUERY) {
			try {
				console.log(`Querying ${command}...`);
				const response = await client.query(command);
				console.log(`  ${command} = ${response}`);
				responses.push({
					command,
					response,
					timestamp: new Date().toISOString(),
				});
			} catch (err) {
				console.log(`  ${command} = ERROR: ${err instanceof Error ? err.message : err}`);
				responses.push({
					command,
					response: `ERROR: ${err instanceof Error ? err.message : err}`,
					timestamp: new Date().toISOString(),
				});
			}
		}

		client.disconnect();
	} catch (err) {
		console.error(`Connection failed: ${err}`);
		process.exit(1);
	}

	const outputPath = resolve(PROJECT_ROOT, "tests/fixtures/command-responses.json");
	const output = {
		capturedAt: new Date().toISOString(),
		host,
		port,
		note: "Captured via QSTN queries only (read-only, no state changes)",
		responses,
	};

	writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
	console.log(`\nSaved ${responses.length} responses to ${outputPath}`);
}

main();
