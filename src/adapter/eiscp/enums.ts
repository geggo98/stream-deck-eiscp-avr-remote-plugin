/**
 * Enum definitions for eISCP commands and responses
 *
 * These enums map to the ISCP command values for Onkyo/Pioneer receivers.
 * Based on OpenHAB Onkyo binding documentation.
 */

/**
 * Power state values
 */
export const PowerState = {
	ON: "01",
	OFF: "00",
} as const;

export type PowerState = (typeof PowerState)[keyof typeof PowerState];

/**
 * Mute state values
 */
export const MuteState = {
	ON: "01",
	OFF: "00",
	TOGGLE: "TG",
} as const;

export type MuteState = (typeof MuteState)[keyof typeof MuteState];

/**
 * Input source enum with decimal and hex values
 *
 * Maps to ISCP SLI command values. Hex value is used in commands.
 */
export const InputSource = {
	DVR_VCR: { decimal: 0, hex: "00", name: "DVR/VCR" },
	SATELLITE_CABLE: { decimal: 1, hex: "01", name: "SATELLITE/CABLE" },
	GAME: { decimal: 2, hex: "02", name: "GAME" },
	AUX: { decimal: 3, hex: "03", name: "AUX" },
	PC: { decimal: 5, hex: "05", name: "PC" },
	BLURAY_DVD: { decimal: 16, hex: "10", name: "BLURAY/DVD" },
	TAPE1: { decimal: 32, hex: "20", name: "TAPE 1" },
	TAPE2: { decimal: 33, hex: "21", name: "TAPE 2" },
	PHONO: { decimal: 34, hex: "22", name: "PHONO" },
	CD: { decimal: 35, hex: "23", name: "CD" },
	FM: { decimal: 36, hex: "24", name: "FM" },
	AM: { decimal: 37, hex: "25", name: "AM" },
	TUNER: { decimal: 38, hex: "26", name: "TUNER" },
	MUSIC_SERVER: { decimal: 39, hex: "27", name: "MUSIC SERVER" },
	INTERNET_RADIO: { decimal: 40, hex: "28", name: "INTERNET RADIO" },
	USB_FRONT: { decimal: 41, hex: "29", name: "USB (Front)" },
	NETWORK: { decimal: 43, hex: "2B", name: "NETWORK" },
	AIRPLAY: { decimal: 45, hex: "2D", name: "AIRPLAY" },
	DAB: { decimal: 42, hex: "2A", name: "DAB" },
	STRM_BOX: { decimal: 46, hex: "2E", name: "STRM BOX" },
	// Additional common inputs (model-specific)
	HDMI1: { decimal: 22, hex: "16", name: "HDMI 1" },
	HDMI2: { decimal: 23, hex: "17", name: "HDMI 2" },
	HDMI3: { decimal: 24, hex: "18", name: "HDMI 3" },
	HDMI4: { decimal: 25, hex: "19", name: "HDMI 4" },
	HDMI5: { decimal: 26, hex: "1A", name: "HDMI 5" },
	CBL_SAT: { decimal: 10, hex: "0A", name: "CBL/SAT" },
} as const;

export type InputSourceKey = keyof typeof InputSource;
export type InputSourceValue = (typeof InputSource)[InputSourceKey];

/**
 * Get input source by hex value
 */
export function getInputByHex(hex: string): InputSourceValue | undefined {
	return Object.values(InputSource).find((s) => s.hex.toLowerCase() === hex.toLowerCase());
}

/**
 * Get input source by decimal value
 */
export function getInputByDecimal(decimal: number): InputSourceValue | undefined {
	return Object.values(InputSource).find((s) => s.decimal === decimal);
}

/**
 * Listening mode (Sound mode) enum
 *
 * Maps to ISCP LMD command values.
 */
export const ListeningMode = {
	STEREO: { decimal: 0, hex: "00", name: "Stereo" },
	DIRECT: { decimal: 1, hex: "01", name: "Direct" },
	PURE_DIRECT: { decimal: 2, hex: "02", name: "Pure Direct" },
	Enhanced: { decimal: 15, hex: "0F", name: "Enhanced" },
	MUSIC: { decimal: 11, hex: "0B", name: "Music" },
	ALL_CHANNEL_STEREO: { decimal: 12, hex: "0C", name: "All Channel Stereo" },
	Unknown17: { decimal: 17, hex: "11", name: "Unknown Mode 17" },
	Unknown20: { decimal: 20, hex: "14", name: "Unknown Mode 20" },
	WHOLE_HOUSE_MODE: { decimal: 64, hex: "40", name: "Whole House Mode" },
	Unknown128: { decimal: 128, hex: "80", name: "Unknown Mode 128" },
	DTS_X_NEO6_CINEMA: { decimal: 130, hex: "82", name: "DTS:X / Neo:6 Cinema" },
	THX_CINEMA: { decimal: 66, hex: "42", name: "THX Cinema" },
	DTS_NEURAL_X: { decimal: 80, hex: "50", name: "DTS Neural:X" },
	DOLBY_SURROUND: { decimal: 81, hex: "51", name: "Dolby Surround" },
	Unspecified: { decimal: 255, hex: "FF", name: "Unspecified" },
} as const;

export type ListeningModeKey = keyof typeof ListeningMode;
export type ListeningModeValue = (typeof ListeningMode)[ListeningModeKey];

/**
 * Get listening mode by hex value
 */
export function getListeningModeByHex(hex: string): ListeningModeValue | undefined {
	return Object.values(ListeningMode).find(
		(m) => m.hex.toLowerCase() === hex.toLowerCase(),
	);
}

/**
 * Get listening mode by decimal value
 */
export function getListeningModeByDecimal(decimal: number): ListeningModeValue | undefined {
	return Object.values(ListeningMode).find((m) => m.decimal === decimal);
}

/**
 * Command names for ISCP commands
 */
export const IscpCommand = {
	POWER: "PWR",
	VOLUME: "MVL",
	MUTE: "AMT",
	INPUT: "SLI",
	LISTENING_MODE: "LMD",
	AUDIO_EQ: "AEQ",
	DIMMER: "DIM",
	MOTOR: "MOT",
	RAS: "RAS",
	TUNER_FREQ: "TFR",
	PCT: "PCT",
	ITV: "ITV",
	NET_DEV_SWITCH: "NDS",
	FIELD_DISPLAY: "FLD",
	UPDATE: "UPD",
	SOUND_PROGRAM: "SPL",
	NET_LIST_TRACK: "NLT",
	NET_LIST_SERVICE: "NLS",
} as const;

export type IscpCommand = (typeof IscpCommand)[keyof typeof IscpCommand];

/**
 * Network music service enum
 *
 * Maps to ISCP NLS (Network List Service) command values.
 * These are the streaming services available on the receiver.
 */
export const NetworkService = {
	TUNE_IN: { key: "0", name: "TuneIn" },
	PANDORA: { key: "1", name: "Pandora" },
	SPOTIFY: { key: "2", name: "Spotify" },
	DEEZER: { key: "3", name: "Deezer" },
	TIDAL: { key: "4", name: "Tidal" },
	AMAZON_MUSIC: { key: "5", name: "Amazon Music" },
	FLARE_CONNECT: { key: "6", name: "FlareConnect" },
	CHROMECAST: { key: "7", name: "Chromecast built-in" },
	DTS_PLAY_FI: { key: "8", name: "DTS Play-Fi" },
	AIRPLAY: { key: "9", name: "AirPlay" },
	MUSIC_SERVER: { key: "0", name: "Music Server" },
	PLAY_QUEUE: { key: "1", name: "Play Queue" },
} as const;

export type NetworkServiceKey = keyof typeof NetworkService;
export type NetworkServiceValue = (typeof NetworkService)[NetworkServiceKey];

/**
 * Get network service by key
 */
export function getNetworkServiceByKey(key: string): NetworkServiceValue | undefined {
	return Object.values(NetworkService).find((s) => s.key === key);
}

/**
 * Unit type values
 */
export const UnitType = {
	RECEIVER: "1",
} as const;

export type UnitType = (typeof UnitType)[keyof typeof UnitType];

/**
 * Terminator characters
 */
export const Terminator = {
	CR: "\x0D", // Carriage Return (most common)
	LF: "\x0A", // Line Feed
	EOF: "\x1A", // End of File
} as const;

export type Terminator = (typeof Terminator)[keyof typeof Terminator];

/**
 * Packet header constants
 */
export const PacketHeader = {
	MAGIC: "ISCP",
	HEADER_SIZE: 16,
	VERSION: "\x01\x00\x00\x00", // Version byte (0x01) followed by reserved bytes
	DEFAULT_TERMINATOR: "\x0D",
} as const;
