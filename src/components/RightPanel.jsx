import { useState } from 'react';
import { SidePanel } from './SidePanel.jsx';
import { InventionLog, VillageKnowledge, ResourceInspector } from './InventionPanels.jsx';
import { GodPowers } from './GodPowers.jsx';

// The whole right column is now a single tabbed panel so each view gets the full
// height instead of fighting for space (which was crushing the villager detail).
//   Villager — the selected person's full stats (list + detail)
//   Village  — collective: inventions, knowledge, clicked-tile resources
//   World    — god powers + village-wide vitals
const TABS = [
  { id: 'villager', label: 'Villager', icon: '🧍' },
  { id: 'village', label: 'Village', icon: '🏘' },
  { id: 'world', label: 'World', icon: '🌍' },
];

export function RightPanel(props) {
  const {
    game, people, selectedPerson, onSelect, onFollow, following,
    inspectedTile, onClearTile,
    onUsePower, activePower, onSelectPower,
  } = props;

  const [tab, setTab] = useState('villager');

  // auto-jump to the relevant tab when context demands it: selecting a villager
  // shows their sheet; clicking a tile shows the village (resource) view.
  const handleSelect = (idx) => { onSelect(idx); if (idx !== null) setTab('villager'); };

  // a person-targeted power is chosen on the World tab, but you pick the target
  // from the villager list — so jump to the Villager tab when one is armed.
  const handleSelectPower = (id) => {
    onSelectPower(id);
    if (id) setTab('villager');
  };

  return (
    <div className="right-panel">
      <div className="tab-bar">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`tab-btn ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="tab-icon">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="tab-body">
        {tab === 'villager' && (
          <SidePanel
            people={people}
            selectedPerson={selectedPerson}
            onSelect={handleSelect}
            onFollow={onFollow}
            following={following}
            activePower={activePower}
          />
        )}

        {tab === 'village' && (
          <div className="village-tab">
            {inspectedTile && (
              <ResourceInspector
                tile={inspectedTile}
                resourceNodes={game.resourceNodes}
                onClose={onClearTile}
              />
            )}
            <InventionLog inventions={game.inventions} knownTech={game.knownTech} />
            <VillageKnowledge knownTech={game.knownTech} people={people} />
            {!inspectedTile && (
              <div className="panel-section">
                <div className="section-label">🔍 Inspect</div>
                <div className="no-selection">Click a tile on the map to see what resources have been discovered there.</div>
              </div>
            )}
          </div>
        )}

        {tab === 'world' && (
          <div className="world-tab">
            <VillageVitals game={game} people={people} />
            <UnderConstruction people={people} />
            <GodPowers
              onUsePower={onUsePower}
              activePower={activePower}
              onSelectPower={handleSelectPower}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// A compact dashboard of village-wide numbers for the World tab.
function VillageVitals({ game, people }) {
  const alive = people.filter(p => p.alive !== false);
  const l = game.larder || {};
  const food = Math.round((l.meat || 0) + (l.fish || 0) + (l.berries || 0) + (l.crops || 0));
  const animals = (game.wildlife || []).filter(w => w.alive).length;
  const partners = alive.filter(p => p.partner).length / 2;
  const children = alive.filter(p => p.lifeStage === 'baby' || p.lifeStage === 'child').length;
  return (
    <div className="panel-section">
      <div className="section-label">🌍 The Village</div>
      <VitalRow label="Population" value={`${alive.length} alive`} />
      <VitalRow label="Day / Season" value={`Day ${game.day} · ${game.season}`} />
      <VitalRow label="Food stores" value={`🍖 ${food}`} critical={food < 10} />
      <VitalRow label="Larder" value={`🥩${l.meat || 0} 🐟${l.fish || 0} 🫐${l.berries || 0} 🌾${l.crops || 0}`} />
      <VitalRow label="Field" value={!game.field?.planted ? 'fallow' : game.field.stage >= 1 ? 'ripe!' : `${Math.round(game.field.stage * 100)}% grown`} />
      <VitalRow label="Wildlife" value={`${animals} animals`} critical={animals < 4} />
      <VitalRow label="Children" value={`${children}`} />
      <VitalRow label="Couples" value={`${Math.floor(partners)}`} />
      <VitalRow label="Buildings" value={`🏠 ${(game.buildings || []).length}`} />
      <VitalRow label="Inventions" value={`${(game.inventions || []).length}`} />
      <VitalRow label="Known crafts" value={`${Object.keys(game.knownTech || {}).length}`} />
      <VitalRow label="Births / Deaths" value={`${game.stats?.totalBirths || 0} / ${game.stats?.totalDeaths || 0}`} />
    </div>
  );
}

// Live list of in-progress build projects so construction is visible without
// selecting the exact builder. Dedupes partner-shared projects by site.
function UnderConstruction({ people }) {
  const seen = new Set();
  const sites = [];
  for (const p of people) {
    const bp = p.buildProject;
    if (!bp || bp.phase === 'complete' || p.alive === false) continue;
    const key = `${bp.site?.x},${bp.site?.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const mn = bp.materialsNeeded || {};
    const target = ((mn.wood || 0) + (mn.stone || 0) + (mn.thatch || 0)) * 1.5 || 1;
    const pct = Math.min(100, Math.round(((bp.progress || 0) / target) * 100));
    sites.push({ key, builder: p.name, type: bp.type || 'structure', phase: bp.phase, pct });
  }
  if (!sites.length) return null;
  return (
    <div className="panel-section">
      <div className="section-label">🏗 Under Construction</div>
      {sites.map(s => (
        <div className="stat-row" key={s.key}>
          <span className="stat-label">{s.builder} · {s.type}</span>
          <span className="stat-value">{s.phase} · {s.pct}%</span>
        </div>
      ))}
    </div>
  );
}

function VitalRow({ label, value, critical }) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${critical ? 'food-critical' : ''}`}>{value}</span>
    </div>
  );
}
