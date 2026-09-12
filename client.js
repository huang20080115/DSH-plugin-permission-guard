window.__ModuleLoader__.load({
	id: "dsh-plugin-permission-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		/**
		 * Client half of the permission guard: a READ-ONLY mode indicator in the
		 * composer tool row.
		 *
		 * It is read-only on purpose. Switching modes must go through the host tool or
		 * the state file, because the only write channel available over HTTP would
		 * bypass `tools/pre-execute` and hand the agent a self-escalation route.
		 *
		 * Data comes from the host's own HTTP route, not host RPC: `harness.handle` /
		 * `host.call` exist only inside the dynamic plugin runner, whose host side keeps
		 * a per-run handler map. The web server is the surface a profile plugin can own.
		 *
		 * The outer `__ModuleLoader__.load({ id, factory })` wrapper is REQUIRED, and
		 * `id` must equal this package's name: a bundle that loads without calling the
		 * loader is rejected with
		 *   "loaded without registering <id> via __ModuleLoader__.load"
		 */

		const React = require("react");

		const SLOT = "conversation.input.left";
		const ENTRY_ID = "permission-guard.mode";
		const MODE_URL = "/permission-guard/mode";

		/**
		 * Display strings, keyed by language.
		 *
		 * WHY A LOCAL TABLE AND NOT `ctx.locale.register`
		 *
		 * The `locale` service offers a real dictionary registry (`register(ns, dicts)` /
		 * `register(ns, locale, dict)` / `bind(ns)`). Using it would hand the built-in
		 * language switcher ownership of these strings, which is attractive.
		 *
		 * It is declined for one reason: this UI is a single read-only indicator with six
		 * strings. Registering into a SHARED namespace risks a duplicate-(ns, locale)
		 * throw, and the typed form demands a dictionary for EVERY shipped locale — a
		 * guaranteed drift bug the next time a language is added upstream. A local table
		 * cannot fail at runtime; the only thing given up is third-party translation of
		 * six strings.
		 *
		 * Following the locale and owning the dictionary are separable decisions, and only
		 * the second is declined: the active language is still READ from the service, so
		 * this follows the system/browser language and re-renders on a live switch.
		 *
		 * Mode NAMES ARE NOT DUPLICATED HERE. They live in modes.js on the host and in the
		 * state file in English; this table only maps a mode id to its localized display
		 * text. That keeps one source for the mode set and one source for its translation.
		 */
		// The note names ONLY mechanisms that actually exist.
		//
		// It used to say "use the permission_mode tool", which was wrong in practice: the tool is
		// registered on the host, but it never reaches the model's tool list, so anyone following that
		// advice finds no such tool. Pointing at something unusable is worse than saying less.
		//
		// Both surviving routes work because the plugin keeps the harness sandbox in step in both
		// directions: the built-in selector changes the harness mode and the plugin follows it, and
		// editing the file is watched and pushed to the harness.
		const EN = {
			label: "Permission",
			readFailed: "Read failed: ",
			note: "Read-only display. Switch with the built-in permission selector, or by editing permissions.json.",
			tooltip: "Current file-permission mode",
			modes: {
				1: { name: "Workspace read", detail: "workspace: read; outside: none" },
				2: { name: "Workspace write", detail: "workspace: read/write; outside: none" },
				3: { name: "Outside readable", detail: "workspace: read/write; outside: read" },
				4: { name: "Full access", detail: "workspace: read/write; outside: read/write" },
			},
		};

		const ZH = {
			label: "权限",
			readFailed: "读取失败：",
			note: "只读显示。切换档位请用内置的权限选择器，或编辑 permissions.json。",
			tooltip: "当前文件权限档位",
			modes: {
				1: { name: "工作区查看", detail: "工作区可读，非工作区不可读" },
				2: { name: "工作区内修改", detail: "工作区可读/写，非工作区不可读" },
				3: { name: "非工作区可读", detail: "工作区可读/写，非工作区可读" },
				4: { name: "完全权限", detail: "工作区可读/写，非工作区可读/写" },
			},
		};

		const MODE_IDS = [1, 2, 3, 4];

		/**
		 * Pick a table for a BCP 47-style tag.
		 *
		 * Prefix matching, not equality: the snapshot's `active` may be `zh-CN`,
		 * `zh-Hans`, or a bare `zh`, and requiring an exact key would silently fall back
		 * to English for every Chinese user. Unmatched tags fall back to English, the
		 * documented terminal language of DSH's own fallback chain.
		 */
		function dictFor(tag) {
			const value = typeof tag === "string" ? tag.toLowerCase() : "";
			if (value.indexOf("zh") === 0) return ZH;
			return EN;
		}

		/**
		 * Resolve the table, following the harness locale when available.
		 *
		 * `navigator` is the second source on purpose: it preserves "follow the system
		 * language" before the locale service resolves and in any embedding where the
		 * service is absent. Both are read defensively — a client bundle must not assume
		 * a browser global exists.
		 */
		function resolveDict(locale) {
			if (locale !== undefined && locale !== null) {
				try {
					const snapshot = locale.getSnapshot();
					if (snapshot !== undefined && snapshot !== null && typeof snapshot.active === "string") {
						return dictFor(snapshot.active);
					}
				} catch (error) { /* fall through to navigator */ }
			}
			try {
				if (typeof navigator !== "undefined" && navigator !== null) {
					const tagged = navigator.language || (navigator.languages && navigator.languages[0]);
					if (typeof tagged === "string") return dictFor(tagged);
				}
			} catch (error) { /* fall through to the default */ }
			return EN;
		}

		const S = {
			wrap: { position: "relative", display: "inline-block" },
			button: {
				display: "inline-flex",
				alignItems: "center",
				gap: "4px",
				padding: "2px 8px",
				borderRadius: "6px",
				border: "1px solid var(--dsw-border, rgba(128,128,128,0.35))",
				background: "transparent",
				color: "inherit",
				fontSize: "12px",
				lineHeight: "18px",
				cursor: "pointer",
				whiteSpace: "nowrap",
			},
			panel: {
				position: "absolute",
				bottom: "100%",
				left: 0,
				marginBottom: "6px",
				minWidth: "250px",
				padding: "6px",
				borderRadius: "8px",
				border: "1px solid var(--dsw-border, rgba(128,128,128,0.35))",
				background: "var(--dsw-surface, Canvas)",
				color: "inherit",
				boxShadow: "0 6px 24px rgba(0,0,0,0.22)",
				zIndex: 40,
			},
			row: { padding: "4px 8px", borderRadius: "6px", fontSize: "12px", lineHeight: "16px" },
			rowActive: { background: "var(--dsw-accent-weak, rgba(128,128,128,0.18))" },
			detail: { display: "block", opacity: 0.65, fontSize: "11px", marginTop: "1px" },
			note: { display: "block", padding: "6px 8px 2px", fontSize: "11px", opacity: 0.7 },
			error: { display: "block", padding: "2px 8px", fontSize: "11px", color: "var(--dsw-danger, #d33)" },
		};

		/**
		 * @param props.locale - the `locale` client service, or undefined. Undefined is a
		 * supported state: the indicator still renders, using `navigator` then English.
		 */
		function ModeIndicator(props) {
			const locale = props && props.locale;
			const [state, setState] = React.useState({ ready: false, id: null, error: null });
			const [open, setOpen] = React.useState(false);
			// Bumped on a locale change purely to force a re-render. The active language is
			// read during render instead of being copied into state, so there is no stale
			// copy to go out of sync with the service.
			const [, setRevision] = React.useState(0);

			React.useEffect(() => {
				let alive = true;
				function load() {
					fetch(MODE_URL, { headers: { accept: "application/json" } })
						.then((response) => response.ok ? response.json() : Promise.reject(new Error("HTTP " + response.status)))
						.then((value) => {
							if (!alive) return;
							setState({ ready: true, id: value && typeof value.id === "number" ? value.id : null, error: null });
						})
						.catch((error) => {
							if (!alive) return;
							setState({ ready: true, id: null, error: String(error && error.message ? error.message : error) });
						});
				}
				load();
				// The mode can change from the tool or the file while this page stays open and
				// there is no push channel, so re-read when the window regains focus.
				window.addEventListener("focus", load);
				return () => {
					alive = false;
					window.removeEventListener("focus", load);
				};
			}, []);

			// Follow a live locale switch. Without this the indicator keeps the language it
			// rendered with until the next unrelated re-render, which looks like the setting
			// was ignored.
			React.useEffect(() => {
				if (locale === undefined || locale === null || typeof locale.subscribe !== "function") return undefined;
				let dispose = null;
				try {
					dispose = locale.subscribe(() => setRevision((n) => n + 1));
				} catch (error) {
					return undefined;
				}
				return typeof dispose === "function" ? dispose : undefined;
			}, [locale]);

			const t = resolveDict(locale);
			const current = MODE_IDS.indexOf(state.id) !== -1 ? t.modes[state.id] : null;
			const label = current
				? String(state.id) + " " + current.name
				: (state.ready ? "?" : "…");

			const rows = MODE_IDS.map((id) => React.createElement("div", {
				key: String(id),
				style: id === state.id ? Object.assign({}, S.row, S.rowActive) : S.row,
			},
				String(id) + " " + t.modes[id].name,
				React.createElement("span", { style: S.detail }, t.modes[id].detail),
			));

			return React.createElement("div", { style: S.wrap },
				React.createElement("button", {
					type: "button",
					style: S.button,
					title: current ? t.tooltip + ": " + current.detail : t.tooltip,
					onClick: () => setOpen(!open),
				}, t.label + " ", React.createElement("span", null, label)),
				open ? React.createElement("div", { style: S.panel },
					rows,
					state.error !== null ? React.createElement("span", { style: S.error }, t.readFailed + state.error) : null,
					React.createElement("span", { style: S.note }, t.note),
				) : null,
			);
		}

		/**
		 * Surface a client-side failure on the page.
		 *
		 * The first version of apply() was
		 *   const slots = ctx.get("slots"); if (slots === undefined) return;
		 * which is a SILENT no-op: the bundle loads, no error is printed anywhere, and the
		 * UI simply never appears. That is indistinguishable from "not registered",
		 * "not applied", and "applied but the slot never resolved", so diagnosing it
		 * needed a restart per hypothesis. This makes the failure say which one it is.
		 */
		function reportFailure(headline, detail) {
			try {
				const existing = document.getElementById("permission-guard-diag");
				if (existing !== null) existing.remove();
				const box = document.createElement("div");
				box.id = "permission-guard-diag";
				box.setAttribute("style", [
					"position:fixed", "left:8px", "bottom:8px", "z-index:2147483647",
					"max-width:520px", "padding:8px 10px", "border-radius:6px",
					"background:#7f1d1d", "color:#fff", "font:12px/1.5 monospace",
					"white-space:pre-wrap", "box-shadow:0 4px 16px rgba(0,0,0,0.4)",
				].join(";"));
				box.textContent = "[permission-guard] " + headline + "\n" + detail;
				document.body.appendChild(box);
			} catch (error) {
				// Nothing further we can do; never throw from the reporter.
			}
		}

		/**
		 * Client-SERVICE dependencies, by Cordis service name.
		 *
		 * These two faces are not interchangeable, which cost a debugging cycle:
		 *
		 *   exports.inject (here)                -> SERVICE names; decide what is
		 *                                           attached to this plugin's ctx
		 *   package.json dsh.client.inject       -> PACKAGE names; load ordering only
		 *
		 * Evidence: dsh-client-resources declares only
		 * '@deepseek-ai/dsh-client-ui-renderer' in its manifest, yet its bundle says
		 * inject = ["slots"]. So `slots` reaches a plugin through THIS list, not the
		 * manifest. An earlier version put a package name here and the manifest, and
		 * `ctx.get("slots")` still returned undefined on DSH Desktop.
		 *
		 * `locale` is declared because the UI must follow the active language. It is still
		 * read with an undefined check at the use site, and the indicator renders in a
		 * fallback language without it, so a locale-service problem degrades the TEXT
		 * rather than removing the control.
		 */
		const inject = ["slots", "locale"];

		function apply(ctx) {
			try {
				const slots = ctx.get("slots");
				if (slots === undefined) {
					reportFailure(
						"ctx.get(\"slots\") returned undefined",
						"the bundle loaded and apply() ran, but the slots service is not attached to this plugin's context.\ndeclared inject: " + JSON.stringify(inject));
					return;
				}
				const locale = ctx.get("locale");
				if (locale === undefined) {
					// Not fatal, and deliberately not silent either: the UI still works, but it
					// falls back to navigator language and will not follow a live switch.
					console.warn("[permission-guard] locale service unavailable; language follows navigator only");
				}
				console.log("[permission-guard] apply() ran; slots service found. Waiting for " + SLOT + " ...");
				slots.inject(SLOT, () => {
					console.log("[permission-guard] slot " + SLOT + " declared; registering...");
					const dispose = slots.register({ name: SLOT, id: ENTRY_ID, order: 5 }, (slotProps) => {
						// The slot may already supply props; locale is passed explicitly so the
						// component never has to reach for a service through a global.
						const merged = Object.assign({}, slotProps, { locale: locale });
						return React.createElement(ModeIndicator, merged);
					});
					console.log("[permission-guard] registered into " + SLOT);
					return dispose;
				});
			} catch (error) {
				reportFailure("apply() threw", String(error && error.stack ? error.stack : error));
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
