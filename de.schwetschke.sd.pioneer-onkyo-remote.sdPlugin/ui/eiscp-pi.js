/**
 * Shared Property Inspector helpers.
 *
 * Populates command/parameter dropdowns from window.EISCP_COMMANDS (generated
 * by `npm run generate:commands` into commands.js) so the PI never has to be
 * hand-synced with the registry. Load order in each PI:
 *   sdpi-components.js  ->  commands.js  ->  eiscp-pi.js  ->  inline init
 */
(function () {
	"use strict";

	const COMMANDS = () => window.EISCP_COMMANDS || [];

	/** Show/hide a "Custom..." text field when its select is set to "custom". */
	function setupCustomToggle(selectSetting, customItemId) {
		const selectEl = document.querySelector('[setting="' + selectSetting + '"]');
		const customItem = document.getElementById(customItemId);
		if (!selectEl || !customItem) return;
		const update = () => {
			customItem.style.display = selectEl.value === "custom" ? "block" : "none";
		};
		selectEl.addEventListener("valuechange", update);
		setTimeout(update, 200);
	}

	/** Inject the shared Device IP selector + custom-IP field into a container. */
	function renderDeviceIp(containerId) {
		const c = document.getElementById(containerId);
		if (!c) return;
		c.innerHTML =
			'<sdpi-item label="Device IP">' +
			'  <sdpi-select setting="deviceIp" placeholder="Select device">' +
			'    <optgroup label="Pre-configured">' +
			'      <option value="10.2.0.32">Receiver (10.2.0.32)</option>' +
			"    </optgroup>" +
			'    <option value="custom">Custom IP...</option>' +
			"  </sdpi-select>" +
			"</sdpi-item>" +
			'<sdpi-item label="Custom IP" id="customIpItem" style="display:none;">' +
			'  <sdpi-textfield setting="customIp" placeholder="192.168.1.100"></sdpi-textfield>' +
			"</sdpi-item>";
		setupCustomToggle("deviceIp", "customIpItem");
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

	window.EiscpPI = { renderDeviceIp, setupCustomToggle, buildCommandSelect, buildParamSelect };
})();
