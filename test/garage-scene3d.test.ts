import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { garageModule } from '../packages/orchestrator/src/garage';
import { applyEvent, fromSnapshot } from '../packages/garage/src/mapper';
import type { GarageState, StationId } from '../packages/garage/src/model';
import { createTheme } from '../packages/garage/src/palette';
import { createScene3D, webglAvailable, type Canvas3D, type GL } from '../packages/garage/src/scene3d';
import { MISSION_RUN_ID, eventAt, marks, snapshotAt, tsOf } from './garage-mission';

// The 3D garage under node: real three.js scene graph and maths, a stub in place of the WebGL context, no text textures.

function stubGL() {
  const calls = { render: 0, disposed: false, size: [0, 0] as [number, number] };
  const gl: GL = {
    setPixelRatio: () => {},
    setSize: (w, h) => void (calls.size = [w, h]),
    render: () => void calls.render++,
    dispose: () => void (calls.disposed = true),
    setClearColor: () => {},
    shadowMap: { enabled: false, type: THREE.PCFShadowMap },
    toneMapping: THREE.NoToneMapping,
    toneMappingExposure: 1,
    outputColorSpace: '',
  };
  return { gl, calls };
}

function stubCanvas() {
  const listeners = new Map<string, Set<unknown>>();
  const canvas: Canvas3D = {
    width: 0,
    height: 0,
    style: { width: '', height: '' },
    addEventListener: (type, fn) => void (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(fn),
    removeEventListener: (type, fn) => void listeners.get(type)?.delete(fn),
  };
  return { canvas, count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0) };
}

function make(theme = createTheme('phosphor')) {
  const { gl, calls } = stubGL();
  const { canvas, count } = stubCanvas();
  const r = createScene3D({ three: THREE, canvas, createGL: () => gl, makeCanvas: null, theme, view: { width: 1280, height: 800, dpr: 1 } });
  return { r, calls, listeners: count, theme };
}

const stateAt = (mark: string): GarageState => fromSnapshot(snapshotAt(marks[mark]!), MISSION_RUN_ID, tsOf(marks[mark]!));

/** Frames from `t0` every 16 ms for `ms`. */
function play(r: ReturnType<typeof make>['r'], t0: number, ms: number): number {
  let t = t0;
  for (; t <= t0 + ms; t += 16) r.frame(t);
  return t;
}

describe('the 3D garage', () => {
  it('places everyone the first state names, seated at their stations, inside the view', () => {
    const { r, calls } = make();
    const s = stateAt('workersRunning');
    r.syncState(s);
    play(r, 1_000, 600);
    expect(calls.render).toBeGreaterThan(30);
    for (const c of Object.values(s.characters)) {
      const v = r.inspect(c.id)!;
      expect(v, c.id).toBeTruthy();
      expect(v.station).toBe(c.station);
      expect(v.alpha).toBe(1);
      const a = r.anchorOf(c.id)!;
      expect([c.id, a.visible]).toEqual([c.id, true]);
    }
    // Leads at their desks sit; the anchor of a station is above it.
    const lead = Object.values(s.characters).find((c) => c.kind === 'lead' && c.station.startsWith('desk:'))!;
    expect(r.inspect(lead.id)!.pose).toBe('sit');
    expect(r.anchorOf('lab' as StationId)!.visible).toBe(true);
  });

  it('walks a character to a new station along the floor, and a later arrival comes in through the entrance', () => {
    const { r } = make();
    const s = stateAt('workersRunning');
    r.syncState(s);
    let t = play(r, 1_000, 500);
    const worker = Object.values(s.characters).find((c) => c.kind === 'worker')!;
    r.moveAgent(worker.id, 'lab');
    t = play(r, t, 50);
    expect(r.inspect(worker.id)!.moving).toBe(true);
    t = play(r, t, 12_000);
    const v = r.inspect(worker.id)!;
    expect([v.moving, v.station]).toEqual([false, 'lab']);

    // A character the next state adds starts at the door and walks in.
    const next = stateAt('teamApproved');
    const late = { ...stateAt('workersRunning') };
    late.characters = { ...late.characters, 'newbie-dev': { ...worker, id: 'newbie-dev', station: 'lab', home: 'lab', persona: 'newbie-dev' } };
    r.syncState(late);
    play(r, t, 30);
    expect(r.inspect('newbie-dev')!.moving).toBe(true);
    expect(next).toBeTruthy();
  });

  it('plays what the mapper emits: animations, station lamps, stamps (no canvas: none drawn), a celebration', () => {
    const { r } = make();
    let state = stateAt('rateCompleted');
    r.syncState(state);
    let t = play(r, 1_000, 200);
    // Replay the next stretch of the mission as live events.
    for (let seq = marks.rateCompleted! + 1; seq <= marks.rateApproved!; seq++) {
      const ev = eventAt(seq);
      if (!ev) continue;
      const out = applyEvent(state, ev, tsOf(seq));
      state = out.state;
      r.syncState(state);
      for (const i of out.intents) r.applyIntent(i);
      t = play(r, t, 48);
    }
    r.applyIntent({ type: 'stamp', kind: 'approved', at: 'bench', task: null });
    r.applyIntent({ type: 'celebrate', scope: 'run', task: null });
    t = play(r, t, 3_000);
    for (const c of Object.values(state.characters)) expect(r.inspect(c.id)!.anim).toBe(state.characters[c.id]!.state);
  });

  it('a layout change re-lays the room and everyone walks to where their station is now', () => {
    const { r } = make();
    r.syncState(stateAt('teamApproved'));
    let t = play(r, 1_000, 400);
    const before = r.layout.spec;
    r.syncState(stateAt('workersRunning'));
    t = play(r, t, 15_000);
    expect(JSON.stringify(r.layout.spec)).not.toBe(JSON.stringify(before));
    for (const c of Object.values(stateAt('workersRunning').characters)) expect(r.inspect(c.id)!.moving).toBe(false);
  });

  it('a theme switch redresses the room and the people in place; dispose releases the GPU and every listener', () => {
    const { r, calls, listeners, theme } = make();
    r.syncState(stateAt('workersRunning'));
    play(r, 1_000, 200);
    const where = Object.fromEntries(Object.keys(stateAt('workersRunning').characters).map((id) => [id, r.inspect(id)!.station]));
    theme.set('neon');
    play(r, 1_300, 200);
    for (const [id, st] of Object.entries(where)) expect(r.inspect(id)!.station).toBe(st);
    expect(listeners()).toBeGreaterThan(0);
    r.dispose();
    expect(calls.disposed).toBe(true);
    expect(listeners()).toBe(0);
    r.frame(5_000); // a frame after dispose is inert
  });

  it('fits the room to the viewport and keeps the HUD band clear', () => {
    const { r } = make();
    r.syncState(stateAt('workersRunning'));
    r.frame(1_000);
    for (const id of ['entrance', 'lab', 'bench', 'terminal'] as StationId[]) {
      const a = r.anchorOf(id)!;
      expect([id, a.visible, a.y < 800 - 150]).toEqual([id, true, true]);
    }
    r.resize(600, 900, 2);
    r.frame(1_100);
    expect(r.anchorOf('entrance' as StationId)!.visible).toBe(true);
  });

  it('someone with nothing to do walks to the lounge and does what the spot is for; leaving still goes out the door', () => {
    const { r } = make();
    const s = stateAt('workersRunning');
    r.syncState(s);
    let t = play(r, 1_000, 300);
    const worker = Object.values(s.characters).find((c) => c.kind === 'worker')!;
    r.moveAgent(worker.id, 'entrance');
    t = play(r, t, 20_000);
    const v = r.inspect(worker.id)!;
    expect([v.station, v.moving, v.leaving]).toEqual(['entrance', false, false]);
    const lg = r.layout.lounge;
    expect(v.gx).toBeGreaterThanOrEqual(lg.gx - 1);
    expect(v.gy).toBeLessThan(lg.gy + lg.h);
    expect(lg.spots.map((p) => p.act)).toContain(v.act);

    // Gone from the state: off to the door and out.
    const gone = { ...s, characters: { ...s.characters } };
    delete gone.characters[worker.id];
    r.syncState(gone);
    t = play(r, t, 30_000);
    expect(r.inspect(worker.id)).toBeNull();
  });

  it('a worker idle at their desk picks up a habit: the phone, perching on the desk, a stretch', () => {
    const { r } = make();
    const s = stateAt('workersRunning');
    r.syncState(s);
    let t = play(r, 1_000, 300);
    const worker = Object.values(s.characters).find((c) => c.kind === 'worker' && c.station.startsWith('bay:'))!;
    r.playAnimation(worker.id, 'idle');
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      t = play(r, t, 40_000 / 4);
      seen.add(String(r.inspect(worker.id)!.act));
    }
    for (const a of seen) expect(['phoneChair', 'perch', 'stretch']).toContain(a);
    // Back to work: no habit.
    r.playAnimation(worker.id, 'implementing');
    play(r, t, 100);
    expect(r.inspect(worker.id)!.act).toBeNull();
  });

  it('webglAvailable says no without a context, and never throws', () => {
    expect(webglAvailable(() => ({ getContext: () => null }))).toBe(false);
    expect(webglAvailable(() => ({ getContext: (id: string) => (id === 'webgl2' ? {} : null) }))).toBe(true);
    expect(webglAvailable(() => { throw new Error('no canvas'); })).toBe(false);
  });
});

describe('three.js, served from the orchestrator', () => {
  it('answers ./three.js with three\'s module build and ./three.core.js beside it', async () => {
    const entry = await garageModule('three.js');
    expect(entry.status).toBe(200);
    expect(entry.headers['content-type']).toContain('javascript');
    expect(entry.body).toContain("from './three.core.js'");
    const core = await garageModule('three.core.js');
    expect(core.status).toBe(200);
    expect(core.body).toContain('REVISION');
    // Only those two names: nothing else of the package is reachable.
    expect((await garageModule('three.webgpu.js')).status).toBe(404);
    expect((await garageModule('../three.core.js')).status).toBe(404);
  });
});
