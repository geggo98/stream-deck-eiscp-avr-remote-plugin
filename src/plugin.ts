import streamDeck from "@elgato/streamdeck";

import { EiscpButtonAction } from "./actions/eiscp-button";
import { EiscpToggleAction } from "./actions/eiscp-toggle";
import { EiscpDialAction } from "./actions/eiscp-dial";
import { EiscpDialIndicatorAction } from "./actions/eiscp-dial-indicator";

streamDeck.logger.setLevel("trace");

streamDeck.actions.registerAction(new EiscpButtonAction());
streamDeck.actions.registerAction(new EiscpToggleAction());
streamDeck.actions.registerAction(new EiscpDialAction());
streamDeck.actions.registerAction(new EiscpDialIndicatorAction());

streamDeck.connect();
