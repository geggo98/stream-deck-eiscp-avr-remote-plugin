import streamDeck from "@elgato/streamdeck";

import { EiscpButtonAction } from "./actions/eiscp-button";
import { EiscpToggleAction } from "./actions/eiscp-toggle";
import { EiscpDialAction } from "./actions/eiscp-dial";
import { EiscpDialIndicatorAction } from "./actions/eiscp-dial-indicator";
import { DEDICATED_ACTIONS } from "./actions/dedicated/index";
import {
	coverOverHttpEnabled,
	type GlobalSettings,
	markGlobalSettingsLoaded,
	setCachedGlobalSettings,
	setGlobalSettingsWriter,
} from "./actions/eiscp-base";
import * as nameStore from "./actions/dedicated/name-store";
import { register as registerDiscovery } from "./actions/dedicated/discovery";
import { ConnectionManager } from "./adapter/eiscp/connection-manager";
import { getDeviceStatusTracker } from "./adapter/eiscp/device-status";
import { setCoverHttpPolicy } from "./adapter/eiscp/now-playing";
import { setAdapterLogger } from "./adapter/logging";

// TRACE makes the SDK dump every WebSocket frame, which means complete settings
// objects, LAN IPs and the whole learned-name map land in the plugin's log files
// (up to 10x50 MB, plaintext, and routinely attached to bug reports). Opt in via
// EISCP_DEBUG for local debugging; ship at INFO.
streamDeck.logger.setLevel(process.env.EISCP_DEBUG ? "trace" : "info");

// Node runs with unhandled rejections fatal, and the SDK's own safety net is a
// `process.once("uncaughtException", …)` — so it absorbs exactly one escaped
// error and the *second* one kills the plugin, taking every button on the deck
// with it. A remote peer or a rejected SDK call should never be able to do that,
// so keep the process alive and leave a breadcrumb instead. Deliberately not
// re-thrown: a dead plugin is strictly worse than a logged fault.
process.on("unhandledRejection", (reason) => {
	streamDeck.logger.error(
		`Unhandled promise rejection (plugin kept running): ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
	);
});
process.on("uncaughtException", (err) => {
	streamDeck.logger.error(`Uncaught exception (plugin kept running): ${err.stack ?? err.message}`);
});

// The adapter layer must not import the SDK (its log rotation is an import
// side effect that races in parallel test processes); wire its logging here.
setAdapterLogger(streamDeck.logger);

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
// The SDK binding for the shared write funnel (updateGlobalSettings); injected so
// the settings module itself stays SDK-free.
setGlobalSettingsWriter((gs) => streamDeck.settings.setGlobalSettings(gs));

// The cover-over-HTTP switch lives in the global settings (action layer); inject the
// read so the adapter stays independent of it, like the logger and the settings writer.
setCoverHttpPolicy(() => coverOverHttpEnabled());

// Always-on passive name discovery (learns option names from the receiver's display).
registerDiscovery(ConnectionManager.getInstance());

// Power/reachability tracking for the deck display. Started here so its message
// observer is attached before the first frame can arrive; the per-host heartbeat
// only runs while an action is actually watching that receiver.
getDeviceStatusTracker();

streamDeck.connect();

// Load persisted device IP + learned names once connected.
streamDeck.settings
	.getGlobalSettings<GlobalSettings>()
	.then((gs) => {
		setCachedGlobalSettings(gs);
		nameStore.load(gs.names);
		// Only now may anything write the global settings back: until this point
		// the cache every writer merges over is empty (see whenGlobalSettingsLoaded).
		markGlobalSettingsLoaded();
	})
	.catch((err) => streamDeck.logger.error(`Failed to load global settings: ${err}`));
