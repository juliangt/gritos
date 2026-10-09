# Deployment (static hosting)

The build output is a plain static site: serve `dist/` over **HTTPS** from any file host. Web Crypto and WebRTC require a secure context, so plain HTTP (other than `localhost`) will not work.

The build uses a **relative base** (`base: './'` in `vite.config.ts`): all asset URLs in `dist/index.html` are relative, so the same build works at the root of a domain, on a GitHub Pages project site (`https://<user>.github.io/<repo>/`), under a Netlify subpath, or in any nginx `location` — no per-host reconfiguration needed.

## Service worker / offline shell (issue #104)

`npm run build` also emits `sw.js` with a content-hashed precache of that exact build (a tiny Vite plugin injects the file list and the `gritos-shell-v…` cache version at build time). Served from `./sw.js`, its scope covers subpath deployments; the shell — document, manifest, icons and hashed assets — is answered cache-first, while anything cross-origin (the `wss:` tracker sockets first among them) passes through untouched and is never cached. On a new deploy the updated worker installs and **waits**; on the visitor's next visit a local toast ("New version available") offers "Reload", whose reload activates the new version and deletes the previous caches. There is no `skipWaiting` and no silent swap: an open session keeps running the version it loaded until the user reloads. `npm run dev` stays SW-free (the worker is production-only, mirroring the dev-only CSP strip). Service workers share the HTTPS requirement of the secure context — they simply do not register over plain HTTP. **iOS Safari caveat:** add-to-home-screen works, but iOS has no install prompt and other PWA gaps (occasional service-worker quirks), so treat iOS as best-effort/partial support.

## Hosts

**GitHub Pages**

```bash
npm run build
# publish dist/ (e.g. via Actions with actions/upload-pages-artifact +
# actions/deploy-pages, or push dist/ to a gh-pages branch)
```

**Netlify**

```bash
npm run build
# Build command: npm run build — Publish directory: dist
```

**nginx (or any web server)**

```bash
npm run build
# serve the dist/ directory over TLS, e.g.:
#   root /srv/gritos/dist;
#   index index.html;
```

## Notes

- **HTTPS is mandatory** for Web Crypto/WebRTC on non-localhost origins.
- **Frame-busting is built in (issue #27):** the inline bootstrap script in `index.html` detects when the page runs inside a frame and refuses to boot — it replaces the document with a warning ("For security, this app cannot run inside a frame or iframe. Open it in its own tab to continue.") instead of starting the app. This in-page fallback is what keeps header-less hosts such as GitHub Pages usable, because browsers ignore `frame-ancestors` in a `<meta>` CSP (the only CSP delivery GitHub Pages supports).
- **Recommended host headers** (self-hosters can do better than the in-page fallback — defense in depth):
  - `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`) — forbids embedding at the HTTP layer.
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
- Single-page app with no routes: no rewrite rules are needed beyond serving `index.html` at `/`.
