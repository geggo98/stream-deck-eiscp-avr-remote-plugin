/**
 * What the receiver's transport is doing, from an `NST` frame.
 *
 * `NST` carries three fields (`prs`: play, repeat, shuffle) and only the first is used
 * here. It is **re-broadcast unsolicited** whenever the state changes, and the
 * ConnectionManager caches every inbound message — so "is this receiver playing?" is
 * answerable without asking, which matters on a unit that accepts one connection and
 * whose `NTC` transport command does not answer a query at all.
 *
 * Deliberately the same names and semantics as the `parsePlayStatus` in
 * `now-playing.ts` on the now-playing branch, which measured them: a merge should
 * collapse the two copies onto this module rather than keeping both.
 */

export type PlayStatus = "play" | "pause" | "stop" | "ff" | "rew" | "eof";

const PLAY_STATUS: Record<string, PlayStatus> = {
	S: "stop",
	P: "play",
	p: "pause",
	F: "ff",
	R: "rew",
	E: "eof",
};

/**
 * Parse an `NST` parameter (`prs`); only the play field is read.
 *
 * Returns `undefined` for anything unrecognised — including an empty parameter — so a
 * caller that has never seen an `NST` frame and one that saw a value it cannot read are
 * treated alike. Both mean "no evidence", which is the safe answer for every decision
 * this is used for.
 */
export function parsePlayStatus(parameter: string | undefined): PlayStatus | undefined {
	return parameter === undefined ? undefined : PLAY_STATUS[parameter[0] ?? ""];
}
