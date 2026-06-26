import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  loadArtifacts, upsertArtifact, removeArtifact, getArtifact, loadConfig, saveConfig, newId,
  type SavedArtifact, type Provenance, type Config,
} from './storage';
import { commitGitHub, openPrGitHub } from './providers';
import { listAccessibleRepos, loadRepos, addRepo, removeRepo, type Repo } from './repos';
import { ARTIFACTS, artifactById, type ArtifactType } from './artifacts';
import { searchSource, loadHit, enabledSources, type Hit, type SourceId, type Tokens } from './sources';
import './style.css';

self.MonacoEnvironment = { getWorker: (_id, label) => (label === 'json' ? new JsonWorker() : new EditorWorker()) };
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

let lang: 'yaml' | 'json' = 'yaml';
let provenance: Provenance = { source: 'manual' };
let activeId: string | null = null;

const editor = monaco.editor.create($('#editor'), {
  value: '', language: 'yaml', theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false,
});

// ---- editor / provenance ----------------------------------------------------
function setContent(text: string) {
  let out = text;
  try { out = lang === 'json' ? JSON.stringify(parseYaml(text), null, 2) : stringifyYaml(parseYaml(text)); } catch { /* keep raw */ }
  const m = editor.getModel();
  if (m) monaco.editor.setModelLanguage(m, lang === 'json' ? 'json' : 'yaml');
  editor.setValue(out);
}
function showProvenance() {
  const p = provenance;
  const where = p.source === 'apis.io' ? `APIs.io${p.aid ? ` · ${p.aid}` : ''}`
    : p.repo ? `${p.source}: ${p.repo}${p.path ? `/${p.path}` : ''}${p.ref ? ` @ ${p.ref}` : ''}`
    : p.url || p.source;
  $('#provenance').innerHTML = `Source: <strong>${esc(String(where))}</strong>` + (p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">open ↗</a>` : '');
}
$('#lang-yaml').addEventListener('click', () => setLang('yaml'));
$('#lang-json').addEventListener('click', () => setLang('json'));
function setLang(l: 'yaml' | 'json') {
  if (l === lang) return;
  const t = editor.getValue();
  let conv = t; try { conv = l === 'json' ? JSON.stringify(parseYaml(t), null, 2) : stringifyYaml(parseYaml(t)); } catch { /* */ }
  lang = l;
  const m = editor.getModel(); if (m) monaco.editor.setModelLanguage(m, l === 'json' ? 'json' : 'yaml');
  editor.setValue(conv);
  $('#lang-yaml').classList.toggle('active', l === 'yaml');
  $('#lang-json').classList.toggle('active', l === 'json');
}

// ---- artifact type + source selectors ---------------------------------------
const typeSelect = $<HTMLSelectElement>('#artifact-type');
typeSelect.innerHTML = ARTIFACTS.map((a) => `<option value="${a.id}">${a.label}</option>`).join('');
typeSelect.value = 'openapi';
let currentArtifact: ArtifactType = artifactById('openapi');
typeSelect.addEventListener('change', () => { currentArtifact = artifactById(typeSelect.value); });

const sourceSelect = $<HTMLSelectElement>('#source');
let currentSource: SourceId = 'apis.io';
function populateSources() {
  const enabled = enabledSources(loadConfig().sources);
  sourceSelect.innerHTML = enabled.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  if (!enabled.some((s) => s.id === currentSource)) currentSource = 'apis.io';
  sourceSelect.value = currentSource;
}
populateSources();
sourceSelect.addEventListener('change', () => { currentSource = sourceSelect.value as SourceId; });
function gitTokens(): Tokens {
  const c = loadConfig();
  return { github: c.githubToken, gitlab: c.gitlabToken, bitbucketUser: c.bitbucketUser, bitbucket: c.bitbucketToken };
}

// ---- search -----------------------------------------------------------------
const results = $('#results');
const qInput = $<HTMLInputElement>('#q');
const hideResults = () => { results.hidden = true; results.innerHTML = ''; };
const msg = (t: string) => { results.innerHTML = `<div class="hit-msg">${esc(t)}</div>`; results.hidden = false; };
let lastHits: Hit[] = [];

async function runSearch() {
  const q = qInput.value.trim();
  const srcLabel = sourceSelect.options[sourceSelect.selectedIndex]?.textContent || currentSource;
  msg(`Searching ${srcLabel} for ${currentArtifact.label}…`);
  try {
    lastHits = await searchSource(currentSource, currentArtifact, q, gitTokens());
    if (!lastHits.length) { msg(currentArtifact.searchNote || `No ${currentArtifact.label} results on ${srcLabel}.`); return; }
    results.innerHTML = lastHits.map((h, i) => `<div class="hit" data-i="${i}">
      <span class="hit-name">${esc(h.name)}</span>
      <span class="hit-sub">${esc(h.repo || h.type || h.source)}${h.path ? ` · ${esc(h.path)}` : ''}</span>
    </div>`).join('');
    results.hidden = false;
    results.querySelectorAll<HTMLElement>('.hit').forEach((el) => el.addEventListener('click', () => selectHit(lastHits[Number(el.dataset.i)])));
  } catch (e) {
    msg(`${srcLabel} search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
async function selectHit(h: Hit) {
  msg(`Loading ${h.name}…`);
  try {
    const content = await loadHit(h, gitTokens());
    provenance = h.source === 'apis.io'
      ? { source: 'apis.io', url: h.url, aid: h.aid } as Provenance
      : { source: h.source, repo: h.repo, path: h.path, ref: h.ref, url: h.url };
    activeId = null;
    $<HTMLInputElement>('#art-name').value = h.name;
    setContent(content);
    showProvenance();
    hideResults();
  } catch (e) {
    msg(`Could not load: ${e instanceof Error ? e.message : String(e)}`);
  }
}
$('#search').addEventListener('click', runSearch);
qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
document.addEventListener('click', (e) => { if (!results.hidden && !(e.target as HTMLElement).closest('.search-wrap')) hideResults(); });

// ---- save -------------------------------------------------------------------
const status = (t: string, ok = true) => { const el = $('#save-status'); el.textContent = t; el.style.color = ok ? 'var(--muted)' : '#f14c4c'; };

$('#save-local').addEventListener('click', () => {
  const name = ($<HTMLInputElement>('#art-name').value.trim()) || 'Untitled';
  const doc: SavedArtifact = activeId && getArtifact(activeId)
    ? { ...getArtifact(activeId)!, name, content: editor.getValue(), lang, savedAt: Date.now() }
    : { id: newId(), name, content: editor.getValue(), lang, provenance, savedAt: Date.now() };
  activeId = doc.id;
  upsertArtifact(doc);
  renderSaved();
  status('Saved locally ✓');
});

async function gitSave(kind: 'commit' | 'pr') {
  const cfg = loadConfig();
  if (!cfg.githubToken) return status('Add a GitHub token in Config.', false);
  // Prefer the repo selected in the savebar (from the Repos tab), then the
  // Config default, then the loaded artifact's GitHub provenance.
  const repo = $<HTMLSelectElement>('#repo-select').value || cfg.defaultRepo || (provenance.source === 'github' ? provenance.repo : undefined);
  if (!repo || !repo.includes('/') || /^\d+$/.test(repo)) return status('Pick a repo (Repos tab) or set a default repo in Config.', false);
  const defaultPath = provenance.path || `${($<HTMLInputElement>('#art-name').value.trim() || 'artifact').replace(/[^a-z0-9._-]+/gi, '-')}.${lang}`;
  const path = window.prompt('File path in the repo:', defaultPath);
  if (!path) return;
  const branch = loadRepos().find((r) => r.fullName === repo)?.defaultBranch || cfg.defaultBranch || 'main';
  const content = editor.getValue();
  const message = `${kind === 'pr' ? 'Propose' : 'Update'} ${path} via spotlight-discovery`;
  status(kind === 'pr' ? 'Opening PR…' : 'Committing…');
  try {
    const url = kind === 'pr' ? await openPrGitHub(repo, path, content, message, branch, cfg) : await commitGitHub(repo, path, content, message, branch, cfg);
    provenance = { source: 'github', repo, path, ref: branch, url };
    showProvenance();
    const el = $('#save-status'); el.innerHTML = `${kind === 'pr' ? 'PR opened' : 'Committed'} ✓ <a href="${esc(url)}" target="_blank" rel="noopener">open ↗</a>`;
  } catch (e) {
    status(`${kind} failed: ${e instanceof Error ? e.message : String(e)}`, false);
  }
}
$('#commit').addEventListener('click', () => gitSave('commit'));
$('#pr').addEventListener('click', () => gitSave('pr'));

// ---- saved list -------------------------------------------------------------
function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function renderSaved() {
  const filter = $<HTMLInputElement>('#filter').value.trim().toLowerCase();
  let docs = loadArtifacts().sort((a, b) => b.savedAt - a.savedAt);
  if (filter) docs = docs.filter((d) => (d.name + ' ' + (d.provenance.repo || '') + ' ' + (d.provenance.source || '')).toLowerCase().includes(filter));
  $('#saved-count').textContent = String(loadArtifacts().length);
  const list = $('#saved-list');
  list.innerHTML = docs.length
    ? docs.map((d) => `<li class="${d.id === activeId ? 'active' : ''}" data-id="${d.id}">
        <span class="store-name" title="${esc(d.name)}">${esc(d.name)}</span>
        <span class="store-meta">${esc(d.provenance.source)}${d.provenance.repo ? ` · ${esc(d.provenance.repo)}` : ''} · ${timeAgo(d.savedAt)}</span>
        <button class="store-btn" type="button">Load</button>
        <button class="store-del" type="button" title="Remove">&times;</button>
      </li>`).join('')
    : '<li class="store-empty">No saved artifacts yet — load one and Save locally.</li>';
  list.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => {
    const id = li.dataset.id!;
    li.querySelector<HTMLButtonElement>('.store-btn')?.addEventListener('click', () => {
      const d = getArtifact(id); if (!d) return;
      activeId = d.id; lang = d.lang; provenance = d.provenance;
      $('#lang-yaml').classList.toggle('active', lang === 'yaml'); $('#lang-json').classList.toggle('active', lang === 'json');
      $<HTMLInputElement>('#art-name').value = d.name;
      const m = editor.getModel(); if (m) monaco.editor.setModelLanguage(m, lang === 'json' ? 'json' : 'yaml');
      editor.setValue(d.content);
      showProvenance(); renderSaved();
    });
    li.querySelector<HTMLButtonElement>('.store-del')?.addEventListener('click', () => {
      removeArtifact(id); if (id === activeId) activeId = null; renderSaved();
    });
  });
}
$<HTMLInputElement>('#filter').addEventListener('input', renderSaved);

// ---- repos ------------------------------------------------------------------
let accessibleRepos: Repo[] = [];
async function loadAccessibleRepos() {
  const token = loadConfig().githubToken;
  const picker = $<HTMLSelectElement>('#repo-picker');
  if (!token) { picker.innerHTML = '<option value="">Add a GitHub token in Config →</option>'; return; }
  picker.innerHTML = '<option value="">Loading your repos…</option>';
  try {
    accessibleRepos = await listAccessibleRepos(token);
    const saved = new Set(loadRepos().map((r) => r.fullName));
    const avail = accessibleRepos.filter((r) => !saved.has(r.fullName));
    picker.innerHTML = avail.length
      ? avail.map((r) => `<option value="${esc(r.fullName)}">${esc(r.fullName)}${r.private ? ' (private)' : ''}</option>`).join('')
      : '<option value="">All accessible repos already added</option>';
  } catch (e) {
    picker.innerHTML = `<option value="">${esc(e instanceof Error ? e.message : 'Could not load repos')}</option>`;
  }
}
// Fill the savebar repo selector (commit/PR target) from the saved list.
function populateRepoSelect() {
  const sel = $<HTMLSelectElement>('#repo-select');
  const repos = loadRepos();
  const prev = sel.value;
  sel.innerHTML = repos.length
    ? repos.map((r) => `<option value="${esc(r.fullName)}">${esc(r.fullName)}</option>`).join('')
    : '<option value="">— add repos in the Repos tab —</option>';
  if (repos.some((r) => r.fullName === prev)) sel.value = prev;
}
function renderRepos() {
  const repos = loadRepos();
  $('#repos-count').textContent = String(repos.length);
  const list = $('#repos-list');
  list.innerHTML = repos.length
    ? repos.map((r) => `<li data-name="${esc(r.fullName)}">
        <span class="store-name" title="${esc(r.fullName)}">${esc(r.fullName)}</span>
        <span class="store-meta">${r.private ? 'private' : 'public'} · ${esc(r.defaultBranch)}</span>
        <button class="store-del" type="button" title="Remove">&times;</button>
      </li>`).join('')
    : '<li class="store-empty">No repos yet — pick one above and Add.</li>';
  list.querySelectorAll<HTMLLIElement>('li[data-name]').forEach((li) => {
    li.querySelector<HTMLButtonElement>('.store-del')?.addEventListener('click', () => {
      removeRepo(li.dataset.name!); renderRepos(); loadAccessibleRepos();
    });
  });
  populateRepoSelect();
}
$('#repo-add').addEventListener('click', () => {
  const full = $<HTMLSelectElement>('#repo-picker').value;
  if (!full) return;
  addRepo(accessibleRepos.find((x) => x.fullName === full) ?? { fullName: full, defaultBranch: 'main', private: false });
  renderRepos();
  loadAccessibleRepos();
});
$('#repo-refresh').addEventListener('click', loadAccessibleRepos);

// ---- tabs + config ----------------------------------------------------------
function switchTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ($('#tab-saved') as HTMLElement).hidden = name !== 'saved';
  ($('#tab-repos') as HTMLElement).hidden = name !== 'repos';
  ($('#tab-config') as HTMLElement).hidden = name !== 'config';
  if (name === 'repos') { renderRepos(); loadAccessibleRepos(); }
}
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab!)));

const CFG_MAP: Array<[string, keyof Config]> = [
  ['cfg-gh-token', 'githubToken'], ['cfg-gh-repo', 'defaultRepo'], ['cfg-gh-branch', 'defaultBranch'],
  ['cfg-gl-token', 'gitlabToken'], ['cfg-bb-user', 'bitbucketUser'], ['cfg-bb-token', 'bitbucketToken'],
];
(function initConfig() {
  const cfg = loadConfig();
  for (const [id, key] of CFG_MAP) {
    const el = $<HTMLInputElement>('#' + id);
    el.value = (cfg[key] as string) ?? '';
    let t: number | undefined;
    el.addEventListener('input', () => {
      clearTimeout(t);
      t = window.setTimeout(() => { const c = loadConfig(); const v = el.value.trim(); if (v) (c[key] as string) = v; else delete c[key]; saveConfig(c); }, 300);
    });
  }
  // Search-source toggles — persist to cfg.sources and re-populate the source dropdown.
  for (const id of ['github', 'gitlab', 'bitbucket'] as const) {
    const el = $<HTMLInputElement>('#src-' + id);
    el.checked = (cfg.sources?.[id]) ?? (id === 'github');
    el.addEventListener('change', () => {
      const c = loadConfig();
      c.sources = { ...(c.sources || {}), [id]: el.checked };
      saveConfig(c);
      populateSources();
    });
  }
  $<HTMLInputElement>('#cfg-show').addEventListener('change', (e) => {
    const type = (e.target as HTMLInputElement).checked ? 'text' : 'password';
    for (const id of ['cfg-gh-token', 'cfg-gl-token', 'cfg-bb-token']) $<HTMLInputElement>('#' + id).type = type;
  });
})();

// ---- boot -------------------------------------------------------------------
renderSaved();
renderRepos();
showProvenance();
