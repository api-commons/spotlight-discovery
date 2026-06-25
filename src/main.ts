import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  loadArtifacts, upsertArtifact, removeArtifact, getArtifact, loadConfig, saveConfig, newId,
  type SavedArtifact, type Provenance, type Config,
} from './storage';
import {
  searchApisIo, loadApisIo, searchGitHub, readGitHub, commitGitHub, openPrGitHub,
  searchGitLab, readGitLab, searchBitbucket, readBitbucket, type SearchHit,
} from './providers';
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

// ---- search -----------------------------------------------------------------
const results = $('#results');
const qInput = $<HTMLInputElement>('#q');
const hideResults = () => { results.hidden = true; results.innerHTML = ''; };
const msg = (t: string) => { results.innerHTML = `<div class="hit-msg">${esc(t)}</div>`; results.hidden = false; };
let lastHits: SearchHit[] = [];

async function runSearch() {
  const source = $<HTMLSelectElement>('#source').value;
  const q = qInput.value.trim();
  msg(`Searching ${source}…`);
  try {
    const cfg = loadConfig();
    if (source === 'apis.io') lastHits = await searchApisIo(q);
    else if (source === 'github') lastHits = await searchGitHub(q, cfg);
    else if (source === 'gitlab') lastHits = await searchGitLab(q, cfg);
    else { const ws = (cfg.bitbucketUser || '').trim(); lastHits = await searchBitbucket(q, ws, cfg); }
    if (!lastHits.length) { msg('No results.'); return; }
    results.innerHTML = lastHits.map((h, i) => `<div class="hit" data-i="${i}">
      <span class="hit-name">${esc(h.name)}</span>
      <span class="hit-sub">${esc(h.repo || h.type || h.provider)}${h.path ? ` · ${esc(h.path)}` : ''}</span>
    </div>`).join('');
    results.hidden = false;
    results.querySelectorAll<HTMLElement>('.hit').forEach((el) => el.addEventListener('click', () => selectHit(lastHits[Number(el.dataset.i)])));
  } catch (e) {
    msg(`${source} search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
async function selectHit(h: SearchHit) {
  msg(`Loading ${h.name}…`);
  try {
    const cfg = loadConfig();
    let content = '';
    if (h.provider === 'apis.io') { content = await loadApisIo(h); provenance = { source: 'apis.io', url: h.url, aid: h.aid } as any; }
    else if (h.provider === 'github') { content = (await readGitHub(h.repo!, h.path!, h.ref, cfg)).content; provenance = { source: 'github', repo: h.repo, path: h.path, ref: h.ref, url: h.url }; }
    else if (h.provider === 'gitlab') { content = (await readGitLab(h.repo!, h.path!, h.ref, cfg)).content; provenance = { source: 'gitlab', repo: h.repo, path: h.path, ref: h.ref }; }
    else { content = (await readBitbucket(h.repo!, h.path!, h.ref, cfg)).content; provenance = { source: 'bitbucket', repo: h.repo, path: h.path, ref: h.ref }; }
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
  const repo = cfg.defaultRepo || provenance.repo;
  if (!repo || !repo.includes('/')) return status('Set a GitHub default repo (owner/repo) in Config.', false);
  const defaultPath = provenance.path || `${($<HTMLInputElement>('#art-name').value.trim() || 'artifact').replace(/[^a-z0-9._-]+/gi, '-')}.${lang}`;
  const path = window.prompt('File path in the repo:', defaultPath);
  if (!path) return;
  const branch = cfg.defaultBranch || 'main';
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

// ---- tabs + config ----------------------------------------------------------
function switchTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ($('#tab-saved') as HTMLElement).hidden = name !== 'saved';
  ($('#tab-config') as HTMLElement).hidden = name !== 'config';
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
  $<HTMLInputElement>('#cfg-show').addEventListener('change', (e) => {
    const type = (e.target as HTMLInputElement).checked ? 'text' : 'password';
    for (const id of ['cfg-gh-token', 'cfg-gl-token', 'cfg-bb-token']) $<HTMLInputElement>('#' + id).type = type;
  });
})();

// ---- boot -------------------------------------------------------------------
renderSaved();
showProvenance();
