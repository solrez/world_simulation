import { Application, Container, Graphics, Text, TextStyle } from 'pixi.js';
import { TILE, MAP_W, MAP_H, TERRAIN, LOCATIONS } from '../utils/constants.js';

const T = TILE;
const MW = MAP_W * T, MH = MAP_H * T;

// richer terrain palette with edge blending
const GRASS_COLS = [0x3d6e30, 0x427335, 0x4a7e3c, 0x3a6a2e, 0x4d8240];
const PATH_COLS = [0x8a7a5e, 0x7e7056, 0x92826a];
const WATER_BASE = 0x1e4d7a;
const WATER_LIGHT = 0x2a6090;
const FLOWER_COLS = [0xe85880, 0xeec844, 0xa060d0, 0xe89040, 0x50c8e0, 0xff7090, 0xffaa30];
const DIRT_COLS = [0x6a5a3e, 0x725f42, 0x5e5236];

export class GameRenderer {
  constructor() {
    this.app = null;
    this.world = null;
    this.terrainLayer = new Container();
    this.shadowLayer = new Container();
    this.decorLayer = new Container();
    this.locationLayer = new Container();
    this.characterLayer = new Container();
    this.particleLayer = new Container();
    this.bubbleLayer = new Container();
    this.lightLayer = new Container();
    this.overlayLayer = new Container();
    this.weatherLayer = new Container();
    this.uiLayer = new Container();

    this.viewport = { x: 0, y: 0, zoom: 1.8 };
    this._dragging = false;
    this._dragStart = { x: 0, y: 0 };
    this._vpStart = { x: 0, y: 0 };
    this._terrainBuilt = false;
    this._animFrame = 0;
    this._embers = [];
    this._particles = [];
    this._trails = [];
    this._timeOfDay = 'morning';
  }

  async init(container) {
    this.app = new Application();
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;
    await this.app.init({ width: w, height: h, backgroundColor: 0x1a3a1a, antialias: false, resolution: 1, autoDensity: true, preference: 'webgl' });
    container.appendChild(this.app.canvas);
    new ResizeObserver(() => {
      const nw = container.clientWidth, nh = container.clientHeight;
      if (nw > 0 && nh > 0) this.app.renderer.resize(nw, nh);
    }).observe(container);

    this.world = new Container();
    this.world.addChild(this.terrainLayer, this.shadowLayer, this.decorLayer, this.locationLayer,
      this.characterLayer, this.particleLayer, this.bubbleLayer, this.lightLayer, this.overlayLayer, this.weatherLayer);
    this.app.stage.addChild(this.world, this.uiLayer);
    this._setupInput(container);
    this.viewport.x = -(MW * this.viewport.zoom) / 2 + this.app.screen.width / 2;
    this.viewport.y = -(MH * this.viewport.zoom) / 2 + this.app.screen.height / 2;
    this.app.ticker.add(() => this._tick());
  }

  _setupInput(el) {
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const oz = this.viewport.zoom;
      this.viewport.zoom = Math.max(0.6, Math.min(5, oz * (e.deltaY < 0 ? 1.12 : 0.88)));
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      this.viewport.x = mx - (mx - this.viewport.x) * (this.viewport.zoom / oz);
      this.viewport.y = my - (my - this.viewport.y) * (this.viewport.zoom / oz);
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      this._dragging = true;
      this._dragStart = { x: e.clientX, y: e.clientY };
      this._vpStart = { x: this.viewport.x, y: this.viewport.y };
      el.style.cursor = 'grabbing';
    });
    window.addEventListener('pointermove', (e) => {
      if (!this._dragging) return;
      this.viewport.x = this._vpStart.x + (e.clientX - this._dragStart.x);
      this.viewport.y = this._vpStart.y + (e.clientY - this._dragStart.y);
    });
    window.addEventListener('pointerup', () => { this._dragging = false; });
  }

  _tick() {
    this._animFrame++;
    this.world.x = this.viewport.x;
    this.world.y = this.viewport.y;
    this.world.scale.set(this.viewport.zoom);
    this._updateParticles();
  }

  // ── TERRAIN ──

  buildTerrain(terrain) {
    if (this._terrainBuilt) return;
    this._terrainBuilt = true;
    const g = new Graphics();

    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const tile = terrain[y][x];
        const seed = x * 37 + y * 19;
        const tx = x * T, ty = y * T;

        // base color with subtle variation
        if (tile.type === TERRAIN.GRASS || tile.type === TERRAIN.FLOWERS) {
          g.rect(tx, ty, T, T).fill(GRASS_COLS[seed % GRASS_COLS.length]);
          // grass blade details
          for (let i = 0; i < 5; i++) {
            const bx = tx + ((seed * (i + 1) * 7) % (T - 2)) + 1;
            const by = ty + ((seed * (i + 1) * 11) % (T - 4)) + 2;
            const bh = 2 + (seed * (i + 3)) % 3;
            const bc = i % 2 === 0 ? 0x5a9a48 : 0x3a6a2a;
            g.moveTo(bx, by + bh).lineTo(bx + 0.5, by).stroke({ color: bc, width: 0.7 });
          }
          // flowers
          if (tile.type === TERRAIN.FLOWERS) {
            for (let i = 0; i < 5; i++) {
              const fx = tx + ((seed * (i + 3) * 5) % (T - 6)) + 3;
              const fy = ty + ((seed * (i + 7) * 3) % (T - 6)) + 3;
              const fc = FLOWER_COLS[(seed + i) % FLOWER_COLS.length];
              g.circle(fx, fy, 1.8).fill(fc);
              g.circle(fx, fy, 0.8).fill(0xffffcc); // center
              g.moveTo(fx, fy + 1.8).lineTo(fx, fy + 5).stroke({ color: 0x3a6a2a, width: 0.6 }); // stem
            }
          }
        } else if (tile.type === TERRAIN.PATH) {
          g.rect(tx, ty, T, T).fill(PATH_COLS[seed % PATH_COLS.length]);
          // pebble texture
          for (let i = 0; i < 3; i++) {
            const px2 = tx + ((seed * (i + 2) * 9) % (T - 4)) + 2;
            const py2 = ty + ((seed * (i + 5) * 7) % (T - 4)) + 2;
            g.circle(px2, py2, 1 + (seed * i) % 2).fill({ color: 0x999080, alpha: 0.3 });
          }
        } else if (tile.type === TERRAIN.WATER) {
          g.rect(tx, ty, T, T).fill(WATER_BASE);
          // animated wave hints (static for build, animated in tick)
          const wy = ty + 6 + (seed % 8);
          g.moveTo(tx + 3, wy).quadraticCurveTo(tx + T / 2, wy - 2, tx + T - 3, wy)
            .stroke({ color: WATER_LIGHT, width: 1, alpha: 0.25 });
          // depth gradient at edges
          g.rect(tx, ty, T, 3).fill({ color: 0x183860, alpha: 0.2 });
        } else if (tile.type === TERRAIN.DIRT) {
          g.rect(tx, ty, T, T).fill(DIRT_COLS[seed % DIRT_COLS.length]);
        }

        // subtle grid line
        g.rect(tx, ty, T, 1).fill({ color: 0x000000, alpha: 0.04 });
        g.rect(tx, ty, 1, T).fill({ color: 0x000000, alpha: 0.04 });
      }
    }

    this.terrainLayer.addChild(g);
    this._buildDecorations(terrain);
    this._buildLocations();
  }

  _buildDecorations(terrain) {
    const g = new Graphics();

    // detailed trees around grove
    const treeClusters = [
      [4,3],[5,4],[7,3],[8,5],[5,6],[7,6],[4,5],[8,4],[3,4],[9,5],[6,3],[6,7],
    ];
    for (const [tx, ty] of treeClusters) {
      this._drawTree(g, tx * T + T / 2, ty * T + T / 2, 'large');
    }

    // scattered trees with variety
    const scattered = [[22,5],[26,10],[2,12],[10,19],[28,3],[1,8],[15,18],[25,19],[12,2],[27,7],[16,3],[3,18],[20,17],[11,7],[18,15]];
    for (const [tx, ty] of scattered) {
      if (tx >= MAP_W || ty >= MAP_H) continue;
      this._drawTree(g, tx * T + T / 2, ty * T + T / 2, tx % 3 === 0 ? 'pine' : 'small');
    }

    // rocks near rock seat — mossy boulders
    this._drawRock(g, 17 * T + 10, 4 * T + 8, 6);
    this._drawRock(g, 18 * T + 14, 4 * T + 12, 5);
    this._drawRock(g, 19 * T + 4, 4 * T + 4, 3.5);

    // pond reeds and lilypads
    for (let i = 0; i < 8; i++) {
      const rx = 23 * T + i * 4 + 2, ry = 14 * T + (i % 3) * 4;
      g.moveTo(rx, ry + 10).quadraticCurveTo(rx + 1, ry + 3, rx - 0.5, ry).stroke({ color: 0x4a7a3a, width: 1.2 });
      g.circle(rx, ry - 1, 2).fill(0x5a8a4a);
    }
    // lilypads on water
    const pondX = 24 * T, pondY = 15 * T;
    for (let i = 0; i < 4; i++) {
      const lx = pondX + (i * 7) - 5, ly = pondY + (i % 2) * 8 + 4;
      g.circle(lx, ly, 3).fill({ color: 0x3a7a3a, alpha: 0.7 });
      g.circle(lx + 0.5, ly - 0.5, 1).fill({ color: 0xff6688, alpha: 0.6 });
    }

    // bushes scattered
    const bushes = [[5,10],[10,14],[20,12],[25,6],[3,7],[14,17],[8,3]];
    for (const [bx, by] of bushes) {
      const px = bx * T + T / 2, py = by * T + T / 2;
      g.circle(px, py, 4).fill(0x2a6a28);
      g.circle(px + 2, py - 1, 3).fill(0x3a7a34);
      g.circle(px - 2, py + 1, 3.5).fill(0x2a5a24);
      // berries
      if (bx % 2 === 0) {
        g.circle(px + 1, py - 2, 1).fill(0xcc3344);
        g.circle(px - 2, py, 1).fill(0xcc3344);
      }
    }

    this.decorLayer.addChild(g);
  }

  _drawTree(g, px, py, type) {
    // shadow
    g.ellipse(px + 2, py + 10, 7, 3).fill({ color: 0x000000, alpha: 0.12 });

    if (type === 'pine') {
      // pine tree
      g.rect(px - 1.5, py + 2, 3, 8).fill(0x4a3020);
      g.moveTo(px - 6, py + 4).lineTo(px, py - 8).lineTo(px + 6, py + 4).fill(0x1a5a1e);
      g.moveTo(px - 5, py).lineTo(px, py - 12).lineTo(px + 5, py).fill(0x1e6a22);
      g.moveTo(px - 3, py - 4).lineTo(px, py - 15).lineTo(px + 3, py - 4).fill(0x228a28);
    } else {
      // trunk
      const tw = type === 'large' ? 3 : 2;
      const th = type === 'large' ? 10 : 7;
      g.rect(px - tw / 2, py, tw, th).fill(0x5a4030);
      g.rect(px - tw / 2 + 0.5, py + 2, 1, th - 2).fill({ color: 0x3a2a18, alpha: 0.3 }); // bark detail

      // canopy layers
      const cr = type === 'large' ? 8 : 5;
      g.circle(px, py - 4, cr).fill(0x2a6a2a);
      g.circle(px - cr * 0.5, py - 2, cr * 0.8).fill(0x256624);
      g.circle(px + cr * 0.5, py - 2, cr * 0.7).fill(0x2e7230);
      g.circle(px, py - cr * 0.6, cr * 0.6).fill(0x348a36); // highlight
    }
  }

  _drawRock(g, px, py, r) {
    g.ellipse(px + 1, py + r * 0.4, r, r * 0.3).fill({ color: 0x000000, alpha: 0.1 }); // shadow
    g.circle(px, py, r).fill(0x6a6a6a);
    g.circle(px - r * 0.2, py - r * 0.2, r * 0.85).fill(0x747474); // highlight
    g.circle(px + r * 0.15, py - r * 0.3, r * 0.3).fill({ color: 0x4a7a4a, alpha: 0.4 }); // moss
  }

  _buildLocations() {
    const g = new Graphics();

    // campfire — stone ring with char marks
    const cf = LOCATIONS.CAMPFIRE;
    const cfx = cf.x * T + T / 2, cfy = cf.y * T + T / 2;
    g.circle(cfx, cfy, 10).fill(0x2a2018); // charred ground
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const r = 9;
      const sx = cfx + Math.cos(a) * r, sy = cfy + Math.sin(a) * r;
      g.circle(sx, sy, 2.5).fill(i % 2 ? 0x6a6a6a : 0x5a5a5a);
      g.circle(sx, sy, 1.5).fill(0x7a7a78); // highlight
    }
    // sitting logs with bark detail
    g.roundRect(cfx - 18, cfy + 10, 16, 5, 2).fill(0x5a4030);
    g.roundRect(cfx - 18, cfy + 10, 16, 2, 1).fill(0x6a5040); // bark highlight
    g.roundRect(cfx + 4, cfy + 12, 16, 5, 2).fill(0x4a3828);
    g.roundRect(cfx - 20, cfy - 8, 5, 14, 2).fill(0x5a4030);

    // well — detailed stone well
    const w = LOCATIONS.WELL;
    const wx = w.x * T + T / 2, wy = w.y * T + T / 2;
    g.circle(wx, wy, 9).fill(0x5a5a5a); // outer wall
    g.circle(wx, wy, 7).fill(0x6a6a6a);
    g.circle(wx, wy, 5).fill(0x1e4060); // water inside
    g.circle(wx - 1, wy - 1, 2).fill({ color: 0x4080b0, alpha: 0.4 }); // water glint
    // crossbeam
    g.rect(wx - 1, wy - 14, 2, 12).fill(0x5a4030);
    g.rect(wx - 7, wy - 15, 14, 2.5).fill(0x5a4030);
    // bucket
    g.rect(wx + 3, wy - 10, 3, 4).fill(0x6a5a40);

    // berry bush marker
    const bb = LOCATIONS.BERRY_BUSH;
    const bbx = bb.x * T + T / 2, bby = bb.y * T + T / 2;
    g.circle(bbx, bby, 6).fill(0x2a6a28);
    g.circle(bbx - 2, bby + 2, 5).fill(0x347a30);
    g.circle(bbx + 3, bby, 5).fill(0x2a5a24);
    for (let i = 0; i < 6; i++) {
      const bax = bbx + Math.cos(i * 1.1) * 4, bay = bby + Math.sin(i * 1.4) * 3;
      g.circle(bax, bay, 1.2).fill(0xcc2244);
    }

    // fishing spot — dock
    const fs = LOCATIONS.FISHING_SPOT;
    const fsx = fs.x * T + T / 2, fsy = fs.y * T + T / 2;
    g.rect(fsx - 2, fsy - 8, 4, 16).fill(0x6a5a40); // dock plank
    g.rect(fsx - 5, fsy - 8, 10, 3).fill(0x7a6a50); // dock end
    g.rect(fsx - 4, fsy + 6, 8, 2).fill(0x6a5a40);

    // meadow flowers — dense cluster
    const mf = LOCATIONS.MEADOW;
    for (let i = 0; i < 30; i++) {
      const fx = mf.x * T + Math.sin(i * 2.3) * 35;
      const fy = mf.y * T + Math.cos(i * 1.7) * 25;
      const fc = FLOWER_COLS[i % FLOWER_COLS.length];
      const size = 1.5 + (i % 3) * 0.5;
      g.circle(fx, fy, size).fill(fc);
      g.circle(fx, fy, size * 0.4).fill(0xffffcc);
      g.moveTo(fx, fy + size).lineTo(fx + (i % 2 ? -1 : 1) * 0.5, fy + size + 4)
        .stroke({ color: 0x3a7a3a, width: 0.6 });
    }

    this.locationLayer.addChild(g);

    // location labels — nicer styling
    for (const [, loc] of Object.entries(LOCATIONS)) {
      const label = new Text({
        text: loc.name,
        style: new TextStyle({ fontSize: 7, fill: 0xa0b090, fontFamily: 'monospace', fontWeight: 'bold', stroke: { color: 0x000000, width: 2 } }),
      });
      label.anchor.set(0.5, 0);
      label.x = loc.x * T + T / 2;
      label.y = loc.y * T - 12;
      this.locationLayer.addChild(label);
    }
  }

  // ── BUILDINGS ──

  updateBuildings(buildings, people) {
    if (this._buildingGfx) this.decorLayer.removeChild(this._buildingGfx);
    const g = new Graphics();

    // draw completed buildings
    if (buildings?.length) {
      for (const b of buildings) {
        const bx = b.x * T + T / 2, by = b.y * T + T / 2;
        const quality = b.quality || 'basic';
        const scale = quality === 'crude' ? 0.7 : quality === 'excellent' ? 1.2 : quality === 'good' ? 1.1 : 1;

        g.ellipse(bx + 2, by + 12 * scale, 14 * scale, 5 * scale).fill({ color: 0x000000, alpha: 0.12 });
        // foundation
        g.roundRect(bx - 12 * scale, by - 2, 24 * scale, 16 * scale, 2).fill(quality === 'crude' ? 0x4a4030 : 0x5a5040);
        // walls — stone for good/excellent, wood for others
        const wallColor = (quality === 'good' || quality === 'excellent') ? 0x7a7a70 : 0x8B7355;
        g.roundRect(bx - 11 * scale, by - 6 * scale, 22 * scale, 16 * scale, 1).fill(wallColor);
        g.roundRect(bx - 10 * scale, by - 5 * scale, 20 * scale, 14 * scale, 1).fill(wallColor + 0x101010);
        // roof
        g.moveTo(bx - 14 * scale, by - 6 * scale).lineTo(bx, by - 18 * scale).lineTo(bx + 14 * scale, by - 6 * scale).fill(0xA0522D);
        g.moveTo(bx - 13 * scale, by - 6 * scale).lineTo(bx, by - 16 * scale).lineTo(bx + 13 * scale, by - 6 * scale).fill(0xB06030);
        // door
        g.roundRect(bx - 3, by + 1, 6, 9 * scale, 1).fill(0x4a3020);
        g.circle(bx + 2, by + 5, 0.8).fill(0xc0a060);
        // window
        g.rect(bx + 5 * scale, by - 1, 5, 5).fill(0x3060a0);
        g.rect(bx + 5 * scale, by + 1.5, 5, 0.5).fill(0x5a4030);
        g.rect(bx + 7.5 * scale, by - 1, 0.5, 5).fill(0x5a4030);
        // chimney for decent+
        if (quality !== 'crude') {
          g.rect(bx + 6, by - 18 * scale, 4, 8).fill(0x6a5a5a);
          if (this._timeOfDay === 'night' || this._timeOfDay === 'evening') {
            for (let i = 0; i < 3; i++) {
              const sy = by - 20 * scale - i * 4 + Math.sin(this._animFrame * 0.03 + i) * 2;
              g.circle(bx + 8 + Math.sin(this._animFrame * 0.02 + i * 2) * 2, sy, 2 - i * 0.4)
                .fill({ color: 0x888888, alpha: 0.2 - i * 0.05 });
            }
          }
        }
        // type label
        if (b.type) {
          const label = new Text({ text: b.type, style: new TextStyle({ fontSize: 5, fill: 0x90a080, fontFamily: 'monospace', stroke: { color: 0x000000, width: 1 } }) });
          label.anchor.set(0.5, 0); label.x = bx; label.y = by + 14 * scale;
          g.addChild(label);
        }
      }
    }

    // draw active construction sites
    if (people) {
      const seen = new Set();
      for (const p of people) {
        if (!p.buildProject || p.buildProject.phase === 'complete' || p.alive === false) continue;
        const bp = p.buildProject;
        const key = `${bp.site.x},${bp.site.y}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const bx = bp.site.x * T + T / 2, by = bp.site.y * T + T / 2;

        if (bp.phase === 'planning') {
          // stakes in the ground marking the site
          for (let i = 0; i < 4; i++) {
            const sx = bx + [-10, 10, -10, 10][i], sy = by + [-8, -8, 8, 8][i];
            g.rect(sx - 0.5, sy - 4, 1, 8).fill(0x8a7050);
          }
          // rope between stakes
          g.moveTo(bx - 10, by - 8).lineTo(bx + 10, by - 8).stroke({ color: 0x8a7050, width: 0.5, alpha: 0.5 });
          g.moveTo(bx + 10, by - 8).lineTo(bx + 10, by + 8).stroke({ color: 0x8a7050, width: 0.5, alpha: 0.5 });
          g.moveTo(bx + 10, by + 8).lineTo(bx - 10, by + 8).stroke({ color: 0x8a7050, width: 0.5, alpha: 0.5 });
          g.moveTo(bx - 10, by + 8).lineTo(bx - 10, by - 8).stroke({ color: 0x8a7050, width: 0.5, alpha: 0.5 });
        } else if (bp.phase === 'foundation') {
          // stone/log foundation
          g.roundRect(bx - 12, by + 4, 24, 6, 1).fill(0x5a5a50);
          g.roundRect(bx - 10, by + 2, 20, 4, 1).fill(0x6a6a58);
          // stacked logs nearby
          for (let i = 0; i < 3; i++) {
            g.roundRect(bx + 14, by - 2 + i * 3, 8, 2.5, 1).fill(0x6a5030);
          }
        } else if (bp.phase === 'walls') {
          // partial walls going up
          g.roundRect(bx - 12, by + 2, 24, 8, 1).fill(0x5a5040); // foundation
          g.roundRect(bx - 11, by - 4, 3, 10, 1).fill(0x8B7355); // left wall
          g.roundRect(bx + 8, by - 4, 3, 10, 1).fill(0x8B7355); // right wall
          g.roundRect(bx - 11, by - 4, 22, 3, 1).fill(0x8B7355); // back wall
          // scaffolding
          g.rect(bx - 14, by - 6, 1, 16).fill(0x7a6a50);
          g.rect(bx + 13, by - 6, 1, 16).fill(0x7a6a50);
          g.rect(bx - 14, by - 2, 28, 1).fill(0x7a6a50);
        } else if (bp.phase === 'roof') {
          // walls complete, roof going on
          g.roundRect(bx - 12, by - 2, 24, 14, 1).fill(0x5a5040);
          g.roundRect(bx - 11, by - 6, 22, 16, 1).fill(0x8B7355);
          // partial roof
          g.moveTo(bx - 14, by - 6).lineTo(bx - 2, by - 14).lineTo(bx + 2, by - 14).fill(0xA0522D);
          // thatch bundles nearby
          for (let i = 0; i < 2; i++) {
            g.circle(bx - 16 + i * 4, by + 6, 3).fill(0x8a9a50);
          }
        }

        // "Under Construction" label
        const phaseLabel = new Text({
          text: `🏗 ${bp.type || 'building'} (${bp.phase})`,
          style: new TextStyle({ fontSize: 5, fill: 0xc0a060, fontFamily: 'monospace', stroke: { color: 0x000000, width: 1 } }),
        });
        phaseLabel.anchor.set(0.5, 0); phaseLabel.x = bx; phaseLabel.y = by + 14;
        g.addChild(phaseLabel);
      }
    }

    this._buildingGfx = g;
    this.decorLayer.addChild(g);
  }

  // ── CHARACTERS ──

  updateCharacters(people) {
    this.characterLayer.removeChildren();

    for (const person of people) {
      if (person.alive === false) {
        // grave marker
        const gx = person.x * T + T / 2, gy = person.y * T + T / 2;
        const g = new Graphics();
        g.rect(gx - 3, gy - 6, 6, 10).fill(0x5a5a5a);
        g.rect(gx - 5, gy - 4, 10, 2).fill(0x5a5a5a);
        this.characterLayer.addChild(g);
        continue;
      }

      const px = person.x * T + T / 2, py = person.y * T + T / 2;
      const g = new Graphics();
      const isSleeping = person.sleeping;
      const isEating = person.eating;
      const isConversing = !!person.conversationId;
      const isBaby = person.lifeStage === 'baby';
      const isChild = person.lifeStage === 'child';
      const isTeen = person.lifeStage === 'teen';
      const s = isBaby ? 0.45 : isChild ? 0.65 : isTeen ? 0.85 : 1;

      // shadow
      g.ellipse(px, py + 10 * s, 5 * s, 2.5 * s).fill({ color: 0x000000, alpha: 0.18 });

      if (isSleeping) {
        // lying down — curved body
        g.roundRect(px - 9 * s, py + 1, 18 * s, 7 * s, 3).fill(person.color);
        g.circle(px - 7 * s, py - 1, 4.5 * s).fill(0xe0c098);
        // hair on head while lying
        const hc = this._hairColor(person);
        g.circle(px - 7 * s, py - 3 * s, 4 * s).fill(hc);
        // closed eyes
        g.moveTo(px - 9 * s, py - 1).lineTo(px - 6 * s, py - 1).stroke({ color: 0x2a2a2a, width: 0.7 });
        // blanket
        g.roundRect(px - 5 * s, py + 1, 14 * s, 7 * s, 2).fill({ color: person.color, alpha: 0.5 });
      } else {
        const walk = isConversing || isEating ? 0 : Math.sin(this._animFrame * 0.1 + person.id * 2.5) * 2.5;
        const bob = Math.abs(walk) * 0.3;

        // feet/shoes
        const shoeColor = 0x4a3828;
        g.roundRect(px - 3.5 * s, py + 6 * s + walk * 0.2, 3 * s, 3 * s, 1).fill(shoeColor);
        g.roundRect(px + 0.5 * s, py + 6 * s - walk * 0.2, 3 * s, 3 * s, 1).fill(shoeColor);

        // legs
        g.rect(px - 3 * s, py + 2 * s, 2.5 * s, (5 + walk * 0.2) * s).fill(0x4a4a5a);
        g.rect(px + 0.5 * s, py + 2 * s, 2.5 * s, (5 - walk * 0.2) * s).fill(0x4a4a5a);

        // body — more detailed torso
        g.roundRect(px - 5.5 * s, py - 5 * s - bob, 11 * s, 11 * s, 3).fill(person.color);
        // clothing detail — belt/collar
        g.rect(px - 5 * s, py + 3 * s - bob, 10 * s, 1.5 * s).fill({ color: 0x000000, alpha: 0.15 });
        g.rect(px - 3 * s, py - 5 * s - bob, 6 * s, 2 * s).fill({ color: 0xffffff, alpha: 0.08 }); // collar

        // arms
        const armSwing = walk * 0.4;
        g.roundRect(px - 7 * s, py - 2 * s - bob + armSwing, 2.5 * s, 7 * s, 1).fill(person.color);
        g.roundRect(px + 4.5 * s, py - 2 * s - bob - armSwing, 2.5 * s, 7 * s, 1).fill(person.color);
        // hands
        g.circle(px - 6 * s, py + 5 * s + armSwing, 1.5 * s).fill(0xe0c098);
        g.circle(px + 6 * s, py + 5 * s - armSwing, 1.5 * s).fill(0xe0c098);

        // pregnant belly
        if (person.pregnant) {
          g.circle(px, py + 1 * s - bob, 4.5 * s).fill({ color: 0xffeedd, alpha: 0.5 });
        }

        // head
        g.circle(px, py - 9 * s - bob, 5.5 * s).fill(0xe0c098);
        // ears
        g.circle(px - 5 * s, py - 9 * s - bob, 1.5 * s).fill(0xd8b888);
        g.circle(px + 5 * s, py - 9 * s - bob, 1.5 * s).fill(0xd8b888);

        // hair
        const hc = this._hairColor(person);
        if (person.gender === 'female') {
          g.circle(px, py - 11 * s - bob, 5.5 * s).fill(hc);
          // long hair sides
          g.roundRect(px - 6 * s, py - 11 * s - bob, 2.5 * s, 8 * s, 1).fill(hc);
          g.roundRect(px + 3.5 * s, py - 11 * s - bob, 2.5 * s, 8 * s, 1).fill(hc);
          // bangs
          g.rect(px - 4 * s, py - 14 * s - bob, 8 * s, 3 * s).fill(hc);
        } else {
          g.rect(px - 5 * s, py - 15 * s - bob, 10 * s, 6 * s).fill(hc);
          g.rect(px - 4.5 * s, py - 14 * s - bob, 9 * s, 4 * s).fill(hc);
        }

        // eyes
        const eyeY = py - 9 * s - bob;
        if (isEating) {
          g.moveTo(px - 3 * s, eyeY).lineTo(px - 1 * s, eyeY).stroke({ color: 0x2a2a2a, width: 0.8 });
          g.moveTo(px + 1 * s, eyeY).lineTo(px + 3 * s, eyeY).stroke({ color: 0x2a2a2a, width: 0.8 });
        } else {
          // eye whites
          g.circle(px - 2.2 * s, eyeY, 1.8 * s).fill(0xffffff);
          g.circle(px + 2.2 * s, eyeY, 1.8 * s).fill(0xffffff);
          // pupils
          g.circle(px - 2 * s, eyeY + 0.3, 1 * s).fill(0x2a2a2a);
          g.circle(px + 2.4 * s, eyeY + 0.3, 1 * s).fill(0x2a2a2a);
          // eye shine
          g.circle(px - 1.5 * s, eyeY - 0.3, 0.4 * s).fill(0xffffff);
          g.circle(px + 2.9 * s, eyeY - 0.3, 0.4 * s).fill(0xffffff);
        }

        // eyebrows (mood-based)
        const browY = eyeY - 2.5 * s;
        if (person.mood === 'annoyed' || person.mood === 'jealous') {
          g.moveTo(px - 4 * s, browY - 1).lineTo(px - 1 * s, browY + 0.5).stroke({ color: 0x3a2a1a, width: 1 });
          g.moveTo(px + 1 * s, browY + 0.5).lineTo(px + 4 * s, browY - 1).stroke({ color: 0x3a2a1a, width: 1 });
        } else if (person.mood === 'sad' || person.mood === 'heartbroken') {
          g.moveTo(px - 4 * s, browY + 0.5).lineTo(px - 1 * s, browY - 0.5).stroke({ color: 0x3a2a1a, width: 0.8 });
          g.moveTo(px + 1 * s, browY - 0.5).lineTo(px + 4 * s, browY + 0.5).stroke({ color: 0x3a2a1a, width: 0.8 });
        }

        // mouth
        this._drawMouth(g, px, py - 6 * s - bob, s, person.mood);
      }

      // partner indicator
      if (person.partner && !isSleeping) {
        const pulse = Math.sin(this._animFrame * 0.06 + person.id) * 0.3 + 0.7;
        g.circle(px + 8 * s, py - 14 * s, 2.5).fill({ color: 0xff4466, alpha: pulse * 0.5 });
      }

      // convo indicator
      if (isConversing && !isSleeping) {
        const pulse = Math.sin(this._animFrame * 0.12) * 0.3 + 0.7;
        g.circle(px, py - 18 * s, 2.5).fill({ color: 0xffdd44, alpha: pulse });
      }

      this.characterLayer.addChild(g);

      // emotes
      if (person.emote && !isSleeping) this._drawEmote(px, py - 20 * s, person.emote);

      // zzz
      if (isSleeping) {
        const bob = Math.sin(this._animFrame * 0.05 + person.id) * 3;
        const sizes = [7, 8, 9];
        for (let zi = 0; zi < 3; zi++) {
          const zz = new Text({
            text: 'Z',
            style: new TextStyle({ fontSize: sizes[zi], fill: 0x8888cc, fontFamily: 'monospace', fontWeight: 'bold', stroke: { color: 0x000000, width: 1 } }),
          });
          zz.anchor.set(0.5);
          zz.x = px + 8 + zi * 5;
          zz.y = py - 6 + bob - zi * 6;
          zz.alpha = 0.8 - zi * 0.15;
          this.characterLayer.addChild(zz);
        }
      }

      // name
      const nameLabel = new Text({
        text: person.name,
        style: new TextStyle({
          fontSize: isBaby ? 5 : isChild ? 6 : 7,
          fill: person.color, fontFamily: 'monospace', fontWeight: 'bold',
          stroke: { color: 0x000000, width: 2 },
        }),
      });
      nameLabel.anchor.set(0.5, 0);
      nameLabel.x = px;
      nameLabel.y = py + (isSleeping ? 10 : 13 * s);
      this.characterLayer.addChild(nameLabel);

      // needs bars
      if (!isSleeping && (person.hunger > 60 || person.tiredness > 70)) {
        const bg = new Graphics();
        const barY = py + 16 * s;
        if (person.hunger > 60) {
          bg.roundRect(px - 9, barY, 18, 3, 1).fill(0x222222);
          bg.roundRect(px - 9, barY, 18 * (1 - person.hunger / 100), 3, 1).fill(0xe08040);
        }
        if (person.tiredness > 70) {
          bg.roundRect(px - 9, barY + 4, 18, 3, 1).fill(0x222222);
          bg.roundRect(px - 9, barY + 4, 18 * (1 - person.tiredness / 100), 3, 1).fill(0x6060c0);
        }
        this.characterLayer.addChild(bg);
      }
    }
  }

  _hairColor(p) {
    if (p.name === 'Elara') return 0x8a4a2a;
    if (p.name === 'Rowan') return 0x2a2820;
    if (p.name === 'Iris') return 0x1a1a1a;
    if (p.name === 'Finn') return 0xc8a050;
    const r = (p.color >> 16) & 0xFF, g = (p.color >> 8) & 0xFF, b = p.color & 0xFF;
    return (Math.floor(r * 0.4) << 16) | (Math.floor(g * 0.35) << 8) | Math.floor(b * 0.3);
  }

  _drawMouth(g, x, y, s, mood) {
    switch (mood) {
      case 'happy': case 'excited': case 'content': case 'loving':
        g.moveTo(x - 2.5 * s, y).quadraticCurveTo(x, y + 2.5 * s, x + 2.5 * s, y).stroke({ color: 0x8a4a3a, width: 0.9 });
        break;
      case 'sad': case 'heartbroken': case 'lonely':
        g.moveTo(x - 2 * s, y + 1.5 * s).quadraticCurveTo(x, y - 0.5 * s, x + 2 * s, y + 1.5 * s).stroke({ color: 0x6a3a2a, width: 0.8 });
        break;
      case 'flirty':
        g.moveTo(x - 2.5 * s, y).quadraticCurveTo(x, y + 2.5 * s, x + 2.5 * s, y).stroke({ color: 0xc04060, width: 1 });
        break;
      case 'annoyed': case 'jealous':
        g.moveTo(x - 2 * s, y + 0.5).lineTo(x + 2 * s, y + 0.5).stroke({ color: 0x6a3a2a, width: 1 });
        break;
      default:
        g.moveTo(x - 1.5 * s, y + 0.5).lineTo(x + 1.5 * s, y + 0.5).stroke({ color: 0x7a4a3a, width: 0.7 });
    }
  }

  _drawEmote(x, y, emote) {
    const g = new Graphics();
    const bob = Math.sin(this._animFrame * 0.12) * 2.5;
    const ey = y + bob;
    switch (emote) {
      case 'heart':
        g.circle(x - 2.5, ey - 2, 3).fill(0xff4466);
        g.circle(x + 2.5, ey - 2, 3).fill(0xff4466);
        g.moveTo(x - 5, ey - 0.5).lineTo(x, ey + 4).lineTo(x + 5, ey - 0.5).fill(0xff4466);
        break;
      case 'anger':
        g.moveTo(x - 4, ey - 4).lineTo(x + 4, ey + 2).stroke({ color: 0xff2222, width: 2 });
        g.moveTo(x + 4, ey - 4).lineTo(x - 4, ey + 2).stroke({ color: 0xff2222, width: 2 });
        break;
      case 'tear':
        g.circle(x, ey, 2.5).fill({ color: 0x4488cc, alpha: 0.8 });
        g.moveTo(x, ey + 2.5).lineTo(x - 1, ey + 5).lineTo(x + 1, ey + 5).fill({ color: 0x4488cc, alpha: 0.5 });
        break;
      case 'sparkle':
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + this._animFrame * 0.06;
          const r = 5 + Math.sin(this._animFrame * 0.1 + i) * 2;
          g.star(x + Math.cos(a) * r, ey + Math.sin(a) * r, 4, 1.5, 0.7).fill(0xffdd44);
        }
        break;
      case 'eat':
        g.circle(x, ey, 3.5).fill(0x88aa44);
        g.circle(x - 1, ey - 1, 1.5).fill(0xaacc66);
        g.circle(x + 1.5, ey + 0.5, 1).fill(0xaacc66);
        break;
      case 'jealous':
        g.circle(x, ey, 4).fill({ color: 0x44aa44, alpha: 0.5 });
        g.moveTo(x - 2, ey).lineTo(x + 2, ey).stroke({ color: 0x227722, width: 1.5 });
        break;
      case 'lonely':
        g.circle(x, ey, 4).fill({ color: 0x6666aa, alpha: 0.35 });
        g.circle(x, ey + 2, 1).fill({ color: 0x4488cc, alpha: 0.5 });
        break;
      case 'fear': case 'sick':
        g.circle(x, ey, 3).fill({ color: 0xaaaa44, alpha: 0.5 });
        g.moveTo(x, ey - 3).lineTo(x, ey + 1).stroke({ color: 0x888822, width: 1.5 });
        g.circle(x, ey + 3, 1).fill(0x888822);
        break;
    }
    this.particleLayer.addChild(g);
  }

  // ── PARTICLES ──

  _updateParticles() {
    // ambient particles based on time
    if (this._animFrame % 8 === 0) {
      if (this._timeOfDay === 'night' || this._timeOfDay === 'evening') {
        // fireflies
        if (this._particles.length < 30) {
          this._particles.push({
            type: 'firefly', x: Math.random() * MW, y: Math.random() * MH,
            vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.3,
            life: 100 + Math.random() * 100, phase: Math.random() * Math.PI * 2,
          });
        }
      } else if (this._timeOfDay === 'morning' || this._timeOfDay === 'midday') {
        // dust motes in sunlight
        if (this._particles.length < 15) {
          this._particles.push({
            type: 'dust', x: Math.random() * MW, y: Math.random() * MH,
            vx: 0.1 + Math.random() * 0.2, vy: -0.05 + Math.random() * 0.1,
            life: 80 + Math.random() * 60,
          });
        }
      }
      // falling leaves
      if (this._particles.length < 40 && Math.random() < 0.3) {
        const treeX = [4,5,7,8,22,26,15,25][Math.floor(Math.random() * 8)];
        const treeY = [3,4,3,5,5,10,18,19][Math.floor(Math.random() * 8)];
        this._particles.push({
          type: 'leaf', x: treeX * T + Math.random() * T, y: treeY * T,
          vx: (Math.random() - 0.5) * 0.3, vy: 0.2 + Math.random() * 0.3,
          life: 80, rot: Math.random() * Math.PI * 2,
        });
      }
    }

    // update & render
    this.particleLayer.removeChildren();
    const g = new Graphics();
    this._particles = this._particles.filter(p => {
      p.x += p.vx; p.y += p.vy; p.life--;
      if (p.life <= 0 || p.y > MH || p.x < 0 || p.x > MW) return false;
      const alpha = Math.min(1, p.life / 30);

      if (p.type === 'firefly') {
        const glow = Math.sin(this._animFrame * 0.1 + p.phase) * 0.5 + 0.5;
        g.circle(p.x, p.y, 1.5).fill({ color: 0xccff44, alpha: glow * alpha * 0.7 });
        g.circle(p.x, p.y, 4).fill({ color: 0xccff44, alpha: glow * alpha * 0.08 });
        p.vx += (Math.random() - 0.5) * 0.1;
        p.vy += (Math.random() - 0.5) * 0.08;
        p.vx *= 0.98; p.vy *= 0.98;
      } else if (p.type === 'dust') {
        g.circle(p.x, p.y, 1).fill({ color: 0xffeecc, alpha: alpha * 0.25 });
      } else if (p.type === 'leaf') {
        p.rot += 0.03;
        p.vx += Math.sin(this._animFrame * 0.02 + p.rot) * 0.02;
        const lx = p.x, ly = p.y;
        g.ellipse(lx, ly, 2, 1).fill({ color: 0x6a8a30, alpha: alpha * 0.6 });
      }
      return true;
    });
    this.particleLayer.addChild(g);
  }

  // ── BUBBLES ──

  updateBubbles(activeConversations, people) {
    this.bubbleLayer.removeChildren();
    if (!activeConversations?.length) return;
    for (const convo of activeConversations) {
      if (!convo.lines.length) continue;
      const lastLine = convo.lines[convo.lines.length - 1];
      const speaker = people.find(p => p.name === lastLine.speaker);
      if (!speaker || speaker.alive === false) continue;
      this._drawBubble(speaker, lastLine.text);
    }
  }

  _drawBubble(speaker, text) {
    const px = speaker.x * T + T / 2, py = speaker.y * T - 25;
    const words = text.split(' ');
    const lines = []; let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).length > 28 && cur) { lines.push(cur); cur = w; } else { cur = cur ? cur + ' ' + w : w; }
    }
    if (cur) lines.push(cur);
    if (lines.length > 3) { lines.length = 3; lines[2] = lines[2].slice(0, -3) + '...'; }

    const lh = 10, padX = 10, padY = 6;
    const tw = Math.max(...lines.map(l => l.length * 4.2));
    const bw = tw + padX * 2, bh = lines.length * lh + padY * 2;
    const g = new Graphics();

    // shadow
    g.roundRect(px - bw / 2 + 2, py - bh - 6, bw, bh, 6).fill({ color: 0x000000, alpha: 0.15 });
    // bubble
    g.roundRect(px - bw / 2, py - bh - 8, bw, bh, 6).fill({ color: 0xfafaf5, alpha: 0.95 }).stroke({ color: speaker.color, width: 1.5 });
    // pointer
    g.moveTo(px - 5, py - 8).lineTo(px, py - 1).lineTo(px + 5, py - 8).fill({ color: 0xfafaf5, alpha: 0.95 });

    this.bubbleLayer.addChild(g);
    for (let i = 0; i < lines.length; i++) {
      const t = new Text({ text: lines[i], style: new TextStyle({ fontSize: 7, fill: 0x1a1a2a, fontFamily: 'monospace' }) });
      t.anchor.set(0.5, 0); t.x = px; t.y = py - bh - 8 + padY + i * lh;
      this.bubbleLayer.addChild(t);
    }
  }

  // ── WILDLIFE ──

  updateWildlife(wildlife) {
    if (this._wildlifeGfx) this.characterLayer.removeChild(this._wildlifeGfx);
    if (!wildlife?.length) return;
    const g = new Graphics();

    for (const animal of wildlife) {
      if (!animal.alive) continue;
      const ax = animal.x * T + T / 2, ay = animal.y * T + T / 2;
      const bob = Math.sin(this._animFrame * 0.06 + animal.id) * 1;

      // shadow
      g.ellipse(ax, ay + 6, 4, 2).fill({ color: 0x000000, alpha: 0.12 });

      switch (animal.type) {
        case 'deer':
          // body
          g.ellipse(ax, ay - 2 + bob, 6, 4).fill(0x8a6a40);
          g.ellipse(ax, ay - 1 + bob, 5, 3.5).fill(0x9a7a50); // belly
          // head
          g.circle(ax + 5, ay - 5 + bob, 3).fill(0x8a6a40);
          g.circle(ax + 6, ay - 6 + bob, 1).fill(0x2a2a2a); // eye
          // antlers
          g.moveTo(ax + 5, ay - 8 + bob).lineTo(ax + 3, ay - 13 + bob).stroke({ color: 0x6a5a30, width: 1 });
          g.moveTo(ax + 5, ay - 8 + bob).lineTo(ax + 8, ay - 12 + bob).stroke({ color: 0x6a5a30, width: 1 });
          // legs
          g.rect(ax - 4, ay + 2, 1.5, 5).fill(0x6a5030);
          g.rect(ax + 2, ay + 2, 1.5, 5).fill(0x6a5030);
          break;
        case 'rabbit':
          g.ellipse(ax, ay - 1 + bob, 3, 2.5).fill(0xa09080);
          g.circle(ax + 2, ay - 3 + bob, 2).fill(0xa09080);
          g.circle(ax + 3, ay - 3.5 + bob, 0.7).fill(0x2a2a2a); // eye
          // ears
          g.ellipse(ax + 1, ay - 6 + bob, 1, 3).fill(0xb0a090);
          g.ellipse(ax + 3, ay - 5.5 + bob, 1, 2.5).fill(0xb0a090);
          // tail
          g.circle(ax - 3, ay + bob, 1.5).fill(0xc0b0a0);
          break;
        case 'wolf':
          g.ellipse(ax, ay - 2 + bob, 6, 4).fill(0x5a5a5a);
          g.circle(ax + 5, ay - 4 + bob, 3).fill(0x5a5a5a);
          g.circle(ax + 6, ay - 5 + bob, 1).fill(0xcc4444); // red eye
          // ears
          g.moveTo(ax + 4, ay - 7 + bob).lineTo(ax + 3, ay - 10 + bob).lineTo(ax + 6, ay - 8 + bob).fill(0x5a5a5a);
          // tail
          g.moveTo(ax - 5, ay - 2 + bob).quadraticCurveTo(ax - 8, ay - 6, ax - 6, ay - 7 + bob).stroke({ color: 0x5a5a5a, width: 2 });
          g.rect(ax - 4, ay + 2, 1.5, 4).fill(0x4a4a4a);
          g.rect(ax + 2, ay + 2, 1.5, 4).fill(0x4a4a4a);
          break;
        case 'boar':
          g.ellipse(ax, ay - 1 + bob, 5, 4).fill(0x6a4a30);
          g.circle(ax + 4, ay - 3 + bob, 2.5).fill(0x6a4a30);
          g.circle(ax + 5, ay - 3.5 + bob, 0.8).fill(0x2a2a2a);
          // tusks
          g.moveTo(ax + 5, ay - 2 + bob).lineTo(ax + 7, ay - 4 + bob).stroke({ color: 0xddddcc, width: 1 });
          g.rect(ax - 3, ay + 2, 2, 3).fill(0x4a3020);
          g.rect(ax + 1, ay + 2, 2, 3).fill(0x4a3020);
          break;
        case 'bird':
          const fly = Math.sin(this._animFrame * 0.15 + animal.id) * 3;
          g.circle(ax, ay - 6 + fly, 2).fill(0x4080c0);
          // wings
          g.moveTo(ax - 4, ay - 6 + fly).quadraticCurveTo(ax - 2, ay - 10 + fly, ax, ay - 6 + fly).fill(0x3070b0);
          g.moveTo(ax + 4, ay - 6 + fly).quadraticCurveTo(ax + 2, ay - 10 + fly, ax, ay - 6 + fly).fill(0x3070b0);
          g.circle(ax + 1.5, ay - 7 + fly, 0.5).fill(0x1a1a1a);
          break;
      }

      // tamed indicator
      if (animal.tamed) {
        g.circle(ax, ay - 12, 2).fill({ color: 0x60c060, alpha: 0.6 });
      }
    }

    this._wildlifeGfx = g;
    this.characterLayer.addChild(g);
  }

  // ── CAMPFIRE ──

  updateCampfire() {
    if (this._fireGfx) this.locationLayer.removeChild(this._fireGfx);
    const cf = LOCATIONS.CAMPFIRE;
    const cx = cf.x * T + T / 2, cy = cf.y * T + T / 2;
    const g = new Graphics();
    const flicker = Math.sin(this._animFrame * 0.15) * 0.2 + 0.8;

    // big glow (especially at night)
    const glowR = this._timeOfDay === 'night' ? 50 : 20;
    g.circle(cx, cy, glowR).fill({ color: 0xff6600, alpha: 0.04 * flicker });
    g.circle(cx, cy, glowR * 0.6).fill({ color: 0xff8800, alpha: 0.08 * flicker });
    g.circle(cx, cy, 8).fill({ color: 0xff4400, alpha: 0.15 * flicker });

    // flames
    for (let i = 0; i < 7; i++) {
      const fy = cy - 2 - Math.abs(Math.sin(this._animFrame * 0.12 + i * 0.9)) * 8;
      const fx = cx + Math.sin(this._animFrame * 0.08 + i * 2.1) * 3;
      const fr = 1.5 + Math.sin(this._animFrame * 0.1 + i) * 1;
      const colors = [0xff2200, 0xff4400, 0xff6600, 0xff8800, 0xffaa00, 0xffcc00, 0xffee66];
      g.circle(fx, fy, fr).fill({ color: colors[i], alpha: 0.8 * flicker });
    }

    // embers
    if (this._animFrame % 6 === 0) {
      this._embers.push({ x: cx + (Math.random() - 0.5) * 6, y: cy, vy: -0.4 - Math.random() * 0.5, vx: (Math.random() - 0.5) * 0.4, life: 35 });
    }
    this._embers = this._embers.filter(e => {
      e.x += e.vx; e.y += e.vy; e.life--;
      if (e.life <= 0) return false;
      const ea = e.life / 35;
      g.circle(e.x, e.y, 0.8 + ea * 0.5).fill({ color: 0xffaa00, alpha: ea * 0.8 });
      return true;
    });
    if (this._embers.length > 40) this._embers.splice(0, this._embers.length - 40);

    this._fireGfx = g;
    this.locationLayer.addChild(g);
  }

  // ── DAY/NIGHT ──

  updateDayNight(timeOfDay) {
    this._timeOfDay = timeOfDay;
    this.overlayLayer.removeChildren();
    const g = new Graphics();
    switch (timeOfDay) {
      case 'night':
        g.rect(0, 0, MW, MH).fill({ color: 0x050818, alpha: 0.55 });
        // campfire warm glow at night
        g.circle(LOCATIONS.CAMPFIRE.x * T + T / 2, LOCATIONS.CAMPFIRE.y * T + T / 2, 90).fill({ color: 0xff8800, alpha: 0.06 });
        break;
      case 'evening':
        g.rect(0, 0, MW, MH).fill({ color: 0x0a0418, alpha: 0.28 });
        g.rect(0, 0, MW, MH).fill({ color: 0xff6030, alpha: 0.04 }); // sunset tint
        break;
      case 'morning':
        g.rect(0, 0, MW, MH).fill({ color: 0xffcc60, alpha: 0.05 });
        break;
      case 'afternoon':
        g.rect(0, 0, MW, MH).fill({ color: 0xff9040, alpha: 0.03 });
        break;
    }
    this.overlayLayer.addChild(g);
  }

  // ── WEATHER ──

  updateWeather(weather) {
    this.weatherLayer.removeChildren();
    if (weather !== 'rainy' && weather !== 'storm') return;
    const g = new Graphics();
    const n = weather === 'storm' ? 80 : 30;
    for (let i = 0; i < n; i++) {
      const rx = Math.random() * MW, ry = Math.random() * MH;
      const len = weather === 'storm' ? 10 : 6;
      const slant = weather === 'storm' ? 4 : 1.5;
      g.moveTo(rx, ry).lineTo(rx + slant, ry + len).stroke({ color: 0x8899bb, width: 1, alpha: 0.2 + Math.random() * 0.3 });
    }
    if (weather === 'storm') g.rect(0, 0, MW, MH).fill({ color: 0x181828, alpha: 0.25 });
    else g.rect(0, 0, MW, MH).fill({ color: 0x284060, alpha: 0.08 });
    this.weatherLayer.addChild(g);
  }

  // ── TRAILS ──

  updateTrails(people) {
    for (const p of people) {
      if (p.alive === false || p.sleeping || !p.targetX) continue;
      this._trails.push({ x: p.x * T + T / 2, y: p.y * T + T / 2, life: 50, color: p.color });
    }
    if (this._trails.length > 250) this._trails.splice(0, this._trails.length - 250);
  }

  drawTrails() {
    if (this._trailGfx) this.terrainLayer.removeChild(this._trailGfx);
    const g = new Graphics();
    this._trails = this._trails.filter(t => {
      t.life--;
      if (t.life <= 0) return false;
      g.circle(t.x, t.y, 0.6).fill({ color: t.color, alpha: (t.life / 50) * 0.12 });
      return true;
    });
    this._trailGfx = g;
    this.terrainLayer.addChild(g);
  }

  // ── CAMERA ──

  followPerson(person) {
    if (!person || !this.app) return;
    const px = person.x * T * this.viewport.zoom;
    const py = person.y * T * this.viewport.zoom;
    // smooth follow
    const tx = this.app.screen.width / 2 - px;
    const ty = this.app.screen.height / 2 - py;
    this.viewport.x += (tx - this.viewport.x) * 0.08;
    this.viewport.y += (ty - this.viewport.y) * 0.08;
  }

  destroy() { this.app?.destroy(true, { children: true }); }
}
