/**
 * The option-name editor: one row per option the receiver has, with the name it
 * gave the option and a field for the user's own.
 *
 * Its own file rather than another block in eiscp-pi.js, because it is self-contained
 * and that file is shared by every panel.
 *
 * Two rules it follows throughout:
 *
 *  - **Rows are built with the DOM, never with innerHTML.** Every name here came off
 *    the network — the receiver's display field — and interpolating that into markup
 *    is the one way a Property Inspector can be made to run someone else's script.
 *  - **Nothing is bound with sdpi-components.** These names live in the plugin's
 *    global settings, and a `global`-bound input writes the whole settings object
 *    back from its own snapshot; with this panel open while Auto-Discover is running,
 *    that snapshot is already stale. Same reason the wake-on-press checkbox is a
 *    plain one (see src/actions/pi-wake.ts).
 */
(function () {
	"use strict";

	/** Typing is not a decision; wait for a pause before writing. */
	const WRITE_DEBOUNCE_MS = 400;

	function send(message) {
		try {
			SDPIComponents.streamDeckClient.send("sendToPlugin", message);
		} catch (e) {
			/* the panel opened before the client did; the next request retries */
		}
	}

	function render(containerId) {
		const c = document.getElementById(containerId);
		if (!c) return;

		c.innerHTML =
			'<div class="sdpi-item"><div class="sdpi-item-label">Names</div>' +
			'  <div class="sdpi-item-value" style="flex-direction:column; align-items:stretch;">' +
			'    <div id="nameEditorRows" class="pi-names"></div>' +
			"  </div>" +
			"</div>" +
			'<div id="nameEditorStatus" class="pi-hint"></div>' +
			'<div class="sdpi-item" id="nameEditorAdd" style="display:none;">' +
			'  <div class="sdpi-item-label">Add</div>' +
			'  <div class="sdpi-item-value">' +
			'    <select id="nameEditorAddSelect" class="pi-name-add"></select>' +
			'    <button id="nameEditorAddBtn">Add</button>' +
			"  </div>" +
			"</div>";

		const rowsEl = c.querySelector("#nameEditorRows");
		const statusEl = c.querySelector("#nameEditorStatus");
		const addItem = c.querySelector("#nameEditorAdd");
		const addSelect = c.querySelector("#nameEditorAddSelect");
		const addBtn = c.querySelector("#nameEditorAddBtn");

		/** Rows by code, so a single stored reply can correct one line in place. */
		const byCode = new Map();
		let label = "option";
		/** A list that arrived while a field had focus; applied on blur. */
		let deferred = null;

		const request = () => send({ event: "getOptionNames" });

		/**
		 * The panel can be painted before the sdpi client has its socket, and that
		 * first request is the one that fills the whole list — a lost one leaves the
		 * editor empty with nothing to explain it. Ask again twice, then stop.
		 */
		let answered = false;
		let attempts = 0;
		function requestUntilAnswered() {
			request();
			if (answered || attempts >= 2) return;
			attempts++;
			setTimeout(() => {
				if (!answered) requestUntilAnswered();
			}, 1000);
		}

		const typing = () => {
			const active = document.activeElement;
			return active && active.classList && active.classList.contains("pi-name-input");
		};

		function buildRow(row) {
			const el = document.createElement("div");
			el.className = "pi-name-row";

			const use = document.createElement("input");
			use.type = "checkbox";
			use.className = "pi-name-use";
			use.checked = row.use === true;
			use.title = "Use my name instead of the receiver's";

			const code = document.createElement("span");
			code.className = "pi-name-code";
			code.textContent = row.code;

			const field = document.createElement("input");
			field.type = "text";
			field.className = "pi-name-input";
			field.maxLength = 48;
			field.value = row.custom || "";
			field.placeholder = row.learned || row.spec || "own name";

			const learned = document.createElement("div");
			learned.className = "pi-name-learned";

			const head = document.createElement("div");
			head.className = "pi-name-head";
			head.appendChild(use);
			head.appendChild(code);
			head.appendChild(field);
			el.appendChild(head);
			el.appendChild(learned);

			const paintSecondary = () => {
				// Always visible, whichever name is in force: the learned one is the
				// answer to "what does the receiver call this?", which is the question
				// the user is deciding about.
				const spec = row.spec ? row.spec + " · " : "";
				learned.textContent = row.learned
					? spec + 'receiver: "' + row.learned + '"'
					: spec + "not learned yet — run Auto-Discover";
				learned.classList.toggle("pi-name-unlearned", !row.learned);
				field.classList.toggle("pi-name-off", !use.checked);
			};

			let timer = null;
			const write = () => {
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				send({ event: "setOptionName", code: row.code, name: field.value, use: use.checked });
			};

			use.addEventListener("change", () => {
				// Nothing to switch on: an empty field means "no name of my own".
				if (use.checked && !field.value.trim()) {
					use.checked = false;
					field.focus();
					return;
				}
				paintSecondary();
				write();
			});
			field.addEventListener("input", () => {
				// The first character the user types is them saying they want their name
				// used; asking for a second click would be pedantic.
				if (field.value.trim() && !use.checked) {
					use.checked = true;
					paintSecondary();
				}
				if (timer) clearTimeout(timer);
				timer = setTimeout(write, WRITE_DEBOUNCE_MS);
			});
			field.addEventListener("change", write);
			field.addEventListener("blur", () => {
				write();
				if (deferred) {
					const list = deferred;
					deferred = null;
					paint(list);
				}
			});

			paintSecondary();
			return { el, field, use, row, paintSecondary };
		}

		function paint(list) {
			byCode.clear();
			rowsEl.textContent = "";
			label = list.label || "option";
			for (const row of list.rows || []) {
				const built = buildRow(row);
				byCode.set(row.code, built);
				rowsEl.appendChild(built.el);
			}

			const rows = list.rows || [];
			if (rows.length === 0) {
				statusEl.textContent = "No " + label + "s known yet — run Auto-Discover above, or add one below.";
			} else if (rows.some((r) => r.seeded)) {
				// Said out loud because the deck already shows these names without anyone
				// having typed them; unexplained, that reads as the plugin being wrong.
				statusEl.textContent =
					"Tick a row to use your own name. FM, AM and DAB are filled in because the " +
					"receiver shows the station there, not the input name — untick one to see what " +
					"it reports.";
			} else {
				statusEl.textContent = "Tick a row to use your own name instead of the receiver's.";
			}

			addSelect.textContent = "";
			for (const item of list.addable || []) {
				const o = document.createElement("option");
				o.value = item.code;
				o.textContent = item.spec + " (" + item.code + ")";
				addSelect.appendChild(o);
			}
			addItem.style.display = (list.addable || []).length ? "" : "none";
		}

		addBtn.addEventListener("click", () => {
			if (addSelect.value) send({ event: "addOptionCode", code: addSelect.value });
		});

		try {
			SDPIComponents.streamDeckClient.sendToPropertyInspector.subscribe((ev) => {
				const p = ev && ev.payload ? ev.payload : ev;
				if (!p) return;
				if (p.event === "optionNames") {
					answered = true;
					if (p.error === "no-ip") {
						byCode.clear();
						rowsEl.textContent = "";
						addItem.style.display = "none";
						statusEl.textContent = "Select a device IP above to edit " + (p.label || "option") + " names.";
						return;
					}
					// Re-rendering under the cursor would eat what is being typed.
					if (typing()) deferred = p;
					else paint(p);
				} else if (p.event === "optionNameStored") {
					const built = byCode.get(p.code);
					if (!built) return;
					built.row.custom = p.custom;
					built.row.use = p.use;
					built.use.checked = p.use === true;
					// The stored text can differ from what was typed (it is clamped and
					// stripped); say so, unless the user is still in the field.
					if (document.activeElement !== built.field) built.field.value = p.custom || "";
					built.paintSecondary();
				} else if (p.event === "discover" && p.phase === "done") {
					// A sweep is what fills this list; ask again once it has.
					request();
				}
			});
		} catch (e) {
			/* sdpi client not ready; the initial request below still runs */
		}

		// The list is per receiver, so it has to follow the Device IP selection. The
		// registration fires once immediately, which is also the initial request.
		//
		// Debounced because the Custom IP field reports every keystroke: without it a
		// typed address would rebuild the whole list a dozen times over.
		let ipTimer = null;
		const requestSoon = () => {
			if (ipTimer) clearTimeout(ipTimer);
			ipTimer = setTimeout(requestUntilAnswered, 250);
		};
		if (window.EiscpPI && window.EiscpPI.onEffectiveIpChanged) window.EiscpPI.onEffectiveIpChanged(requestSoon);
		else requestSoon();
	}

	window.EiscpNameEditor = { render };
})();
