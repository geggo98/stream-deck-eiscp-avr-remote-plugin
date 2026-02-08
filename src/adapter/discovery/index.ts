/**
 * Unified eISCP Device Discovery Adapter
 *
 * This module provides a unified interface for discovering eISCP-compatible devices
 * using multiple methods:
 * - DNS-SD (AirPlay devices on macOS) - discovers IPs to try eISCP on
 * - eISCP broadcast discovery (Onkyo/Pioneer receivers)
 * - eISCP network scanning (TCP port scanning)
 *
 * ALL devices are verified via eISCP connection. Only devices that successfully
 * connect via eISCP are returned.
 */

export {
	discoverAllDevicesStreaming,
	discoverAllDevices,
	type DeviceSource,
	type DiscoveredDevice,
	type DeviceMetadata,
	type EiscpConnectResult,
	type EiscpConnectError,
	type ScanProgress,
	type UnifiedDiscoveryResult,
	type UnifiedDiscoveryOptions,
} from "./unified-controller.js";
