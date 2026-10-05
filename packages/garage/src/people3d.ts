// The garage's people: small low-poly figures with jointed arms, legs and head, dressed by role and specialty, with hair and
// skin from the same stable parts the 2D sprites use. A rig only holds joints; `pose` moves them from what the character is
// doing, every frame, easing toward the target so nothing snaps.
import type * as THREE from 'three';
import type { AnimationName, CharacterKind } from './model.js';
import { mix, roleColor, type GaragePalette } from './palette.js';
import { characterParts, normalizeCharacter } from './sprites.js';
import { hash01, type Kit } from './kit3d.js';

export interface Rig {
  root: THREE.Group;
  /** Everything above the feet: bobs, leans and jumps without moving the feet's anchor. */
  body: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  eyes: THREE.Mesh[];
  pip: THREE.Mesh;
  pipMat: THREE.MeshBasicMaterial;
  cloud: THREE.Group;
  /** Every material the figure owns: fading in and out sets their opacity. */
  mats: THREE.Material[];
  /** The top of the head, from the feet: where bubbles and the pip sit. */
  height: number;
  seed: number;
}

export interface PoseInput {
  anim: AnimationName;
  seated: boolean;
  walking: boolean;
  hopping: boolean;
  celebrating: boolean;
  /** Walk cycle phase, in strides. */
  stride: number;
  now: number;
  /** 0..1 */
  alpha: number;
}

const HIP_Y = 0.42;
const SHOULDER_Y = 0.83;
const HEAD_Y = 1.08;
const HEAD_R = 0.21;

/** Build a figure for `id`. Its look is stable: the same id always gets the same face, hair and clothes. */
export function makeRig(kit: Kit, pal: GaragePalette, id: string, kind: CharacterKind, specialty: string | null, opts: { chair?: boolean } = {}): Rig {
  const T = kit.T;
  const parts = normalizeCharacter(characterParts(id, kind, specialty));
  const sc = pal.scene;
  const shirt = roleColor(pal, kind === 'council' ? 'council' : kind, specialty);
  const skin = sc.skin[parts.skin % sc.skin.length]!;
  const hair = sc.hair[parts.hairColor % sc.hair.length]!;
  const mats: THREE.Material[] = [];
  const own = (color: string, o: { rough?: number; basic?: boolean } = {}) => {
    const m = kit.ownMat(color, { rough: o.rough ?? 0.75, basic: o.basic });
    mats.push(m);
    return m;
  };
  const mShirt = own(shirt, { rough: 0.8 });
  const mShirtDark = own(mix(shirt, sc.pants, 0.45));
  const mSkin = own(skin, { rough: 0.6 });
  const mHair = own(hair, { rough: 0.9 });
  const mPants = own(sc.pants);
  const mShoe = own(sc.shoe, { rough: 0.6 });
  const mEye = own(sc.shoe, { rough: 0.3 });

  const root = new T.Group();
  const body = new T.Group();
  root.add(body);
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) => {
    const m = new T.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    return m;
  };

  // Legs, pivoting at the hip.
  const leg = (side: number) => {
    const g = new T.Group();
    g.position.set(side * 0.085, HIP_Y, 0);
    g.add(mesh(kit.boxGeo(0.12, 0.36, 0.14), mPants, 0, -0.18, 0));
    g.add(mesh(kit.boxGeo(0.13, 0.07, 0.21), mShoe, 0, -0.39, 0.035));
    body.add(g);
    return g;
  };
  const legL = leg(-1);
  const legR = leg(1);

  // Torso: a rounded block of shirt, a belt line.
  const torso = new T.Group();
  torso.position.set(0, HIP_Y, 0);
  const chest = mesh(kit.capsuleGeo(0.165, 0.17), mShirt, 0, 0.22, 0);
  chest.scale.set(1.08, 1, 0.8);
  torso.add(chest);
  torso.add(mesh(kit.boxGeo(0.33, 0.05, 0.25), mShirtDark, 0, 0.02, 0));
  body.add(torso);

  // Arms, pivoting at the shoulder (children of the torso so they lean with it).
  const arm = (side: number) => {
    const g = new T.Group();
    g.position.set(side * 0.215, SHOULDER_Y - HIP_Y, 0);
    g.add(mesh(kit.capsuleGeo(0.052, 0.2), mShirt, 0, -0.13, 0));
    g.add(mesh(kit.sphereGeo(0.055, 10, 8), mSkin, 0, -0.29, 0));
    torso.add(g);
    return g;
  };
  const armL = arm(-1);
  const armR = arm(1);

  // Head: face, eyes, hair by style, and what the role wears.
  const head = new T.Group();
  head.position.set(0, HEAD_Y - HIP_Y, 0);
  torso.add(head);
  head.add(mesh(kit.sphereGeo(HEAD_R, 20, 16), mSkin));
  const eyes = [-1, 1].map((s) => {
    const e = mesh(kit.sphereGeo(0.028, 8, 6), mEye, s * 0.075, 0.01, HEAD_R - 0.02);
    e.scale.set(1, 1.25, 0.6);
    e.castShadow = false;
    head.add(e);
    return e;
  });
  const cheeks = [-1, 1].map((s) => {
    const c = mesh(kit.sphereGeo(0.03, 8, 6), own(mix(skin, sc.hair[5]!, 0.35)), s * 0.12, -0.06, HEAD_R - 0.035);
    c.scale.set(1, 0.6, 0.4);
    c.castShadow = false;
    return c;
  });
  head.add(...cheeks);
  const cap = (k: number) => {
    const m = mesh(kit.sphereGeo(HEAD_R * k, 20, 12, Math.PI * 0.55), mHair, 0, 0.0, -0.01);
    return m;
  };
  switch (parts.hairStyle) {
    case 'short':
      head.add(cap(1.07));
      break;
    case 'long': {
      head.add(cap(1.08));
      head.add(mesh(kit.boxGeo(0.36, 0.3, 0.12), mHair, 0, -0.12, -0.14));
      break;
    }
    case 'bun':
      head.add(cap(1.07), mesh(kit.sphereGeo(0.09, 12, 10), mHair, 0, 0.2, -0.12));
      break;
    case 'cap': {
      const hat = mesh(kit.sphereGeo(HEAD_R * 1.08, 20, 12, Math.PI * 0.5), mShirtDark, 0, 0.02, 0);
      const brim = mesh(kit.boxGeo(0.3, 0.025, 0.18), mShirtDark, 0, 0.06, 0.24);
      brim.rotation.x = 0.12;
      head.add(hat, brim);
      break;
    }
    default:
      break;
  }
  if (kind === 'council' && opts.chair) {
    // The chair's crown.
    const crown = new T.Group();
    const gold = own(pal.room.alert, { rough: 0.3 });
    crown.add(mesh(kit.cylGeo(0.12, 0.12, 0.06, 12), gold, 0, 0, 0));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      crown.add(mesh(kit.boxGeo(0.035, 0.07, 0.035), gold, Math.sin(a) * 0.11, 0.06, Math.cos(a) * 0.11));
    }
    crown.position.set(0, HEAD_R + 0.02, 0);
    crown.rotation.z = 0.15;
    head.add(crown);
  } else if (kind === 'council') {
    // Glasses: the council reads everything.
    const frame = own(sc.shoe, { rough: 0.4 });
    for (const s of [-1, 1]) {
      const ring = mesh(kit.torusGeo(0.042, 0.009), frame, s * 0.078, 0.012, HEAD_R - 0.005);
      ring.castShadow = false;
      head.add(ring);
    }
  } else if (kind === 'lead') {
    // A headset: band over the top, a mic toward the mouth.
    const band = mesh(kit.torusGeo(HEAD_R + 0.025, 0.014, Math.PI), own(sc.shoe, { rough: 0.5 }), 0, 0.0, 0);
    band.rotation.z = 0;
    band.rotation.y = Math.PI / 2;
    head.add(band);
    for (const s of [-1, 1]) head.add(mesh(kit.cylGeo(0.05, 0.05, 0.04, 12), own(sc.shoe), s * (HEAD_R + 0.02), -0.02, 0).rotateZ(Math.PI / 2));
    const mic = mesh(kit.boxGeo(0.015, 0.015, 0.16), own(sc.shoe), HEAD_R - 0.03, -0.1, 0.1);
    mic.rotation.y = -0.6;
    head.add(mic);
  }

  // The status pip: a gem over the head for what people must notice.
  const pipMat = kit.ownMat(pal.room.alert, { basic: true }) as THREE.MeshBasicMaterial;
  mats.push(pipMat);
  const pip = new T.Mesh(kit.own(new T.OctahedronGeometry(0.08, 0)), pipMat);
  pip.position.set(0, HEAD_Y + HEAD_R + 0.32, 0);
  pip.visible = false;
  root.add(pip);

  // A small rain cloud for a failed character.
  const cloud = new T.Group();
  const cloudMat = own(mix(sc.pants, pal.room.concreteDark, 0.5), { rough: 1 });
  for (const [x, y, r] of [[-0.09, 0, 0.09], [0.04, 0.03, 0.11], [0.14, 0, 0.08]] as const) cloud.add(mesh(kit.sphereGeo(r, 10, 8), cloudMat, x, y, 0));
  const dropMat = own(pal.base.blue, { basic: true });
  for (let i = 0; i < 3; i++) cloud.add(mesh(kit.boxGeo(0.012, 0.05, 0.012), dropMat, -0.08 + i * 0.09, -0.12, 0));
  cloud.position.set(0, HEAD_Y + HEAD_R + 0.38, 0);
  cloud.visible = false;
  root.add(cloud);

  return { root, body, torso, head, armL, armR, legL, legR, eyes, pip, pipMat, cloud, mats, height: HEAD_Y + HEAD_R, seed: hash01(id) * 1000 };
}

const ease = (cur: number, target: number, k: number): number => cur + (target - cur) * k;

/** Move the joints toward what the character is doing at `p.now`; `dt` in ms keeps the easing frame-rate independent. */
export function pose(r: Rig, p: PoseInput, dt: number, pal: GaragePalette): void {
  const k = 1 - Math.pow(0.001, Math.min(dt, 100) / 1000 * 6); // ~6 time constants a second
  const t = p.now + r.seed;
  const s = Math.sin(p.stride * Math.PI * 2);
  let legL = 0;
  let legR = 0;
  let armL = 0;
  let armR = 0;
  let armLz = 0;
  let armRz = 0;
  let headX = 0;
  let headY = 0;
  let lean = 0;
  let lift = 0;
  let seatDrop = 0;

  const typing = p.anim === 'implementing';
  if (p.hopping) {
    armL = -2.6;
    armR = -2.6;
    legL = -0.4;
    legR = 0.3;
  } else if (p.walking) {
    legL = s * 0.65;
    legR = -s * 0.65;
    armL = -s * 0.55;
    armR = s * 0.55;
    lift = Math.abs(Math.sin(p.stride * Math.PI * 2)) * 0.035;
  } else if (p.celebrating || p.anim === 'celebrate') {
    const j = Math.abs(Math.sin(t / 170));
    lift = j * 0.22;
    armL = -2.9 + Math.sin(t / 90) * 0.2;
    armR = -2.9 - Math.sin(t / 90) * 0.2;
    armLz = -0.35;
    armRz = 0.35;
    headX = -0.15;
  } else if (p.seated) {
    seatDrop = 1;
    legL = -1.45;
    legR = -1.45;
    if (typing) {
      armL = -1.15 + Math.sin(t / 70) * 0.09;
      armR = -1.15 - Math.sin(t / 70) * 0.09;
      armLz = 0.18;
      armRz = -0.18;
      headX = 0.12 + Math.sin(t / 900) * 0.04;
    } else if (p.anim === 'thinking') {
      armR = -2.35;
      armRz = -0.55;
      armL = -0.85;
      headX = -0.12;
      headY = Math.sin(t / 1800) * 0.12;
    } else if (p.anim === 'researching') {
      armL = -1.0;
      armR = -1.0;
      headX = 0.18;
      headY = Math.sin(t / 650) * 0.32;
    } else if (p.anim === 'review') {
      armL = -1.05;
      armR = -1.35;
      lean = 0.18;
      headX = 0.22;
    } else if (p.anim === 'failed' || p.anim === 'blocked') {
      armL = -0.5;
      armR = -0.5;
      lean = 0.35;
      headX = 0.5;
    } else if (p.anim === 'awaitingHuman') {
      armL = -0.9;
      armR = -2.9 + Math.sin(t / 120) * 0.25;
      armRz = 0.25;
    } else {
      armL = -0.9;
      armR = -0.9;
      headY = Math.sin(t / 2600) * 0.25;
    }
  } else {
    switch (p.anim) {
      case 'failed':
      case 'blocked':
        lean = 0.3;
        headX = 0.55;
        armL = 0.1;
        armR = 0.1;
        break;
      case 'awaitingHuman':
        armR = -2.9 + Math.sin(t / 120) * 0.3;
        armRz = 0.25;
        break;
      case 'testing':
        armL = -1.2;
        armR = -0.6;
        headX = 0.1;
        headY = Math.sin(t / 1100) * 0.2;
        break;
      case 'thinking':
        armR = -2.3;
        armRz = -0.6;
        headX = -0.15;
        break;
      case 'waiting':
        // A foot taps.
        legR = Math.max(0, Math.sin(t / 160)) * -0.25;
        headY = Math.sin(t / 2100) * 0.3;
        break;
      default:
        headY = Math.sin(t / 2600) * 0.3;
        break;
    }
  }

  r.legL.rotation.x = ease(r.legL.rotation.x, legL, k);
  r.legR.rotation.x = ease(r.legR.rotation.x, legR, k);
  r.armL.rotation.x = ease(r.armL.rotation.x, armL, k);
  r.armR.rotation.x = ease(r.armR.rotation.x, armR, k);
  r.armL.rotation.z = ease(r.armL.rotation.z, armLz, k);
  r.armR.rotation.z = ease(r.armR.rotation.z, armRz, k);
  r.head.rotation.x = ease(r.head.rotation.x, headX, k);
  r.head.rotation.y = ease(r.head.rotation.y, headY, k);
  r.torso.rotation.x = ease(r.torso.rotation.x, lean, k);
  // Seated: the hips drop onto the seat; a breath lifts the chest a little either way.
  const breathe = Math.sin(t / 1100) * 0.012;
  r.body.position.y = ease(r.body.position.y, lift + seatDrop * 0.05, k * 1.5);
  r.torso.scale.y = 1 + breathe;

  // Blink: a quick squash every few seconds, at a time of the figure's own.
  const blink = (t % 4200) < 110;
  for (const e of r.eyes) e.scale.y = blink ? 0.15 : 1.25;

  // The pip: red failed, orange blocked, yellow waiting on a person (blinking), violet in review.
  const b = pal.base;
  const color = p.anim === 'failed' ? b.red : p.anim === 'blocked' ? b.orange : p.anim === 'awaitingHuman' ? b.yellow : p.anim === 'review' ? b.violet : null;
  r.pip.visible = !!color && (p.anim !== 'awaitingHuman' || Math.floor(p.now / 450) % 2 === 0);
  if (color) r.pipMat.color.set(color);
  r.pip.rotation.y = t / 500;
  r.pip.position.y = r.height + 0.32 + Math.sin(t / 400) * 0.04 + r.body.position.y;
  r.cloud.visible = p.anim === 'failed';
  if (r.cloud.visible) {
    r.cloud.position.y = r.height + 0.42 + r.body.position.y;
    r.cloud.children.slice(3).forEach((d, i) => (d.position.y = -0.12 - (((t / 600) + i / 3) % 1) * 0.2));
  }

  for (const m of r.mats) {
    m.opacity = p.alpha;
    m.transparent = p.alpha < 1;
    m.depthWrite = p.alpha >= 1;
  }
}
