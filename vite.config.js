import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

const dataDir = path.resolve(__dirname, 'data');

// plugin that adds API endpoints for saving conversation data to disk
function saveDataPlugin() {
  return {
    name: 'save-data',
    configureServer(server) {
      // POST /api/save-conversation — append one conversation to the log
      server.middlewares.use('/api/save-conversation', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const record = JSON.parse(body);
            const file = path.join(dataDir, 'conversations.jsonl');
            fs.mkdirSync(dataDir, { recursive: true });
            fs.appendFileSync(file, JSON.stringify(record) + '\n');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });

      // POST /api/save-world — save full world state snapshot
      server.middlewares.use('/api/save-world', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const file = path.join(dataDir, `world_state_${ts}.json`);
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(file, JSON.stringify(data, null, 2));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, file }));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });

      // GET /api/conversations — read all saved conversations
      server.middlewares.use('/api/conversations', (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end(); return; }
        try {
          const file = path.join(dataDir, 'conversations.jsonl');
          if (!fs.existsSync(file)) { res.setHeader('Content-Type', 'application/json'); res.end('[]'); return; }
          const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean);
          const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(records));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), saveDataPlugin()],
})
