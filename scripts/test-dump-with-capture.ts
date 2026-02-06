#!/usr/bin/env -S npx tsx
/**
 * Test script for eISCP dump command with captured data
 *
 * This script starts a mock TCP server that serves the raw packet dump
 * from a real receiver, then allows you to test the eiscp dump command.
 *
 * Usage:
 *   npx tsx scripts/test-dump-with-capture.ts
 *
 * Then in another terminal:
 *   npm run eiscp -- dump --host 127.0.0.1 --port <port>
 */

import { createServer } from "net";
import { readFileSync } from "fs";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read the captured raw data
const RAW_DUMP_PATH = resolve(__dirname, "../tests/fixtures/raw-dump.bin");
const RAW_DATA = readFileSync(RAW_DUMP_PATH);

console.log("eISCP Dump Test Server");
console.log("======================");
console.log(`Loaded ${RAW_DATA.length} bytes of captured data from ${RAW_DUMP_PATH}`);
console.log();

// Create server that continuously sends the captured data
const server = createServer((socket) => {
	const clientAddress = `${socket.remoteAddress}:${socket.remotePort}`;
	console.log(`[${new Date().toISOString()}] Client connected from ${clientAddress}`);

	// Send the captured data immediately
	socket.write(RAW_DATA);
	console.log(`[${new Date().toISOString()}] Sent ${RAW_DATA.length} bytes to ${clientAddress}`);

	// Optionally, send data repeatedly for testing
	let interval: ReturnType<typeof setInterval> | null = null;

	// If you want to continuously send data (for stress testing), uncomment:
	// interval = setInterval(() => {
	//   socket.write(RAW_DATA);
	//   console.log(`[${new Date().toISOString()}] Sent ${RAW_DATA.length} bytes to ${clientAddress} (repeating)`);
	// }, 5000);

	socket.on("close", () => {
		console.log(`[${new Date().toISOString()}] Client disconnected: ${clientAddress}`);
		if (interval) {
			clearInterval(interval);
		}
	});

	socket.on("error", (err) => {
		console.error(`[${new Date().toISOString()}] Socket error: ${err.message}`);
		if (interval) {
			clearInterval(interval);
		}
	});
});

// Listen on random port
server.listen(0, () => {
	const port = (server.address() as { port: number }).port;
	console.log(`Mock eISCP server listening on port ${port}`);
	console.log();
	console.log("Now run in another terminal:");
	console.log(`  npm run eiscp -- dump --host 127.0.0.1 --port ${port}`);
	console.log();
	console.log("Or with raw packet output:");
	console.log(`  npm run eiscp -- dump --host 127.0.0.1 --port ${port} --raw`);
	console.log();
	console.log("Press Ctrl+C to stop the server");
});

// Handle graceful shutdown
process.on("SIGINT", () => {
	console.log("\nShutting down server...");
	server.close(() => {
		console.log("Server closed.");
		process.exit(0);
	});
});
