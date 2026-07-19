/**
 * Unit tests for eISCP network scanner
 *
 * These tests focus on IP generation, subnet logic, and configuration
 * without making real network requests.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
	PrivateIpRange,
	getSubnetsForRange,
	generateIpsForSubnet,
	checkPort,
	ipToInt,
	intToIp,
	isPrivateIp,
	type Subnet,
	type ScannedDevice,
	formatScannedDevice,
	scannedDeviceToJson,
} from "../src/adapter/eiscp/network-scanner.ts";

describe("network-scanner", () => {
	describe("PrivateIpRange", () => {
		it("should have CLASS_A range 10.0.0.0/8", () => {
			assert.equal(PrivateIpRange.CLASS_A.start, "10.0.0.0");
			assert.equal(PrivateIpRange.CLASS_A.end, "10.255.255.255");
			assert.equal(PrivateIpRange.CLASS_A.prefix, 8);
		});

		it("should have CLASS_B range 172.16.0.0/12", () => {
			assert.equal(PrivateIpRange.CLASS_B.start, "172.16.0.0");
			assert.equal(PrivateIpRange.CLASS_B.end, "172.31.255.255");
			assert.equal(PrivateIpRange.CLASS_B.prefix, 12);
		});

		it("should have CLASS_C range 192.168.0.0/16", () => {
			assert.equal(PrivateIpRange.CLASS_C.start, "192.168.0.0");
			assert.equal(PrivateIpRange.CLASS_C.end, "192.168.255.255");
			assert.equal(PrivateIpRange.CLASS_C.prefix, 16);
		});
	});

	describe("ipToInt", () => {
		it("should convert valid IP to integer", () => {
			assert.equal(ipToInt("0.0.0.0"), 0);
			assert.equal(ipToInt("255.255.255.255"), 0xffffffff);
			assert.equal(ipToInt("10.0.0.1"), 0x0a000001);
			assert.equal(ipToInt("192.168.1.1"), 0xc0a80101);
		});

		it("should throw for invalid IP", () => {
			assert.throws(() => ipToInt("invalid"));
			assert.throws(() => ipToInt("256.0.0.1"));
		});
	});

	describe("intToIp", () => {
		it("should convert integer to IP", () => {
			assert.equal(intToIp(0), "0.0.0.0");
			assert.equal(intToIp(0xffffffff), "255.255.255.255");
			assert.equal(intToIp(0x0a000001), "10.0.0.1");
			assert.equal(intToIp(0xc0a80101), "192.168.1.1");
		});

		it("should handle round-trip conversion", () => {
			const ips = ["10.2.0.32", "192.168.1.1", "172.16.255.254", "8.8.8.8"];
			for (const ip of ips) {
				assert.equal(intToIp(ipToInt(ip)), ip);
			}
		});
	});

	describe("isPrivateIp", () => {
		it("should identify Class A private IPs", () => {
			assert.equal(isPrivateIp("10.0.0.1"), true);
			assert.equal(isPrivateIp("10.255.255.254"), true);
			assert.equal(isPrivateIp("10.128.0.1"), true);
		});

		it("should identify Class B private IPs", () => {
			assert.equal(isPrivateIp("172.16.0.1"), true);
			assert.equal(isPrivateIp("172.31.255.254"), true);
			assert.equal(isPrivateIp("172.20.0.1"), true);
		});

		it("should reject non-private Class B IPs", () => {
			assert.equal(isPrivateIp("172.15.255.255"), false);
			assert.equal(isPrivateIp("172.32.0.1"), false);
		});

		it("should identify Class C private IPs", () => {
			assert.equal(isPrivateIp("192.168.0.1"), true);
			assert.equal(isPrivateIp("192.168.255.254"), true);
			assert.equal(isPrivateIp("192.168.1.100"), true);
		});

		it("should reject public IPs", () => {
			assert.equal(isPrivateIp("8.8.8.8"), false);
			assert.equal(isPrivateIp("1.1.1.1"), false);
			assert.equal(isPrivateIp("127.0.0.1"), false);
			assert.equal(isPrivateIp("0.0.0.0"), false);
		});
	});

	describe("getSubnetsForRange", () => {
		it("should return all /24 subnets for CLASS_A", () => {
			const subnets = getSubnetsForRange("CLASS_A");
			// 256 * 256 = 65536 subnets
			assert.equal(subnets.length, 256 * 256);
			assert.equal(subnets[0]!.network, "10.0.0");
			assert.equal(subnets.at(-1)!.network, "10.255.255");
		});

		it("should return all /24 subnets for CLASS_B", () => {
			const subnets = getSubnetsForRange("CLASS_B");
			// 16 * 256 = 4096 subnets
			assert.equal(subnets.length, 16 * 256);
			assert.equal(subnets[0]!.network, "172.16.0");
			assert.equal(subnets.at(-1)!.network, "172.31.255");
		});

		it("should return all /24 subnets for CLASS_C", () => {
			const subnets = getSubnetsForRange("CLASS_C");
			// 256 subnets
			assert.equal(subnets.length, 256);
			assert.equal(subnets[0]!.network, "192.168.0");
			assert.equal(subnets.at(-1)!.network, "192.168.255");
		});

		it("should set correct range property", () => {
			const classA = getSubnetsForRange("CLASS_A");
			const classB = getSubnetsForRange("CLASS_B");
			const classC = getSubnetsForRange("CLASS_C");

			assert.equal(classA[0]!.range, "CLASS_A");
			assert.equal(classB[0]!.range, "CLASS_B");
			assert.equal(classC[0]!.range, "CLASS_C");
		});

		it("should set /24 netmask", () => {
			const subnets = getSubnetsForRange("CLASS_C");
			for (const subnet of subnets) {
				assert.equal(subnet.netmask, "255.255.255.0");
			}
		});
	});

	describe("generateIpsForSubnet", () => {
		it("should generate 254 IPs for a /24 subnet", () => {
			const subnet: Subnet = {
				network: "192.168.1",
				netmask: "255.255.255.0",
				range: "CLASS_C",
			};
			const ips = generateIpsForSubnet(subnet);
			assert.equal(ips.length, 254);
		});

		it("should start from .1 and end at .254", () => {
			const subnet: Subnet = {
				network: "10.2.0",
				netmask: "255.255.255.0",
				range: "CLASS_A",
			};
			const ips = generateIpsForSubnet(subnet);
			assert.equal(ips[0], "10.2.0.1");
			assert.equal(ips.at(-1), "10.2.0.254");
		});

		it("should generate IPs for Class B subnet", () => {
			const subnet: Subnet = {
				network: "172.16.5",
				netmask: "255.255.255.0",
				range: "CLASS_B",
			};
			const ips = generateIpsForSubnet(subnet);
			assert.equal(ips.length, 254);
			assert.equal(ips[0], "172.16.5.1");
			assert.equal(ips.at(-1), "172.16.5.254");
		});

		it("should not include .0 or .255", () => {
			const subnet: Subnet = {
				network: "192.168.1",
				netmask: "255.255.255.0",
				range: "CLASS_C",
			};
			const ips = generateIpsForSubnet(subnet);

			// Check that .0 and .255 are not included
			assert.equal(ips.includes("192.168.1.0"), false);
			assert.equal(ips.includes("192.168.1.255"), false);
		});
	});

	describe("formatScannedDevice", () => {
		it("should format device correctly", () => {
			const device: ScannedDevice = {
				host: "192.168.1.100",
				port: 60128,
				timeout: 200,
			};
			const formatted = formatScannedDevice(device);
			assert.equal(formatted, "192.168.1.100:60128 (timeout: 200ms)");
		});
	});

	describe("scannedDeviceToJson", () => {
		it("should convert device to JSON object", () => {
			const device: ScannedDevice = {
				host: "10.2.0.32",
				port: 60128,
				timeout: 150,
			};
			const json = scannedDeviceToJson(device);
			assert.equal(json.host, "10.2.0.32");
			assert.equal(json.port, 60128);
			assert.equal(json.timeout, 150);
		});
	});

	describe("checkPort", () => {
		it("should return false for timeout", async () => {
			// TEST-NET-3 (RFC 5737) is reserved for documentation and never
			// routed, so the SYN goes nowhere and the check must time out.
			// (10.255.255.1 was used before — but that IS routable inside a
			// 10/8 LAN and could accidentally connect. A truly local silent
			// listener is not possible with node:net, which always accepts.)
			const result = await checkPort("203.0.113.1", 60128, 100);
			assert.equal(result, false);
		});

		it("should return false for connection refused", async () => {
			// Check localhost on a port that's probably not listening
			const result = await checkPort("127.0.0.1", 1, 100);
			assert.equal(result, false);
		});
	});

	describe("IP and subnet configuration", () => {
		it("should generate correct IP count for single subnet", () => {
			const subnet: Subnet = {
				network: "192.168.1",
				netmask: "255.255.255.0",
				range: "CLASS_C",
			};
			const ips = generateIpsForSubnet(subnet);

			// /24 subnet should have 254 usable IPs (.1 to .254)
			assert.equal(ips.length, 254);
		});

		it("should generate correct IP count for multiple subnets", () => {
			const subnets = [
				{ network: "10.2.0", netmask: "255.255.255.0", range: "CLASS_A" as const },
				{ network: "192.168.1", netmask: "255.255.255.0", range: "CLASS_C" as const },
			];

			let totalIps = 0;
			for (const subnet of subnets) {
				totalIps += generateIpsForSubnet(subnet).length;
			}

			// 2 subnets * 254 IPs = 508
			assert.equal(totalIps, 508);
		});

		it("should generate IPs in correct range for Class A", () => {
			const subnets = getSubnetsForRange("CLASS_A").slice(0, 10);
			for (const subnet of subnets) {
				const ips = generateIpsForSubnet(subnet);
				for (const ip of ips) {
					assert.ok(ip.startsWith(subnet.network + "."), `${ip} should start with ${subnet.network}.`);
					assert.ok(isPrivateIp(ip), `${ip} should be private`);
				}
			}
		});

		it("should generate IPs in correct range for Class B", () => {
			const subnets = getSubnetsForRange("CLASS_B").slice(0, 10);
			for (const subnet of subnets) {
				const ips = generateIpsForSubnet(subnet);
				for (const ip of ips) {
					assert.ok(ip.startsWith(subnet.network + "."), `${ip} should start with ${subnet.network}.`);
					assert.ok(isPrivateIp(ip), `${ip} should be private`);
				}
			}
		});

		it("should generate IPs in correct range for Class C", () => {
			const subnets = getSubnetsForRange("CLASS_C").slice(0, 10);
			for (const subnet of subnets) {
				const ips = generateIpsForSubnet(subnet);
				for (const ip of ips) {
					assert.ok(ip.startsWith(subnet.network + "."), `${ip} should start with ${subnet.network}.`);
					assert.ok(isPrivateIp(ip), `${ip} should be private`);
				}
			}
		});
	});
});
