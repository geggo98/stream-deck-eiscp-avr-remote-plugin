import streamDeck from "@elgato/streamdeck";

import { IncrementCounter } from "./actions/increment-counter";
import { PowerControl } from "./actions/power-control";
import { EiscpButtonAction } from "./actions/eiscp-button";
import { EiscpToggleAction } from "./actions/eiscp-toggle";
import { EiscpDialAction } from "./actions/eiscp-dial";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel("trace");

// Register the increment action.
streamDeck.actions.registerAction(new IncrementCounter());
// Register the power control action.
streamDeck.actions.registerAction(new PowerControl());
// Register universal eISCP actions.
streamDeck.actions.registerAction(new EiscpButtonAction());
streamDeck.actions.registerAction(new EiscpToggleAction());
streamDeck.actions.registerAction(new EiscpDialAction());

// Finally, connect to the Stream Deck.
streamDeck.connect();
