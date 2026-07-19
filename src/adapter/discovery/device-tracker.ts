/**
 * Device tracking and merging for unified eISCP discovery.
 *
 * The parallel discovery methods (AirPlay/DNS-SD, eISCP broadcast, network
 * scan) report the same physical receiver under different original IDs and
 * possibly different IPs. The DeviceTracker assigns one numeric ID per
 * physical device and merges later sightings into it — by original ID, by IP
 * overlap, or by the eISCP hardware identifier — emitting incremental update
 * events along the way.
 *
 * Deliberately free of any network/client dependencies so the merge behaviour
 * is directly unit-testable (see tests/unified-discovery.test.ts); the
 * connection-checking side lives in unified-controller.ts.
 */

/**
 * Source of device discovery
 */
export type DeviceSource = "airplay" | "eiscp-broadcast" | "eiscp-scan";

/**
 * Identity of a tracked device: one numeric id per physical device, used
 * consistently across updates, results, and errors (no stringified copies).
 */
export type DeviceId = number;

/**
 * Discovered device (before eISCP connection verification)
 */
export interface DiscoveredDevice {
	/** Unique device identifier */
	id: string;
	/** All IP addresses associated with this device */
	ips: string[];
	/** Discovery source */
	source: DeviceSource;
	/** Source-specific metadata */
	metadata: DeviceMetadata;
}

/**
 * Tracked device state - accumulates information from all discovery methods
 */
export interface TrackedDevice {
	/** Numeric device ID (simple counter) */
	deviceId: DeviceId;
	/** All IP addresses associated with this device */
	ips: string[];
	/** Discovery sources that found this device */
	sources: Set<DeviceSource>;
	/** Combined metadata from all discovery methods */
	metadata: DeviceMetadata;
	/** Original device IDs that were merged into this device */
	originalIds: Set<string>;
}

/**
 * Device update event types
 */
export type DeviceUpdateType =
	| "device-created" // New device discovered
	| "ips-added" // Additional IPs discovered for existing device
	| "metadata-airplay" // AirPlay metadata added/updated
	| "metadata-eiscp-broadcast" // eISCP broadcast metadata added/updated
	| "eiscp-connected"; // Successfully connected via eISCP

/**
 * Device update event
 */
export interface DeviceUpdate {
	/** Numeric device ID */
	deviceId: DeviceId;
	/** Type of update */
	type: DeviceUpdateType;
	/** What changed (specific fields that were added/updated) */
	changes: {
		/** New IPs that were added (for ips-added) */
		newIps?: string[];
		/** Discovery source that triggered the update */
		source?: DeviceSource;
	};
	/** Current complete device state */
	currentState: TrackedDevice;
}

/**
 * Device metadata from discovery
 */
export interface DeviceMetadata {
	/** From AirPlay */
	airplay?: {
		instanceName: string;
		hostname: string;
		txtRecords: Map<string, string>;
	};
	/** From eISCP broadcast */
	eiscpBroadcast?: {
		modelName: string;
		iscpPort: number;
		areaCode: string;
		identifier: string;
		unitType: string;
		rawMessage: string;
	};
	/** From eISCP scan */
	eiscpScan?: {
		timeout: number;
	};
}

/**
 * The source a device is primarily attributed to (first one that found it).
 */
export function primarySource(tracked: TrackedDevice | undefined): DeviceSource {
	return Array.from(tracked?.sources ?? [])[0] ?? "eiscp-scan";
}

/**
 * Deep-enough copy of a tracked device for emitting: later mutations of the
 * live ips array, sets, or metadata must not change already-emitted events.
 */
export function snapshotTracked(tracked: TrackedDevice): TrackedDevice {
	return {
		deviceId: tracked.deviceId,
		ips: [...tracked.ips],
		sources: new Set(tracked.sources),
		originalIds: new Set(tracked.originalIds),
		metadata: structuredClone(tracked.metadata),
	};
}

/**
 * Tracks discovered devices and merges duplicate sightings into one device.
 *
 * Merge precedence (first match wins): known original ID, then any
 * overlapping IP, then the eISCP hardware identifier. Every state change is
 * reported through the optional onUpdate callback; emitted events carry a
 * snapshot, never the live object.
 */
export class DeviceTracker {
	/** Device ID counter for numeric IDs */
	private nextDeviceId = 0;

	// Tracking maps for device merging
	// Maps: IP -> numeric device ID, identifier -> numeric device ID
	private readonly ipToNumericId = new Map<string, number>();
	private readonly identifierToNumericId = new Map<string, number>();

	/** Track which numeric device ID each original ID maps to */
	private readonly originalIdToNumericId = new Map<string, number>();

	/** Tracked devices by numeric ID */
	private readonly trackedDevices = new Map<number, TrackedDevice>();

	private readonly onUpdate?: (update: DeviceUpdate) => void;

	constructor(onUpdate?: (update: DeviceUpdate) => void) {
		this.onUpdate = onUpdate;
	}

	/**
	 * The live tracked state for a device. Callers that hand this on to
	 * event consumers must copy it via snapshotTracked first.
	 */
	get(deviceId: DeviceId): TrackedDevice | undefined {
		return this.trackedDevices.get(deviceId);
	}

	/**
	 * Add a discovered device to tracking: merged into an existing tracked
	 * device where possible, otherwise created fresh (emitting the matching
	 * update events). Returns the numeric ID the sighting was attributed to.
	 */
	addDiscoveredDevice(device: DiscoveredDevice): { deviceId: DeviceId; isNew: boolean } {
		const { deviceId, isNew, tracked } = this.getOrCreateTrackedDevice(
			device.id,
			device.source,
			device.ips,
			device.metadata,
		);

		if (isNew) {
			// Emit device-created update
			this.emitUpdate({
				deviceId,
				type: "device-created",
				changes: {
					source: device.source,
				},
				currentState: snapshotTracked(tracked),
			});
		} else {
			// Update existing device
			this.updateTrackedDevice(deviceId, device.source, device.ips, device.metadata);
		}

		return { deviceId, isNew };
	}

	/**
	 * Emit device update event
	 */
	private emitUpdate(update: DeviceUpdate): void {
		this.onUpdate?.(update);
	}

	/**
	 * Get or create a tracked device
	 */
	private getOrCreateTrackedDevice(
		originalId: string,
		source: DeviceSource,
		ips: string[],
		metadata: DeviceMetadata,
	): { deviceId: number; isNew: boolean; tracked: TrackedDevice } {
		// Check if this original ID already maps to a numeric ID
		const existingNumericId = this.originalIdToNumericId.get(originalId);
		if (existingNumericId !== undefined) {
			const tracked = this.trackedDevices.get(existingNumericId)!;
			return { deviceId: existingNumericId, isNew: false, tracked };
		}

		// Check if any IP already belongs to a tracked device
		for (const ip of ips) {
			const existingId = this.ipToNumericId.get(ip);
			if (existingId !== undefined) {
				const tracked = this.trackedDevices.get(existingId)!;
				this.originalIdToNumericId.set(originalId, existingId);
				return { deviceId: existingId, isNew: false, tracked };
			}
		}

		// Check if eISCP identifier already exists
		if (metadata.eiscpBroadcast?.identifier) {
			const existingId = this.identifierToNumericId.get(
				metadata.eiscpBroadcast.identifier,
			);
			if (existingId !== undefined) {
				const tracked = this.trackedDevices.get(existingId)!;
				this.originalIdToNumericId.set(originalId, existingId);
				return { deviceId: existingId, isNew: false, tracked };
			}
		}

		// Create new tracked device
		const newDeviceId = this.nextDeviceId++;
		const newDevice: TrackedDevice = {
			deviceId: newDeviceId,
			ips: [...ips],
			sources: new Set([source]),
			metadata: { ...metadata },
			originalIds: new Set([originalId]),
		};

		this.trackedDevices.set(newDeviceId, newDevice);
		this.originalIdToNumericId.set(originalId, newDeviceId);

		// Map IPs to this device
		for (const ip of ips) {
			this.ipToNumericId.set(ip, newDeviceId);
		}

		// Map identifier if present
		if (metadata.eiscpBroadcast?.identifier) {
			this.identifierToNumericId.set(metadata.eiscpBroadcast.identifier, newDeviceId);
		}

		return { deviceId: newDeviceId, isNew: true, tracked: newDevice };
	}

	/**
	 * Update a tracked device with new information
	 */
	private updateTrackedDevice(
		numericDeviceId: number,
		source: DeviceSource,
		ips: string[],
		metadata: DeviceMetadata,
	): void {
		const tracked = this.trackedDevices.get(numericDeviceId);
		if (!tracked) return;

		const updates: DeviceUpdateType[] = [];

		// Check for new IPs
		const existingIps = new Set(tracked.ips);
		const newIps = ips.filter((ip) => !existingIps.has(ip));
		if (newIps.length > 0) {
			tracked.ips.push(...newIps);
			for (const ip of newIps) {
				this.ipToNumericId.set(ip, numericDeviceId);
			}
			updates.push("ips-added");
		}

		// Update sources
		if (!tracked.sources.has(source)) {
			tracked.sources.add(source);
		}

		// Update metadata
		if (metadata.airplay && !tracked.metadata.airplay) {
			tracked.metadata.airplay = metadata.airplay;
			updates.push("metadata-airplay");
		}
		if (metadata.eiscpBroadcast && !tracked.metadata.eiscpBroadcast) {
			tracked.metadata.eiscpBroadcast = metadata.eiscpBroadcast;
			// Also update the identifier mapping
			this.identifierToNumericId.set(metadata.eiscpBroadcast.identifier, numericDeviceId);
			updates.push("metadata-eiscp-broadcast");
		}
		if (metadata.eiscpScan && !tracked.metadata.eiscpScan) {
			tracked.metadata.eiscpScan = metadata.eiscpScan;
		}

		// Emit update events
		for (const updateType of updates) {
			this.emitUpdate({
				deviceId: numericDeviceId,
				type: updateType,
				changes: {
					newIps: updateType === "ips-added" ? newIps : undefined,
					source,
				},
				currentState: snapshotTracked(tracked),
			});
		}
	}
}
