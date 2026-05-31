#!/usr/bin/env -S tsx
/**
 * Dummy eISCP discovery server for local testing.
 *
 * Listens for ECN discovery queries (`!1ECNQSTN` / `!pECNQSTN`) on UDP 60128 and
 * replies with N fake receivers, so the plugin's "Device IP" dropdown can be
 * exercised with multiple entries without owning several real receivers.
 *
 * Note: the discovered `host` is the responder's source IP, so all fakes share
 * this machine's address (distinct model names keep the entries distinguishable).
 * For genuinely distinct IPs you need real devices or loopback aliases.
 *
 * Usage:
 *   npm run dummy:discovery -- [--count 4] [--port 60128]
 *   Stop with Ctrl+C.
 */
import dgram from "node:dgram";
import { decodePacket, encodePacket, parseIscpMessage } from "../src/adapter/eiscp/protocol.ts";

const args = process.argv.slice(2);
const optValue = (name: string, def: string): string => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1]! : def;
};
const COUNT = Math.max(1, parseInt(optValue("--count", "4"), 10) || 4);
const PORT = parseInt(optValue("--port", "60128"), 10) || 60128;

const MODELS = ["VSX-FAKE1", "TX-NR-FAKE", "VSX-LX-FAKE", "TX-RZ-FAKE", "SC-FAKE", "DTM-FAKE"];
const devices = Array.from({ length: COUNT }, (_, i) => ({
	model: i < MODELS.length ? MODELS[i]! : `FAKE-${i + 1}`,
	id: (i + 1).toString(16).padStart(12, "0").toUpperCase(), // 12-char identifier
}));

const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

sock.on("message", (msg: Buffer, rinfo) => {
	let unit: string;
	try {
		const iscp = parseIscpMessage(decodePacket(msg).message);
		if (iscp.command !== "ECN") return; // only answer discovery queries
		unit = iscp.unit; // "1" (Onkyo) or "p" (Pioneer)
	} catch {
		return; // not an eISCP packet
	}
	for (const d of devices) {
		// ECN response: !<unit>ECN<model>/<iscpPort>/<area><identifier>
		const packet = encodePacket("ECN", `${d.model}/${PORT}/XX${d.id}`, unit);
		sock.send(packet.bytes as Uint8Array, rinfo.port, rinfo.address);
	}
	console.log(`↩ replied to ${rinfo.address}:${rinfo.port} (unit ${unit}) with ${devices.length} devices`);
});

sock.on("error", (err) => {
	console.error("socket error:", err.message);
	sock.close();
	process.exit(1);
});

sock.bind(PORT, () => {
	try {
		sock.setBroadcast(true);
	} catch {
		/* not fatal */
	}
	console.log(`dummy eISCP discovery server listening on udp/${PORT} with ${devices.length} fake devices:`);
	for (const d of devices) console.log(`  ${d.model}  (id ${d.id})`);
	console.log("Ctrl+C to stop.");
});
