# World Simulation — village-life

A village life simulation built with React, Vite, and PixiJS. Agents
converse and act over time; the dev server persists conversation logs and
world-state snapshots to `data/` locally.

## Getting started

```bash
npm install
cp .env.example .env   # then add your own OpenAI API key
npm run dev
```

Open the printed local URL (default Vite port) in your browser.

## Configuration

The simulation calls the OpenAI API. Provide a key in `.env`:

```
VITE_OPENAI_API_KEY=sk-...
```

`.env` is gitignored and is never committed.

## Security notes

This is a local/experimental project. Be aware of the following before
deploying it anywhere public — see [SECURITY.md](./SECURITY.md) for details:

- **The API key is client-side.** Vite inlines `VITE_`-prefixed variables
  into the browser bundle at build time, so any deployed build exposes your
  key to end users. Use your own key locally; do **not** host a public build
  with a key you care about. A backend proxy is required to use this safely
  in production.
- **The dev server write endpoints are local-only.** The `/api/save-*`
  routes in `vite.config.js` run only under `vite dev`. Don't expose your
  dev server to untrusted networks.
