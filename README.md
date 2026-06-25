<p align="center"><a href="https://spotlight-rules.com"><img src="https://raw.githubusercontent.com/api-commons/spotlight-discovery/main/spotlight-rules-logo.png" alt="Spotlight Rules" height="90"></a></p>

# Spotlight Discovery

A **browser-first registry** for API artifacts. Search **APIs.io** and code across
**GitHub / GitLab / Bitbucket**, keep a **provenance** pointer to where you found
each one, **save locally** *and* **commit or open a PR** to git with your own access
token, then **search and edit** your saved artifacts — all in the browser, no backend.

Part of the [Spotlight](https://spotlight-rules.com) governance suite.

## What it does

- **Search multiple sources** — APIs.io (the open API catalog) plus code search on
  GitHub, GitLab, and Bitbucket — and load any result into the editor.
- **Provenance** — every loaded artifact remembers where it came from (catalog entry
  or `repo/path@ref`), with a link back.
- **Save locally** — artifacts autosave to your browser; filter/search and re-edit them.
- **Save to git** — **Commit** or **Open PR** to a GitHub repo using a personal access
  token you store in Config (GitLab/Bitbucket writes are a fast-follow).
- **Edit** with Monaco, YAML ⇄ JSON.

> Tokens live **only in your browser** (Config tab) and are sent straight to the
> provider APIs. GitHub is the most CORS-friendly for browser writes; GitLab/Bitbucket
> search/read are best-effort depending on their CORS.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build
```

Deployed to GitHub Pages. Lint anything you find with
[spotlight-validator](https://validator.spotlight-rules.com) or the
[Spotlight rules catalog](https://spotlight-rules.com/spec/).

---

Part of [Spotlight Rules](https://spotlight-rules.com) — a project of [API Evangelist](https://apievangelist.com), maintained openly under [API Commons](https://apicommons.org). Apache-2.0.
