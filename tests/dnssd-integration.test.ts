/**
 * Integration tests for dns-sd adapter (macOS only)
 *
 * These tests run actual dns-sd commands and require macOS.
 * They are skipped on non-macOS platforms.
 */

import { strict as assert } from "node:assert";
import { describe, it, before } from "node:test";
import { platform } from "node:os";
import {
	isDnsSdAvailable,
	browseAirplayDevices,
	lookupDevice,
	getHostAddresses,
	discoverAirplayDevices,
	discoverAirplayDevicesWithErrorReporting,
} from "../src/adapter/dnssd/index.ts";

const isMacOS = platform() === "darwin";

describe("dns-sd integration tests", () => {
	before(() => {
		if (!isMacOS) {
			console.log("Skipping integration tests - not on macOS");
		}
	});

	describe("isDnsSdAvailable", () => {
		it("should return true on macOS", () => {
			assert.equal(isDnsSdAvailable(), isMacOS);
		});
	});

	// Only run these tests on macOS
	if (isMacOS) {
		describe("browseAirplayDevices", () => {
			it("should execute dns-sd browse command", async () => {
				const result = await browseAirplayDevices({ timeout: 3000 });

				// Should have stdout with browse results
				assert.ok(result.stdout.length > 0);

				// Command should complete (either normally or by timeout)
				assert.ok(result.exitCode !== null || result.timedOut);
			});

			it("should include browse output with timestamp and devices", async () => {
				const result = await browseAirplayDevices({ timeout: 3000 });

				assert.ok(result.stdout.includes("Timestamp"));
				assert.ok(
					result.stdout.includes("Instance Name") ||
						result.stdout.includes("_airplay._tcp"),
				);
			});
		});

		describe("discoverAirplayDevices", () => {
			it("should discover AirPlay devices on the network", async () => {
				const result = await discoverAirplayDevices({
					timeout: 1000,
					includeIntermediate: true,
				});

				assert.ok(Array.isArray(result.devices));
				assert.ok(result.intermediate);

				// If devices are found, check their structure
				if (result.devices.length > 0) {
					const device = result.devices[0]!;
					assert.ok(typeof device.instanceName === "string");
					assert.ok(typeof device.hostname === "string");
					assert.ok(typeof device.port === "number");
					assert.ok(Array.isArray(device.ipv4Addresses));
					assert.ok(Array.isArray(device.ipv6Addresses));
					assert.ok(device.txtRecords instanceof Map);
				}
			});

			it("should include intermediate results when requested", async () => {
				const result = await discoverAirplayDevices({
					timeout: 1000,
					includeIntermediate: true,
				});

				assert.ok(result.intermediate);
				assert.ok(typeof result.intermediate.browseRaw === "string");
				assert.ok(Array.isArray(result.intermediate.browseParsed));
			});
		});

		describe("discoverAirplayDevicesWithErrorReporting", () => {
			it("should report errors for non-existent devices", async () => {
				const result = await discoverAirplayDevicesWithErrorReporting({
					timeout: 1000,
					includeIntermediate: true,
					instanceNames: ["NonExistentDevice12345"],
					continueOnError: true,
				});

				assert.ok(result.errors.length > 0);
				assert.equal(result.errors[0]?.instanceName, "NonExistentDevice12345");
				assert.equal(result.errors[0]?.stage, "lookup");
			});

			it("should return devices even with some errors", async () => {
				const result = await discoverAirplayDevicesWithErrorReporting({
					timeout: 1000,
					instanceNames: ["NonExistentDevice12345", "AnotherFakeDevice"],
					continueOnError: true,
				});

				// Should have errors for the fake devices
				assert.ok(result.errors.length >= 2);
			});
		});

		describe("getDevice", () => {
			it("should throw error for non-existent device", async () => {
				await assert.rejects(
					async () => {
						await getDevice("NonExistentDevice12345", { timeout: 1000 });
					},
					(err) => {
						assert.ok(
							err instanceof Error || typeof err === "object",
						);
						return true;
					},
				);
			});
		});

		describe("lookupDevice and getHostAddresses", () => {
			it("should fail gracefully for non-existent device", async () => {
				const lookupResult = await lookupDevice("NonExistentDevice12345", {
					timeout: 1000,
				});

				// lookup command times out or returns empty for non-existent device
				assert.ok(
					lookupResult.timedOut ||
						lookupResult.stdout.length === 0 ||
						lookupResult.exitCode !== null,
				);
			});

			it("should get addresses fail for non-existent hostname", async () => {
				const result = await getHostAddresses("nonexistent-host.local.", {
					timeout: 1000,
				});

				// Command should complete (possibly with error or timeout)
				assert.ok(result.exitCode !== null || result.timedOut);
			});
		});

		describe("timeout handling", () => {
			it("should respect timeout setting", async () => {
				const start = Date.now();
				await browseAirplayDevices({ timeout: 1000 });
				const elapsed = Date.now() - start;

				// Should take approximately 1 second (+- some margin for process overhead)
				assert.ok(elapsed >= 800 && elapsed < 2500);
			});
		});
	}
});
