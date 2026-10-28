# Documentation publishing

The site builds from Markdown in `docs/` with navigation, page contents, local search, mobile layouts and source links. GitHub Pages hosts static docs; the storefront/API stay on the application host.

Intended URL: [FreshPick Docs](https://FreshOnTime.github.io/Agentic-FreshPick/).

## Build and preview

```bash
npm ci --ignore-scripts
npm run docs:build
python3 -m http.server 8080 --directory docs-site
```

Open `http://localhost:8080/`. Generated `docs-site/` is ignored by git. The builder checks generated page/asset links, converts Markdown links to HTML and points source references to GitHub. Markdown remains readable in the repository.

No database, customer data, credentials or app environment are used. Search runs in the browser against a static index, without third-party services or analytics.

## Publishing

`.github/workflows/docs-pages.yml` builds documentation changes, checks pull requests and deploys `main` through GitHub Pages actions. Manual `workflow_dispatch` is supported. Deployment uses the `github-pages` environment with `pages: write` and `id-token: write`.

For first-time setup, an administrator opens **Settings → Pages → Build and deployment** and selects **GitHub Actions**, then runs **Documentation Pages**. The normal workflow token cannot enable Pages for the first time. Environment protection rules may also require administrator action. This repository's publishing source was configured to GitHub Actions during this update.

Use the workflow deployment result to verify publication; a local build is not proof of a live site.

## Maintaining guides

Edit the relevant Markdown file and run `npm run docs:build`. Add guides to `docs/README.md` and primary navigation in `scripts/build-docs.mjs`. Presentation assets live in `docs/site/`.

Keep examples free of real credentials/customer data. Distinguish implemented behavior, disabled features and future work. Historical design notes remain accessible from the index and do not describe current deployment verification.
