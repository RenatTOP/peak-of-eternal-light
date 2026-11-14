// Start screen: the Moon from the south pole side, lit from the true Sun direction
// at the cursor time (ephemeris), so the globe's terminator matches the calculation.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

import { DATA_URL, type AppData, type GlobeCap } from "../lib/data";
import { T, sunAlpha } from "../lib/theme";

type Vec3 = [number, number, number];

interface Props {
  data: AppData;
  selectedId: string | null;
  sunPctById: Record<string, number>;
  sunDir: Vec3; // MOON_ME, unit
  earthDir: Vec3;
  onPick: (lat: number, lon: number) => void;
  onZoomPole: () => void;
}

// MOON_ME (x to Earth, z north) -> three.js coordinates (y up) and back
const toThree = (v: Vec3) => new THREE.Vector3(v[0], v[2], -v[1]);
const fromThree = (p: THREE.Vector3): Vec3 => [p.x, -p.z, p.y];

function unit(lat: number, lon: number): Vec3 {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

const R_MOON_M = 1737400;
const D2R = Math.PI / 180;

// Main sphere with the equirectangular texture, cut short at the poles; theta from the north pole.
// UVs recomputed because SphereGeometry stretches the texture over the cut range.
function trimmedSphere(thetaStart: number, thetaEnd: number): THREE.SphereGeometry {
  const rows = Math.ceil(((thetaEnd - thetaStart) / Math.PI) * 180);
  const g = new THREE.SphereGeometry(1, 256, rows, 0, Math.PI * 2, thetaStart, thetaEnd - thetaStart);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const theta = thetaStart + (1 - uv.getY(i)) * (thetaEnd - thetaStart);
    uv.setY(i, 1 - theta / Math.PI);
  }
  return g;
}

// Polar cap: a disc in stereographic projection (like the map), UVs linear in map x, y,
// so no pinching or radial streaks at the pole. The edge fades into the sphere.
function capGeometry(cap: GlobeCap, fadeDeg: number): THREE.BufferGeometry {
  const RINGS = 72;
  const SEG = 256;
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  for (let i = 0; i <= RINGS; i++) {
    const rho = (cap.rho_max_m * i) / RINGS;
    const colat = 2 * Math.atan(rho / (2 * R_MOON_M));
    const alpha = Math.min(1, Math.max(0, (cap.colat_deg - colat / D2R) / fadeDeg));
    for (let j = 0; j <= SEG; j++) {
      const lon = (2 * Math.PI * j) / SEG;
      const x = rho * Math.sin(lon);
      const y = -cap.sign * rho * Math.cos(lon);
      const me: Vec3 = [Math.sin(colat) * Math.cos(lon), Math.sin(colat) * Math.sin(lon), cap.sign * Math.cos(colat)];
      const p = toThree(me);
      pos.push(p.x, p.y, p.z);
      uv.push((x / cap.rho_max_m + 1) / 2, (y / cap.rho_max_m + 1) / 2);
      col.push(1, 1, 1, alpha);
    }
  }
  const at = (i: number, j: number) => i * (SEG + 1) + j;
  // counter-clockwise triangles seen from outside
  const p0 = new THREE.Vector3().fromArray(pos, at(1, 0) * 3);
  const p1 = new THREE.Vector3().fromArray(pos, at(2, 0) * 3);
  const p2 = new THREE.Vector3().fromArray(pos, at(2, 1) * 3);
  const outward = new THREE.Vector3().subVectors(p1, p0).cross(new THREE.Vector3().subVectors(p2, p0)).dot(p0) > 0;
  const idx: number[] = [];
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const [a, b, c, d] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (outward) idx.push(a, b, c, a, c, d);
      else idx.push(a, c, b, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}

const VIEW_LAT = -70; // view from below the pole, slightly towards Earth
const FOV = 22;
const DIST0 = 5.4;

interface Overlay {
  w: number;
  h: number;
  cx: number;
  cy: number;
  r: number;
  sunA: number;
  earthA: number;
  pole: { x: number; y: number; visible: boolean };
}

export function Globe({ data, selectedId, sunPctById, sunDir, earthDir, onPick, onZoomPole }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gl = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    moon: THREE.Group;
    mesh: THREE.Mesh;
    light: THREE.DirectionalLight;
    markers: Map<string, THREE.Mesh>;
    render: () => void;
  } | null>(null);
  const dirs = useRef({ sun: sunDir, earth: earthDir });
  dirs.current = { sun: sunDir, earth: earthDir };
  const handlers = useRef({ onPick, onZoomPole });
  handlers.current = { onPick, onZoomPole };
  const [ov, setOv] = useState<Overlay | null>(null);
  const zoomed = useRef(false); // the user zoomed; don't refit to size

  // --- scene (once)
  useEffect(() => {
    const cv = canvas.current;
    const box = wrap.current;
    if (!cv || !box || !data.globe) return;
    const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
    camera.position.set(0, 0, DIST0);

    const loader = new THREE.TextureLoader();
    const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const tex = (file: string, srgb: boolean) => {
      const t = loader.load(DATA_URL(file), () => render());
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = aniso;
      return t;
    };
    const { caps, cap_fade_deg: fade = 2 } = data.globe;
    const mesh = new THREE.Mesh(
      caps
        ? trimmedSphere((caps.north.colat_deg - fade) * D2R, Math.PI - (caps.south.colat_deg - fade) * D2R)
        : new THREE.SphereGeometry(1, 256, 180),
      new THREE.MeshStandardMaterial({
        map: tex(data.globe.color, true), normalMap: tex(data.globe.normal, false), roughness: 1, metalness: 0,
      }),
    );
    const moon = new THREE.Group();
    moon.add(mesh);
    for (const cap of caps ? [caps.south, caps.north] : []) {
      const m = new THREE.Mesh(capGeometry(cap, fade), new THREE.MeshStandardMaterial({
        map: tex(cap.color, true), normalMap: tex(cap.normal, false), roughness: 1, metalness: 0,
        vertexColors: true, transparent: true,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2, // above the sphere at the seam
      }));
      m.renderOrder = 1;
      moon.add(m);
    }
    scene.add(moon);
    const light = new THREE.DirectionalLight(0xffffff, 3.4);
    scene.add(light, new THREE.AmbientLight(0x9ec3dc, 0.05));

    // orientation: point (VIEW_LAT, 0) faces the camera, north up
    const c = toThree(unit(VIEW_LAT, 0));
    const up = toThree(unit(VIEW_LAT + 90, 0));
    const right = new THREE.Vector3().crossVectors(up, c);
    moon.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, c).transpose());

    const markers = new Map<string, THREE.Mesh>();
    for (const s of data.sites) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: T.sun }));
      m.position.copy(toThree(unit(s.lat, s.lon)).multiplyScalar(1.001));
      moon.add(m);
      markers.set(s.id, m);
    }

    const render = () => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (!w || !h) return;
      light.position.copy(toThree(dirs.current.sun)).applyQuaternion(moon.quaternion).multiplyScalar(10);
      // markers keep a constant screen size, not kilometres
      const zk = Math.min(1, (camera.position.z - 1) / (DIST0 - 1));
      for (const m of markers.values()) m.scale.setScalar((m.userData.size as number ?? 0.0065) * zk);
      renderer.render(scene, camera);
      // overlay: disc radius on screen, Sun and Earth directions, where the pole is
      const d = camera.position.z;
      const r = (h / 2) / Math.tan((FOV * Math.PI) / 360) / Math.sqrt(d * d - 1);
      const ang = (v: Vec3) => {
        const p = toThree(v).applyQuaternion(moon.quaternion);
        return Math.atan2(-p.y, p.x);
      };
      const pole = toThree([0, 0, -1]).applyQuaternion(moon.quaternion);
      const pp = pole.clone().project(camera);
      setOv({
        w, h, cx: w / 2, cy: h / 2, r,
        sunA: ang(dirs.current.sun), earthA: ang(dirs.current.earth),
        pole: { x: (pp.x + 1) * w / 2, y: (1 - pp.y) * h / 2, visible: pole.z > 1 / d },
      });
    };

    const resize = () => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
      if (!zoomed.current) {
        // disc with rings (+46 px) and labels fits in the scene
        const target = Math.max(80, Math.min(w, h) / 2 - 64);
        const k = (h / 2) / (Math.tan((FOV * Math.PI) / 360) * target);
        camera.position.z = Math.sqrt(k * k + 1);
      }
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    gl.current = { renderer, scene, camera, moon, mesh, light, markers, render };
    if (import.meta.env.DEV) Object.assign(window, { __globe: { ...gl.current, THREE, toThree, unit } });
    resize();
    return () => {
      ro.disconnect();
      renderer.dispose();
      gl.current = null;
    };
  }, [data]);

  // --- site markers: colour and size
  useEffect(() => {
    const g = gl.current;
    if (!g) return;
    for (const s of data.sites) {
      const m = g.markers.get(s.id)!;
      const sel = s.id === selectedId;
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.set(s.group === "mission" ? T.earth : s.group === "psr" ? T.psr : T.sun);
      mat.opacity = s.group === "candidate" ? sunAlpha(sunPctById[s.id] ?? 50) : 1;
      mat.transparent = mat.opacity < 1;
      m.userData.size = sel ? 0.012 : 0.0065;
    }
    g.render();
  }, [data, selectedId, sunPctById]);

  // --- light moves with the time cursor
  useEffect(() => {
    gl.current?.render();
  }, [sunDir, earthDir]);

  // --- rotate, zoom, click
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    let drag: { x: number; y: number; moved: number } | null = null;
    const touches = new Map<number, [number, number]>();
    let pinch = 0; // distance between two fingers
    const zoomBy = (f: number) => {
      const g = gl.current;
      if (!g) return;
      zoomed.current = true;
      g.camera.position.z = Math.min(9, Math.max(1.35, g.camera.position.z * f));
      g.render();
    };
    const down = (e: PointerEvent) => {
      cv.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2) {
        const [a, b] = [...touches.values()];
        pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
        drag = null;
      } else {
        drag = { x: e.clientX, y: e.clientY, moved: 0 };
      }
    };
    const move = (e: PointerEvent) => {
      const g = gl.current;
      if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2 && pinch > 0) {
        const [a, b] = [...touches.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        zoomBy(pinch / Math.max(d, 1));
        pinch = d;
        return;
      }
      if (!drag || !g) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY, moved: drag.moved + Math.abs(dx) + Math.abs(dy) };
      const k = 0.004 * Math.min(1, (g.camera.position.z - 1) / (DIST0 - 1));
      const q = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * k)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * k));
      g.moon.quaternion.premultiply(q);
      g.render();
    };
    const up = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = 0;
      const g = gl.current;
      if (drag && drag.moved < 5 && g) {
        const r = cv.getBoundingClientRect();
        const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, g.camera);
        // the Moon is a unit sphere at the scene centre; intersect it exactly, not via the mesh
        const hit = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
        if (hit) {
          const p = fromThree(g.moon.worldToLocal(hit).normalize());
          const lat = (Math.asin(p[2]) * 180) / Math.PI;
          const lon = (((Math.atan2(p[1], p[0]) * 180) / Math.PI) + 360) % 360;
          handlers.current.onPick(lat, lon);
        }
      }
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(1 + e.deltaY * 0.0012);
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
      cv.removeEventListener("wheel", wheel);
    };
  }, []);

  return (
    <div ref={wrap} className="stage-fill" style={{ position: "absolute", inset: 0 }}>
      <canvas ref={canvas} className="globe-canvas" aria-label="The Moon seen from below its south pole. Drag to turn, scroll to zoom, click a spot south of 60°S to analyse it." />
      {ov && <GlobeOverlay ov={ov} data={data} selectedId={selectedId} onZoomPole={() => handlers.current.onZoomPole()} />}
    </div>
  );
}

function GlobeOverlay({ ov, data, selectedId, onZoomPole }: {
  ov: Overlay;
  data: AppData;
  selectedId: string | null;
  onZoomPole: () => void;
}) {
  const { w, h, cx, cy, r } = ov;
  const r1 = r + 22;
  const r2 = r + 46;
  const ticks = [];
  for (let d = 0; d < 360; d += 5) {
    const a = (d * Math.PI) / 180;
    const l = d % 30 === 0 ? 7 : 3;
    ticks.push(<line key={d} x1={cx + r2 * Math.cos(a)} y1={cy + r2 * Math.sin(a)}
                     x2={cx + (r2 - l) * Math.cos(a)} y2={cy + (r2 - l) * Math.sin(a)}
                     stroke="rgba(134,201,232,0.45)" strokeWidth="1" />);
  }
  const at = (a: number, rr: number) => [cx + rr * Math.cos(a), cy + rr * Math.sin(a)];
  const [sx, sy] = at(ov.sunA, r1);
  const [ex, ey] = at(ov.earthA, r1);

  // polar lens: bottom right of the disc
  const lr = Math.max(56, Math.min(104, r * 0.38));
  const lx = Math.min(w - lr - 8, cx + r * 0.78);
  const ly = Math.min(h - lr - 40, cy + r * 0.66);
  const lens = data.globe?.lens;
  const [bx0, by0, bx1, by1] = lens?.bounds ?? [0, 0, 1, 1];
  const toLens = (x: number, y: number) => [((x - bx0) / (bx1 - bx0)) * 2 * lr, ((by1 - y) / (by1 - by0)) * 2 * lr];
  const poleL = toLens(0, 0);
  const lead = ov.pole.visible && (() => {
    const a = Math.atan2(ly - ov.pole.y, lx - ov.pole.x);
    return <line x1={ov.pole.x + 16 * Math.cos(a)} y1={ov.pole.y + 16 * Math.sin(a)}
                 x2={lx - lr * Math.cos(a)} y2={ly - lr * Math.sin(a)} stroke={T.sun} strokeWidth="1" />;
  })();

  return (
    <>
      <svg className="globe-overlay" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <circle cx={cx} cy={cy} r={r1} fill="none" stroke="rgba(134,201,232,0.35)" />
        <circle cx={cx} cy={cy} r={r2} fill="none" stroke="rgba(134,201,232,0.18)" />
        {ticks}
        <circle cx={ex} cy={ey} r="6" fill={T.earth} />
        <circle cx={ex} cy={ey} r="11" fill="none" stroke={T.earth} strokeOpacity="0.5" />
        <circle cx={sx} cy={sy} r="7" fill={T.sun} />
        <circle cx={sx} cy={sy} r="12" fill="none" stroke={T.sun} strokeOpacity="0.5" />
        {ov.pole.visible && <circle cx={ov.pole.x} cy={ov.pole.y} r="16" fill="none" stroke={T.sun} strokeWidth="1.5" />}
        {lead}
      </svg>
      <div className="dir-label" style={{ left: Math.min(Math.max(sx, 62), w - 62), top: sy + 16, transform: "translateX(-50%)", textAlign: "center" }}>
        <b style={{ color: T.sun }}>SUN</b><span>grazing the pole</span>
      </div>
      <div className="dir-label" style={{ left: ex + (Math.cos(ov.earthA) < 0 ? -18 : 18), top: ey - 16,
                                          transform: Math.cos(ov.earthA) < 0 ? "translateX(-100%)" : undefined }}>
        <b style={{ color: T.earth }}>EARTH</b><span>near side</span>
      </div>
      {lens && (
        <>
          <button className="lens" style={{ left: lx - lr, top: ly - lr, width: 2 * lr, height: 2 * lr }}
                  onClick={onZoomPole} aria-label="Zoom into the south pole">
            <img src={DATA_URL(lens.file)} alt="" />
            <svg width={2 * lr} height={2 * lr} viewBox={`0 0 ${2 * lr} ${2 * lr}`}>
              {data.sites.map((s) => {
                const [x, y] = toLens(s.x, s.y);
                if (x < 0 || y < 0 || x > 2 * lr || y > 2 * lr) return null;
                const sel = s.id === selectedId;
                return (
                  <g key={s.id}>
                    <circle cx={x} cy={y} r={sel ? 4.5 : 3} fill={s.group === "psr" ? T.psr : T.sun} stroke={T.bg} strokeWidth="1.5" />
                    {sel && <circle cx={x} cy={y} r="9" fill="none" stroke={T.sun} strokeWidth="1.2" />}
                  </g>
                );
              })}
              <path d={`M${poleL[0] - 5} ${poleL[1]} H${poleL[0] + 5} M${poleL[0]} ${poleL[1] - 5} V${poleL[1] + 5}`} stroke={T.text} />
            </svg>
          </button>
          <div className="lens-label" style={{ left: lx - lr - 20, top: ly + lr + 8, width: 2 * lr + 40 }}>
            <b>SOUTH POLE · {Math.round((bx1 - bx0) / 1000)} KM</b><span>click to zoom in</span>
          </div>
        </>
      )}
      <div className="stage-hint">Drag to turn the Moon · scroll to zoom · click any spot south of 60°S</div>
    </>
  );
}

