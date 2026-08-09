/**
 * Turn OpenCV's LBP frontal-face cascade into a module the plugin can bundle.
 *
 * The cascade is training data, not code: 19 stages of boosted stumps over 142 local
 * binary pattern features, produced from thousands of photographs by people who are not
 * us. It is used the same way the vendored Property Inspector bundle is — frozen, checked
 * in, and recorded in `SECURITY.md` with its origin and hash — rather than fetched at
 * build time, so a build is reproducible and a supply-chain question has an answer.
 *
 * ```
 * npm run generate:cascade                       # from the pinned upstream URL
 * npm run generate:cascade -- ./some.xml         # or a local copy
 * ```
 *
 * The XML is ~54 KB of markup around ~2 200 numbers. What lands in `src/` is the numbers,
 * which is both far smaller and the only part that means anything.
 *
 * **Which cascade, and why this one.** Both of OpenCV's frontal LBP cascades were tried
 * against a real 512-pixel portrait, decoded through this plugin's own half-resolution
 * path. `lbpcascade_frontalface_improved.xml` has a 45x45 window, which on a half-scale
 * image means it cannot see a face smaller than ~18 % of the cover's height — and it
 * found nothing on a portrait whose face is ~11 %. `lbpcascade_frontalface.xml`, at
 * 24x24, found it with four agreeing detections and still found nothing on a faceless
 * sleeve. Reach beat the improved cascade's lower false-positive rate, because the small
 * faces are exactly the ones the colour test in `face-crop.ts` cannot help with either.
 *
 * **Licence.** Neither is `pico.js`, which states no licence at all and does not even
 * contain its cascade. The file shipped here carries no notice of its own and is covered
 * by OpenCV's Apache-2.0; the improved one does carry a three-clause BSD notice, so the
 * generator checks and reproduces whichever applies rather than assuming.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_SOURCE = "https://raw.githubusercontent.com/opencv/opencv/4.x/data/lbpcascades/lbpcascade_frontalface.xml";

/**
 * Where a cascade with no notice of its own gets its licence from.
 *
 * `lbpcascade_frontalface.xml` opens with nothing but its training sample counts, so the
 * repository's licence applies. Its sibling `lbpcascade_frontalface_improved.xml` does
 * carry a three-clause BSD notice of its own, which is why the generator checks rather
 * than assuming either way.
 */
const REPOSITORY_LICENCE =
	"This file carries no notice of its own. It is part of the OpenCV repository and is\n" +
	"covered by its licence: Apache-2.0, https://github.com/opencv/opencv/blob/4.x/LICENSE";
const OUTPUT = fileURLToPath(new URL("../src/actions/generated/face-cascade.ts", import.meta.url));

/** Values per weak classifier's `internalNodes`: left, right, feature, then the subset. */
const SUBSET_WORDS = 8;

function numbersIn(text: string): number[] {
	return text.trim().split(/\s+/).filter(Boolean).map(Number);
}

function section(xml: string, tag: string): string {
	const open = xml.indexOf(`<${tag}>`);
	const close = xml.lastIndexOf(`</${tag}>`);
	if (open < 0 || close < 0) throw new Error(`no <${tag}> section`);
	return xml.slice(open + tag.length + 2, close);
}

/**
 * The licence to record, reproduced verbatim when the file states one.
 *
 * A BSD notice requires the copyright notice to be retained, so it is copied rather than
 * summarised. When the leading comment is *not* a licence — and in this cascade it is the
 * training sample counts — saying "the upstream licence, as required" above it would be a
 * plain untruth in a generated file, which is why this looks before it copies.
 */
function licence(xml: string): { text: string; verbatim: boolean } {
	const start = xml.indexOf("<!--");
	const end = xml.indexOf("-->");
	const comment = start >= 0 && end > start ? xml.slice(start + 4, end) : "";
	const verbatim = /copyright|licen[cs]e|redistribution/i.test(comment);
	const text = verbatim ? comment : REPOSITORY_LICENCE;
	return {
		verbatim,
		text: text
			.split("\n")
			.map((line) => ` * ${line.replace(/\s+$/, "")}`)
			.join("\n"),
	};
}

const source = process.argv[2] ?? DEFAULT_SOURCE;
const xml = source.startsWith("http")
	? await (await fetch(source)).text()
	: readFileSync(source, "utf8");
const sha256 = createHash("sha256").update(xml).digest("hex");

const width = Number(/<width>(\d+)<\/width>/.exec(xml)?.[1]);
const height = Number(/<height>(\d+)<\/height>/.exec(xml)?.[1]);
const featureType = /<featureType>(\w+)<\/featureType>/.exec(xml)?.[1];
if (featureType !== "LBP") throw new Error(`expected an LBP cascade, got ${featureType}`);
if (!width || !height) throw new Error("no window size in the cascade");

// Features first: each is one cell of a 3x3 pattern, so the whole feature spans 3w x 3h.
const features: number[] = [];
for (const rect of section(xml, "features").matchAll(/<rect>([^<]*)<\/rect>/g)) {
	const [x, y, w, h] = numbersIn(rect[1]!);
	if (x === undefined || y === undefined || w === undefined || h === undefined) throw new Error("malformed rect");
	features.push(x, y, w, h);
}

// Stages, in file order. Each declares how many weak classifiers follow it, which is what
// assigns the flat list of trees below to stages.
const stages = section(xml, "stages");
const stageThresholds: number[] = [];
const stageTreeCounts: number[] = [];
for (const stage of stages.matchAll(
	/<maxWeakCount>(\d+)<\/maxWeakCount>\s*<stageThreshold>([-\d.e+]+)<\/stageThreshold>/gi,
)) {
	stageTreeCounts.push(Number(stage[1]));
	stageThresholds.push(Number(stage[2]));
}

const treeFeatures: number[] = [];
const treeSubsets: number[] = [];
for (const node of stages.matchAll(/<internalNodes>([^<]*)<\/internalNodes>/g)) {
	const values = numbersIn(node[1]!);
	if (values.length !== 3 + SUBSET_WORDS) throw new Error(`unexpected internalNodes of ${values.length} values`);
	treeFeatures.push(values[2]!);
	treeSubsets.push(...values.slice(3));
}
const treeLeaves: number[] = [];
for (const leaf of stages.matchAll(/<leafValues>([^<]*)<\/leafValues>/g)) {
	const values = numbersIn(leaf[1]!);
	if (values.length !== 2) throw new Error(`unexpected leafValues of ${values.length} values`);
	treeLeaves.push(...values);
}

const trees = treeFeatures.length;
const declared = stageTreeCounts.reduce((a, b) => a + b, 0);
if (trees !== declared) throw new Error(`${trees} trees but the stages declare ${declared}`);
if (treeLeaves.length !== trees * 2) throw new Error("leaf values do not match the trees");
if (treeFeatures.some((f) => f * 4 >= features.length)) throw new Error("a tree refers to a feature that is not there");

const round = (n: number): string => Number(n.toFixed(7)).toString();
const list = (values: number[], perLine: number): string => {
	const lines: string[] = [];
	for (let i = 0; i < values.length; i += perLine) lines.push(`\t${values.slice(i, i + perLine).map(round).join(", ")},`);
	return lines.join("\n");
};

const file = `/**
 * Generated by \`npm run generate:cascade\` — do not edit.
 *
 * OpenCV's LBP frontal-face cascade, as numbers. See \`scripts/generate-face-cascade.ts\`
 * for how it is derived and \`src/actions/face-cascade.ts\` for how it is evaluated.
 *
 * Source:  ${source}
 * SHA-256: ${sha256}
 * Window:  ${width}x${height}, ${stageThresholds.length} stages, ${trees} weak classifiers, ${features.length / 4} features
 *
 * ${licence(xml).verbatim ? "The upstream licence, reproduced as it requires:" : "Licence:"}
 *
${licence(xml).text}
 */

/** The window the cascade was trained on; nothing smaller than this can be found. */
export const CASCADE_WINDOW = { width: ${width}, height: ${height} };

/** \`x, y, w, h\` per feature. One cell of a 3x3 pattern, so the feature spans 3w by 3h. */
export const CASCADE_FEATURES = new Int32Array([
${list(features, 16)}
]);

/** How many weak classifiers belong to each stage, in order. */
export const CASCADE_STAGE_SIZES = new Int32Array([
${list(stageTreeCounts, 20)}
]);

/** A stage passes when its classifiers' votes reach this. */
export const CASCADE_STAGE_THRESHOLDS = new Float32Array([
${list(stageThresholds, 6)}
]);

/** Which feature each weak classifier looks at. */
export const CASCADE_TREE_FEATURES = new Int32Array([
${list(treeFeatures, 20)}
]);

/** ${SUBSET_WORDS} words of bitmask per classifier: which of the 256 codes vote "yes". */
export const CASCADE_TREE_SUBSETS = new Int32Array([
${list(treeSubsets, 8)}
]);

/** The two votes per classifier: the first for a code in the subset, the second for one outside. */
export const CASCADE_TREE_LEAVES = new Float32Array([
${list(treeLeaves, 6)}
]);
`;

writeFileSync(OUTPUT, file);
console.log(
	`${OUTPUT}\n  ${width}x${height} window, ${stageThresholds.length} stages, ${trees} classifiers, ${features.length / 4} features` +
		`\n  source ${source}\n  sha256 ${sha256}\n  ${(file.length / 1024).toFixed(1)} KB of TypeScript from ${(xml.length / 1024).toFixed(1)} KB of XML`,
);
