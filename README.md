# API Discovery

A **browser-first registry** for API artifacts. Search **APIs.io** and code across
**GitHub / GitLab / Bitbucket**, keep a **provenance** pointer to where you found
each one, **save locally** *and* **commit or open a PR** to git with your own access
token, then **search and edit** your saved artifacts — all in the browser, no backend.

Live at **[discover.apicommons.org](https://discover.apicommons.org)**. Part of the
[API Commons](https://apicommons.org) tools, alongside
[API Reusability](https://reusability.apicommons.org).

## What it does

- **Search multiple sources** — APIs.io (the open API catalog) plus code search on
  GitHub, GitLab, and Bitbucket — and load any result into the editor.
- **Provenance** — every loaded artifact remembers where it came from (catalog entry
  or `repo/path@ref`), with a link back.
- **Save locally** — artifacts autosave to your browser; filter/search and re-edit them.
- **Save to git** — **Commit** or **Open PR** to a GitHub repo using a personal access
  token you store in Config (GitLab/Bitbucket writes are a fast-follow).
- **Edit** with Monaco, YAML ⇄ JSON.
- **Assemble an APIs.json** — roll every saved artifact into a single APIs.json 0.21
  (YAML) index and download it.

> Tokens live **only in your browser** (Config tab) and are sent straight to the
> provider APIs. GitHub is the most CORS-friendly for browser writes; GitLab/Bitbucket
> search/read are best-effort depending on their CORS.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build
```

Deployed to GitHub Pages at [discover.apicommons.org](https://discover.apicommons.org).

---

A project of [API Evangelist](https://apievangelist.com), maintained openly under
[API Commons](https://apicommons.org). Apache-2.0.
