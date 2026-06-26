# Security

This is an experimental project intended to run locally. The notes below
document known security considerations so they are not mistaken for
oversights. None of these involve secrets committed to the repository — the
repo contains no API keys, and `.env` is gitignored.

## 1. The OpenAI API key is exposed in client builds

`src/engine/ai.js` reads the key via `import.meta.env.VITE_OPENAI_API_KEY`
and calls the OpenAI API directly from the browser. Vite inlines any
`VITE_`-prefixed variable into the client bundle at build time, so the key
is present in plain text in any built/deployed `dist/`. Anyone with access
to a deployed build can extract and reuse the key.

**Impact:** unauthorized use of your OpenAI key if you host a public build.

**Mitigation:** Use a personal key locally only. For any public deployment,
move the OpenAI calls behind a backend proxy (a small server route that
holds the key server-side and forwards requests), so the key never reaches
the browser. Rotate any key that may have shipped in a build.

## 2. Unauthenticated file-write endpoints on the dev server

`vite.config.js` registers `saveDataPlugin`, which adds `/api/save-world`,
`/api/save-conversation`, and `/api/conversations` middleware. These accept
unauthenticated POSTs and write files under `data/`. `/api/save-world`
derives a filename from a timestamp (not user input), but the endpoints
have no auth and could be abused by anything that can reach the dev server.

**Impact:** arbitrary writes under `data/` and disk consumption by any
client able to reach the running dev server.

**Mitigation:** These routes run **only** under `vite dev`
(`configureServer`); they are not part of a production build. Do not expose
your dev server to untrusted networks (Vite binds to localhost by default).

## 3. Unbounded request body buffering

The dev-server endpoints accumulate the full request body in memory before
parsing, with no size limit. A large or slow request could consume memory.

**Impact:** local denial of service on the dev server.

**Mitigation:** Same as above — dev-only. If hardening is desired, add a
request body-size cap to the middleware in `vite.config.js`.

## Reporting

This is a personal/experimental repository. Open an issue for any
security-relevant concern.
