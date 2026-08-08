/**
 * The markup every Property Inspector shares, checked as structure rather than by eye.
 *
 * `ui/eiscp-pi.js` builds its panels by concatenating string literals, and a browser
 * will happily render an unbalanced one — nesting whatever follows inside the div that
 * was never closed. That is not hypothetical: re-ordering these blocks dropped a
 * `</div>` and swallowed the entire cover-art setting into a hint, and nothing failed.
 * A Property Inspector is otherwise only verifiable with an eye on the panel.
 *
 * The expressions are pure string concatenation, so they can be evaluated on their own
 * without a DOM. Nothing here runs the panel's logic — only the markup it produces.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = readFileSync(
	new URL("../de.schwetschke.sd.eiscp-avr-remote.sdPlugin/ui/eiscp-pi.js", import.meta.url),
	"utf8",
);

/**
 * Evaluate one `<target>.innerHTML = "…" + "…";` expression from the file.
 *
 * Deliberately not a regex over the markup itself: what matters is the string the
 * browser is actually handed, after the concatenation the source is written in.
 */
function markupOf(target: string): string {
	const start = source.indexOf(`${target}.innerHTML =`);
	assert.ok(start >= 0, `no ${target}.innerHTML assignment found`);
	const from = source.indexOf("=", start) + 1;
	const end = source.indexOf(";\n", from);
	assert.ok(end > from, `unterminated ${target}.innerHTML assignment`);
	const expression = source.slice(from, end);
	// Parenthesised: the expression starts on the next line, and `return` followed by a
	// newline is a `return;` — the first version of this helper silently yielded
	// undefined for every block.
	return new Function(`return (${expression})`)() as string;
}

/** Tag names in the order they open or close, ignoring void and self-closing tags. */
function tagSequence(html: string): { name: string; closing: boolean }[] {
	const out: { name: string; closing: boolean }[] = [];
	for (const m of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g)) {
		const [, slash, name, selfClosing] = m;
		if (selfClosing === "/") continue;
		if (["input", "br", "img", "hr", "meta", "link"].includes(name!.toLowerCase())) continue;
		out.push({ name: name!.toLowerCase(), closing: slash === "/" });
	}
	return out;
}

function assertBalanced(html: string, what: string): void {
	const stack: string[] = [];
	for (const tag of tagSequence(html)) {
		if (!tag.closing) {
			stack.push(tag.name);
			continue;
		}
		const open = stack.pop();
		assert.equal(open, tag.name, `${what}: </${tag.name}> closes <${open ?? "nothing"}>`);
	}
	assert.deepEqual(stack, [], `${what}: left open ${stack.join(", ")}`);
}

const deviceBlock = markupOf("c");
const sharedBlock = markupOf("extras");

describe("the shared Property Inspector markup", () => {
	it("is balanced, so nothing ends up nested in a hint", () => {
		assertBalanced(deviceBlock, "device block");
		assertBalanced(sharedBlock, "shared block");
	});

	it("puts the device first, on its own", () => {
		// The one setting every action needs before anything else can work.
		assert.match(deviceBlock, /setting="deviceIp"/);
		assert.match(deviceBlock, /setting="customIp"/);
		// And nothing plugin-wide leaks into it — that block is appended after whatever
		// the page itself offers, which is how the ordering works without every panel
		// having to spell it out.
		assert.doesNotMatch(deviceBlock, /wakeOnPress|showOnTrackChange|coverOverHttp/);
	});

	it("orders the plugin-wide settings the way they are used", () => {
		// Device, then what a press does, then the track display, then where the cover
		// comes from. Asserted by position, because the order is the requirement.
		const order = ["wakeOnPress", "showOnTrackChange", "trackChangeSeconds", "coverOverHttp"];
		const positions = order.map((id) => sharedBlock.indexOf(id));
		for (const [i, at] of positions.entries()) assert.ok(at >= 0, `${order[i]} is missing`);
		for (let i = 1; i < positions.length; i++) {
			assert.ok(
				positions[i]! > positions[i - 1]!,
				`${order[i]} should come after ${order[i - 1]}, got ${positions[i]} vs ${positions[i - 1]}`,
			);
		}
	});

	it("keeps the per-action settings off sdpi's global binding", () => {
		// A `global`-bound input keeps its own snapshot of the whole settings object and
		// writes all of it back; that is how a panel left open during name discovery once
		// reverted the learned names.
		const perAction = /<sdpi-(checkbox|range)[^>]*setting="(showOnTrackChange|trackChangeSeconds)"[^>]*>/g;
		const bound = [...sharedBlock.matchAll(perAction)];
		assert.equal(bound.length, 2, "both per-action inputs are present");
		for (const m of bound) assert.doesNotMatch(m[0]!, /\bglobal\b/, m[0]);
	});

	it("gives every hint a class, never bare text", () => {
		// Plain text in a Property Inspector inherits black, which is invisible on the
		// dark panel — sdpi-components themes only its own components.
		for (const html of [deviceBlock, sharedBlock]) {
			for (const div of html.matchAll(/<div\b[^>]*>/g)) {
				assert.match(div[0]!, /class="(pi-hint|pi-warn|pi-check|sdpi-item)"|id="/, div[0]);
			}
		}
	});
});
