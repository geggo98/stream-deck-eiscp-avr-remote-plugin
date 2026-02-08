import { action, KeyDownEvent, SingletonAction, WillAppearEvent, streamDeck } from "@elgato/streamdeck";
import { EiscpClient, createClient } from "../adapter/eiscp/client";

/**
 * Power mode for the action
 */
export type PowerMode = "on" | "off" | "toggle";

/**
 * Global settings for the plugin (shared across all actions)
 */
interface GlobalSettings {
	deviceIp?: string;
}

/**
 * Settings for PowerControl action
 */
interface PowerControlSettings {
	powerMode?: PowerMode;
	deviceIp?: string; // Per-action override of global IP
	customIp?: string; // Custom IP address when "custom" is selected
	[key: string]: any; // Index signature for JsonObject constraint
}

/**
 * Action to control eISCP receiver power
 *
 * Supports three modes:
 * - on: Always power on the receiver
 * - off: Always power off the receiver
 * - toggle: Toggle the current power state
 */
@action({ UUID: "de.schwetschke.sd.pioneer-onkyo-remote.power-control" })
export class PowerControl extends SingletonAction<PowerControlSettings> {
	private clients: Map<string, EiscpClient> = new Map();

	/**
	 * Get the device IP from settings (action-level override or global)
	 */
	private getDeviceIp(ev: KeyDownEvent<PowerControlSettings> | WillAppearEvent<PowerControlSettings>): string {
		// Check action-level override first
		if (ev.payload.settings.deviceIp && ev.payload.settings.deviceIp !== "custom") {
			return ev.payload.settings.deviceIp;
		}
		// Check for custom IP
		if (ev.payload.settings.customIp) {
			return ev.payload.settings.customIp;
		}
		// Fall back to global settings
		const global = streamDeck.settings.getGlobalSettings() as GlobalSettings;
		return global.deviceIp || "10.2.0.32";
	}

	/**
	 * Get or create a client for the specified IP
	 */
	private getClient(host: string): EiscpClient {
		if (!this.clients.has(host)) {
			const client = createClient({
				host,
				port: 60128,
				autoQuery: false,
				debugLog: false,
			});
			this.clients.set(host, client);
		}
		return this.clients.get(host)!;
	}

	/**
	 * Update the action title based on power mode
	 */
	private updateTitle(ev: WillAppearEvent<PowerControlSettings> | KeyDownEvent<PowerControlSettings>): void {
		const mode = ev.payload.settings.powerMode ?? "toggle";
		const titles: Record<PowerMode, string> = {
			on: "ON",
			off: "OFF",
			toggle: "Power",
		};
		ev.action.setTitle(titles[mode]);
	}

	/**
	 * Handle action appearance
	 */
	override async onWillAppear(ev: WillAppearEvent<PowerControlSettings>): Promise<void> {
		this.updateTitle(ev);

		// Show alert if no device IP is configured
		const ip = this.getDeviceIp(ev);
		if (!ip) {
			await ev.action.setTitle("No IP");
		}
	}

	/**
	 * Handle key press - send power command to receiver
	 */
	override async onKeyDown(ev: KeyDownEvent<PowerControlSettings>): Promise<void> {
		const mode = ev.payload.settings.powerMode ?? "toggle";
		const host = this.getDeviceIp(ev);

		if (!host) {
			ev.action.showAlert();
			return;
		}

		try {
			const client = this.getClient(host);

			// Connect if not already connected
			if (!client.isConnected()) {
				await client.connect();
			}

			// Send power command based on mode
			switch (mode) {
				case "on":
					await client.powerOn();
					break;
				case "off":
					await client.powerOff();
					break;
				case "toggle": {
					const currentState = await client.queryPower();
					await client.setPower(!currentState);
					break;
				}
			}

			ev.action.showOk();
		} catch (err) {
			streamDeck.logger.error(`Power control error: ${err}`);
			ev.action.showAlert();
		}
	}
}
