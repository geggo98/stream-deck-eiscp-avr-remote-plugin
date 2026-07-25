/**
 * Unit tests for dns-sd parser using captured fixtures
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseBrowseOutput,
	parseLookupOutput,
	parseGetAddrOutput,
	combineDeviceInfo,
	type AddressResult,
	type LookupResult,
	type ParseError,
} from "../src/adapter/dnssd/index.ts";

const __dirname = join(fileURLToPath(import.meta.url), "..");

function loadFixture(name: string): unknown {
	const path = join(__dirname, "fixtures", `${name}.json`);
	const content = readFileSync(path, "utf-8");
	return JSON.parse(content);
}

describe("parseBrowseOutput", () => {
	it("should parse browse result fixture", () => {
		const fixture = loadFixture("browse-result") as {
			raw: string;
			parsed: unknown[];
		};

		const result = parseBrowseOutput(fixture.raw);

		assert.equal(result.length, fixture.parsed.length);
		assert.equal(result[0]?.instanceName, "Katharinas MacBook Air (2)");
		assert.equal(result[0]?.action, "add");
		assert.equal(result[0]?.interface, "14");

		// Check that Schreibtisch (Pioneer receiver) is in results
		const pioneer = result.find((r) => r.instanceName === "Schreibtisch");
		assert.ok(pioneer, "Schreibtisch should be found");
		assert.equal(pioneer?.interface, "14");

		// Check that Schlafzimmer (Sonos) is in results
		const sonos = result.find((r) => r.instanceName === "Schlafzimmer");
		assert.ok(sonos, "Schlafzimmer should be found");
		assert.equal(sonos?.interface, "14");
	});

	it("should handle empty output", () => {
		const result = parseBrowseOutput("");
		assert.deepEqual(result, []);
	});

	it("should skip header lines", () => {
		const output = `
Timestamp     A/R    Flags  if Domain               Service Type         Instance Name
14:14:38.646  Add        3  14 local.               _airplay._tcp.       Test Device
`;
		const result = parseBrowseOutput(output);
		assert.equal(result.length, 1);
		assert.equal(result[0]?.instanceName, "Test Device");
	});

	it("should parse remove actions", () => {
		const output = "14:14:38.646  Rmv        3  14 local.               _airplay._tcp.       Test Device";
		const result = parseBrowseOutput(output);
		assert.equal(result[0]?.action, "remove");
	});
});

describe("parseLookupOutput", () => {
	it("should parse lookup result fixture for Pioneer receiver", () => {
		const fixture = loadFixture("lookup-result-pioneer") as {
			raw: string;
			parsed: {
				instanceName: string;
				hostname: string;
				port: number;
				txtRecords: { key: string; value: string }[];
			};
		};

		const result = parseLookupOutput(fixture.raw);

		assert.equal(result.instanceName, fixture.parsed.instanceName);
		assert.equal(result.hostname, fixture.parsed.hostname);
		assert.equal(result.port, fixture.parsed.port);

		// Check key TXT records
		const recordsMap = new Map(result.txtRecords.map((r) => [r.key, r.value]));
		assert.equal(recordsMap.get("deviceid"), "00:09:B0:73:5E:D9");
		assert.equal(recordsMap.get("model"), "Pioneer VSX-S520D AV Receiver");
		assert.equal(recordsMap.get("manufacturer"), "Onkyo & Pioneer");
		assert.equal(recordsMap.get("serialNumber"), "0009B0F0EE61");
		assert.equal(recordsMap.get("features"), "0x445F8A00,0x1C340");
	});

	it("should throw ParseError for malformed output", () => {
		assert.throws(
			() => parseLookupOutput("invalid output"),
			(err) => {
				const parseErr = err as ParseError;
				return parseErr.name === "ParseError";
			},
		);
	});

	it("should throw ParseError for empty output", () => {
		assert.throws(
			() => parseLookupOutput(""),
			(err) => {
				const parseErr = err as ParseError;
				return parseErr.name === "ParseError";
			},
		);
	});

	it("should handle output without TXT records", () => {
		const output =
			"Test Device._airplay._tcp.local. can be reached at test-device.local.:7000";
		const result = parseLookupOutput(output);
		assert.equal(result.instanceName, "Test Device");
		assert.equal(result.hostname, "test-device.local.");
		assert.equal(result.port, 7000);
		assert.equal(result.txtRecords.length, 0);
	});
});

describe("parseGetAddrOutput", () => {
	it("should parse getaddr result fixture for Pioneer receiver", () => {
		const fixture = loadFixture("getaddr-result-pioneer") as {
			raw: string;
			parsed: { addressType: string; address: string }[];
		};

		const result = parseGetAddrOutput(fixture.raw);

		assert.equal(result.length, 3);

		// Check IPv4 address
		const ipv4 = result.find((r) => r.addressType === "ipv4");
		assert.ok(ipv4, "Should have IPv4 address");
		assert.equal(ipv4?.address, "10.2.0.32");

		// Check IPv6 addresses
		const ipv6 = result.filter((r) => r.addressType === "ipv6");
		assert.equal(ipv6.length, 2);
	});

	it("should handle simple format output", () => {
		const output = `DNS-SD (v4v6) test-device.local.
> IPv4 address: 192.168.1.100
> IPv6 address: fe80::1234:5678:90ab:cdef`;
		const result = parseGetAddrOutput(output);

		assert.equal(result.length, 2);
		assert.equal(result[0]?.address, "192.168.1.100");
		assert.equal(result[0]?.addressType, "ipv4");
		assert.equal(result[1]?.address, "fe80::1234:5678:90ab:cdef");
		assert.equal(result[1]?.addressType, "ipv6");
	});

	it("should handle empty output", () => {
		const result = parseGetAddrOutput("");
		assert.deepEqual(result, []);
	});

	// The family is derived from the address itself, not the flags field (see the
	// hardening suite below); these two only pin that real rows still parse.
	it("parses an IPv4 table row", () => {
		const output = `Timestamp     A/R  Flags         IF  Hostname                               Address                                      TTL
14:15:36.907  Add  40000002      14  test.local.                            192.168.1.100                                120`;
		const result = parseGetAddrOutput(output);
		assert.equal(result[0]?.addressType, "ipv4");
	});

	it("parses an IPv6 table row", () => {
		const output = `Timestamp     A/R  Flags         IF  Hostname                               Address                                      TTL
14:15:36.907  Add  40000003      14  test.local.                            FE80::1234                                    120`;
		const result = parseGetAddrOutput(output);
		assert.equal(result[0]?.addressType, "ipv6");
	});
});

describe("combineDeviceInfo", () => {
	it("should combine lookup and address results", () => {
		const fixture = loadFixture("lookup-result-pioneer") as { parsed: LookupResult };
		const addrFixture = loadFixture("getaddr-result-pioneer") as { parsed: AddressResult[] };

		const device = combineDeviceInfo(fixture.parsed, addrFixture.parsed);

		assert.equal(device.instanceName, "Schreibtisch");
		assert.equal(device.hostname, "Pioneer-VSX-S520D-F0EE61.local.");
		assert.equal(device.port, 7000);
		assert.equal(device.ipv4Addresses.length, 1);
		assert.equal(device.ipv4Addresses[0], "10.2.0.32");
		assert.equal(device.ipv6Addresses.length, 2);
		assert.equal(device.txtRecords.size, 15);
		assert.equal(device.txtRecords.get("model"), "Pioneer VSX-S520D AV Receiver");
	});

	it("should handle device with only IPv4 addresses", () => {
		const lookup = {
			instanceName: "Test",
			serviceType: "_airplay._tcp",
			domain: "local.",
			hostname: "test.local.",
			port: 7000,
			txtRecords: [],
		};

		const addresses = [
			{ hostname: "test.local.", addressType: "ipv4" as const, address: "192.168.1.100" },
		];

		const device = combineDeviceInfo(lookup, addresses);

		assert.equal(device.ipv4Addresses.length, 1);
		assert.equal(device.ipv6Addresses.length, 0);
	});

	it("should handle device with only IPv6 addresses", () => {
		const lookup = {
			instanceName: "Test",
			serviceType: "_airplay._tcp",
			domain: "local.",
			hostname: "test.local.",
			port: 7000,
			txtRecords: [],
		};

		const addresses = [
			{
				hostname: "test.local.",
				addressType: "ipv6" as const,
				address: "fe80::1234",
			},
		];

		const device = combineDeviceInfo(lookup, addresses);

		assert.equal(device.ipv4Addresses.length, 0);
		assert.equal(device.ipv6Addresses.length, 1);
	});

	it("should handle device with no addresses", () => {
		const lookup = {
			instanceName: "Test",
			serviceType: "_airplay._tcp",
			domain: "local.",
			hostname: "test.local.",
			port: 7000,
			txtRecords: [],
		};

		const device = combineDeviceInfo(lookup, []);

		assert.equal(device.ipv4Addresses.length, 0);
		assert.equal(device.ipv6Addresses.length, 0);
	});
});

// DNS-SD is dev-only tooling (tree-shaken out of the shipped plugin), but the
// input is mDNS advertisements from any host on the LAN, and these strings become
// connect targets in the unified controller.
describe("parseGetAddrOutput address hardening", () => {
	const row = (flags: string, address: string) =>
		`Timestamp     A/R  Flags         IF  Hostname   Address   TTL\n` +
		`14:15:36.907  Add  ${flags}      14  host.local.        ${address}        120\n`;

	it("drops rows whose address is not an IP at all", () => {
		// `(.+?)` matched any text, so a name-like value became a DNS lookup.
		for (const bad of ["attacker.example.com", "not-an-ip", "999.1.1.1", "1.2.3", "::gg"]) {
			assert.deepEqual(parseGetAddrOutput(row("40000002", bad)), [], `${bad} must be dropped`);
		}
	});

	it("derives the family from the address, not the advertiser-controlled flags", () => {
		// The old heuristic read the last digit of the flags field, so an IPv6
		// literal could be labelled ipv4 and vice versa.
		const asIpv4Flags = parseGetAddrOutput(row("40000002", "FE80::1%en0"));
		assert.equal(asIpv4Flags.length, 1);
		assert.equal(asIpv4Flags[0]!.addressType, "ipv6");

		const asIpv6Flags = parseGetAddrOutput(row("40000003", "10.2.0.32"));
		assert.equal(asIpv6Flags.length, 1);
		assert.equal(asIpv6Flags[0]!.addressType, "ipv4");
	});

	it("keeps a real IPv6 zone but drops the dns-sd no-scope placeholder", () => {
		// Both forms come from real captured output; the zone matters for
		// link-local addresses, while "%<0>" is dns-sd's placeholder.
		const scoped = parseGetAddrOutput(row("40000003", "FE80::209:B0FF:FE73:5ED9%en0"));
		assert.equal(scoped[0]!.address, "FE80::209:B0FF:FE73:5ED9%en0");

		const placeholder = parseGetAddrOutput(row("40000003", "2003:F2:C704:2000::1%<0>"));
		assert.equal(placeholder[0]!.address, "2003:F2:C704:2000::1");
	});
});
