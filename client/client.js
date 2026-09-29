/**
 * dsh-update-notifier — 浏览器（客户端）半边。
 *
 * 这是一个手写的 module-loader bundle：DSH 的客户端插件不需要构建工具链，
 * 只要用 window.__ModuleLoader__.load({ id, factory }) 包一层，
 * 在 factory 里通过 require() 拿到共享模块（react 等）即可。
 *
 * 行为：
 *   - 页面每次加载都会调用一次 /dsh-update-notifier/api/check；
 *   - 有更新且今天未被「不再提示」跳过时，渲染全局弹窗到 shell.overlay 插槽；
 *   - 弹窗提供：升级更新 / 取消 / 今日不再提示（勾选后写入当天日期）。
 */
window.__ModuleLoader__.load({
	id: "dsh-update-notifier",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const API = "/dsh-update-notifier/api";
		const SNOOZE_KEY = "dsh-update-notifier:snooze-date";
		const STYLE_ID = "dsh-update-notifier-style";

		/** 弹窗样式：注入一次，跟随系统深浅色。 */
		const CSS = [
			".dsh-un-mask{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);",
			"display:flex;align-items:center;justify-content:center;padding:24px;",
			"font-family:inherit;animation:dsh-un-fade .15s ease-out}",
			"@keyframes dsh-un-fade{from{opacity:0}to{opacity:1}}",
			".dsh-un-card{width:100%;max-width:520px;border-radius:14px;padding:24px 26px;",
			"background:#ffffff;color:#1f2328;box-shadow:0 18px 48px rgba(0,0,0,.28);",
			"border:1px solid rgba(0,0,0,.06);line-height:1.6}",
			".dsh-un-title{font-size:17px;font-weight:600;margin:0 0 4px;display:flex;align-items:center;gap:8px}",
			".dsh-un-badge{font-size:11px;font-weight:500;padding:2px 8px;border-radius:999px;",
			"background:rgba(14,138,177,.12);color:#0e8ab1}",
			".dsh-un-sub{font-size:12.5px;opacity:.65;margin:0 0 16px}",
			".dsh-un-row{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:7px 0;",
			"border-bottom:1px dashed rgba(128,128,128,.22)}",
			".dsh-un-row:last-of-type{border-bottom:none}",
			".dsh-un-k{opacity:.6}",
			".dsh-un-v{font-weight:600;font-variant-numeric:tabular-nums}",
			".dsh-un-new{color:#0e8ab1}",
			".dsh-un-body{margin:14px 0 18px;padding:12px 14px;border-radius:10px;",
			"background:rgba(128,128,128,.08);font-size:12.5px;max-height:150px;overflow:auto;",
			"white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace}",
			".dsh-un-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}",
			".dsh-un-snooze{display:flex;align-items:center;gap:7px;font-size:12.5px;opacity:.8;cursor:pointer;user-select:none}",
			".dsh-un-snooze input{width:15px;height:15px;cursor:pointer;accent-color:#0e8ab1}",
			".dsh-un-actions{display:flex;gap:10px}",
			".dsh-un-btn{border:1px solid transparent;border-radius:9px;padding:9px 18px;font-size:13px;",
			"font-weight:500;cursor:pointer;font-family:inherit;transition:opacity .15s}",
			".dsh-un-btn:disabled{opacity:.55;cursor:not-allowed}",
			".dsh-un-primary{background:#0e8ab1;color:#fff}",
			".dsh-un-primary:hover:not(:disabled){opacity:.88}",
			".dsh-un-ghost{background:transparent;color:inherit;border-color:rgba(128,128,128,.35)}",
			".dsh-un-ghost:hover:not(:disabled){background:rgba(128,128,128,.1)}",
			".dsh-un-err{color:#d13438;font-size:12.5px;margin-top:10px;word-break:break-all}",
			".dsh-un-ok{color:#0e8ab1;font-size:12.5px;margin-top:10px}",
			"@media (prefers-color-scheme:dark){",
			".dsh-un-card{background:#22262b;color:#e6e6e6;border-color:rgba(255,255,255,.08);",
			"box-shadow:0 18px 48px rgba(0,0,0,.55)}",
			".dsh-un-body{background:rgba(255,255,255,.06)}",
			".dsh-un-badge{background:rgba(90,190,220,.16);color:#7fd0e8}",
			".dsh-un-new{color:#7fd0e8}",
			".dsh-un-primary{background:#1a7f9e}",
			"}",
		].join("");

		function ensureStyle() {
			if (document.getElementById(STYLE_ID) !== null) {
				return;
			}
			const el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		/** 本地日期键，例如 2026-09-29 —— 免打扰按「自然日」而不是 24 小时。 */
		function todayKey() {
			const d = new Date();
			const m = String(d.getMonth() + 1);
			const day = String(d.getDate());
			return d.getFullYear() + "-" + (m.length < 2 ? "0" + m : m) + "-" + (day.length < 2 ? "0" + day : day);
		}

		function readSnooze() {
			try {
				return window.localStorage.getItem(SNOOZE_KEY);
			} catch (e) {
				return null;
			}
		}

		function writeSnooze() {
			try {
				window.localStorage.setItem(SNOOZE_KEY, todayKey());
			} catch (e) {
				/* 隐私模式下 localStorage 不可用：忽略，退化为每次都提示 */
			}
		}

		function formatTime(value) {
			if (typeof value !== "string" || value.length === 0) {
				return "未知";
			}
			const d = new Date(value);
			if (Number.isNaN(d.getTime())) {
				return value;
			}
			const p = (n) => (n < 10 ? "0" + n : String(n));
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
				+ " " + p(d.getHours()) + ":" + p(d.getMinutes());
		}

		/** 更新提示弹窗：挂在 shell.overlay 插槽上，常驻但按状态决定是否渲染。 */
		function UpdateNotice() {
			const [phase, setPhase] = React.useState("checking");
			const [info, setInfo] = React.useState(null);
			const [error, setError] = React.useState("");
			const [snooze, setSnooze] = React.useState(false);
			const [detail, setDetail] = React.useState("");

			React.useEffect(() => {
				ensureStyle();
				let alive = true;
				fetch(API + "/check", { headers: { accept: "application/json" }, credentials: "same-origin" })
					.then((res) => (res.ok ? res.json() : null))
					.then((data) => {
						if (alive !== true || data === null) {
							return;
						}
						if (data.updateAvailable !== true) {
							setPhase("idle");
							return;
						}
						if (readSnooze() === todayKey()) {
							setPhase("idle");
							return;
						}
						setInfo(data);
						setPhase("prompt");
					})
					.catch(() => {
						if (alive === true) {
							setPhase("idle");
						}
					});
				return () => {
					alive = false;
				};
			}, []);

			/** 关闭：勾了「今日不再提示」就写入当天日期。 */
			const close = React.useCallback((forceSnooze) => {
				if (snooze === true || forceSnooze === true) {
					writeSnooze();
				}
				setPhase("idle");
			}, [snooze]);

			React.useEffect(() => {
				if (phase !== "prompt" && phase !== "failed") {
					return undefined;
				}
				const onKey = (event) => {
					if (event.key === "Escape") {
						close(false);
					}
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [phase, close]);

			const upgrade = React.useCallback(() => {
				setPhase("upgrading");
				setError("");
				setDetail("");
				fetch(API + "/upgrade", {
					method: "POST",
					headers: { "content-type": "application/json" },
					credentials: "same-origin",
					body: JSON.stringify({ version: info === null ? "" : info.target }),
				})
					.then((res) => res.json().then((body) => ({ status: res.status, body })))
					.then(({ status, body }) => {
						if (body !== null && body.ok === true) {
							setDetail(body.output || "npm 安装完成");
							setPhase("done");
							// 升级已完成，重启前不必再提示
							writeSnooze();
							return;
						}
						setError((body && body.error) || ("升级失败（HTTP " + status + "）"));
						setDetail((body && (body.stderr || body.output)) || "");
						setPhase("failed");
					})
					.catch((e) => {
						setError(String(e && e.message ? e.message : e));
						setPhase("failed");
					});
			}, [info]);

			if (phase === "checking" || phase === "idle" || info === null) {
				return null;
			}

			const busy = phase === "upgrading";
			const rows = [
				["当前版本", info.installed, false],
				["最新版本", info.target, true],
				["发布时间", formatTime(info.publishedAt), false],
				["升级频道", info.channel, false],
			].map((r, i) => h("div", { className: "dsh-un-row", key: "r" + i },
				h("span", { className: "dsh-un-k" }, r[0]),
				h("span", { className: "dsh-un-v" + (r[2] ? " dsh-un-new" : "") }, String(r[1]))));

			const actions = phase === "done"
				? [h("button", { key: "ok", className: "dsh-un-btn dsh-un-primary", onClick: () => close(false) }, "知道了")]
				: [
					h("button", {
						key: "later",
						className: "dsh-un-btn dsh-un-ghost",
						disabled: busy,
						onClick: () => close(false),
					}, "取消"),
					h("button", {
						key: "go",
						className: "dsh-un-btn dsh-un-primary",
						disabled: busy || info.upgradeAllowed !== true,
						onClick: upgrade,
					}, busy ? "升级中…" : "升级更新"),
				];

			return h("div", { className: "dsh-un-mask", role: "dialog", "aria-modal": "true" },
				h("div", { className: "dsh-un-card" },
					h("h2", { className: "dsh-un-title" },
						phase === "done" ? "升级完成" : "发现新版本",
						h("span", { className: "dsh-un-badge" }, "DSH " + info.installed)),
					h("p", { className: "dsh-un-sub" },
						phase === "done"
							? "升级已安装，重启 dsh 后生效。"
							: "DeepSeek Harness 有新版本可用，建议升级以获得最新功能与修复。"),
					h("div", null, rows),
					phase === "done"
						? h("div", { className: "dsh-un-ok" }, "已安装 " + info.target + "，请重启 dsh web 使其生效。")
						: null,
					phase === "failed"
						? h("div", { className: "dsh-un-err" }, "升级失败：" + error)
						: null,
					detail !== ""
						? h("div", { className: "dsh-un-body" }, detail)
						: null,
					h("div", { className: "dsh-un-foot", style: { marginTop: "18px" } },
						phase === "done"
							? h("span", { className: "dsh-un-snooze" })
							: h("label", { className: "dsh-un-snooze" },
								h("input", {
									type: "checkbox",
									checked: snooze,
									disabled: busy,
									onChange: (e) => setSnooze(e.target.checked),
								}),
								"今日不再提示"),
						h("div", { className: "dsh-un-actions" }, actions))));
		}

		/** 必需服务：UI 插槽注册表。 */
		const inject = ["slots"];

		/**
		 * 把更新提示注册进全局浮层插槽。
		 * shell.overlay 由 dsh-client-ui-layout 声明为 root 级 list 插槽，
		 * 适合承载这类应用级弹窗。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-update-notifier",
				order: 100,
			}, UpdateNotice));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
