import streamDeck from "@elgato/streamdeck";

import { EiscpButtonAction } from "./actions/eiscp-button";
import { EiscpToggleAction } from "./actions/eiscp-toggle";
import { EiscpDialAction } from "./actions/eiscp-dial";
import { EiscpDialIndicatorAction } from "./actions/eiscp-dial-indicator";
import { DEDICATED_ACTIONS } from "./actions/dedicated/index";

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

streamDeck.connect();
