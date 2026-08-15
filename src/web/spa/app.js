/* Symphony SPA — no external dependencies, CSP: self only. */
"use strict";

const state = {
	connection: "disconnected",
	snapshot: null,
	lastEventSequence: 0,
	token: null,
	es: null,
	view: "overview",
	selectedTask: null,
	configDraft: null,
	configBase: null,
	configIssues: [],
};

const $view = document.getElementById("view");
const $connection = document.getElementById("connection");
const $repo = document.getElementById("repo");
const $status = document.getElementById("status");
const $events = document.getElementById("events");

function token() {
	if (state.token) return state.token;
	const hash = window.location.hash || "";
	const m = hash.match(/token=([A-Za-z0-9_-]+)/);
	state.token = m ? m[1] : "";
	return state.token;
}

function authHeaders(json = true) {
	const h = { Authorization: "Bearer " + token() };
	if (json) h["Content-Type"] = "application/json";
	return h;
}

function setConnection(value) {
	state.connection = value;
	$connection.textContent = value.charAt(0).toUpperCase() + value.slice(1);
	$connection.className = "state " + value;
}

async function fetchSnapshot() {
	const res = await fetch("/api/v1/snapshot", { headers: authHeaders(false) });
	if (res.status === 401) { setConnection("disconnected"); throw new Error("unauthorized"); }
	state.snapshot = await res.json();
	state.lastEventSequence = state.snapshot.lastEventSequence;
	$repo.textContent = state.snapshot.repositoryPath + (state.snapshot.configValid ? "" : " · config invalid");
	render();
}

function connectEvents() {
	if (state.es) state.es.close();
	setConnection("reconnecting");
	const es = new EventSource("/api/v1/events?lastEventId=" + state.lastEventId || "/api/v1/events", { withCredentials: false });
	state.es = es;
	es.addEventListener("open", () => setConnection("live"));
	es.addEventListener("error", () => { setConnection("reconnecting"); });
	es.addEventListener("snapshot_required", async () => {
		setConnection("snapshot");
		await fetchSnapshot();
		connectEvents();
	});
	for (const type of ["task.created","task.stage_changed","task.run_state_changed","task.updated","report.submitted","check.completed","attempt.started","attempt.completed","attempt.interrupted","approval.resolved","integration.recorded","config.applied"]) {
		es.addEventListener(type, async (ev) => {
			const event = JSON.parse(ev.data);
			state.lastEventId = event.eventId;
			state.lastEventSequence = event.sequence;
			$events.textContent = `event ${event.sequence} · ${event.type}`;
			await fetchSnapshot(); // projection follows the same events
			setConnection("live");
		});
	}
}

async function sendCommand(type, aggregateId, expectedRevision, payload) {
	const body = {
		commandId: crypto.randomUUID(),
		type,
		repositoryId: state.snapshot.repositoryId,
		aggregateId,
		expectedRevision,
		payload: payload || {},
	};
	const res = await fetch("/api/v1/commands", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) });
	const result = await res.json();
	if (!res.ok) {
		$status.textContent = result.code === "revision_conflict"
			? "Outdated view — another surface changed this task. Refreshing…"
			: "Rejected: " + (result.reason || result.detail || result.code);
		if (result.code === "revision_conflict") { await fetchSnapshot(); }
		return null;
	}
	await fetchSnapshot();
	return result;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function render() {
	const views = {
		overview: renderOverview,
		tasks: renderTasks,
		run: renderRun,
		review: renderReview,
		verification: renderVerification,
		configuration: renderConfiguration,
		diagnostics: renderDiagnostics,
	};
	(views[state.view] || renderOverview)();
}

function activeTask() {
	if (!state.snapshot) return null;
	return state.snapshot.tasks.find((t) => !["done","cancelled"].includes(t.stage)) || null;
}

function badge(status) { return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`; }

function renderOverview() {
	const s = state.snapshot || { tasks: [] };
	const active = activeTask();
	$view.innerHTML = `
		<div class="card"><h2>Repository</h2>
			<div>${escapeHtml(s.repositoryPath || "")}</div>
			<div class="dim">config ${s.configValid ? "valid" : "INVALID"} · hash ${escapeHtml(s.configHash || "")}</div></div>
		<div class="card"><h2>Active task</h2>
			${active ? taskCard(active) : '<div class="dim">No active task</div>'}</div>
		<div class="card"><h2>Checks</h2>${checksTable(active)}</div>`;
}

function taskCard(t) {
	return `<div><strong>${escapeHtml(t.id)}</strong> ${escapeHtml(t.title)} · stage <strong>${escapeHtml(t.stage)}</strong> · run ${badge(t.runState)} · rev ${escapeHtml(String(t.revision))}</div>
	<div class="dim">reports: ${t.hasReports.plan ? "plan✓" : "plan✗"} ${t.hasReports.implementation ? "impl✓" : "impl✗"} ${t.hasReports.review ? "review✓" : "review✗"} · AC ${t.acceptanceTotal}</div>
	<div class="actions">${actionsFor(t)}</div>`;
}

function actionsFor(t) {
	const btn = (label, type, extra = "", cls = "") =>
		`<button class="action ${cls}" data-type="${type}" data-task="${escapeHtml(t.id)}" data-rev="${escapeHtml(String(t.revision))}" ${extra}>${label}</button>`;
	let out = "";
	if (t.stage === "plan") out += btn("Approve plan", "task.approve_plan") + btn("Reject plan", "task.reject_plan");
	if (t.stage === "verify" || t.stage === "postverify") out += btn("Run checks", "checks.run");
	if (t.stage === "ready") out += btn("Record integration (HEAD)", "task.record_integration", 'data-rev-head="1"');
	if (t.stage === "postverify") out += btn("Complete", "task.complete");
	if (t.runState === "idle" || t.runState === "interrupted") out += btn("Pause", "task.pause");
	if (t.runState === "waiting") out += btn("Resume", "task.resume");
	if (!["done","cancelled"].includes(t.stage)) out += btn("Cancel", "task.cancel", "", "danger");
	return out;
}

function checksTable(t) {
	if (!t || t.checks.length === 0) return '<div class="dim">checks not run</div>';
	return `<table><thead><tr><th>check</th><th>status</th></tr></thead><tbody>
	${t.checks.map((c) => `<tr><td>${escapeHtml(c.name)}</td><td>${badge(c.status)}</td></tr>`).join("")}
	</tbody></table>`;
}

function renderTasks() {
	const s = state.snapshot || { tasks: [] };
	$view.innerHTML = `<div class="card"><h2>Tasks</h2>
	<table><thead><tr><th>id</th><th>title</th><th>stage</th><th>run</th><th>rev</th></tr></thead><tbody>
	${s.tasks.map((t) => `<tr data-task="${escapeHtml(t.id)}" class="row"><td>${escapeHtml(t.id)}</td><td>${escapeHtml(t.title)}</td><td>${escapeHtml(t.stage)}</td><td>${badge(t.runState)}</td><td>${escapeHtml(String(t.revision))}</td></tr>`).join("") || '<tr><td colspan="5" class="dim">none</td></tr>'}
	</tbody></table></div>
	${state.selectedTask && s.tasks.find((t) => t.id === state.selectedTask) ? selectedCard(s.tasks.find((t) => t.id === state.selectedTask)) : ""}`;
}

function selectedCard(t) {
	return `<div class="card"><h2>${escapeHtml(t.id)}</h2>${taskCard(t)}</div>`;
}

function renderRun() {
	const t = activeTask();
	$view.innerHTML = t
		? `<div class="card"><h2>Active run</h2>${taskCard(t)}${checksTable(t)}
		   <div class="dim">Live briefs and model turns stay in the Pi session; this view mirrors confirmed state only.</div></div>`
		: '<div class="card"><h2>Active run</h2><div class="dim">No active task.</div></div>';
}

function renderReview() {
	const t = activeTask();
	$view.innerHTML = `<div class="card"><h2>Review</h2>
		${t ? taskCard(t) : '<div class="dim">No active task.</div>'}
		<div class="dim">Fresh-context reviews run in a separate Pi session. Findings appear here once recorded.</div></div>`;
}

function renderVerification() {
	const t = activeTask();
	$view.innerHTML = `<div class="card"><h2>Verification</h2>
		${t ? taskCard(t) + checksTable(t) : '<div class="dim">No active task.</div>'}
		${t && t.integration ? `<div class="dim">integrated ${escapeHtml(t.integration.revision.slice(0,10))} on ${escapeHtml(t.integration.targetBranch)} at ${escapeHtml(t.integration.integratedAt)}</div>` : ""}</div>`;
}

async function renderConfiguration() {
	if (!state.configBase) {
		const res = await fetch("/api/v1/config", { headers: authHeaders(false) });
		const data = await res.json();
		state.configText = data.text;
		state.configBase = data.text;
		state.configDraft = data.text;
	}
	$view.innerHTML = `<div class="card"><h2>Configuration</h2>
		<div class="dim">Draft → validate → diff → explicit apply. Invalid drafts never touch disk.</div>
		<textarea id="draft" aria-label="Configuration draft">${escapeHtml(state.configDraft || "")}</textarea>
		<div class="actions">
			<button id="validate">Validate</button>
			<button id="apply" class="danger" ${state.configIssues.length ? "disabled" : ""}>Apply</button>
		</div>
		<pre id="diff">${escapeHtml((state.configDiff || []).join("\n"))}</pre>
		<div id="issues">${state.configIssues.map((i) => `<div>✗ ${escapeHtml(i.path)}: ${escapeHtml(i.message)}</div>`).join("")}</div>
	</div>`;
	document.getElementById("validate").onclick = validateDraft;
	document.getElementById("apply").onclick = applyDraft;
}

async function validateDraft() {
	const draft = document.getElementById("draft").value;
	state.configDraft = draft;
	const res = await fetch("/api/v1/config/validate", { method: "POST", headers: authHeaders(), body: JSON.stringify({ draft, configHash: state.snapshot.configHash }) });
	const data = await res.json();
	if (res.status === 409) { $status.textContent = "Config changed elsewhere — reloading"; await fetchSnapshot(); return; }
	state.configIssues = data.issues || [];
	state.configDiff = data.diff || [];
	renderConfiguration();
}

async function applyDraft() {
	const draft = document.getElementById("draft").value;
	if (!confirm("Apply this configuration to .symphony/config.yaml?")) return;
	const res = await fetch("/api/v1/config/apply", { method: "POST", headers: authHeaders(), body: JSON.stringify({ draft, configHash: state.snapshot.configHash }) });
	const data = await res.json();
	if (!res.ok) { $status.textContent = data.error + (data.issues ? ": " + data.issues[0].message : ""); return; }
	$status.textContent = "Applied" + (data.backedUp ? " (backup written)" : "");
	await fetchSnapshot();
}

function renderDiagnostics() {
	$view.innerHTML = `<div class="card"><h2>Diagnostics</h2>
		<div>connection: ${escapeHtml(state.connection)}</div>
		<div>last event sequence: ${state.lastEventSequence}</div>
		<div>projection version: ${escapeHtml(String(state.snapshot ? state.snapshot.projectionVersion : "—"))}</div>
		<div class="dim">Server is loopback-only and bound to this Pi process. It is not a sandbox boundary.</div></div>`;
}

function escapeHtml(text) {
	return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------------------
// Event delegation: buttons and task rows
// ---------------------------------------------------------------------------

$view.addEventListener("click", async (ev) => {
	const target = ev.target;
	if (!(target instanceof HTMLElement)) return;
	if (target.classList.contains("nav")) {
		state.view = target.dataset.view;
		document.querySelectorAll("button.nav").forEach((b) => b.classList.toggle("active", b === target));
		render();
		return;
	}
	if (target.classList.contains("row")) {
		state.selectedTask = target.dataset.task;
		state.view = "tasks";
		render();
		return;
	}
	if (target.classList.contains("action")) {
		const type = target.dataset.type;
		const task = target.dataset.task;
		const rev = Number(target.dataset.rev);
		const payload = {};
		if (type === "task.record_integration") payload.revision = "HEAD";
		if (type === "checks.run") payload.set = "verify";
		const result = await sendCommand(type, task, rev, payload);
		if (result) $status.textContent = result.next || "Accepted";
	}
});

document.addEventListener("keydown", (ev) => {
	if (ev.key >= "1" && ev.key <= "7" && ev.target === document.body) {
		const buttons = [...document.querySelectorAll("button.nav")];
		const b = buttons[Number(ev.key) - 1];
		if (b) { b.focus(); b.click(); }
	}
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
	if (!token()) { setConnection("disconnected"); $view.innerHTML = "<div class='card'>Missing token — open the URL printed by /sym web.</div>"; return; }
	try {
		await fetchSnapshot();
		// also load the current config text for the editor
		const res = await fetch("/api/v1/snapshot", { headers: authHeaders(false) });
		setConnection("live");
		connectEvents();
	} catch (err) {
		setConnection("disconnected");
	}
})();
