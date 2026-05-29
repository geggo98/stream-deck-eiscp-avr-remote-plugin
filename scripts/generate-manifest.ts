#!/usr/bin/env tsx
/**
 * Generate the manifest's `Actions` array from the action catalog.
 *
 * Keeps the 4 generic actions and the ~16 dedicated actions in sync with
 * src/actions/dedicated/catalog.ts (UUID, icon paths, States, encoder layout)
 * so the @action decorators, the bundled icons and the manifest can never drift.
 * All other manifest fields are preserved verbatim.
 *
 * Usage: npm run generate:manifest
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEDICATED_SPECS,
	GENERIC_SPECS,
	dedicatedPropertyInspector,
	uuidFor,
	type DedicatedSpec,
	type GenericSpec,
} from "../src/actions/dedicated/catalog.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const MANIFEST_PATH = resolve(
	PROJECT_ROOT,
	"de.schwetschke.sd.pioneer-onkyo-remote.sdPlugin/manifest.json",
);

interface ManifestState {
	Name?: string;
	Image: string;
	TitleAlignment?: string;
}
interface ManifestAction {
	Name: string;
	UUID: string;
	Icon: string;
	Tooltip: string;
	Controllers: string[];
	PropertyInspectorPath: string;
	States: ManifestState[];
	Encoder?: { layout: string; TriggerDescription: { Push: string; Rotate: string } };
}

function genericAction(spec: GenericSpec): ManifestAction {
	const img = `imgs/actions/${spec.id}/key`;
	const states: ManifestState[] =
		spec.states === 2
			? [
					{ Name: "Off", Image: img, TitleAlignment: "middle" },
					{ Name: "On", Image: img, TitleAlignment: "middle" },
				]
			: [{ Image: img, TitleAlignment: "middle" }];
	const a: ManifestAction = {
		Name: spec.name,
		UUID: uuidFor(spec.id),
		Icon: `imgs/actions/${spec.id}/icon`,
		Tooltip: spec.tooltip,
		Controllers: [spec.controller],
		PropertyInspectorPath: spec.propertyInspector,
		States: states,
	};
	if (spec.controller === "Encoder") {
		a.Encoder = {
			layout: spec.encoderLayout ?? "$A1",
			TriggerDescription: { Push: "Press action", Rotate: "Adjust" },
		};
	}
	return a;
}

function dedicatedAction(spec: DedicatedSpec): ManifestAction {
	const base = `imgs/actions/${spec.id}`;
	const states: ManifestState[] =
		spec.states === 2
			? [
					{ Name: "Off", Image: `${base}/key`, TitleAlignment: "middle" },
					{ Name: "On", Image: `${base}/key-on`, TitleAlignment: "middle" },
				]
			: [{ Image: `${base}/key`, TitleAlignment: "middle" }];
	const a: ManifestAction = {
		Name: spec.name,
		UUID: uuidFor(spec.id),
		Icon: `${base}/icon`,
		Tooltip: spec.tooltip,
		Controllers: [spec.controller],
		PropertyInspectorPath: dedicatedPropertyInspector(spec),
		States: states,
	};
	if (spec.kind === "dial") {
		a.Encoder = {
			layout: spec.encoderLayout ?? "$B1",
			TriggerDescription: { Push: "Mute", Rotate: "Adjust volume" },
		};
	}
	return a;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
manifest.Actions = [...GENERIC_SPECS.map(genericAction), ...DEDICATED_SPECS.map(dedicatedAction)];
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

console.log(
	`Updated manifest with ${manifest.Actions.length} actions ` +
		`(${GENERIC_SPECS.length} generic + ${DEDICATED_SPECS.length} dedicated).`,
);
