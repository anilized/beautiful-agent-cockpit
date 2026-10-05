// The 3D garage's building blocks: one material per colour and finish, primitive meshes with shadows, and text drawn into
// textures. three.js is handed in (the page loads the served ./three.js); nothing here imports it at runtime, so a test runs
// the same code against the npm package. Colours come only from palette.ts.
import type * as THREE from 'three';

export type Three = typeof THREE;

/** A 2D canvas for text and surface textures; null under node, where labels are simply left out. */
export interface TextCanvas {
  width: number;
  height: number;
  getContext(id: '2d'): CanvasRenderingContext2D | null;
}
export type CanvasMaker = (width: number, height: number) => TextCanvas | null;

export interface MatOpts {
  /** 0 mirror .. 1 chalk (default 0.85). */
  rough?: number;
  metal?: number;
  /** Lit from inside: the colour and how strongly. */
  glow?: string;
  glowK?: number;
  /** Unlit (screens, bulbs, neon): drawn at full colour whatever the light. */
  basic?: boolean;
  opacity?: number;
  double?: boolean;
}

export interface LabelOpts {
  fg: string;
  bg?: string | null;
  /** Font size in canvas pixels (the canvas is sized to the text). */
  px?: number;
  bold?: boolean;
  /** A soft halo in this colour around the letters (neon). */
  halo?: string | null;
  pad?: number;
  font?: string;
}

const FONT = '"Segoe UI", system-ui, -apple-system, Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, Consolas, Menlo, monospace';

/**
 * A scene's worth of shared resources. `T` is three.js; everything made through the kit is disposed with it (meshes made from
 * kit geometry and materials need no disposal of their own).
 */
export class Kit {
  private readonly mats = new Map<string, THREE.Material>();
  private readonly geos = new Map<string, THREE.BufferGeometry>();
  private readonly owned = new Set<{ dispose(): void }>();

  constructor(readonly T: Three, readonly makeCanvas: CanvasMaker | null) {}

  // ---------- materials ----------

  mat(color: string, o: MatOpts = {}): THREE.Material {
    const key = `${color}|${o.rough ?? ''}|${o.metal ?? ''}|${o.glow ?? ''}|${o.glowK ?? ''}|${o.basic ? 1 : 0}|${o.opacity ?? ''}|${o.double ? 1 : 0}`;
    let m = this.mats.get(key);
    if (!m) {
      const T = this.T;
      const side = o.double ? T.DoubleSide : T.FrontSide;
      const transparent = o.opacity !== undefined && o.opacity < 1;
      m = o.basic
        ? new T.MeshBasicMaterial({ color: new T.Color(color), side, transparent, opacity: o.opacity ?? 1, toneMapped: false })
        : new T.MeshStandardMaterial({
            color: new T.Color(color), roughness: o.rough ?? 0.85, metalness: o.metal ?? 0, side, transparent, opacity: o.opacity ?? 1,
            ...(o.glow ? { emissive: new T.Color(o.glow), emissiveIntensity: o.glowK ?? 1 } : {}),
          });
      this.mats.set(key, m);
    }
    return m;
  }

  /** A material of its own (not shared): for things that change colour or fade one at a time. */
  ownMat(color: string, o: MatOpts = {}): THREE.MeshStandardMaterial | THREE.MeshBasicMaterial {
    const T = this.T;
    const m = o.basic
      ? new T.MeshBasicMaterial({ color: new T.Color(color), transparent: true, opacity: o.opacity ?? 1, toneMapped: false, side: o.double ? T.DoubleSide : T.FrontSide })
      : new T.MeshStandardMaterial({
          color: new T.Color(color), roughness: o.rough ?? 0.85, metalness: o.metal ?? 0, transparent: true, opacity: o.opacity ?? 1,
          ...(o.glow ? { emissive: new T.Color(o.glow), emissiveIntensity: o.glowK ?? 1 } : {}),
        });
    this.owned.add(m);
    return m;
  }

  // ---------- geometry ----------

  private geo<G extends THREE.BufferGeometry>(key: string, make: () => G): G {
    let g = this.geos.get(key);
    if (!g) {
      g = make();
      this.geos.set(key, g);
    }
    return g as G;
  }

  boxGeo(w: number, h: number, d: number): THREE.BoxGeometry {
    return this.geo(`box|${w}|${h}|${d}`, () => new this.T.BoxGeometry(w, h, d));
  }
  cylGeo(rTop: number, rBottom: number, h: number, seg = 16): THREE.CylinderGeometry {
    return this.geo(`cyl|${rTop}|${rBottom}|${h}|${seg}`, () => new this.T.CylinderGeometry(rTop, rBottom, h, seg));
  }
  sphereGeo(r: number, wSeg = 16, hSeg = 12, thetaLength = Math.PI): THREE.SphereGeometry {
    return this.geo(`sph|${r}|${wSeg}|${hSeg}|${thetaLength}`, () => new this.T.SphereGeometry(r, wSeg, hSeg, 0, Math.PI * 2, 0, thetaLength));
  }
  capsuleGeo(r: number, len: number): THREE.CapsuleGeometry {
    return this.geo(`cap|${r}|${len}`, () => new this.T.CapsuleGeometry(r, len, 6, 12));
  }
  planeGeo(w: number, h: number): THREE.PlaneGeometry {
    return this.geo(`plane|${w}|${h}`, () => new this.T.PlaneGeometry(w, h));
  }
  torusGeo(r: number, tube: number, arc = Math.PI * 2): THREE.TorusGeometry {
    return this.geo(`torus|${r}|${tube}|${arc}`, () => new this.T.TorusGeometry(r, tube, 8, 24, arc));
  }

  // ---------- meshes ----------

  mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, shadow: 'cast' | 'receive' | 'both' | 'none' = 'both'): THREE.Mesh {
    const m = new this.T.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = shadow === 'cast' || shadow === 'both';
    m.receiveShadow = shadow === 'receive' || shadow === 'both';
    return m;
  }

  /** A box whose base sits at y (furniture is placed by its foot, not its middle). */
  box(w: number, h: number, d: number, color: string | THREE.Material, x = 0, y = 0, z = 0, o: MatOpts = {}): THREE.Mesh {
    const mat = typeof color === 'string' ? this.mat(color, o) : color;
    return this.mesh(this.boxGeo(w, h, d), mat, x, y + h / 2, z);
  }

  cyl(r: number, h: number, color: string | THREE.Material, x = 0, y = 0, z = 0, o: MatOpts & { rTop?: number; seg?: number } = {}): THREE.Mesh {
    const mat = typeof color === 'string' ? this.mat(color, o) : color;
    return this.mesh(this.cylGeo(o.rTop ?? r, r, h, o.seg ?? 16), mat, x, y + h / 2, z);
  }

  ball(r: number, color: string | THREE.Material, x = 0, y = 0, z = 0, o: MatOpts = {}): THREE.Mesh {
    const mat = typeof color === 'string' ? this.mat(color, o) : color;
    return this.mesh(this.sphereGeo(r), mat, x, y, z);
  }

  group(...children: THREE.Object3D[]): THREE.Group {
    const g = new this.T.Group();
    for (const c of children) g.add(c);
    return g;
  }

  // ---------- textures ----------

  /** Draw into a fresh canvas texture; null when there is no canvas (node). */
  texture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, repeat?: [number, number]): THREE.CanvasTexture | null {
    const c = this.makeCanvas?.(w, h);
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return null;
    draw(ctx, w, h);
    const tex = new this.T.CanvasTexture(c as unknown as HTMLCanvasElement);
    tex.colorSpace = this.T.SRGBColorSpace;
    tex.anisotropy = 4;
    if (repeat) {
      tex.wrapS = tex.wrapT = this.T.RepeatWrapping;
      tex.repeat.set(repeat[0], repeat[1]);
    }
    this.owned.add(tex);
    return tex;
  }

  /** Text on a transparent (or `bg`) card, as a texture sized to it, with its aspect ratio. */
  label(text: string, o: LabelOpts): { tex: THREE.CanvasTexture; aspect: number } | null {
    const px = o.px ?? 48;
    const pad = o.pad ?? Math.round(px * 0.35);
    const font = `${o.bold ? '700 ' : '500 '}${px}px ${o.font === 'mono' ? MONO : FONT}`;
    const probe = this.makeCanvas?.(8, 8)?.getContext('2d');
    if (!probe) return null;
    probe.font = font;
    const w = Math.ceil(probe.measureText(text).width) + pad * 2;
    const h = Math.ceil(px * 1.3) + pad * 2;
    const tex = this.texture(w, h, (ctx) => {
      if (o.bg) {
        ctx.fillStyle = o.bg;
        const r = Math.min(h / 2, px * 0.4);
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, r);
        ctx.fill();
      }
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (o.halo) {
        ctx.shadowColor = o.halo;
        ctx.shadowBlur = px * 0.5;
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = o.halo;
          ctx.fillText(text, w / 2, h / 2);
        }
        ctx.shadowBlur = 0;
      }
      ctx.fillStyle = o.fg;
      ctx.fillText(text, w / 2, h / 2);
    });
    return tex ? { tex, aspect: w / h } : null;
  }

  /** A label as an upright plane `height` tall (world units), facing +z; null without a canvas. */
  labelPlane(text: string, height: number, o: LabelOpts): THREE.Mesh | null {
    const l = this.label(text, o);
    if (!l) return null;
    const m = new this.T.MeshBasicMaterial({ map: l.tex, transparent: true, toneMapped: false, depthWrite: false });
    this.owned.add(m);
    const geo = new this.T.PlaneGeometry(height * l.aspect, height);
    this.owned.add(geo);
    return new this.T.Mesh(geo, m);
  }

  /** A label as a camera-facing sprite `height` tall; null without a canvas. */
  labelSprite(text: string, height: number, o: LabelOpts): THREE.Sprite | null {
    const l = this.label(text, o);
    if (!l) return null;
    const m = new this.T.SpriteMaterial({ map: l.tex, transparent: true, toneMapped: false, depthWrite: false });
    this.owned.add(m);
    const s = new this.T.Sprite(m);
    s.scale.set(height * l.aspect, height, 1);
    return s;
  }

  /** Register something made outside the kit (a geometry, a texture) so `dispose` releases it. */
  own<R extends { dispose(): void }>(r: R): R {
    this.owned.add(r);
    return r;
  }

  dispose(): void {
    for (const m of this.mats.values()) m.dispose();
    for (const g of this.geos.values()) g.dispose();
    for (const o of this.owned) o.dispose();
    this.mats.clear();
    this.geos.clear();
    this.owned.clear();
  }
}

/** A stable number in 0..1 for a string (the same id always lands the same way). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return (h % 100_000) / 100_000;
}
