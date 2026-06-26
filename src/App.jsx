import { useState, useEffect, useRef } from 'react';
import { GameRenderer } from './renderer/GameRenderer.js';
import { createSimulation, simulateTick, findConversationGroup, runConversation, runAIAction, downloadConversationArchive, downloadFullWorldState } from './engine/simulation.js';
import { SidePanel } from './components/SidePanel.jsx';
import { ConversationLog } from './components/ConversationLog.jsx';
import { GodPowers, applyGodPower } from './components/GodPowers.jsx';
import './App.css';

const initialState = createSimulation();

function App() {
  const [game, setGame] = useState(initialState);
  const [selectedPerson, setSelectedPerson] = useState(null);
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  const [activePower, setActivePower] = useState(null);
  const [following, setFollowing] = useState(null);
  const [matchmakeFirst, setMatchmakeFirst] = useState(null);

  const gameRef = useRef(initialState);
  const rendererRef = useRef(null);
  const pixiRef = useRef(null);
  const activeConvoCount = useRef(0);

  useEffect(() => {
    gameRef.current = { ...gameRef.current, speed };
  }, [speed]);

  // pixi init
  useEffect(() => {
    if (!pixiRef.current) return;
    const renderer = new GameRenderer();
    rendererRef.current = renderer;
    let destroyed = false;
    const initRenderer = async () => {
      try {
        await renderer.init(pixiRef.current);
        if (destroyed) return;
        renderer.buildTerrain(gameRef.current.terrain);
        renderer.updateCharacters(gameRef.current.people);
      } catch (e) { console.error('PixiJS init failed:', e); }
    };
    initRenderer();
    return () => { destroyed = true; renderer.destroy(); };
  }, []);

  // simulation tick
  useEffect(() => {
    const interval = setInterval(() => {
      if (paused) return;
      const next = simulateTick(gameRef.current);
      gameRef.current = next;
      setGame({ ...next });

      if (rendererRef.current) {
        rendererRef.current.updateBuildings(next.buildings, next.people);
        rendererRef.current.updateCharacters(next.people);
        rendererRef.current.updateWildlife(next.wildlife);
        rendererRef.current.updateBubbles(next.activeConversations, next.people);
        rendererRef.current.updateCampfire();
        rendererRef.current.updateDayNight(next.timeOfDay, next.hour + next.minute / 60);
        rendererRef.current.updateWeather(next.weather);
        rendererRef.current.updateTrails(next.people);
        rendererRef.current.drawTrails();

        // follow camera
        if (following !== null) {
          const person = next.people[following];
          if (person && person.alive !== false) rendererRef.current.followPerson(person);
        }
      }
    }, 400 / speed);
    return () => clearInterval(interval);
  }, [speed, paused, following]);

  // conversations
  useEffect(() => {
    if (paused) return;
    const tryConvo = async () => {
      if (activeConvoCount.current >= 2) return;
      const group = findConversationGroup(gameRef.current.people);
      if (!group) return;
      activeConvoCount.current++;
      try {
        await runConversation(gameRef, group, () => {
          setGame({ ...gameRef.current });
          if (rendererRef.current) {
            rendererRef.current.updateCharacters(gameRef.current.people);
            rendererRef.current.updateBubbles(gameRef.current.activeConversations, gameRef.current.people);
          }
        });
      } finally { activeConvoCount.current--; }
    };
    const convoInterval = setInterval(tryConvo, 4000 / speed);
    return () => clearInterval(convoInterval);
  }, [speed, paused]);

  // AI actions — the escalation gate flags who is "interesting" (pendingLLM);
  // we spend an LLM call only on them. When nobody is flagged, zero calls.
  useEffect(() => {
    if (paused) return;
    const actionInterval = setInterval(async () => {
      const candidates = gameRef.current.people.filter(p =>
        p.pendingLLM && p.alive !== false && !p.conversationId && !p.sleeping && !p.eating &&
        p.lifeStage !== 'baby'
      );
      if (!candidates.length) return; // nothing interesting — no LLM call this round
      // oldest-flagged first (they've waited longest)
      const person = candidates[0];
      const idx = gameRef.current.people.indexOf(person);
      await runAIAction(gameRef, idx);
      setGame({ ...gameRef.current });
    }, 2000 / speed); // can poll more often now that most rounds no-op
    return () => clearInterval(actionInterval);
  }, [speed, paused]);

  // god power handler
  const handleGodPower = (powerId, targetIdx) => {
    applyGodPower(powerId, targetIdx, gameRef);
    setGame({ ...gameRef.current });
    setActivePower(null);
  };

  // villager click — either apply power or select
  const handleSelectPerson = (idx) => {
    if (activePower === 'matchmake') {
      if (matchmakeFirst === null) {
        setMatchmakeFirst(idx);
      } else if (matchmakeFirst !== idx) {
        applyGodPower('matchmake_pair', { a: matchmakeFirst, b: idx }, gameRef);
        setGame({ ...gameRef.current });
        setActivePower(null);
        setMatchmakeFirst(null);
      }
      return;
    }
    if (activePower) {
      handleGodPower(activePower, idx);
    } else {
      setSelectedPerson(selectedPerson === idx ? null : idx);
    }
  };

  // follow toggle
  const handleFollow = (idx) => {
    if (following === idx) {
      setFollowing(null);
      if (rendererRef.current) rendererRef.current._followTarget = null;
    } else {
      setFollowing(idx);
    }
  };

  const timeStr = `${String(game.hour).padStart(2, '0')}:${String(game.minute).padStart(2, '0')}`;
  const aliveCount = game.people.filter(p => p.alive !== false).length;

  return (
    <div className="app">
      <div className="header">
        <div className="header-left">
          <span className="title">Village Life</span>
          <span className="sep">|</span>
          <span className="header-stat">Day {game.day}</span>
          <span className="sep">·</span>
          <span className="header-stat">{timeStr}</span>
          <span className="sep">·</span>
          <span className="header-era">{game.timeOfDay}</span>
          <span className="sep">·</span>
          <span className={`header-stat ${game.weather !== 'clear' ? 'weather-active' : 'dim'}`}>
            {game.weather === 'storm' ? '⛈ storm' : game.weather === 'rainy' ? '🌧 rain' : game.weather === 'cloudy' ? '☁ cloudy' : '☀ clear'}
          </span>
          <span className="sep">·</span>
          <span className="header-stat dim">{aliveCount} alive</span>
          <span className="sep">·</span>
          <span className="header-stat">{game.season}</span>
          <span className="sep">·</span>
          <span className={`header-stat ${game.villageFood < 10 ? 'food-critical' : ''}`}>🍖 {Math.round(game.villageFood)}</span>
        </div>
        <div className="header-right">
          <button className="hdr-btn export-btn" onClick={() => downloadConversationArchive()} title="Download all conversations as JSON">
            💬
          </button>
          <button className="hdr-btn export-btn" onClick={() => downloadFullWorldState(game)} title="Download full world state as JSON">
            🌍
          </button>
          <button className="hdr-btn" onClick={() => setPaused(!paused)}>
            {paused ? '▶ Play' : '⏸ Pause'}
          </button>
          {[1, 2, 3].map(s => (
            <button key={s} className={`hdr-btn ${speed === s ? 'active' : ''}`} onClick={() => setSpeed(s)}>
              {s}x
            </button>
          ))}
        </div>
      </div>

      <div className="main-area">
        <div className="map-container">
          <div className="pixi-container" ref={pixiRef} />
          {activePower && (
            <div className="god-power-indicator">
              {activePower === 'matchmake'
                ? matchmakeFirst !== null
                  ? `Matchmake: ${game.people[matchmakeFirst]?.name} + ? — click second villager`
                  : 'Matchmake: click first villager'
                : `Using: ${activePower} — click a villager`}
              <span className="cancel-link" onClick={() => { setActivePower(null); setMatchmakeFirst(null); }}> (cancel)</span>
            </div>
          )}
          {following !== null && (
            <div className="follow-indicator">
              Following: {game.people[following]?.name}
              <span className="cancel-link" onClick={() => setFollowing(null)}> (stop)</span>
            </div>
          )}
        </div>

        <div className="right-panel">
          <SidePanel
            people={game.people}
            selectedPerson={selectedPerson}
            onSelect={handleSelectPerson}
            onFollow={handleFollow}
            following={following}
          />
          <GodPowers
            people={game.people}
            onUsePower={handleGodPower}
            activePower={activePower}
            onSelectPower={setActivePower}
          />
        </div>
      </div>

      <ConversationLog
        activeConversations={game.activeConversations}
        pastConversations={game.conversations}
        people={game.people}
        events={game.events}
      />
    </div>
  );
}

export default App;
