// Start screen: the Moon from the south pole side, lit from the true Sun direction
// at the cursor time (ephemeris), so the globe's terminator matches the calculation.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

import { DATA_URL, type AppData, type GlobeCap, type Mission } from "../lib/data";
import { T, sunAlpha } from "../lib/theme";
import { Brackets } from "./hud";

type Vec3 = [number, number, number];

interface Props {
  data: AppData;
  selectedId: string | null;
  sunPctById: Record<string, number>;
  sunDir: Vec3; // MOON_ME, unit
  earthDir: Vec3;
  onPick: (lat: number, lon: number) => void;
  onZoomPole: () => void;
  missions: Mission[];
  missionId: string;
  focus: { lat: number; lon: number; key: number } | null; // turn the globe to this point
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

// Analysis zone around the south pole: edge latitudes come from the far-mountain grid
// so the drawing always matches where a click gives a result.
function analysisZone(data: AppData): { outerLat: number } {
  const rho = data.anyPoint?.far.meta.zones.outer?.rho_max_m ?? 925_000;
  return { outerLat: -90 + (2 * Math.atan(rho / (2 * R_MOON_M))) / D2R };
}

// Translucent disc from the pole to the edge: faint inside, denser at the rim
function zoneFill(outerLat: number): THREE.BufferGeometry {
  const RINGS = 48;
  const SEG = 256;
  const edge = (90 + outerLat) * D2R;
  const pos: number[] = [];
  const col: number[] = [];
  for (let i = 0; i <= RINGS; i++) {
    const colat = (edge * i) / RINGS;
    const t = Math.max(0, (colat - edge * 0.7) / (edge * 0.3)); // 0 inside, 1 at the edge
    const alpha = 0.03 + 0.16 * t * t;
    for (let j = 0; j <= SEG; j++) {
      const p = toThree(unit(-90 + colat / D2R, (360 * j) / SEG)).multiplyScalar(1.0015);
      pos.push(p.x, p.y, p.z);
      col.push(1, 1, 1, alpha);
    }
  }
  const idx: number[] = [];
  const at = (i: number, j: number) => i * (SEG + 1) + j;
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) idx.push(at(i, j), at(i + 1, j + 1), at(i + 1, j), at(i, j), at(i, j + 1), at(i + 1, j + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}

function latRing(lat: number, r = 1.002): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let j = 0; j < 360; j++) pts.push(toThree(unit(lat, j)).multiplyScalar(r));
  return new THREE.BufferGeometry().setFromPoints(pts);
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
  zone: { x: number; y: number } | null; // where to label the analysis zone edge
  zoneLat: number;
  mission: { x: number; y: number; name: string; status: Mission["status"] } | null; // chosen mission, if visible
}

// Circle on the surface: planned landing region (exact spot unpublished)
function surfaceCircle(lat: number, lon: number, radiusKm: number): THREE.BufferGeometry {
  const c = toThree(unit(lat, lon));
  const e1 = new THREE.Vector3(0, 1, 0).cross(c);
  if (e1.lengthSq() < 1e-8) e1.set(1, 0, 0);
  e1.normalize();
  const e2 = new THREE.Vector3().crossVectors(c, e1);
  const a = radiusKm / 1737.4;
  const pts: THREE.Vector3[] = [];
  for (let k = 0; k < 128; k++) {
    const t = (2 * Math.PI * k) / 128;
    pts.push(c.clone().multiplyScalar(Math.cos(a))
      .addScaledVector(e1, Math.sin(a) * Math.cos(t)).addScaledVector(e2, Math.sin(a) * Math.sin(t)).multiplyScalar(1.002));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}

/** Orientation with (lat, lon) facing the camera and north up. */
function lookAt(lat: number, lon: number): THREE.Quaternion {
  const c = toThree(unit(lat, lon));
  const up = toThree(unit(lat + 90, lon));
  const right = new THREE.Vector3().crossVectors(up, c);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, c).transpose());
}

export function Globe({ data, selectedId, sunPctById, sunDir, earthDir, onPick, onZoomPole, missions, missionId, focus }: Props) {
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
    missionMarks: Map<string, THREE.Object3D>;
    render: () => void;
  } | null>(null);
  const dirs = useRef({ sun: sunDir, earth: earthDir });
  dirs.current = { sun: sunDir, earth: earthDir };
  const handlers = useRef({ onPick, onZoomPole });
  handlers.current = { onPick, onZoomPole };
  const missionRef = useRef({ missions, missionId });
  missionRef.current = { missions, missionId };
  const [ov, setOv] = useState<Overlay | null>(null);
  const [ready, setReady] = useState(false);
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

    // show the scene once all textures load: no frame with black caps
    const loader = new THREE.TextureLoader(new THREE.LoadingManager(() => {
      setReady(true);
      render();
    }));
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
    const zone = analysisZone(data);
    const fill = new THREE.Mesh(zoneFill(zone.outerLat), new THREE.MeshBasicMaterial({
      color: T.bracket, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    fill.renderOrder = 2;
    const edge = new THREE.LineLoop(latRing(zone.outerLat),
      new THREE.LineBasicMaterial({ color: T.bracket, transparent: true, opacity: 0.95 }));
    edge.renderOrder = 3;
    moon.add(fill, edge);
    scene.add(moon);
    const light = new THREE.DirectionalLight(0xffffff, 3.4);
    scene.add(light, new THREE.AmbientLight(0x9ec3dc, 0.05));

    // orientation: point (VIEW_LAT, 0) faces the camera, north up
    moon.quaternion.copy(lookAt(VIEW_LAT, 0));

    // missions: diamond = actual landing, dashed circle = planned region
    const missionMarks = new Map<string, THREE.Object3D>();
    for (const ms of missions) {
      const { lat, lon, precision, radius_km } = ms.where;
      if (lat === undefined || lon === undefined) continue;
      let o: THREE.Object3D;
      if (precision === "landed") {
        o = new THREE.Mesh(new THREE.OctahedronGeometry(1), new THREE.MeshBasicMaterial({
          color: ms.status === "failure" ? T.empty : T.text }));
        o.position.copy(toThree(unit(lat, lon)).multiplyScalar(1.0015));
        o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), toThree(unit(lat, lon)));
        o.userData.size = 0.0075;
      } else {
        const ring = new THREE.LineLoop(surfaceCircle(lat, lon, radius_km ?? 30),
          new THREE.LineDashedMaterial({ color: T.bracket, dashSize: 0.004, gapSize: 0.003, transparent: true, opacity: 0.9 }));
        ring.computeLineDistances();
        o = ring;
      }
      o.renderOrder = 4;
      moon.add(o);
      missionMarks.set(ms.id, o);
    }

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
      for (const o of missionMarks.values()) if (o.userData.size) o.scale.setScalar((o.userData.size as number) * zk);
      renderer.render(scene, camera);
      // overlay: disc radius on screen, Sun and Earth directions, where the pole is
      const d = camera.position.z;
      const r = (h / 2) / Math.tan((FOV * Math.PI) / 360) / Math.sqrt(d * d - 1);
      const ang = (v: Vec3) => {
        const p = toThree(v).applyQuaternion(moon.quaternion);
        return Math.atan2(-p.y, p.x);
      };
      let zoneAt: { x: number; y: number } | null = null;
      for (let j = 0; j < 360; j += 2) {
        const p = toThree(unit(zone.outerLat, j)).applyQuaternion(moon.quaternion);
        if (p.z < 1.25 / d) continue; // unreadable near the disc edge
        const q = p.clone().project(camera);
        const sx = (q.x + 1) * w / 2;
        const sy = (1 - q.y) * h / 2;
        if (sy < 40 || sx < 70 || sx > w - 70) continue; // label must fit in the frame
        if (!zoneAt || sy < zoneAt.y) zoneAt = { x: sx, y: sy };
      }
      const pole = toThree([0, 0, -1]).applyQuaternion(moon.quaternion);
      const pp = pole.clone().project(camera);
      // label of the chosen mission, if its place is on the visible side
      const { missions: ml, missionId: mid } = missionRef.current;
      const sel = ml.find((x) => x.id === mid);
      let mission: Overlay["mission"] = null;
      if (sel && sel.where.lat !== undefined && sel.where.lon !== undefined) {
        const p = toThree(unit(sel.where.lat, sel.where.lon)).applyQuaternion(moon.quaternion);
        if (p.z > 1.05 / d) {
          const q = p.clone().project(camera);
          mission = { x: (q.x + 1) * w / 2, y: (1 - q.y) * h / 2, name: sel.name, status: sel.status };
        }
      }
      setOv({
        w, h, cx: w / 2, cy: h / 2, r,
        sunA: ang(dirs.current.sun), earthA: ang(dirs.current.earth),
        pole: { x: (pp.x + 1) * w / 2, y: (1 - pp.y) * h / 2, visible: pole.z > 1 / d },
        zone: zoneAt, zoneLat: zone.outerLat, mission,
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
    gl.current = { renderer, scene, camera, moon, mesh, light, markers, missionMarks, render };
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
      m.visible = s.group !== "mission"; // landed missions drawn as diamonds (missionMarks)
    }
    g.render();
  }, [data, selectedId, sunPctById]);

  // --- chosen mission: brighter, label updated
  useEffect(() => {
    const g = gl.current;
    if (!g) return;
    for (const [id, o] of g.missionMarks) {
      if (o instanceof THREE.LineLoop) (o.material as THREE.LineDashedMaterial).opacity = id === missionId ? 1 : 0.55;
      else o.userData.size = id === missionId ? 0.011 : 0.0075;
    }
    g.render();
  }, [missionId]);

  // --- turn the globe to a point (mission view): smoothly, in ~0.9 s
  useEffect(() => {
    const g = gl.current;
    if (!g || !focus) return;
    const from = g.moon.quaternion.clone();
    const to = lookAt(focus.lat, focus.lon);
    const t0 = performance.now();
    let raf = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 900);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      g.moon.quaternion.slerpQuaternions(from, to, e);
      g.render();
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // a hidden tab draws no frames, so just set the final position
    const snap = setTimeout(() => { g.moon.quaternion.copy(to); g.render(); }, 1200);
    return () => { cancelAnimationFrame(raf); clearTimeout(snap); };
  }, [focus]);

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
    <div ref={wrap} className="stage-fill"
         style={{ position: "absolute", inset: 0, opacity: ready ? 1 : 0, transition: "opacity 0.5s ease" }}>
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

  // "South pole" inset: a square preview in the scene corner with a leader line from the pole.
  // Size: the largest that keeps it off the Moon's disc (at least 104 px).
  const lens = data.globe?.lens;
  const PAD = 14;
  const CAP = 30; // caption height under the image
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const touches = (sz: number) => {
    const x0 = w - PAD - sz;
    const y0 = h - PAD - CAP - sz;
    return Math.hypot(clamp(cx, x0, w - PAD) - cx, clamp(cy, y0, h - PAD) - cy) < r + 10;
  };
  let ls = Math.round(clamp(Math.min(w, h) * 0.26, 104, 156));
  while (ls > 104 && touches(ls)) ls -= 4;
  const lx0 = w - PAD - ls; // image top-left corner
  const ly0 = h - PAD - CAP - ls;
  const [bx0, by0, bx1, by1] = lens?.bounds ?? [0, 0, 1, 1];
  const toLens = (x: number, y: number) => [((x - bx0) / (bx1 - bx0)) * ls, ((by1 - y) / (by1 - by0)) * ls];
  const poleL = toLens(0, 0);
  // leader: diagonally from the ring at the pole, then horizontally to the inset's left edge
  const lead = ov.pole.visible && lens && (() => {
    const ty = ly0 + 16;
    const ex0 = lx0 - 22;
    const a = Math.atan2(ty - ov.pole.y, ex0 - ov.pole.x);
    const x1 = ov.pole.x + 10 * Math.cos(a);
    const y1 = ov.pole.y + 10 * Math.sin(a);
    if (Math.hypot(ex0 - x1, ty - y1) < 12) return null; // pole almost under the inset
    return (
      <g stroke={T.bracket} strokeWidth="1" fill="none">
        <polyline points={`${x1},${y1} ${ex0},${ty} ${lx0 - 3},${ty}`} strokeOpacity="0.7" />
        <circle cx={lx0 - 3} cy={ty} r="1.8" fill={T.bracket} stroke="none" />
      </g>
    );
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
        {ov.pole.visible && (
          <g stroke={T.bracket} fill="none" strokeWidth="1.2">
            <circle cx={ov.pole.x} cy={ov.pole.y} r="9" />
            <path d={`M${ov.pole.x - 14} ${ov.pole.y} h5 M${ov.pole.x + 9} ${ov.pole.y} h5
                      M${ov.pole.x} ${ov.pole.y - 14} v5 M${ov.pole.x} ${ov.pole.y + 9} v5`} />
          </g>
        )}
        {lead}
      </svg>
      <div className="dir-label" style={{ left: Math.min(Math.max(sx, 62), w - 62), top: sy + 16, transform: "translateX(-50%)", textAlign: "center" }}>
        <b style={{ color: T.sun }}>SUN</b><span>grazing the pole</span>
      </div>
      <div className="dir-label" style={{ left: ex + (Math.cos(ov.earthA) < 0 ? -18 : 18), top: ey - 16,
                                          transform: Math.cos(ov.earthA) < 0 ? "translateX(-100%)" : undefined }}>
        <b style={{ color: T.earth }}>EARTH</b><span>near side</span>
      </div>
      {ov.mission && (
        <div className="mission-tag" style={{ left: ov.mission.x, top: ov.mission.y }}>
          <b>{ov.mission.name}</b>
          <span>{ov.mission.status === "planned" ? "planned landing region" : ov.mission.status === "failure" ? "landing failed" : "landed here"}</span>
        </div>
      )}
      {ov.zone && (
        <div className="zone-label" style={{ left: ov.zone.x, top: ov.zone.y }}>
          <b>ANALYSIS ZONE</b><span>any spot south of {Math.round(-ov.zoneLat)}°S</span>
        </div>
      )}
      {lens && (
        <button className="inset" style={{ left: lx0, top: ly0, width: ls }} onClick={onZoomPole}
                aria-label="Open the south pole map">
          <Brackets size={8} />
          <span className="inset-img" style={{ height: ls }}>
            <img src={DATA_URL(lens.file)} alt="" />
            <svg width={ls} height={ls} viewBox={`0 0 ${ls} ${ls}`}>
              {data.sites.map((s) => {
                const [x, y] = toLens(s.x, s.y);
                if (x < 3 || y < 3 || x > ls - 3 || y > ls - 3) return null;
                const sel = s.id === selectedId;
                return (
                  <g key={s.id}>
                    <circle cx={x} cy={y} r={sel ? 3.5 : 2.4} fill={s.group === "psr" ? T.psr : T.sun} stroke={T.bg} strokeWidth="1" />
                    {sel && <circle cx={x} cy={y} r="7" fill="none" stroke={T.sun} strokeWidth="1" />}
                  </g>
                );
              })}
              <path d={`M${poleL[0] - 4} ${poleL[1]} H${poleL[0] + 4} M${poleL[0]} ${poleL[1] - 4} V${poleL[1] + 4}`} stroke={T.text} />
            </svg>
            <span className="inset-scale">{Math.round((bx1 - bx0) / 1000)} km</span>
          </span>
          <span className="inset-cap"><b>SOUTH POLE</b><span>{ls >= 140 ? "Open map ›" : "›"}</span></span>
        </button>
      )}
      <div className="stage-hint">Drag to turn the Moon · scroll to zoom · click any spot south of 60°S</div>
    </>
  );
}

