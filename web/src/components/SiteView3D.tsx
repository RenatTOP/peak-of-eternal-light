// 3D "standing at the point" view: LOLA terrain around (with lunar curvature), far mountains as a silhouette
// from the same horizon profile as the numbers, GPU shadows, the Sun and Earth where the ephemeris
// puts them, and real stars. Time follows the timeline cursor; what you see here is what the panels count.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

import type { AnyPoint } from "../lib/anypoint";
import { siteVector, xyToLatLon, type Ephem, type Vec3 } from "../lib/astro";
import { fmtDateTime, fmtLat, fmtLon } from "../lib/format";
import {
  applyMat, backgroundStars, BRIGHT_STARS, CLOUDS, EYE_M, farShadowData, heightAt, lineOfSight, loadRegion,
  moonFixedFromJ2000, observerBasis, radec, regionSpec, rng, skyAt, sphereU, toLocal, type Region,
} from "../lib/scene3d";
import { T } from "../lib/theme";
import { Brackets } from "./hud";

export interface ViewTarget {
  kind: "site" | "point" | "route";
  name: string;
  x: number; // map point, m
  y: number;
  groundZ: number; // surface height above the sphere, m
  route?: RoutePt[]; // rover path (map points) and how the rover drove it
  waypoints?: [number, number][]; // user route vertices
}

export interface RoutePt {
  x: number;
  y: number;
  state?: "lit" | "dark" | "ahead";
}

export type ViewMode = "eye" | "above";

export interface ViewReadout {
  sunFrac: number;
  sunClear: number; // ° above terrain (negative = behind a ridge)
  earthFrac: number;
  earthClear: number;
}

export interface Landmark {
  id: string;
  name: string;
  x: number;
  y: number;
  groundZ: number;
}

interface Props {
  ephem: Ephem;
  anyPoint: AnyPoint;
  target: ViewTarget;
  t: number;
  readout: ViewReadout | null;
  landmarks: Landmark[];
  mode: ViewMode;
  onMode: (m: ViewMode) => void;
  onClose: () => void;
}

const DEG = Math.PI / 180;
const RING_M = 150_000; // distance at which the far-mountain silhouette is drawn

// patch frame (east, north, up) -> three.js (y up)
const v3 = (v: Vec3) => new THREE.Vector3(v[0], v[2], -v[1]);

// --------------------------------------------------------------------------- //
// shaders
// --------------------------------------------------------------------------- //

const TERRAIN_VS = /* glsl */ `
varying vec3 vP;
void main() {
  vP = vec3(position.x, -position.z, position.y);
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
}`;

const COMMON_GLSL = /* glsl */ `
const float PI = 3.14159265;
const float R_MOON = 1737400.0;
float discFrac(float delta, float r) {
  float d = clamp(delta / r, -1.0, 1.0);
  return 1.0 - (acos(d) - d * sqrt(1.0 - d * d)) / PI;
}
// regolith phase law (Allen's law for the Moon): backscatter is many times brighter than forward
float phaseLaw(vec3 toSun, vec3 toEye) {
  float a = degrees(acos(clamp(dot(toSun, toEye), -1.0, 1.0)));
  return max(pow(10.0, -0.4 * (0.026 * a + 4e-9 * a * a * a * a)), 0.015);
}
vec3 tonemap(float I, float exposure) {
  vec3 c = vec3(1.0, 0.975, 0.94) * (1.0 - exp(-I * exposure));
  return pow(c, vec3(1.0 / 2.2));
}`;

const TERRAIN_FS = /* glsl */ `
uniform highp sampler2D uH;
uniform highp sampler2D uFar;
uniform float uSize, uStep, uHalf, uMaxU, uK, uNodeHalf, uSunR, uExposure, uGrow, uAmbient;
uniform vec3 uSun, uCam;
varying vec3 vP;
${COMMON_GLSL}

float hAt(vec2 en) {
  vec2 f = clamp((en + uHalf) / uStep, 0.0, uSize - 1.001);
#ifdef LINEAR
  return texture(uH, (f + 0.5) / uSize).r;
#else
  ivec2 i = ivec2(floor(f));
  vec2 w = f - vec2(i);
  float a = texelFetch(uH, i, 0).r, b = texelFetch(uH, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uH, i + ivec2(0, 1), 0).r, d = texelFetch(uH, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
#endif
}

// shadow from the patch terrain: ray to the Sun over the height map; the angle by which terrain blocks
// the ray -> share of the solar disc above it (soft 0.53° edge, as in the calculation)
float nearLight(vec3 P) {
  float t = uStep * 0.75;
  float occl = -1.0;
  for (int k = 0; k < STEPS; k++) {
    vec3 Q = P + uSun * t;
    if (abs(Q.x) > uHalf || abs(Q.y) > uHalf || Q.z > uMaxU) break;
    occl = max(occl, (hAt(Q.xy) - Q.z) / t);
    if (occl > uSunR) break;
    t *= uGrow;
  }
  return discFrac(-occl, uSunR);
}

// shadow from mountains beyond the patch: the far ridge top towards the Sun from the node grid
float farLight(vec3 P, vec3 up) {
  vec2 g = clamp((P.xy + uNodeHalf) / (2.0 * uNodeHalf) * (uK - 1.0), 0.0, uK - 1.001);
  ivec2 i = ivec2(floor(g));
  vec2 w = g - vec2(i);
  vec4 a = texelFetch(uFar, i, 0), b = texelFetch(uFar, i + ivec2(1, 0), 0);
  vec4 c = texelFetch(uFar, i + ivec2(0, 1), 0), d = texelFetch(uFar, i + ivec2(1, 1), 0);
  vec4 wt = vec4((1.0 - w.x) * (1.0 - w.y) * a.w, w.x * (1.0 - w.y) * b.w, (1.0 - w.x) * w.y * c.w, w.x * w.y * d.w);
  float ws = wt.x + wt.y + wt.z + wt.w;
  if (ws < 1e-3) return 1.0;
  vec3 top = (a.xyz * wt.x + b.xyz * wt.y + c.xyz * wt.z + d.xyz * wt.w) / ws;
  float ridge = asin(clamp(dot(normalize(top - P), up), -1.0, 1.0));
  float sunEl = asin(clamp(dot(uSun, up), -1.0, 1.0));
  return discFrac(sunEl - ridge, uSunR);
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
// roughness below the model scale: fractal (amplitude ~ scale^0.8, as for regolith); an octave fades
// once it is smaller than a pixel, so nothing shimmers in the distance
float detail(vec2 p, float fp) {
  float h = 0.0;
  float sc = 0.6;
  for (int k = 0; k < 4; k++) {
    float fade = 1.0 - smoothstep(sc * 0.25, sc * 0.6, fp);
    h += (noise(p / sc + float(k) * 17.3) - 0.5) * pow(sc, 0.8) * fade;
    sc *= 2.7;
  }
  return h;
}

void main() {
  vec3 P = vP;
  float s = uStep;
  float hx = hAt(P.xy + vec2(s, 0.0)) - hAt(P.xy - vec2(s, 0.0));
  float hy = hAt(P.xy + vec2(0.0, s)) - hAt(P.xy - vec2(0.0, s));
  vec3 N = normalize(vec3(-hx / (2.0 * s), -hy / (2.0 * s), 1.0));
  // small relief missing from the 80 m model, so the ground underfoot isn't a plane
  float fp = length(fwidth(P.xy));
  float tex = 0.0;
  if (fp < 8.0) {
    float e = max(0.15, fp * 0.5);
    float d0 = detail(P.xy, fp);
    vec2 gd = vec2(detail(P.xy + vec2(e, 0.0), fp) - d0, detail(P.xy + vec2(0.0, e), fp) - d0) / e;
    N = normalize(N + vec3(-gd * 0.03, 0.0));
    tex = d0;
  }
  vec3 V = normalize(uCam - P);
  float albedo = 0.11 * (1.0 + 0.14 * (noise(P.xy / 900.0) - 0.5) + 0.08 * (noise(P.xy / 140.0) - 0.5) + 0.05 * tex);
  // sub-pixel roughness (as in Hapke): part of the surface is lit even when the
  // mean slope faces slightly away, so the terminator is soft, not black and white
  float mu0 = 0.5 * (dot(N, uSun) + sqrt(dot(N, uSun) * dot(N, uSun) + 0.0016));
  float I = albedo * uAmbient; // light reflected from sunlit slopes around
  if (mu0 > 0.002) {
    vec3 up = normalize(vec3(P.xy, P.z + R_MOON));
    float vis = min(farLight(P, up), 1.0);
    // the ray starts from the bilinear surface (like the ones it walks over), not from a mesh triangle
    if (vis > 0.0) vis = min(vis, nearLight(vec3(P.xy, max(P.z, hAt(P.xy)) + 0.5)));
    float mu = max(dot(N, V), 0.02);
    I += albedo * (0.5 * mu0 + mu0 / (mu0 + mu)) * vis * phaseLaw(uSun, V); // lunar Lambert, L = 0.5
  }
  gl_FragColor = vec4(tonemap(I, uExposure), 1.0);
}`;

const RING_VS = /* glsl */ `
attribute float aTop;
attribute float aE;
varying float vTop;
varying float vE;
varying vec3 vDir;
uniform vec3 uEye;
void main() {
  vTop = aTop;
  vE = aE;
  vDir = position - uEye;
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
}`;

const RING_FS = /* glsl */ `
uniform vec3 uSun; // three.js
uniform vec3 uUp;
uniform float uExposure;
varying float vTop;
varying float vE;
varying vec3 vDir;
${COMMON_GLSL}
void main() {
  // far mountains: slope facing us and slightly up. With a low Sun the crests catch the light
  // and the foothills are in shadow: brightness fades with depth below the silhouette top
  vec3 d = normalize(vDir);
  vec3 h = normalize(d - dot(d, uUp) * uUp);
  vec3 n = normalize(-h * 0.8 + uUp * 0.6);
  float mu0 = max(dot(n, uSun), 0.0);
  float below = vE - degrees(asin(clamp(dot(d, uUp), -1.0, 1.0)));
  float sunEl = degrees(asin(clamp(dot(uSun, uUp), -1.0, 1.0)));
  float crest = exp(-max(below, 0.0) / max(0.25, 0.4 * sunEl + 0.25));
  float I = 0.11 * (0.5 * mu0 + mu0 / (mu0 + 0.3)) * crest * phaseLaw(uSun, -d) + 0.0012;
  gl_FragColor = vec4(tonemap(I, uExposure), 1.0);
}`;

// diorama walls (view from above): dark sides from the terrain edge down
const SKIRT_VS = /* glsl */ `
attribute float aTop;
varying float vTop;
void main() {
  vTop = aTop;
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
}`;

const SKIRT_FS = /* glsl */ `
varying float vTop;
void main() {
  vec3 c = mix(vec3(0.012, 0.03, 0.05), vec3(0.04, 0.09, 0.13), vTop);
  gl_FragColor = vec4(c + vec3(0.3, 0.5, 0.6) * smoothstep(0.985, 1.0, vTop) * 0.5, 1.0);
}`;

const STAR_VS = /* glsl */ `
attribute float aB;
uniform float uPx;
varying float vB;
void main() {
  vB = aB;
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
  gl_PointSize = (1.2 + 2.2 * min(aB, 1.5)) * uPx;
}`;

const STAR_FS = /* glsl */ `
varying float vB;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.2, r);
  gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * vB * a, 1.0);
}`;

const SPRITE_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
}`;

// Sun disc with limb darkening and a faint glow around it (in the lens; no atmosphere)
const SUN_FS = /* glsl */ `
uniform float uR;    // disc angular radius, rad
uniform float uSpan; // half side of the square, rad
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0 * uSpan / uR; // in disc radii
  vec3 c = vec3(0.0);
  if (r < 1.0) {
    float mu = sqrt(1.0 - r * r);
    c = vec3(1.0, 0.96, 0.88) * (0.45 + 0.55 * mu) * 3.0;
  }
  c += vec3(1.0, 0.8, 0.5) * (0.5 * exp(-(r - 1.0) * 1.6) * step(1.0, r) + 0.12 / (r * r + 0.5));
  gl_FragColor = vec4(min(c, vec3(1.0)), 1.0);
}`;

// lens flare over the terrain, only when the Sun is actually visible (disc share)
const GLARE_FS = /* glsl */ `
uniform float uK;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = uK * (0.35 * exp(-r * 9.0) + 0.1 * exp(-r * 3.0)) * (1.0 - smoothstep(0.8, 1.0, r));
  gl_FragColor = vec4(vec3(1.0, 0.88, 0.7) * a, 1.0);
}`;

const EARTH_VS = /* glsl */ `
varying vec3 vN;
void main() {
  vN = normalMatrix * normal; // camera frame: z towards us (for the rim)
  gl_Position = projectionMatrix * (modelViewMatrix * vec4(position, 1.0));
}`;

// Earth: phase from the Sun direction; stylised clouds (ocean and clouds, no continents)
const EARTH_FS = /* glsl */ `
uniform vec3 uSun; // camera frame
varying vec3 vN;
float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float noise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), u.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), u.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float fbm(vec3 p) {
  float h = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { h += a * noise(p); p *= 2.13; a *= 0.5; }
  return h;
}
void main() {
  vec3 n = normalize(vN);
  // clouds: swirled bands (noise-warped coordinates) and wider belts near the "equator" y = 0
  vec3 q = n * 3.0 + vec3(fbm(n * 2.0), fbm(n * 2.0 + 5.2), fbm(n * 2.0 + 9.7)) * 1.6;
  float cl = fbm(q * 1.4) + 0.12 * (1.0 - abs(n.y)) - 0.06;
  cl = smoothstep(0.5, 0.72, cl);
  vec3 ocean = mix(vec3(0.02, 0.09, 0.3), vec3(0.04, 0.18, 0.42), fbm(n * 6.0));
  vec3 day = mix(ocean, vec3(0.92, 0.94, 0.97), cl);
  vec3 L = normalize(uSun);
  float mu = dot(n, L);
  vec3 c = day * smoothstep(-0.04, 0.2, mu) * (0.3 + 0.7 * max(mu, 0.0));
  // thin atmosphere: blue rim on the day side
  float rim = pow(1.0 - max(n.z, 0.0), 3.0);
  c += vec3(0.25, 0.5, 1.0) * rim * 0.5 * smoothstep(-0.1, 0.3, mu);
  gl_FragColor = vec4(pow(c, vec3(1.0 / 1.6)), 1.0);
}`;

// --------------------------------------------------------------------------- //
// component
// --------------------------------------------------------------------------- //

interface Look {
  yaw: number; // azimuth from the observer's north, °
  pitch: number; // °
  fov: number; // vertical field of view, °
}

interface Orbit {
  yaw: number; // camera heading, azimuth from the patch's north, °
  pitch: number; // angle above the horizon, °
  dist: number; // camera to the look-at point, m
  e: number; // look-at point in the patch frame, m
  n: number;
}

const ABOVE_FOV = 45;

type Status ={ kind: "loading"; frac: number; what: string } | { kind: "ready" } | { kind: "failed"; msg: string };

function lite(): boolean {
  return window.matchMedia("(max-width: 960px), (pointer: coarse)").matches;
}

function fmtAz(a: number): string {
  return `${Math.round(((a % 360) + 360) % 360)}°`;
}

export default function SiteView3D({ ephem, anyPoint, target, t, readout, landmarks, mode, onMode, onClose }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "loading", frac: 0, what: "terrain" });
  const [look, setLook] = useState<Look>({ yaw: 0, pitch: 2, fov: 60 });
  const lookRef = useRef(look);
  lookRef.current = look;
  const [region, setRegion] = useState<Region | null>(null);
  const [sky, setSky] = useState<{ sunAz: number; sunEl: number; earthAz: number; earthEl: number } | null>(null);
  const [orbit, setOrbit] = useState<Orbit>({ yaw: 0, pitch: 38, dist: 9000, e: 0, n: 0 });
  const orbitRef = useRef(orbit);
  orbitRef.current = orbit;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const eng = useRef<Engine | null>(null);
  const aimed = useRef(false);

  // --- engine: created once
  useEffect(() => {
    const e = new Engine(canvas.current!, overlay.current!, wrap.current!);
    eng.current = e;
    if (import.meta.env.DEV) (window as unknown as { __v3: Engine }).__v3 = e; // for debugging in the console
    return () => {
      e.dispose();
      eng.current = null;
    };
  }, []);

  // --- patch: where the centre is. For a route, the middle of the path if it all fits, else the rover.
  const spec = regionSpec(anyPoint, target.x, target.y, lite());
  const centre = regionCentre(target, region, spec.half);
  const ckey = `${Math.round(centre[0])},${Math.round(centre[1])}`;
  // keep the old patch while the new one loads (otherwise the eye ends up outside it)
  const here = region && `${Math.round(region.cx)},${Math.round(region.cy)}` === ckey ? region : null;
  useEffect(() => {
    let alive = true;
    setStatus({ kind: "loading", frac: 0, what: "terrain" });
    loadRegion(anyPoint, centre[0], centre[1], lite(), (frac, what) => alive && setStatus({ kind: "loading", frac, what }), () => alive)
      .then((r) => {
        if (!alive || !r) return;
        eng.current?.setRegion(r);
        setRegion(r);
        setStatus({ kind: "ready" });
      })
      .catch((err) => alive && setStatus({ kind: "failed", msg: String(err) }));
    return () => { alive = false; };
  }, [ckey]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- observer: eye 2 m above the ground; far silhouette from the horizon profile at this point
  const [lat, lon] = xyToLatLon(target.x, target.y);
  useEffect(() => {
    const e = eng.current;
    if (!e || !here) return;
    e.setObserver(lat, lon, target.groundZ);
    let alive = true;
    anyPoint.far.at(here.zone, target.x, target.y, target.groundZ + EYE_M).then((far) => {
      if (alive && far) e.setRing(far.elev);
    });
    return () => { alive = false; };
  }, [here, lat, lon, target.groundZ, target.x, target.y, anyPoint]);

  useEffect(() => {
    eng.current?.setRoute(here && target.route ? target.route : null, target.waypoints ?? null);
  }, [here, target.route, target.waypoints]);

  const obsLabel = target.kind === "route" ? "ROVER" : target.name.toUpperCase();
  useEffect(() => {
    eng.current?.setMode(mode, obsLabel);
  }, [mode, obsLabel, here]);

  useEffect(() => {
    eng.current?.setLandmarks(landmarks);
  }, [here, landmarks, lat, lon]);

  // --- sky at time t
  useEffect(() => {
    const e = eng.current;
    if (!e || !here) return;
    setSky(e.setTime(ephem, t, readout?.sunFrac ?? 0, readout?.earthFrac ?? 0));
  }, [here, ephem, t, readout?.sunFrac, readout?.earthFrac, lat, lon]);

  // first look is at the Sun (or Earth if the Sun is down); again at a new place,
  // but not every time the rover moves
  const who = target.kind === "route" ? "route" : `${Math.round(target.x)},${Math.round(target.y)}`;
  useEffect(() => { aimed.current = false; }, [who]);
  useEffect(() => {
    if (!sky || aimed.current) return;
    aimed.current = true;
    const onSun = sky.sunEl > -3;
    setLook({ yaw: onSun ? sky.sunAz : sky.earthAz, pitch: Math.max(1, Math.min(8, (onSun ? sky.sunEl : sky.earthEl) + 2)), fov: 60 });
  }, [sky]);

  useEffect(() => {
    eng.current?.setLook(look);
  }, [look, region]);

  // from above: frame the whole route (or place) with the Sun from the side, where relief reads best
  const fitted = useRef("");
  const fit = () => {
    const box = eng.current?.fitBox();
    if (!box || !sky) return;
    // route fully in frame; place or point with ~10 km around it
    const dist = Math.min(90_000, box.ext > 0 ? Math.max(4000, box.ext * 1.5 + 3000) : 14_000);
    setOrbit({ yaw: sky.sunAz + 90, pitch: 38, dist, e: box.e, n: box.n });
  };
  useEffect(() => {
    if (mode !== "above" || !here || !sky || fitted.current === `${who}|${ckey}`) return;
    fitted.current = `${who}|${ckey}`;
    fit();
  }, [mode, here, sky, who, ckey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    eng.current?.setOrbit(orbit);
  }, [orbit, region]);

  // --- controls: drag to look around, wheel / pinch to zoom
  useEffect(() => {
    const cv = overlay.current!;
    const pts = new Map<number, [number, number]>();
    let pinch = 0;
    let panning = false;
    const centroid = () => {
      const v = [...pts.values()];
      return [v.reduce((s, p) => s + p[0], 0) / v.length, v.reduce((s, p) => s + p[1], 0) / v.length];
    };
    const down = (e: PointerEvent) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      // from above: right button or Shift pans instead of rotating
      panning = e.button === 2 || e.shiftKey;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
      }
    };
    const move = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const c0 = centroid();
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      const c1 = centroid();
      if (modeRef.current === "above") {
        const O = orbitRef.current;
        if (pts.size === 2) {
          // two fingers: pinch zooms, moving pans
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
          const next = pan(O, c1[0] - c0[0], c1[1] - c0[1], cv.clientHeight);
          setOrbit({ ...next, dist: pinch > 0 ? clampDist(O.dist * (pinch / d)) : O.dist });
          pinch = d;
          return;
        }
        const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
        if (panning) setOrbit(pan(O, dx, dy, cv.clientHeight));
        else setOrbit({ ...O, yaw: O.yaw - dx * 0.3, pitch: clampOrbitPitch(O.pitch + dy * 0.25) });
        return;
      }
      const L = lookRef.current;
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch > 0) setLook({ ...L, fov: clampFov(L.fov * (pinch / d)) });
        pinch = d;
        return;
      }
      const k = L.fov / cv.clientHeight;
      setLook({ yaw: L.yaw - (e.clientX - prev[0]) * k, pitch: clampPitch(L.pitch + (e.clientY - prev[1]) * k), fov: L.fov });
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      pinch = 0;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (modeRef.current === "above") {
        const O = orbitRef.current;
        setOrbit({ ...O, dist: clampDist(O.dist * Math.exp(e.deltaY * 0.0012)) });
        return;
      }
      const L = lookRef.current;
      setLook({ ...L, fov: clampFov(L.fov * Math.exp(e.deltaY * 0.0012)) });
    };
    const menu = (e: Event) => e.preventDefault();
    cv.addEventListener("contextmenu", menu);
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cv.removeEventListener("contextmenu", menu);
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
      cv.removeEventListener("wheel", wheel);
    };
  }, []);

  // smoothly turn back to the body
  const anim = useRef(0);
  const aim = (az: number, el: number, fov: number) => {
    cancelAnimationFrame(anim.current);
    const from = lookRef.current;
    const dy = ((((az - from.yaw) % 360) + 540) % 360) - 180;
    const to = { yaw: from.yaw + dy, pitch: clampPitch(el), fov };
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 600);
      const s = k * k * (3 - 2 * k);
      setLook({ yaw: from.yaw + (to.yaw - from.yaw) * s, pitch: from.pitch + (to.pitch - from.pitch) * s,
                fov: from.fov * Math.pow(to.fov / from.fov, s) });
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(anim.current), []);
  const lookSun = () => sky && aim(sky.sunAz, sky.sunEl, Math.min(look.fov, 40));
  const lookEarth = () => sky && aim(sky.earthAz, sky.earthEl, 8);

  const onKey = (e: React.KeyboardEvent) => {
    const L = lookRef.current;
    const k = L.fov / 12;
    const O = orbitRef.current;
    const h = overlay.current?.clientHeight ?? 500;
    const map: Record<string, () => void> = mode === "above" ? {
      ArrowLeft: () => setOrbit(e.shiftKey ? pan(O, 40, 0, h) : { ...O, yaw: O.yaw - 10 }),
      ArrowRight: () => setOrbit(e.shiftKey ? pan(O, -40, 0, h) : { ...O, yaw: O.yaw + 10 }),
      ArrowUp: () => setOrbit(e.shiftKey ? pan(O, 0, 40, h) : { ...O, pitch: clampOrbitPitch(O.pitch + 5) }),
      ArrowDown: () => setOrbit(e.shiftKey ? pan(O, 0, -40, h) : { ...O, pitch: clampOrbitPitch(O.pitch - 5) }),
      "+": () => setOrbit({ ...O, dist: clampDist(O.dist / 1.25) }),
      "=": () => setOrbit({ ...O, dist: clampDist(O.dist / 1.25) }),
      "-": () => setOrbit({ ...O, dist: clampDist(O.dist * 1.25) }),
      f: fit,
      v: () => onMode("eye"),
      Escape: onClose,
    } : {
      v: () => onMode("above"),
      ArrowLeft: () => setLook({ ...L, yaw: L.yaw - k }),
      ArrowRight: () => setLook({ ...L, yaw: L.yaw + k }),
      ArrowUp: () => setLook({ ...L, pitch: clampPitch(L.pitch + k) }),
      ArrowDown: () => setLook({ ...L, pitch: clampPitch(L.pitch - k) }),
      "+": () => setLook({ ...L, fov: clampFov(L.fov / 1.25) }),
      "=": () => setLook({ ...L, fov: clampFov(L.fov / 1.25) }),
      "-": () => setLook({ ...L, fov: clampFov(L.fov * 1.25) }),
      s: lookSun,
      e: lookEarth,
      Escape: onClose,
    };
    const f = map[e.key];
    if (f) {
      e.preventDefault();
      f();
    }
  };

  const loading = status.kind === "loading";
  const above = mode === "above";
  const r = readout;
  return (
    <div ref={wrap} className="view3d">
      <canvas ref={canvas} className="view3d-gl" />
      <canvas ref={overlay} className="view3d-hud" tabIndex={0} onKeyDown={onKey} role="img"
              aria-label={above
                ? `Terrain around ${target.kind === "route" ? "the route" : target.name} seen from above. Drag to orbit, right-drag or Shift to pan, scroll to zoom, F to fit, V for the view from the ground.`
                : `View from ${target.name}, looking ${fmtAz(look.yaw)}. Drag to look around, arrow keys to turn, plus and minus to zoom, S and E to face the Sun or Earth, V for the view from above.`} />
      <Brackets />
      <div className="v3-title">
        <b>{above ? (target.kind === "route" ? "ABOVE THE ROUTE" : `ABOVE ${target.name.toUpperCase()}`)
                  : target.kind === "route" ? "FROM THE ROVER" : `FROM ${target.name.toUpperCase()}`}</b>
        <span className="mono">{fmtLat(lat)} {fmtLon(lon)} · {Math.round(target.groundZ)} m{above ? "" : ` · eye ${EYE_M} m`}</span>
        <span className="mono muted">{fmtDateTime(t)} UTC</span>
      </div>
      <div className="v3-tools">
        <div className="seg v3-mode" role="group" aria-label="Camera">
          <button className={above ? "" : "on"} aria-pressed={!above} onClick={() => onMode("eye")}>Ground</button>
          <button className={above ? "on" : ""} aria-pressed={above} onClick={() => onMode("above")}>Above</button>
        </div>
        {above ? (
          <button className="tool" onClick={fit} disabled={!sky} title="Show the whole route (or place) again">Fit</button>
        ) : (
          <>
            <button className="tool" onClick={lookSun} disabled={!sky}>
              <i className="v3-dot" style={{ background: T.sun }} />Sun
            </button>
            <button className="tool" onClick={lookEarth} disabled={!sky}>
              <i className="v3-dot" style={{ background: T.earth }} />Earth
            </button>
          </>
        )}
        <button className="tool" onClick={onClose}>Map</button>
      </div>
      {r && sky && (
        <div className="v3-readout">
          <div>
            <span className="dot" style={r.sunFrac > 0 ? { background: T.sun } : { border: `1.5px solid ${T.sun}` }} />
            <span>{r.sunFrac >= 0.999 ? "Sun in view" : r.sunFrac > 0 ? `Sun ${Math.round(r.sunFrac * 100)}% visible` : "Sun hidden"}</span>
            <span className="muted mono">{clearText(r.sunClear)} · az {fmtAz(sky.sunAz)}</span>
          </div>
          <div>
            <span className="dot" style={r.earthFrac > 0 ? { background: T.earth } : { border: `1.5px solid ${T.earth}` }} />
            <span>{r.earthFrac > 0 ? "Earth in view" : "Earth hidden"}</span>
            <span className="muted mono">{clearText(r.earthClear)} · az {fmtAz(sky.earthAz)}</span>
          </div>
        </div>
      )}
      <div className="v3-foot mono">
        <span>{above ? `${(orbit.dist / 1000).toFixed(1)} km away · drag to orbit, right-drag to pan, scroll to zoom`
                     : `${Math.round(look.fov)}° field · drag to look, scroll to zoom`}</span>
        <span className="muted">Terrain: LOLA {region ? `${region.hm.step} m` : ""} to {Math.round(spec.half / 1000)} km, distant mountains from the horizon profile. True vertical scale.</span>
      </div>
      {loading && (
        <div className="stage-card">
          <div className="panel v3-load">
            <b>{status.what === "terrain" ? "Loading terrain" : "Tracing distant mountains"}</b>
            <div className="v3-bar"><i style={{ width: `${Math.round(status.frac * 100)}%` }} /></div>
          </div>
        </div>
      )}
      {status.kind === "failed" && (
        <div className="stage-card">
          <div className="panel v3-load">
            <b>Could not build the 3D view</b>
            <p>{status.msg}</p>
            <div className="btn-row"><button className="btn primary" onClick={onClose}>Back to the map</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function clearText(c: number): string {
  return c >= 0 ? `${c.toFixed(1)}° over terrain` : `${(-c).toFixed(1)}° below the ridge`;
}

const clampPitch = (p: number) => Math.min(85, Math.max(-80, p));
const clampFov = (f: number) => Math.min(100, Math.max(2, f));
const clampOrbitPitch = (p: number) => Math.min(89, Math.max(6, p));
const clampDist = (d: number) => Math.min(120_000, Math.max(300, d));

/** Pan the look-at point: the ground follows the finger. Scale = frame width at the look-at distance. */
function pan(O: Orbit, dx: number, dy: number, heightPx: number): Orbit {
  const k = (2 * O.dist * Math.tan((ABOVE_FOV * DEG) / 2)) / heightPx;
  const sy = Math.sin(O.yaw * DEG), cy = Math.cos(O.yaw * DEG);
  // right of the view direction is (cos, −sin); forward is (sin, cos); forward is foreshortened by pitch
  const fwd = (dy * k) / Math.max(Math.sin(O.pitch * DEG), 0.3);
  return { ...O, e: O.e - dx * k * cy + fwd * sy, n: O.n + dx * k * sy + fwd * cy };
}

function regionCentre(target: ViewTarget, current: Region | null, half: number): [number, number] {
  if (target.kind !== "route" || !target.route?.length) return [target.x, target.y];
  const xs = target.route.map((p) => p.x), ys = target.route.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // the whole path fits with a margin: one patch for the whole route
  if (Math.max(x1 - x0, y1 - y0) / 2 < half - 8000) return [(x0 + x1) / 2, (y0 + y1) / 2];
  // otherwise around the rover; moved only when it nears the edge
  if (current && Math.hypot(target.x - current.cx, target.y - current.cy) < half - 12_000) return [current.cx, current.cy];
  return [target.x, target.y];
}

// --------------------------------------------------------------------------- //
// three.js
// --------------------------------------------------------------------------- //

class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(60, 1, 0.5, 400_000);
  private skyGroup = new THREE.Group();
  private starGroup = new THREE.Group();
  private sun: THREE.Mesh;
  private sunMat: THREE.ShaderMaterial;
  private glare: THREE.Mesh;
  private glareMat: THREE.ShaderMaterial;
  private earth: THREE.Mesh;
  private earthMat: THREE.ShaderMaterial;
  private terrainMat: THREE.ShaderMaterial | null = null;
  private terrain: THREE.Mesh[] = [];
  private ring: THREE.Mesh | null = null;
  private ringMat: THREE.ShaderMaterial;
  private route: Line2[] = [];
  private routeLocal: Vec3[] = []; // path points in the patch frame, for "show the whole route"
  private waypoints: Vec3[] = [];
  private skirt: THREE.Mesh | null = null;
  private mode: ViewMode = "eye";
  private orbit: Orbit = { yaw: 0, pitch: 38, dist: 9000, e: 0, n: 0 };
  private camLocal: Vec3 = [0, 0, 0];
  private obsLabel = "";
  private sunFrac = 0;
  private allMarks: { name: string; p: Vec3 }[] = [];
  private region: Region | null = null;
  private obs: { lat: number; lon: number; eye: Vec3; basis: [Vec3, Vec3, Vec3]; groundZ: number } | null = null;
  private look: Look = { yaw: 0, pitch: 0, fov: 60 };
  private sunDir: Vec3 = [0, 0, 1];
  private radii = { sun: 0.0046, earth: 0.0165 };
  private seen = { sun: true, earth: true }; // body visible from the eye (same numbers as the panel)
  private earthDir: Vec3 = [0, 0, 1];
  private marks: { name: string; p: Vec3; km: number }[] = [];
  private landmarks: Landmark[] = [];
  private raf = 0;
  private ro: ResizeObserver;
  private readonly overlay: HTMLCanvasElement;
  private readonly linear: boolean;
  private readonly steps: number;

  constructor(canvas: HTMLCanvasElement, overlay: HTMLCanvasElement, wrap: HTMLElement) {
    this.overlay = overlay;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, reversedDepthBuffer: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 1);
    this.linear = this.renderer.extensions.has("OES_texture_float_linear");
    this.steps = lite() ? 56 : 110;
    this.scene.add(this.skyGroup);
    this.skyGroup.add(this.starGroup);
    this.starGroup.matrixAutoUpdate = false;
    this.buildStars();

    this.sunMat = new THREE.ShaderMaterial({
      vertexShader: SPRITE_VS, fragmentShader: SUN_FS, uniforms: { uR: { value: 0.0046 }, uSpan: { value: 4 * DEG } },
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.sunMat);
    this.sun.renderOrder = -8;
    this.skyGroup.add(this.sun);

    this.earthMat = new THREE.ShaderMaterial({
      vertexShader: EARTH_VS, fragmentShader: EARTH_FS, uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) } },
      depthTest: false, depthWrite: false,
    });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.earthMat);
    this.earth.renderOrder = -7;
    this.skyGroup.add(this.earth);

    this.glareMat = new THREE.ShaderMaterial({
      vertexShader: SPRITE_VS, fragmentShader: GLARE_FS, uniforms: { uK: { value: 0 } },
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.glare = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.glareMat);
    this.glare.renderOrder = 10;
    this.skyGroup.add(this.glare);

    this.ringMat = new THREE.ShaderMaterial({
      vertexShader: RING_VS, fragmentShader: RING_FS,
      uniforms: { uSun: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3(0, 1, 0) },
                  uEye: { value: new THREE.Vector3() }, uExposure: { value: 16 } },
    });

    this.ro = new ResizeObserver(() => this.resize(wrap));
    this.ro.observe(wrap);
    this.resize(wrap);
  }

  private resize(wrap: HTMLElement) {
    const w = Math.max(1, wrap.clientWidth), h = Math.max(1, wrap.clientHeight);
    const pr = Math.min(window.devicePixelRatio || 1, lite() ? 1 : 1.5);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.overlay.width = Math.round(w * (window.devicePixelRatio || 1));
    this.overlay.height = Math.round(h * (window.devicePixelRatio || 1));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const l of this.route) (l.material as LineMaterial).resolution.set(w, h);
    this.invalidate();
  }

  private buildStars() {
    const pos: number[] = [];
    const b: number[] = [];
    for (const [ra, de, mag] of BRIGHT_STARS) {
      const d = radec(ra, de);
      pos.push(d[0], d[1], d[2]);
      b.push(Math.min(1.6, Math.max(0.25, 0.35 + 0.32 * (2.6 - mag))));
    }
    for (const s of backgroundStars(7000)) {
      pos.push(...s.dir);
      b.push(0.06 + 0.3 * s.b);
    }
    // Magellanic Clouds: hazy clusters of faint points
    const r = rng(11);
    for (const [ra, de, size] of CLOUDS) {
      const c = radec(ra, de);
      const e1 = normalize(cross([0, 0, 1], c)), e2 = cross(c, e1);
      for (let i = 0; i < 700; i++) {
        const g1 = gauss(r) * size * 0.35 * DEG, g2 = gauss(r) * size * 0.2 * DEG;
        pos.push(c[0] + e1[0] * g1 + e2[0] * g2, c[1] + e1[1] * g1 + e2[1] * g2, c[2] + e1[2] * g1 + e2[2] * g2);
        b.push(0.04 + 0.06 * r());
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos.map((v) => v * 1000), 3));
    g.setAttribute("aB", new THREE.Float32BufferAttribute(b, 1));
    const m = new THREE.ShaderMaterial({
      vertexShader: STAR_VS, fragmentShader: STAR_FS, uniforms: { uPx: { value: window.devicePixelRatio || 1 } },
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, m);
    pts.renderOrder = -10;
    pts.frustumCulled = false;
    this.starGroup.add(pts);
  }

  setRegion(r: Region) {
    this.region = r;
    for (const m of this.terrain) {
      m.geometry.dispose();
      this.scene.remove(m);
    }
    this.terrain = [];
    this.terrainMat?.uniforms.uH.value.dispose();
    this.terrainMat?.uniforms.uFar.value.dispose();
    this.terrainMat?.dispose();

    const { hm } = r;
    const S = hm.size;
    const pos = new Float32Array(S * S * 3);
    let maxU = -Infinity;
    for (let j = 0; j < S; j++) {
      for (let i = 0; i < S; i++) {
        const k = j * S + i;
        const u = hm.u[k];
        maxU = Math.max(maxU, u);
        pos[k * 3] = -hm.half + i * hm.step;
        pos[k * 3 + 1] = u;
        pos[k * 3 + 2] = hm.half - j * hm.step;
      }
    }
    // cells in square rings from the centre out: the observer is near the centre, so the near
    // ones draw first and the early depth test skips the heavy shader for hidden far ones
    const C = S - 1;
    const mid = (C - 1) / 2;
    const ringOf = (i: number, j: number) => Math.round(Math.max(Math.abs(i - mid), Math.abs(j - mid)));
    const start = new Uint32Array(Math.ceil(mid) + 3);
    for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) start[ringOf(i, j) + 1]++;
    for (let k = 1; k < start.length; k++) start[k] += start[k - 1];
    const cells = new Uint32Array(C * C);
    for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) cells[start[ringOf(i, j)]++] = j * S + i;
    const idx = new Uint32Array(C * C * 6);
    let p = 0;
    for (const a of cells) {
      const b = a + 1, c = a + S, d = c + 1;
      // counter-clockwise seen from above (+y)
      idx[p++] = a; idx[p++] = b; idx[p++] = d;
      idx[p++] = a; idx[p++] = d; idx[p++] = c;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();

    const hTex = new THREE.DataTexture(hm.u, S, S, THREE.RedFormat, THREE.FloatType);
    hTex.minFilter = hTex.magFilter = this.linear ? THREE.LinearFilter : THREE.NearestFilter;
    hTex.generateMipmaps = false;
    hTex.needsUpdate = true;
    const fTex = new THREE.DataTexture(new Float32Array(r.K * r.K * 4), r.K, r.K, THREE.RGBAFormat, THREE.FloatType);
    fTex.minFilter = fTex.magFilter = THREE.NearestFilter;
    fTex.generateMipmaps = false;
    fTex.needsUpdate = true;

    const reach = hm.half * 2.9;
    this.terrainMat = new THREE.ShaderMaterial({
      vertexShader: TERRAIN_VS, fragmentShader: TERRAIN_FS,
      defines: { STEPS: this.steps, ...(this.linear ? { LINEAR: 1 } : {}) },
      uniforms: {
        uH: { value: hTex }, uFar: { value: fTex }, uSize: { value: S }, uStep: { value: hm.step }, uHalf: { value: hm.half },
        uMaxU: { value: maxU + 1 }, uK: { value: r.K }, uNodeHalf: { value: r.nodeHalf }, uSunR: { value: 0.0046 },
        uExposure: { value: 16 }, uGrow: { value: Math.pow(reach / (hm.step * 0.75), 1 / this.steps) }, uAmbient: { value: 0.006 },
        uSun: { value: new THREE.Vector3(0, 0, 1) }, uCam: { value: new THREE.Vector3() },
      },
    });
    const mesh = new THREE.Mesh(g, this.terrainMat);
    mesh.renderOrder = 1;
    mesh.frustumCulled = false;
    this.terrain = [mesh];
    this.scene.add(mesh);
    this.buildSkirt(r);
    this.invalidate();
  }

  // diorama walls: four sides from the terrain edge to a common floor
  private buildSkirt(r: Region) {
    if (this.skirt) {
      this.skirt.geometry.dispose();
      (this.skirt.material as THREE.Material).dispose();
      this.scene.remove(this.skirt);
    }
    const { hm } = r;
    const S = hm.size;
    let minU = Infinity;
    for (const u of hm.u) minU = Math.min(minU, u);
    const base = minU - 600;
    const pos: number[] = [];
    const top: number[] = [];
    const idx: number[] = [];
    const sides: ((k: number) => [number, number])[] = [
      (k) => [k, 0], (k) => [S - 1, k], (k) => [S - 1 - k, S - 1], (k) => [0, S - 1 - k],
    ];
    for (const side of sides) {
      const v0 = pos.length / 3;
      for (let k = 0; k < S; k++) {
        const [i, j] = side(k);
        const e = -hm.half + i * hm.step, n = -hm.half + j * hm.step;
        pos.push(...v3([e, n, hm.u[j * S + i]]).toArray(), ...v3([e, n, base]).toArray());
        top.push(1, 0);
        if (k > 0) {
          const a = v0 + 2 * (k - 1);
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aTop", new THREE.Float32BufferAttribute(top, 1));
    g.setIndex(idx);
    this.skirt = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: SKIRT_VS, fragmentShader: SKIRT_FS, side: THREE.DoubleSide }));
    this.skirt.frustumCulled = false;
    this.skirt.renderOrder = 2;
    this.skirt.visible = this.mode === "above";
    this.scene.add(this.skirt);
  }

  setObserver(lat: number, lon: number, groundZ: number) {
    const r = this.region;
    if (!r) return;
    const basis = observerBasis(r.frame, lat, lon);
    const p = siteVector(lat, lon, groundZ + EYE_M);
    const c = r.frame.c;
    const d: Vec3 = [(p[0] - c[0]) * 1000, (p[1] - c[1]) * 1000, (p[2] - c[2]) * 1000];
    const f = r.frame;
    const e = d[0] * f.e[0] + d[1] * f.e[1] + d[2] * f.e[2];
    const n = d[0] * f.n[0] + d[1] * f.n[1] + d[2] * f.n[2];
    let u = d[0] * f.u[0] + d[1] * f.u[1] + d[2] * f.u[2];
    // eye not below the drawn surface (the 80 m model smooths peaks and pits)
    u = Math.max(u, heightAt(r.hm, e, n) + EYE_M);
    this.obs = { lat, lon, eye: [e, n, u], basis, groundZ };
    this.ringMat.uniforms.uEye.value.copy(v3(this.obs.eye));
    this.ringMat.uniforms.uUp.value.copy(v3(basis[2]));
    this.updateMarks();
    this.invalidate();
  }

  /** Far-mountain silhouette: the observer's horizon profile beyond the patch. */
  setRing(elev: Float32Array) {
    const o = this.obs;
    if (!o) return;
    if (this.ring) {
      this.ring.geometry.dispose();
      this.scene.remove(this.ring);
    }
    const n = elev.length;
    const [be, bn, bu] = o.basis;
    const pos: number[] = [];
    const top: number[] = [];
    const topE: number[] = [];
    for (let k = 0; k <= n; k++) {
      const az = ((k % n) * 2 * Math.PI) / n;
      const E = elev[k % n] <= -89 ? -3 : elev[k % n];
      for (const [el, isTop] of [[-8, 0], [E, 1]] as const) {
        const ce = Math.cos(el * DEG), se = Math.sin(el * DEG);
        const d = [0, 1, 2].map((c) => ce * (Math.sin(az) * be[c] + Math.cos(az) * bn[c]) + se * bu[c]);
        pos.push(...v3([o.eye[0] + d[0] * RING_M, o.eye[1] + d[1] * RING_M, o.eye[2] + d[2] * RING_M]).toArray());
        top.push(isTop);
        topE.push(E);
      }
    }
    const idx: number[] = [];
    for (let k = 0; k < n; k++) {
      const a = 2 * k;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aTop", new THREE.Float32BufferAttribute(top, 1));
    g.setAttribute("aE", new THREE.Float32BufferAttribute(topE, 1));
    g.setIndex(idx);
    this.ringMat.side = THREE.DoubleSide;
    this.ring = new THREE.Mesh(g, this.ringMat);
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 2;
    this.ring.visible = this.mode !== "above";
    this.scene.add(this.ring);
    this.invalidate();
  }

  /** Rover path coloured as on the map: sunlit / in shadow / still ahead. */
  setRoute(pts: RoutePt[] | null, waypoints: [number, number][] | null) {
    for (const l of this.route) {
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
      this.scene.remove(l);
    }
    this.route = [];
    this.routeLocal = [];
    this.waypoints = [];
    const r = this.region;
    if (!r || !pts || pts.length < 2) {
      this.invalidate();
      return;
    }
    const local = (x: number, y: number): Vec3 | null => {
      const [la, lo] = xyToLatLon(x, y);
      const l = toLocal(r.frame, siteVector(la, lo, 0));
      if (Math.abs(l[0]) > r.hm.half || Math.abs(l[1]) > r.hm.half) return null;
      return [l[0], l[1], heightAt(r.hm, l[0], l[1])];
    };
    const COL = { lit: new THREE.Color(T.sun), dark: new THREE.Color(T.night), ahead: new THREE.Color(T.text).multiplyScalar(0.55) };
    const pos: number[] = [];
    const col: number[] = [];
    for (let k = 0; k < pts.length - 1; k++) {
      // small steps so the line lies on the terrain
      const a = pts[k], b = pts[k + 1];
      const c = COL[a.state ?? "ahead"];
      const m = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 40));
      for (let s = 0; s <= m; s++) {
        if (s === m && k < pts.length - 2) break;
        const l = local(a.x + ((b.x - a.x) * s) / m, a.y + ((b.y - a.y) * s) / m);
        if (!l) continue;
        this.routeLocal.push(l);
        pos.push(...v3([l[0], l[1], l[2] + 1.2]).toArray());
        col.push(c.r, c.g, c.b);
      }
    }
    if (pos.length < 6) return;
    this.waypoints = (waypoints ?? []).map(([x, y]) => local(x, y)).filter((v): v is Vec3 => !!v);
    const geo = new LineGeometry();
    geo.setPositions(pos);
    geo.setColors(col);
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const mk = (o: ConstructorParameters<typeof LineMaterial>[0], order: number) => {
      const m = new LineMaterial(o);
      m.resolution.copy(size);
      const l = new Line2(geo, m);
      l.renderOrder = order;
      l.frustumCulled = false;
      this.scene.add(l);
      return l;
    };
    this.route = [
      mk({ color: 0x03070d, linewidth: 6 }, 3), // dark outline (opaque: drawn before the colour)
      mk({ vertexColors: true, linewidth: 3 }, 4),
      // from above: the part of the path behind a hill, faint through the terrain
      mk({ vertexColors: true, linewidth: 2, transparent: true, opacity: 0.28, depthTest: false, depthWrite: false }, 5),
    ];
    this.applyMode();
    this.invalidate();
  }

  setLandmarks(list: Landmark[]) {
    this.landmarks = list;
    this.updateMarks();
    this.invalidate();
  }

  // labels of sites actually visible from here (ray above the terrain)
  private updateMarks() {
    const r = this.region, o = this.obs;
    this.marks = [];
    this.allMarks = [];
    if (!r || !o) return;
    for (const lm of this.landmarks) {
      const [la, lo] = xyToLatLon(lm.x, lm.y);
      const l = toLocal(r.frame, siteVector(la, lo, 0));
      if (Math.abs(l[0]) > r.hm.half || Math.abs(l[1]) > r.hm.half) continue;
      const p: Vec3 = [l[0], l[1], Math.max(heightAt(r.hm, l[0], l[1]), sphereU(l[0], l[1], lm.groundZ)) + 3];
      const km = Math.hypot(p[0] - o.eye[0], p[1] - o.eye[1]) / 1000;
      if (km >= 0.2) this.allMarks.push({ name: lm.name, p });
      if (km < 0.2 || !lineOfSight(r.hm, o.eye, p)) continue;
      this.marks.push({ name: lm.name, p, km });
    }
  }

  /** Sun, Earth and stars at time t. Returns the bodies' azimuth and elevation for the observer. */
  setTime(ephem: Ephem, t: number, sunFrac: number, earthFrac: number) {
    this.seen = { sun: sunFrac > 0, earth: earthFrac > 0 };
    this.sunFrac = sunFrac;
    const r = this.region, o = this.obs;
    if (!r || !o) return null;
    const obsKm = siteVector(o.lat, o.lon, o.groundZ + EYE_M);
    const s = skyAt(ephem, r.frame, obsKm, t);
    this.sunDir = s.sun;
    this.radii = { sun: s.sunRadius, earth: s.earthRadius };
    this.earthDir = s.earth;
    const sun = v3(s.sun), earth = v3(s.earth);
    const span = 4 * DEG;
    this.sun.position.copy(sun.clone().multiplyScalar(1000));
    this.sun.scale.setScalar(1000 * Math.tan(span));
    this.sunMat.uniforms.uR.value = s.sunRadius;
    this.sunMat.uniforms.uSpan.value = span;
    this.glare.position.copy(sun.clone().multiplyScalar(1000));
    this.glare.scale.setScalar(1000 * Math.tan(30 * DEG));
    this.earth.position.copy(earth.clone().multiplyScalar(1000));
    this.earth.scale.setScalar(1000 * Math.sin(s.earthRadius));
    if (this.terrainMat) {
      this.terrainMat.uniforms.uSun.value.set(s.sun[0], s.sun[1], s.sun[2]);
      this.terrainMat.uniforms.uSunR.value = s.sunRadius;
      const tex = this.terrainMat.uniforms.uFar.value as THREE.DataTexture;
      (tex.image.data as Float32Array).set(farShadowData(r, s.sun));
      tex.needsUpdate = true;
    }
    this.ringMat.uniforms.uSun.value.copy(sun);
    // stars: J2000 -> MOON_ME -> patch frame -> three.js
    const M = moonFixedFromJ2000(t);
    const f = r.frame;
    const col = (v: Vec3) => {
      const me = applyMat(M, v);
      return v3([me[0] * f.e[0] + me[1] * f.e[1] + me[2] * f.e[2], me[0] * f.n[0] + me[1] * f.n[1] + me[2] * f.n[2],
                 me[0] * f.u[0] + me[1] * f.u[1] + me[2] * f.u[2]]);
    };
    const X = col([1, 0, 0]), Y = col([0, 1, 0]), Z = col([0, 0, 1]);
    this.starGroup.matrix.makeBasis(X, Y, Z);
    this.starGroup.matrixWorldNeedsUpdate = true;
    this.invalidate();
    const [be, bn, bu] = o.basis;
    const azel = (d: Vec3) => {
      const x = d[0] * be[0] + d[1] * be[1] + d[2] * be[2];
      const y = d[0] * bn[0] + d[1] * bn[1] + d[2] * bn[2];
      const z = d[0] * bu[0] + d[1] * bu[1] + d[2] * bu[2];
      return [((Math.atan2(x, y) / DEG) + 360) % 360, Math.asin(Math.max(-1, Math.min(1, z))) / DEG];
    };
    const [sunAz, sunEl] = azel(s.sun);
    const [earthAz, earthEl] = azel(s.earth);
    return { sunAz, sunEl, earthAz, earthEl };
  }

  setLook(l: Look) {
    this.look = l;
    this.invalidate();
  }

  setOrbit(o: Orbit) {
    this.orbit = o;
    this.invalidate();
  }

  setMode(m: ViewMode, label: string) {
    this.mode = m;
    this.obsLabel = label;
    this.applyMode();
  }

  // what each mode shows: far silhouette only from the eye, walls and "path through the hill" only from above
  private applyMode() {
    const above = this.mode === "above";
    if (this.ring) this.ring.visible = !above;
    if (this.skirt) this.skirt.visible = above;
    if (this.route.length === 3) {
      (this.route[0].material as LineMaterial).linewidth = above ? 6 : 4.5;
      (this.route[1].material as LineMaterial).linewidth = above ? 3 : 2.5;
      this.route[2].visible = above;
    }
    this.invalidate();
  }

  /** Centre and extent to show from above: the route, or else the observer point. */
  fitBox(): { e: number; n: number; ext: number } | null {
    const pts = this.routeLocal.length ? this.routeLocal : this.obs ? [this.obs.eye] : [];
    if (!pts.length) return null;
    const es = pts.map((p) => p[0]), ns = pts.map((p) => p[1]);
    const [e0, e1, n0, n1] = [Math.min(...es), Math.max(...es), Math.min(...ns), Math.max(...ns)];
    return { e: (e0 + e1) / 2, n: (n0 + n1) / 2, ext: Math.max(e1 - e0, n1 - n0) };
  }

  get half(): number {
    return this.region?.hm.half ?? 30_000;
  }

  private dirOf(az: number, el: number): Vec3 {
    const [be, bn, bu] = this.obs!.basis;
    const ce = Math.cos(el * DEG), se = Math.sin(el * DEG), sa = Math.sin(az * DEG), ca = Math.cos(az * DEG);
    return [0, 1, 2].map((c) => ce * (sa * be[c] + ca * bn[c]) + se * bu[c]) as Vec3;
  }

  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private render() {
    const o = this.obs;
    const cam = this.camera;
    if (!o || !this.region) {
      this.renderer.render(new THREE.Scene(), cam);
      return;
    }
    const hm = this.region.hm;
    if (this.mode === "above") {
      // orbit around a point on the terrain; the camera doesn't dive under a hill
      const O = this.orbit;
      const tu = heightAt(hm, O.e, O.n);
      const ce = Math.cos(O.pitch * DEG), se = Math.sin(O.pitch * DEG);
      const P: Vec3 = [O.e - O.dist * ce * Math.sin(O.yaw * DEG), O.n - O.dist * ce * Math.cos(O.yaw * DEG), tu + O.dist * se];
      if (Math.abs(P[0]) < hm.half && Math.abs(P[1]) < hm.half) P[2] = Math.max(P[2], heightAt(hm, P[0], P[1]) + 40);
      this.camLocal = P;
      cam.position.copy(v3(P));
      cam.up.set(0, 1, 0);
      cam.fov = ABOVE_FOV;
      cam.near = Math.max(0.5, O.dist * 0.0005);
      cam.updateProjectionMatrix();
      cam.lookAt(v3([O.e, O.n, tu]));
    } else {
      this.camLocal = o.eye;
      cam.position.copy(v3(o.eye));
      cam.up.copy(v3(o.basis[2]));
      cam.fov = this.look.fov;
      cam.near = 0.5;
      cam.updateProjectionMatrix();
      cam.lookAt(v3(o.eye).add(v3(this.dirOf(this.look.yaw, this.look.pitch))));
    }
    cam.updateMatrixWorld();
    const eye = cam.position.clone();
    this.skyGroup.position.copy(eye);
    this.sun.lookAt(eye);
    this.glare.lookAt(eye);
    // lens flare only from the observer's eye (disc share from the calculation)
    this.glareMat.uniforms.uK.value = this.mode === "eye" ? this.sunFrac : 0;
    if (this.terrainMat) {
      const c = this.camLocal;
      this.terrainMat.uniforms.uCam.value.set(c[0], c[1], c[2]);
      this.terrainMat.uniforms.uAmbient.value = this.mode === "above" ? 0.0035 : 0.006;
    }
    this.earthMat.uniforms.uSun.value.copy(v3(this.sunDir)).transformDirection(cam.matrixWorldInverse);
    this.renderer.render(this.scene, cam);
    if (this.mode === "above") this.drawAbove();
    else this.drawHud();
  }

  // view from above: compass, observer or rover, route vertices, sites
  private drawAbove() {
    const cv = this.overlay;
    const ctx = cv.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.width / dpr, h = cv.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const o = this.obs!;
    const inv = this.camera.matrixWorldInverse;
    const ty = Math.tan((this.camera.fov * DEG) / 2), tx = ty * this.camera.aspect;
    const proj = (p: Vec3): [number, number] | null => {
      const q = v3(p).applyMatrix4(inv);
      if (q.z > -1) return null;
      const x = q.x / -q.z / tx, y = q.y / -q.z / ty;
      return Math.abs(x) < 1.2 && Math.abs(y) < 1.2 ? [((x + 1) / 2) * w, ((1 - y) / 2) * h] : null;
    };
    const diamond = (x: number, y: number, r: number, fill: string | null, stroke: string) => {
      ctx.beginPath();
      ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
    };
    ctx.font = `11px ${T.mono}`;
    const label = (x: number, y: number, a: string, b: string | null, color: string) => {
      const tw = Math.max(ctx.measureText(a).width, b ? ctx.measureText(b).width : 0);
      const lx = x + 10 + tw > w - 6 ? x - 10 - tw : x + 10;
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(3, 7, 13, 0.6)";
      ctx.fillRect(lx - 3, y - 12, tw + 6, b ? 28 : 16);
      ctx.fillStyle = color;
      ctx.fillText(a, lx, y);
      if (b) {
        ctx.fillStyle = T.muted;
        ctx.fillText(b, lx, y + 12);
      }
    };

    // catalog sites
    for (const m of this.allMarks) {
      const s = proj(m.p);
      if (!s) continue;
      diamond(s[0], s[1], 4, null, "rgba(227, 238, 245, 0.8)");
      label(s[0], s[1] - 2, m.name, null, "rgba(227, 238, 245, 0.85)");
    }
    // route vertices: start is a filled diamond
    this.waypoints.forEach((p, i) => {
      const s = proj([p[0], p[1], p[2] + 2]);
      if (s) diamond(s[0], s[1], 5, i === 0 ? T.text : T.bg, T.text);
    });
    // observer / rover: a post above the ground so it shows behind a slope
    const g = o.eye[2] - EYE_M;
    const base = proj([o.eye[0], o.eye[1], g]);
    const topP = proj([o.eye[0], o.eye[1], g + Math.max(40, this.orbit.dist * 0.03)]);
    if (base) {
      if (topP) {
        ctx.strokeStyle = T.both;
        ctx.beginPath();
        ctx.moveTo(base[0], base[1]);
        ctx.lineTo(topP[0], topP[1]);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(base[0], base[1], 5.5, 0, 2 * Math.PI);
      ctx.fillStyle = this.seen.sun ? T.sun : T.bg;
      ctx.fill();
      ctx.strokeStyle = T.both;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
      const at = topP ?? base;
      label(at[0], at[1], this.obsLabel, this.seen.sun ? "in sunlight" : "in shadow", T.both);
    }

    // compass: top is where the camera looks; Sun and Earth on the rim by azimuth
    const cx = w - 52, cy = 118, R = 28;
    ctx.fillStyle = "rgba(3, 7, 13, 0.72)";
    ctx.beginPath();
    ctx.arc(cx, cy, R + 13, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = "rgba(134, 201, 232, 0.45)";
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.stroke();
    const at = (az: number, r: number): [number, number] => {
      const a = (az - this.orbit.yaw) * DEG;
      return [cx + Math.sin(a) * r, cy - Math.cos(a) * r];
    };
    ctx.font = `600 10px ${T.mono}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const [az, n] of [[0, "N"], [90, "E"], [180, "S"], [270, "W"]] as const) {
      const [x, y] = at(az, R - 9);
      ctx.fillStyle = n === "N" ? T.text : T.faint;
      ctx.fillText(n, x, y);
    }
    const azOf = (d: Vec3) => Math.atan2(d[0], d[1]) / DEG;
    for (const [d, col, seen] of [[this.sunDir, T.sun, this.seen.sun], [this.earthDir, T.earth, this.seen.earth]] as const) {
      const [x, y] = at(azOf(d), R);
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, 2 * Math.PI);
      ctx.fillStyle = seen ? col : T.bg;
      ctx.fill();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.textBaseline = "alphabetic";
  }

  // azimuth scale at the top, true horizon line, site labels and arrows to the bodies
  private drawHud() {
    const cv = this.overlay;
    const ctx = cv.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.width / dpr, h = cv.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const o = this.obs!;
    const eye = this.camera.position.clone();
    const inv = this.camera.matrixWorldInverse;
    const ty = Math.tan((this.camera.fov * DEG) / 2), tx = ty * this.camera.aspect;
    const proj = (d: Vec3): [number, number, boolean] => {
      const p = eye.clone().add(v3(d).multiplyScalar(1000)).applyMatrix4(inv);
      if (p.z > -1e-3) return [0, 0, false]; // behind the camera
      const x = p.x / -p.z / tx, y = p.y / -p.z / ty;
      return [(x + 1) / 2 * w, (1 - y) / 2 * h, Math.abs(x) < 1.6 && Math.abs(y) < 1.6];
    };
    const L = this.look;

    // true horizon (0°): dashed
    ctx.strokeStyle = "rgba(134, 201, 232, 0.35)";
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    let pen = false;
    const hfov = L.fov * Math.max(1, w / h) * 0.75 + 5;
    for (let a = L.yaw - hfov; a <= L.yaw + hfov; a += 1) {
      const [x, y, ok] = proj(this.dirOf(a, 0));
      if (!ok) { pen = false; continue; }
      if (pen) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // azimuth scale
    ctx.font = `11px ${T.mono}`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(3, 7, 13, 0.55)";
    ctx.fillRect(0, 0, w, 26);
    const stepDeg = L.fov > 50 ? 10 : L.fov > 20 ? 5 : L.fov > 8 ? 2 : 1;
    const labelEvery = stepDeg * (L.fov > 50 ? 3 : 5);
    const names: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W" };
    for (let a = Math.ceil((L.yaw - hfov) / stepDeg) * stepDeg; a <= L.yaw + hfov; a += stepDeg) {
      const [x, , ok] = proj(this.dirOf(a, L.pitch));
      if (!ok || x < 0 || x > w) continue;
      const az = ((Math.round(a) % 360) + 360) % 360;
      const major = az % labelEvery === 0;
      ctx.strokeStyle = major ? T.bracket : "rgba(134, 201, 232, 0.4)";
      ctx.beginPath();
      ctx.moveTo(x, 26);
      ctx.lineTo(x, major ? 17 : 21);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = names[az] ? T.text : T.muted;
        ctx.fillText(names[az] ?? `${az}`, x, 12);
      }
    }
    // Sun and Earth: a mark on the scale or an arrow at the edge
    for (const [d, col, label] of [[this.sunDir, T.sun, "SUN"], [this.earthDir, T.earth, "EARTH"]] as const) {
      const [be, bn, bu] = o.basis;
      const az = Math.atan2(d[0] * be[0] + d[1] * be[1] + d[2] * be[2], d[0] * bn[0] + d[1] * bn[1] + d[2] * bn[2]) / DEG;
      const el = Math.asin(d[0] * bu[0] + d[1] * bu[1] + d[2] * bu[2]) / DEG;
      const [x, , ok] = proj(this.dirOf(az, L.pitch));
      ctx.fillStyle = col;
      if (ok && x >= 0 && x <= w) {
        ctx.beginPath();
        ctx.moveTo(x, 26); ctx.lineTo(x - 5, 33); ctx.lineTo(x + 5, 33);
        ctx.fill();
        const [bx, by, bok] = proj(d);
        if (bok && by > 40 && by < h - 20) {
          const rpx = (Math.tan(label === "SUN" ? this.radii.sun : this.radii.earth) / ty) * (h / 2);
          const seen = label === "SUN" ? this.seen.sun : this.seen.earth;
          ctx.textAlign = "left";
          ctx.globalAlpha = seen ? 1 : 0.6;
          ctx.fillText(`${label} ${el.toFixed(1)}°${seen ? "" : " · behind terrain"}`, bx + rpx * 0.75 + 10, by - rpx * 0.75 - 6);
          ctx.globalAlpha = 1;
          ctx.textAlign = "center";
        }
      } else {
        // off screen: arrow at the side edge, at the body's elevation if possible
        const right = (((az - L.yaw) % 360) + 360) % 360 < 180;
        const ex = right ? w - 12 : 12;
        const ey = Math.min(h - 110, Math.max(70, h / 2 - (el - L.pitch) * (h / L.fov))) + (label === "SUN" ? 0 : 18);
        ctx.beginPath();
        if (right) { ctx.moveTo(ex + 6, ey); ctx.lineTo(ex - 2, ey - 6); ctx.lineTo(ex - 2, ey + 6); }
        else { ctx.moveTo(ex - 6, ey); ctx.lineTo(ex + 2, ey - 6); ctx.lineTo(ex + 2, ey + 6); }
        ctx.fill();
        ctx.textAlign = right ? "right" : "left";
        ctx.fillText(label, right ? ex - 8 : ex + 8, ey + 4);
        ctx.textAlign = "center";
      }
    }
    // sites in view
    ctx.textAlign = "left";
    for (const m of this.marks) {
      const d = [m.p[0] - o.eye[0], m.p[1] - o.eye[1], m.p[2] - o.eye[2]];
      const n = Math.hypot(d[0], d[1], d[2]);
      const [x, y, ok] = proj([d[0] / n, d[1] / n, d[2] / n]);
      if (!ok || x < 0 || x > w || y < 30 || y > h) continue;
      ctx.strokeStyle = T.text;
      ctx.beginPath();
      ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, y - 4); ctx.lineTo(x, y - 18);
      ctx.stroke();
      const tw = Math.max(ctx.measureText(m.name).width, 50);
      const tx = x + 4 + tw > w - 6 ? x - 4 - tw : x + 4;
      ctx.fillStyle = T.text;
      ctx.fillText(m.name, tx, y - 22);
      ctx.fillStyle = T.muted;
      ctx.fillText(`${m.km.toFixed(1)} km`, tx, y - 9);
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.scene.traverse((obj) => {
      const m = obj as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.terrainMat?.uniforms.uH.value.dispose();
    this.terrainMat?.uniforms.uFar.value.dispose();
    this.renderer.dispose();
  }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
}
