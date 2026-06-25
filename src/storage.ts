// Client-side persistence: saved artifacts (with provenance) + config (git tokens).
export interface Provenance {
  source: 'apis.io' | 'github' | 'gitlab' | 'bitbucket' | 'url' | 'manual';
  url?: string; // where it was found / its source URL
  repo?: string; // owner/repo (or workspace/repo)
  path?: string; // file path in the repo
  ref?: string; // branch/ref
  aid?: string; // APIs.io artifact id
}
export interface SavedArtifact {
  id: string;
  name: string;
  format?: string;
  lang: 'yaml' | 'json';
  content: string;
  provenance: Provenance;
  savedAt: number;
}

const DOCS = 'spotlight-discovery:artifacts';
const CFG = 'spotlight-discovery:config';

export interface Config {
  githubToken?: string;
  gitlabToken?: string;
  bitbucketUser?: string;
  bitbucketToken?: string;
  defaultRepo?: string; // owner/repo for GitHub saves
  defaultBranch?: string;
  sources?: Record<string, boolean>; // search source toggles (apis.io/github/gitlab/bitbucket)
}

const read = <T>(k: string, fallback: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(k) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* disabled / quota */
  }
};

export const loadArtifacts = (): SavedArtifact[] => read<SavedArtifact[]>(DOCS, []);
export const saveArtifacts = (a: SavedArtifact[]) => write(DOCS, a);
export function upsertArtifact(a: SavedArtifact) {
  const all = loadArtifacts();
  const i = all.findIndex((x) => x.id === a.id);
  if (i >= 0) all[i] = a;
  else all.push(a);
  saveArtifacts(all);
}
export const removeArtifact = (id: string) => saveArtifacts(loadArtifacts().filter((a) => a.id !== id));
export const getArtifact = (id: string) => loadArtifacts().find((a) => a.id === id);

export const loadConfig = (): Config => read<Config>(CFG, {});
export const saveConfig = (c: Config) => write(CFG, c);

export const newId = () => globalThis.crypto?.randomUUID?.() ?? 'a' + Math.random().toString(36).slice(2) + Date.now().toString(36);
