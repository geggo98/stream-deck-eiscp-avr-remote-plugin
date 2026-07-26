/**
 * Shared Property Inspector helpers.
 *
 * Populates command/parameter dropdowns from window.EISCP_COMMANDS (generated
 * by `npm run generate:commands` into commands.js) so the PI never has to be
 * hand-synced with the registry. Load order in each PI:
 *   sdpi-components.js  ->  commands.js  ->  eiscp-pi.js  ->  init/<pi-name>.js
 *
 * The per-PI init script is a separate file rather than an inline <script>
 * because the PIs carry a Content-Security-Policy that refuses inline script
 * (see SECURITY.md). Shared styling lives in eiscp-pi.css.
 */
(function () {
	"use strict";

	const COMMANDS = () => window.EISCP_COMMANDS || [];

	/** How long to wait for the plugin's device-list reply before offering a way out. */
	const DEVICE_LIST_TIMEOUT_MS = 6000;

	// Anything that depends on "is a usable device IP configured?" registers here:
	// the Device IP select, the custom-IP field and the plugin-wide global setting
	// can each change it, and the Auto-Discover button has to follow.
	const ipListeners = new Set();
	function onEffectiveIpChanged(fn) {
		ipListeners.add(fn);
		fn();
	}
	function notifyIpChanged() {
		for (const fn of ipListeners) {
			try {
				fn();
			} catch (e) {
				/* a broken listener must not stop the others */
			}
		}
	}

	// The plugin-wide fallback IP (global settings). resolveDeviceIp() in the
	// plugin falls back to it, so an action with nothing selected can still be
	// perfectly functional — the PI must not claim otherwise.
	let globalDeviceIp = "";
	try {
		SDPIComponents.streamDeckClient
			.getGlobalSettings()
			.then((gs) => {
				globalDeviceIp = (gs && gs.deviceIp) || "";
				notifyIpChanged();
			})
			.catch(() => {
				/* leave the fallback empty */
			});
	} catch (e) {
		/* sdpi client not ready; the per-action value is still evaluated */
	}

	/** The IP this action would actually use, mirroring the plugin's resolveDeviceIp. */
	function effectiveDeviceIp() {
		const sel = document.querySelector('[setting="deviceIp"]');
		const custom = document.querySelector('[setting="customIp"]');
		const selected = sel && sel.value ? String(sel.value) : "";
		if (selected && selected !== "custom") return selected;
		const manual = custom && custom.value ? String(custom.value).trim() : "";
		if (manual) return manual;
		return globalDeviceIp;
	}

	/** Show/hide a "Custom..." text field when its select is set to "custom". */
	function setupCustomToggle(selectSetting, customItemId, isForced) {
		const selectEl = document.querySelector('[setting="' + selectSetting + '"]');
		const customItem = document.getElementById(customItemId);
		if (!selectEl || !customItem) return;
		const update = () => {
			const on = selectEl.value === "custom" || (isForced && isForced());
			customItem.style.display = on ? "block" : "none";
		};
		selectEl.addEventListener("valuechange", update);
		setTimeout(update, 200);
		return update;
	}

	/** Inject the shared Device IP selector + custom-IP field into a container. */
	function renderDeviceIp(containerId) {
		const c = document.getElementById(containerId);
		if (!c) return;
		// sdpi-select renders only the options present at first paint and ignores
		// any injected via innerHTML or appended later, so a hand-built dropdown
		// stays empty. Use the sdpi-components "datasource" round-trip instead: the
		// plugin answers a "getDevices" request with the discovered receivers (see
		// src/actions/pi-devices.ts); hot-reload lets it push the list as discovery
		// completes. The list includes a "Custom IP…" entry that reveals the field.
		c.innerHTML =
			'<sdpi-item label="Device IP">' +
			'  <sdpi-select setting="deviceIp" placeholder="Select device"' +
			'    datasource="getDevices" loading="Scanning the network…" hot-reload></sdpi-select>' +
			"</sdpi-item>" +
			'<div id="deviceIpScanning" class="pi-hint" style="display:none;">' +
			"  Scanning for more devices…" +
			"</div>" +
			'<div class="sdpi-item" id="deviceIpFallback" style="display:none; margin:2px 4px 6px;">' +
			'  <span id="deviceIpHint" class="pi-warn"></span>' +
			"</div>" +
			'<div class="sdpi-item" style="justify-content:flex-end; margin:0 4px 4px;">' +
			'  <button id="manualIpBtn" style="font-size:12px;">Enter IP manually</button>' +
			"</div>" +
			'<sdpi-item label="Custom IP" id="customIpItem" style="display:none;">' +
			'  <sdpi-textfield setting="customIp" placeholder="192.168.1.100"></sdpi-textfield>' +
			"</sdpi-item>" +
			'<sdpi-item label="Standby">' +
			'  <div class="pi-check">' +
			'    <input type="checkbox" id="wakeOnPress" checked>' +
			'    <label for="wakeOnPress">Wake the receiver when a key is pressed</label>' +
			"  </div>" +
			"</sdpi-item>" +
			'<div class="pi-hint">' +
			"  In standby the receiver ignores everything except power and input selection," +
			"  so keys are shown dimmed and a press wakes it first." +
			"</div>";

		// The manual field must be reachable *without* the plugin: it used to appear
		// only when the dropdown's "Custom IP…" entry was selected, and that entry
		// arrives in the plugin's reply — so when the plugin was not answering there
		// was no way to type an address at all. An escape hatch cannot depend on the
		// thing it is an escape hatch from.
		let manualForced = false;
		const refreshCustomVisibility = setupCustomToggle("deviceIp", "customIpItem", () => manualForced);
		const manualBtn = c.querySelector("#manualIpBtn");
		if (manualBtn) {
			manualBtn.addEventListener("click", () => {
				manualForced = true;
				if (refreshCustomVisibility) refreshCustomVisibility();
				const field = document.querySelector('[setting="customIp"]');
				if (field && typeof field.focus === "function") field.focus();
			});
		}

		// The wake-on-press switch. Read straight from the global settings, but
		// written back through the plugin (see src/actions/pi-wake.ts): a
		// `global`-bound component would rewrite the whole settings object from a
		// snapshot taken when this panel opened, and take the learned names with it.
		const wake = c.querySelector("#wakeOnPress");
		if (wake) {
			try {
				SDPIComponents.streamDeckClient
					.getGlobalSettings()
					.then((gs) => {
						// Absent means on: waking is the default.
						wake.checked = !gs || gs.wakeOnPress !== false;
					})
					.catch(() => {
						/* leave it at the default */
					});
				wake.addEventListener("change", () => {
					SDPIComponents.streamDeckClient.send("sendToPlugin", {
						event: "setWakeOnPress",
						value: wake.checked,
					});
				});
				// A rejected write is answered with the value that is actually stored.
				SDPIComponents.streamDeckClient.sendToPropertyInspector.subscribe((ev) => {
					const p = ev && ev.payload ? ev.payload : ev;
					if (!p || p.event !== "setWakeOnPress") return;
					wake.checked = p.value !== false;
				});
			} catch (e) {
				/* sdpi client not ready; the checkbox stays at its default */
			}
		}

		// Keep dependent UI (the Auto-Discover button) in step with either input.
		const selectEl = document.querySelector('[setting="deviceIp"]');
		if (selectEl) selectEl.addEventListener("valuechange", notifyIpChanged);
		const customEl = document.querySelector('[setting="customIp"]');
		if (customEl) {
			customEl.addEventListener("valuechange", notifyIpChanged);
			customEl.addEventListener("input", notifyIpChanged);
		}

		// Watchdog: the dropdown shows its "loading" text until the plugin replies,
		// so a plugin that is not running left it on "Scanning the network…" forever
		// with no explanation. Time out, say so, and reveal the manual field. Mirrors
		// the watchdog renderDiscover already had for its own messages.
		const fallback = c.querySelector("#deviceIpFallback");
		const hint = c.querySelector("#deviceIpHint");
		let answered = false;
		const watchdog = setTimeout(() => {
			if (answered) return;
			if (hint) {
				hint.textContent =
					"No device list from the plugin — is it running? Enter the IP manually below.";
			}
			if (fallback) fallback.style.display = "flex";
			manualForced = true;
			if (refreshCustomVisibility) refreshCustomVisibility();
		}, DEVICE_LIST_TIMEOUT_MS);

		// The plugin answers immediately from what it already knows (last used
		// receiver, previous scan) and refreshes the list in the background, so the
		// reply carries a `scanning` flag: say that more devices may still turn up
		// instead of leaving a short list looking complete.
		const scanning = c.querySelector("#deviceIpScanning");
		try {
			SDPIComponents.streamDeckClient.sendToPropertyInspector.subscribe((ev) => {
				const p = ev && ev.payload ? ev.payload : ev;
				if (!p || p.event !== "getDevices") return;
				answered = true;
				clearTimeout(watchdog);
				if (fallback) fallback.style.display = "none";
				if (scanning) scanning.style.display = p.scanning ? "block" : "none";
				// An adopted or pre-selected IP arrives with the list; the
				// Auto-Discover button has to notice it.
				setTimeout(notifyIpChanged, 0);
			});
		} catch (e) {
			/* sdpi client not ready; the watchdog still offers the manual field */
		}
	}

	/** Populate a command <sdpi-select>, grouped into optgroups by category. */
	function buildCommandSelect(selectEl, filter) {
		if (!selectEl) return;
		const groups = {};
		for (const cmd of COMMANDS()) {
			if (filter && !filter(cmd)) continue;
			(groups[cmd.category] = groups[cmd.category] || []).push(cmd);
		}
		for (const category of Object.keys(groups).sort()) {
			const og = document.createElement("optgroup");
			og.label = category;
			for (const cmd of groups[category]) {
				const o = document.createElement("option");
				o.value = cmd.code;
				o.textContent = cmd.name + " (" + cmd.code + ")";
				og.appendChild(o);
			}
			selectEl.appendChild(og);
		}
	}

	/** Populate a parameter <sdpi-select> from a command's values (+ optional extras). */
	function buildParamSelect(selectEl, code, extras) {
		if (!selectEl) return;
		// Remove previously generated options, keep any declared in markup with data-keep.
		Array.from(selectEl.querySelectorAll("option:not([data-keep]), optgroup")).forEach((n) => n.remove());
		const cmd = COMMANDS().find((c) => c.code === code);
		const values = cmd ? cmd.values : [];
		for (const v of values) {
			const o = document.createElement("option");
			o.value = v.param;
			o.textContent = v.name + " (" + v.param + ")";
			selectEl.appendChild(o);
		}
		for (const ex of extras || []) {
			const o = document.createElement("option");
			o.value = ex.value;
			o.textContent = ex.label;
			selectEl.appendChild(o);
		}
	}

	/**
	 * Inject an "Auto-Discover" button (with a warning + live progress) that asks
	 * the plugin to sweep every option and learn its name from the receiver.
	 */
	function renderDiscover(containerId, optionLabel) {
		const c = document.getElementById(containerId);
		if (!c) return;
		const label = optionLabel || "option";
		c.innerHTML =
			'<div class="sdpi-item">' +
			'  <button id="discoverBtn" class="sdpi-item-value" style="width:100%;">Auto-Discover ' +
			label +
			" names</button>" +
			"</div>" +
			'<div id="discoverWarn" style="display:none; margin:8px 4px; font-size:12px;">' +
			'  <p class="pi-warn">This cycles the receiver through every ' +
			label +
			" to read each name from its display. The " +
			label +
			" will change repeatedly and is restored at the end.</p>" +
			'  <button id="discoverConfirm">Discover</button>&nbsp;' +
			'  <button id="discoverCancel">Cancel</button>' +
			"</div>" +
			'<div id="discoverNeedsIp" class="pi-hint" style="display:none;">' +
			"  Select a device IP above to enable Auto-Discover." +
			"</div>" +
			'<div id="discoverStatus" class="pi-hint" style="display:none;"></div>';

		const btn = c.querySelector("#discoverBtn");
		const warn = c.querySelector("#discoverWarn");
		const status = c.querySelector("#discoverStatus");
		const needsIp = c.querySelector("#discoverNeedsIp");
		const show = (el, on) => {
			if (el) el.style.display = on ? "block" : "none";
		};

		// A sweep talks to the receiver, so it is meaningless without an address:
		// the plugin would answer "No device IP configured" and the key would just
		// flash an alert. Disable it until an IP would actually be resolved — which
		// includes the plugin-wide global setting, not only this action's selection.
		onEffectiveIpChanged(() => {
			const hasIp = effectiveDeviceIp() !== "";
			if (btn) {
				btn.disabled = !hasIp;
				btn.style.opacity = hasIp ? "" : "0.5";
				btn.style.cursor = hasIp ? "" : "not-allowed";
				btn.title = hasIp ? "" : "Select a device IP first";
			}
			show(needsIp, !hasIp);
			if (!hasIp) {
				show(warn, false);
				show(status, false);
			}
		});

		// Watchdog: if the plugin never answers (e.g. it was just restarted),
		// don't leave the status stuck on "Starting discovery…" forever.
		const WATCHDOG_MS = 10000;
		let watchdog = null;
		const stopWatchdog = () => {
			if (watchdog) {
				clearTimeout(watchdog);
				watchdog = null;
			}
		};
		const armWatchdog = () => {
			stopWatchdog();
			watchdog = setTimeout(() => {
				status.textContent = "No response from plugin — is it running?";
				show(btn, true);
			}, WATCHDOG_MS);
		};

		btn.addEventListener("click", () => show(warn, true));
		c.querySelector("#discoverCancel").addEventListener("click", () => show(warn, false));
		c.querySelector("#discoverConfirm").addEventListener("click", () => {
			// Defence in depth: the panel is hidden when no IP resolves, but never
			// start a receiver sweep that the plugin can only reject.
			if (effectiveDeviceIp() === "") {
				show(warn, false);
				return;
			}
			show(warn, false);
			show(status, true);
			show(btn, false);
			status.textContent = "Starting discovery…";
			try {
				SDPIComponents.streamDeckClient.send("sendToPlugin", { action: "discover" });
				armWatchdog();
			} catch (e) {
				status.textContent = "Could not start: " + e;
				show(btn, true);
			}
		});

		try {
			SDPIComponents.streamDeckClient.sendToPropertyInspector.subscribe((ev) => {
				const p = ev && ev.payload ? ev.payload : ev;
				if (!p || p.event !== "discover") return;
				if (p.phase === "progress") {
					armWatchdog(); // sweep steps take seconds; re-arm on each event
					status.textContent = "Discovering… " + p.done + ": " + (p.current || "");
				} else if (p.phase === "done") {
					stopWatchdog();
					status.textContent = "Done — discovered " + (p.count || 0) + " names. Re-open the action to see them.";
					show(btn, true);
				} else if (p.phase === "error") {
					stopWatchdog();
					status.textContent = "Failed: " + (p.message || "unknown error");
					show(btn, true);
				}
			});
		} catch (e) {
			/* sdpi client not ready; button still sends, progress just won't show */
		}
	}

	window.EiscpPI = { renderDeviceIp, setupCustomToggle, buildCommandSelect, buildParamSelect, renderDiscover };
})();
