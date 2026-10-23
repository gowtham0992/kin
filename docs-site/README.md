# Kin documentation site

This separate Docusaurus build publishes only the six explicitly allowlisted
pages in `content/` and reviewed assets in `static/`. It does not ingest the
application's historical `docs/` tree or use any family data, credentials,
analytics, paid search or cloud API.

Use Node 22.23.2 from this directory:

```sh
npm ci --ignore-scripts --no-audit --fund=false
npm run build
npm run serve
```

Open http://127.0.0.1:3044/kin/. The default production base is
https://gowtham0992.github.io/kin/. Set the build-time `KIN_DOCS_URL`
(HTTPS origin) and `KIN_DOCS_BASE_URL` (path with trailing slash) deliberately
if a reviewed hosting configuration requires a different location. `build/` is
the static publication artifact; hosting and publication are separate from this
build. All source and generated build output stay inside the existing Kin
repository; no second repository is needed.

GitHub Pages publishes **https://gowtham0992.github.io/kin/** from this
repository's `gh-pages` branch, with `/` (root) as the publishing source. That
branch contains only the reviewed static build, including `.nojekyll`; `main`
retains the source and lockfile. Rebuild and verify the six routes before
replacing a published build. Never deploy the historical `docs/` directory as
the Pages source. GitHub Free requires the repository to remain public for
Pages hosting; changing visibility may take this site offline without
affecting Kin's app.

Only the reviewed static output belongs in the docs deployment. Never include
operator notes, release controls or account credentials.

## Build boundary

The generator is isolated from Kin's application dependencies. Docusaurus
3.10.2 is the current stable version checked for this build, but its dependency
audit is not clean: 45 reported package findings propagate from five underlying
build-tool packages. The static output contains no Node server, worker pool,
development server or source maps. Build only reviewed Markdown/MDX, CSS and
configuration; never expose the development server publicly or treat a static
deployment as proof the generator dependencies are free of vulnerabilities.

The package intentionally omits `type`: Docusaurus's generated registry expects
Webpack's mixed module mode. Setting pure ESM or explicit CommonJS breaks that
registry. Configuration files use the supported CommonJS form without changing
the application repository's ESM setting.
