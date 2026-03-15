import streamDeck from "@elgato/streamdeck";

import { EiscpButtonAction } from "./actions/eiscp-button";
import { EiscpToggleAction } from "./actions/eiscp-toggle";
import { EiscpDialAction } from "./actions/eiscp-dial";

streamDeck.logger.setLevel("trace");

streamDeck.actions.registerAction(new EiscpButtonAction());
streamDeck.actions.registerAction(new EiscpToggleAction());
streamDeck.actions.registerAction(new EiscpDialAction());

streamDeck.connect();
