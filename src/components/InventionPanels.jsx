import { TECH_GRAPH } from '../utils/constants.js';

// ── Invention Log (Phase 6) ──
// A chronicle of breakthroughs as they happen — what was discovered, by whom,
// and when. Fills in over time; it reflects what's HAPPENED, not what's possible.
// A 📜 means the discoverer died without passing it on and the knowledge is lost.
export function InventionLog({ inventions = [], knownTech = {} }) {
  const recent = [...inventions].reverse();
  return (
    <div className="panel-section invention-log">
      <div className="section-label">💡 Inventions ({recent.length})</div>
      {recent.length === 0 ? (
        <div className="no-selection">Nothing invented yet — the village still does everything by hand.</div>
      ) : (
        recent.map((inv, i) => {
          const lost = !knownTech[inv.techId];
          return (
            <div key={i} className={`invention-entry ${lost ? 'lost' : ''}`}>
              <span className="inv-label">{lost ? '📜' : '💡'} {inv.label}</span>
              <span className="inv-meta"> — {inv.by}, Day {inv.day}{lost ? ' (lost)' : ''}</span>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Village Knowledge (Phase 6) ──
// What the village collectively knows how to do RIGHT NOW, and who keeps each
// secret alive. If only one living soul holds a recipe, it's flagged at-risk —
// surfacing the oral-tradition stakes.
export function VillageKnowledge({ knownTech = {}, people = [], recipeCatalog = {} }) {
  const alive = people.filter(p => p.alive !== false);
  const entries = Object.entries(knownTech);
  return (
    <div className="panel-section village-knowledge">
      <div className="section-label">📚 Village Knowledge ({entries.length})</div>
      {entries.length === 0 ? (
        <div className="no-selection">The village knows no crafts beyond the basics.</div>
      ) : (
        entries.map(([techId, info]) => {
          const tech = recipeCatalog[techId] || TECH_GRAPH[techId];
          const keepers = alive.filter(p => p.knownTech?.[techId]).map(p => p.name);
          return (
            <div key={techId} className="knowledge-entry">
              <span className="know-label">{tech?.label || techId}</span>
              <span className="know-meta"> — {keepers.length ? `known by ${keepers.join(', ')}` : `nobody alive (first: ${info.by})`}</span>
              {keepers.length === 1 && <span className="know-risk"> ⚠ at risk</span>}
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Tech Metrics (Phase 4) ──
// The "is discovery working at the right RATES" view: experiments, success rate,
// what the village has discovered, and what's currently blocking ideas.
export function TechMetrics({ metrics, materialCatalog = {} }) {
  if (!metrics) return null;
  const { attempts = 0, successes = 0, recipesMinted = 0, gatePasses = 0, gateRejects = 0, rejectReasons = {} } = metrics;
  const rate = attempts ? Math.round((successes / attempts) * 100) : 0;
  const derivedMats = Object.values(materialCatalog).filter(m => m.origin === 'derived').length;
  const topReject = Object.entries(rejectReasons).sort((a, b) => b[1] - a[1])[0];
  return (
    <div className="panel-section tech-metrics">
      <div className="section-label">🧪 Discovery</div>
      <div className="metric-row"><span>Experiments</span><span>{attempts}</span></div>
      <div className="metric-row"><span>Success rate</span><span>{rate}%</span></div>
      <div className="metric-row"><span>Recipes invented</span><span>{recipesMinted}</span></div>
      <div className="metric-row"><span>New materials</span><span>{derivedMats}</span></div>
      <div className="metric-row"><span>Ideas gated</span><span>{gatePasses}✓ / {gateRejects}✗</span></div>
      {topReject && <div className="metric-note">Most blocked by: {topReject[0]} ({topReject[1]})</div>}
    </div>
  );
}

// ── Resource Inspector (Phase 6) ──
// Click a tile → shows the discovered resources on/around it. Only reveals what
// the village has actually noticed (nodes with at least one discoverer).
export function ResourceInspector({ tile, resourceNodes = [], onClose }) {
  if (!tile) return null;
  const here = (resourceNodes || []).filter(n =>
    Math.abs(n.x - tile.x) <= 1 && Math.abs(n.y - tile.y) <= 1 &&
    n.discoveredBy && Object.keys(n.discoveredBy).length > 0);
  return (
    <div className="panel-section resource-inspector">
      <div className="section-label">
        🔍 Tile ({tile.x}, {tile.y})
        <span className="close-x" onClick={onClose}>✕</span>
      </div>
      {here.length === 0 ? (
        <div className="no-selection">Nothing notable here — or nothing has been discovered here yet.</div>
      ) : (
        here.map((n, i) => (
          <div key={i} className="resource-entry">
            <span className="res-material">{n.material}</span>
            <span className="res-look"> — {n.look}</span>
          </div>
        ))
      )}
    </div>
  );
}
