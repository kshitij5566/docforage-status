# DocForage status

Public uptime monitoring for [docforage.com](https://docforage.com), independent
of DocForage's own infrastructure.

- A GitHub Actions workflow probes the public endpoints every 5 minutes from
  GitHub's network (`check.mjs`).
- The static status page is generated into `docs/` and served by GitHub Pages.
- A service going down opens an issue labeled `incident` (closing it on
  recovery) — watch this repo to get notified.

Source of truth for this directory lives in the main DocForage repo under
`infra/status/`; this repo is the deploy target.
