// Multi-source discovery + git writes, browser-side. GitHub is the most CORS-friendly
// (search, read, commit, PR all work with a PAT); GitLab/Bitbucket are best-effort
// (their CORS varies). APIs.io reuses the validator's client.
import { searchArtifacts, loadArtifactContent } from './apisio';
import type { Config } from './storage';

export interface SearchHit {
  provider: 'apis.io' | 'github' | 'gitlab' | 'bitbucket';
  name: string;
  repo?: string; // owner/repo or workspace/repo or gitlab project id
  path?: string;
  ref?: string;
  url?: string;
  aid?: string; // apis.io
  type?: string; // apis.io artifact type
}

const b64encode = (s: string) => btoa(unescape(encodeURIComponent(s)));
const b64decode = (s: string) => decodeURIComponent(escape(atob(s.replace(/\s/g, ''))));

// ---- APIs.io ----------------------------------------------------------------
export async function searchApisIo(q: string): Promise<SearchHit[]> {
  const hits = await searchArtifacts('openapis', q, 25);
  return hits.map((h) => ({ provider: 'apis.io', name: h.name || h.aid, aid: h.aid, type: h.type, url: h.url }));
}
export const loadApisIo = (h: SearchHit) => loadArtifactContent({ aid: h.aid!, name: h.name, type: h.type || 'OpenAPI', url: h.url! } as any);

// ---- GitHub -----------------------------------------------------------------
const GH = 'https://api.github.com';
const ghHeaders = (token?: string) => ({
  accept: 'application/vnd.github+json',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});
export async function searchGitHub(q: string, cfg: Config): Promise<SearchHit[]> {
  if (!cfg.githubToken) throw new Error('GitHub code search needs a token (Config).');
  const query = q.trim() ? q : '"openapi: 3" extension:yaml';
  const res = await fetch(`${GH}/search/code?per_page=25&q=${encodeURIComponent(query)}`, { headers: ghHeaders(cfg.githubToken) });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.json().catch(() => ({})))?.message || res.statusText}`);
  const data = await res.json();
  return (data.items || []).map((it: any) => ({
    provider: 'github', name: it.name, repo: it.repository?.full_name, path: it.path,
    ref: it.repository?.default_branch, url: it.html_url,
  }));
}
export async function readGitHub(repo: string, path: string, ref: string | undefined, cfg: Config): Promise<{ content: string; sha?: string }> {
  const res = await fetch(`${GH}/repos/${repo}/contents/${path}${ref ? `?ref=${ref}` : ''}`, { headers: ghHeaders(cfg.githubToken) });
  if (!res.ok) throw new Error(`GitHub read ${res.status}`);
  const data = await res.json();
  return { content: b64decode(data.content), sha: data.sha };
}
async function ghGetSha(repo: string, path: string, branch: string, cfg: Config): Promise<string | undefined> {
  const res = await fetch(`${GH}/repos/${repo}/contents/${path}?ref=${branch}`, { headers: ghHeaders(cfg.githubToken) });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return (await res.json()).sha;
}
export async function commitGitHub(repo: string, path: string, content: string, message: string, branch: string, cfg: Config): Promise<string> {
  if (!cfg.githubToken) throw new Error('GitHub PAT required (Config).');
  const sha = await ghGetSha(repo, path, branch, cfg);
  const res = await fetch(`${GH}/repos/${repo}/contents/${path}`, {
    method: 'PUT', headers: { ...ghHeaders(cfg.githubToken), 'content-type': 'application/json' },
    body: JSON.stringify({ message, content: b64encode(content), branch, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) throw new Error(`GitHub commit ${res.status}: ${(await res.json().catch(() => ({})))?.message || ''}`);
  return (await res.json()).content?.html_url || `https://github.com/${repo}/blob/${branch}/${path}`;
}
export async function openPrGitHub(repo: string, path: string, content: string, message: string, base: string, cfg: Config): Promise<string> {
  if (!cfg.githubToken) throw new Error('GitHub PAT required (Config).');
  const head = `spotlight/${path.replace(/[^a-z0-9]+/gi, '-')}-${Date.now().toString(36)}`;
  const refRes = await fetch(`${GH}/repos/${repo}/git/ref/heads/${base}`, { headers: ghHeaders(cfg.githubToken) });
  if (!refRes.ok) throw new Error(`GitHub base ref ${refRes.status}`);
  const baseSha = (await refRes.json()).object.sha;
  const mk = await fetch(`${GH}/repos/${repo}/git/refs`, {
    method: 'POST', headers: { ...ghHeaders(cfg.githubToken), 'content-type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${head}`, sha: baseSha }),
  });
  if (!mk.ok) throw new Error(`GitHub branch ${mk.status}`);
  await commitGitHub(repo, path, content, message, head, cfg);
  const pr = await fetch(`${GH}/repos/${repo}/pulls`, {
    method: 'POST', headers: { ...ghHeaders(cfg.githubToken), 'content-type': 'application/json' },
    body: JSON.stringify({ title: message, head, base, body: 'Opened by spotlight-discovery.' }),
  });
  if (!pr.ok) throw new Error(`GitHub PR ${pr.status}: ${(await pr.json().catch(() => ({})))?.message || ''}`);
  return (await pr.json()).html_url;
}

// ---- GitLab (best-effort) ---------------------------------------------------
const GL = 'https://gitlab.com/api/v4';
export async function searchGitLab(q: string, cfg: Config): Promise<SearchHit[]> {
  if (!cfg.gitlabToken) throw new Error('GitLab search needs a token (Config).');
  const res = await fetch(`${GL}/search?scope=blobs&search=${encodeURIComponent(q || 'openapi')}`, { headers: { authorization: `Bearer ${cfg.gitlabToken}` } });
  if (!res.ok) throw new Error(`GitLab ${res.status}`);
  const data = await res.json();
  return (data || []).map((b: any) => ({ provider: 'gitlab', name: b.basename || b.path, repo: String(b.project_id), path: b.path, ref: b.ref }));
}
export async function readGitLab(projectId: string, path: string, ref: string | undefined, cfg: Config): Promise<{ content: string }> {
  const res = await fetch(`${GL}/projects/${projectId}/repository/files/${encodeURIComponent(path)}?ref=${ref || 'HEAD'}`, { headers: { authorization: `Bearer ${cfg.gitlabToken}` } });
  if (!res.ok) throw new Error(`GitLab read ${res.status}`);
  return { content: b64decode((await res.json()).content) };
}
export async function commitGitLab(projectId: string, path: string, content: string, message: string, branch: string, cfg: Config): Promise<string> {
  const res = await fetch(`${GL}/projects/${projectId}/repository/commits`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.gitlabToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ branch, commit_message: message, actions: [{ action: 'update', file_path: path, content }] }),
  });
  if (!res.ok) {
    // file may not exist -> create
    const c2 = await fetch(`${GL}/projects/${projectId}/repository/commits`, {
      method: 'POST', headers: { authorization: `Bearer ${cfg.gitlabToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ branch, commit_message: message, actions: [{ action: 'create', file_path: path, content }] }),
    });
    if (!c2.ok) throw new Error(`GitLab commit ${c2.status}`);
  }
  return `https://gitlab.com/${projectId}/-/blob/${branch}/${path}`;
}

// ---- Bitbucket (best-effort) ------------------------------------------------
const BB = 'https://api.bitbucket.org/2.0';
const bbAuth = (cfg: Config) => 'Basic ' + btoa(`${cfg.bitbucketUser}:${cfg.bitbucketToken}`);
export async function searchBitbucket(q: string, workspace: string, cfg: Config): Promise<SearchHit[]> {
  if (!cfg.bitbucketToken || !cfg.bitbucketUser) throw new Error('Bitbucket search needs username + app password (Config).');
  const res = await fetch(`${BB}/workspaces/${workspace}/search/code?search_query=${encodeURIComponent(q || 'openapi')}`, { headers: { authorization: bbAuth(cfg) } });
  if (!res.ok) throw new Error(`Bitbucket ${res.status}`);
  const data = await res.json();
  return (data.values || []).map((v: any) => ({ provider: 'bitbucket', name: v.file?.path?.split('/').pop() || 'file', repo: `${workspace}/${v.file?.commit?.repository?.name || ''}`, path: v.file?.path, ref: v.file?.commit?.hash }));
}
export async function readBitbucket(repoFull: string, path: string, ref: string | undefined, cfg: Config): Promise<{ content: string }> {
  const res = await fetch(`${BB}/repositories/${repoFull}/src/${ref || 'HEAD'}/${path}`, { headers: { authorization: bbAuth(cfg) } });
  if (!res.ok) throw new Error(`Bitbucket read ${res.status}`);
  return { content: await res.text() };
}
