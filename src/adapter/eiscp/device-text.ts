/**
 * Making device-supplied text safe to persist, render, and log.
 *
 * Every string in this plugin that originates on the wire passes through here.
 * There is one implementation on purpose: this is a security boundary (untrusted
 * text reaching a Stream Deck title, a settings file, and a log), and two copies of
 * a boundary drift.
 *
 * The policy is "strip C0 and DEL, then clamp", **not** "keep ASCII". That
 * distinction became load-bearing when the packet decoder moved from ASCII to
 * UTF-8: the receiver declares its text fields as "64 Unicode letters [UTF-8
 * encoded]", so an ASCII-only filter would now delete the very characters the
 * decoder was fixed to preserve — an umlaut would silently vanish from a track
 * title instead of arriving intact.
 *
 * What is still removed:
 *   - C0 control characters and DEL. The receiver really does send them: its
 *     display payloads are prefixed with 0x1a (SUB), and a control byte in a
 *     Stream Deck title or a persisted settings blob is at best noise.
 *   - anything past `maxLength`, because the length is the peer's choice.
 */

/**
 * Strip control characters and clamp to `maxLength` characters.
 *
 * Counted in code points rather than UTF-16 units (the `for…of` iteration), so a
 * character outside the BMP counts once and cannot be cut in half into a lone
 * surrogate — which would otherwise be a well-formed-string invariant broken by
 * remote input.
 */
export function sanitiseDeviceText(value: string, maxLength: number): string {
	let out = "";
	let count = 0;
	for (const ch of value) {
		const code = ch.codePointAt(0)!;
		if (code >= 0x20 && code !== 0x7f) {
			out += ch;
			count++;
		}
		if (count >= maxLength) break;
	}
	return out.trim();
}
