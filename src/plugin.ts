import streamDeck from "@elgato/streamdeck";

import { EiscpButtonAction } from "./actions/eiscp-button";
import { EiscpToggleAction } from "./actions/eiscp-toggle";
import { EiscpDialAction } from "./actions/eiscp-dial";
import { EiscpDialIndicatorAction } from "./actions/eiscp-dial-indicator";
import { DEDICATED_ACTIONS } from "./actions/dedicated/index";
import { type GlobalSettings, setCachedGlobalSettings } from "./actions/eiscp-base";
import * as nameStore from "./actions/dedicated/name-store";
import { register as registerDiscovery } from "./actions/dedicated/discovery";
import { ConnectionManager } from "./adapter/eiscp/connection-manager";

streamDeck.logger.setLevel("trace");

// Generic, fully-configurable actions (advanced).
streamDeck.actions.registerAction(new EiscpButtonAction());
streamDeck.actions.registerAction(new EiscpToggleAction());
streamDeck.actions.registerAction(new EiscpDialAction());
streamDeck.actions.registerAction(new EiscpDialIndicatorAction());

// Pre-built, ready-to-drop actions (Power, Mute, Volume, Next Input, ...).
for (const dedicated of DEDICATED_ACTIONS) {
	streamDeck.actions.registerAction(dedicated);
}

// Keep the cached global settings fresh (used by resolveDeviceIp + name persistence).
streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => setCachedGlobalSettings(ev.settings));

// Always-on passive name discovery (learns option names from the receiver's display).
registerDiscovery(ConnectionManager.getInstance());

streamDeck.connect();

// Load persisted device IP + learned names once connected.
streamDeck.settings
	.getGlobalSettings<GlobalSettings>()
	.then((gs) => {
		setCachedGlobalSettings(gs);
		nameStore.load(gs.names);
	})
	.catch((err) => streamDeck.logger.error(`Failed to load global settings: ${err}`));
