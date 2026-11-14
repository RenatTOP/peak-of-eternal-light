// DATA & METHOD: how we compute, from what data, and how accurate it is.
import { Head, Panel } from "./hud";

export function MethodPage() {
  return (
    <div className="method">
      <div className="method-grid">
        <Panel>
          <Head num="01" label="HOW IT WORKS" />
          <p>
            For any spot and any dates, the browser traces the <b>real terrain horizon</b> in 720 directions
            and places the <b>Sun and Earth</b> in that local sky, hour by hour. A panel gets power while part
            of the solar disc is above the ridge line; direct-to-Earth radio works while part of Earth’s disc is.
          </p>
          <ul>
            <li><b>Solar energy</b>: mean visible share of the solar disc, the share of full-Sun power.</li>
            <li><b>Longest night</b>: longest stretch with the Sun fully hidden; it sizes the battery.</li>
            <li><b>Link to Earth</b>: share of time with any part of Earth above the terrain.</li>
            <li><b>Windows</b>: exact UTC intervals for sunlight, Earth link, both, and night.</li>
            <li><b>Power check</b>: a vertical panel turning to face the Sun, a battery and two loads. The craft
              operates while the panel covers its operating load and otherwise drops to survival mode on the battery.
              We step through the period and report whether the battery ever runs empty, the lowest charge, and the
              smallest battery that would never run empty.</li>
            <li><b>Terrain uncertainty</b>: for eight candidate sites NASA publishes 100 versions of the 5 m terrain,
              each within the error estimate of the LOLA model. We rerun every result on all 100 and show the
              5–95% range, plus how many versions the craft survives.</li>
          </ul>
          <p>
            Catalog sites use horizons precomputed from 5 m terrain. For any other point south of 60°S the near
            terrain (33–47 km) is traced live from LOLA tiles, 80 m poleward of 80°S and 120 m beyond, and distant
            mountains come from a precomputed grid (2 km / 5 km spacing), corrected for the observer’s height.
          </p>
        </Panel>
        <Panel>
          <Head num="02" label="DATA" />
          <ul>
            <li><b>Ephemerides</b>: NASA/JPL NAIF SPICE, DE440 planetary ephemeris and lunar orientation (MOON_ME), 2024–2035.</li>
            <li><b>Terrain</b>: LRO LOLA polar DEMs, 5 m at candidate sites, 20–240 m regional (Barker et al.).</li>
            <li><b>Near-site detail</b>: shape-from-shading 5 m terrain and LROC NAC mosaics of Artemis III regions (Bertone et al.).</li>
            <li><b>Reference maps</b>: average illumination, Earth visibility and permanent shadow to 65°S (Mazarico et al., Barker et al.).
              NASA publishes none beyond 65°S, so the 60–66°S band on the map is computed here with the same horizon model, over the same 18.6 years.</li>
            <li><b>Globe</b>: NASA SVS CGI Moon Kit, LROC WAC colour and LOLA topography. The poles are drawn as
              polar stereographic caps, the south one shaded from the 240 m LOLA polar DEM.</li>
          </ul>
          <p>Panels and antenna are assumed 2 m above the ground. Everything runs client-side; no server.</p>
        </Panel>
        <Panel>
          <Head num="03" label="VALIDATION" />
          <p>Average visibility over 18.6 years, our ray tracer against NASA’s published maps at 229 stratified points:</p>
          <table>
            <thead><tr><th>QUANTITY</th><th>CORRELATION</th><th>BIAS</th></tr></thead>
            <tbody>
              <tr><td>Sunlight</td><td>r = 0.995</td><td>−0.6 pp</td></tr>
              <tr><td>Earth visibility</td><td>r = 0.995</td><td>+1.1 pp</td></tr>
            </tbody>
          </table>
          <p>
            <b>Terrain uncertainty</b>: across the 100 terrain versions, annual sunlight varies by 0.2–1.2 pp (1σ)
            at the candidate sites, while the longest night can vary by days (Peak near Shackleton: 5.7–10.4 d),
            which matters for sizing the battery. The spread of each version against NASA’s base LOLA terrain is
            applied to our horizon; since our near terrain comes from the sharper shape-from-shading model, the
            range is a conservative (wider) estimate.
          </p>
          <p>
            Known events are reproduced: Chandrayaan-3 sunset on 4 September 2023 and sunrise on
            19–20 September, and IM-1 Odysseus sunset on 2 March 2024.
          </p>
          <p>
            <b>Any point on the map</b>: against full 5 m horizons, the live browser horizon differs by a median
            0.3 pp in annual sunlight (random points near the landing regions) and 0.2 pp at catalog sites.
            Errors grow where the Sun or Earth skims a sharp ridge that 80 m terrain smooths out,
            e.g. the rim of the Mons Mouton plateau.
          </p>
        </Panel>
      </div>
    </div>
  );
}
