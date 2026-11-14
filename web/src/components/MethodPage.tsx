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
          </ul>
          <p>
            Catalog sites use horizons precomputed from 5 m terrain. For any other point the near terrain
            (to ~33 km) is traced live from 80 m LOLA tiles, and distant mountains come from a precomputed
            2 km grid, corrected for the observer’s height.
          </p>
        </Panel>
        <Panel>
          <Head num="02" label="DATA" />
          <ul>
            <li><b>Ephemerides</b>: NASA/JPL NAIF SPICE, DE440 planetary ephemeris and lunar orientation (MOON_ME), 2024–2035.</li>
            <li><b>Terrain</b>: LRO LOLA polar DEMs, 5 m at candidate sites, 20–240 m regional (Barker et al.).</li>
            <li><b>Near-site detail</b>: shape-from-shading 5 m terrain and LROC NAC mosaics of Artemis III regions (Bertone et al.).</li>
            <li><b>Reference maps</b>: average illumination, Earth visibility and permanent shadow (Mazarico et al., Barker et al.).</li>
            <li><b>Globe</b>: NASA SVS CGI Moon Kit, LROC WAC colour and LOLA topography.</li>
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
            Known events are reproduced: Chandrayaan-3 sunset on 4 September 2023 and sunrise on
            19–20 September, and IM-1 Odysseus sunset on 2 March 2024. For arbitrary points the live
            horizon stays within about 2 pp of the 5 m catalog horizons.
          </p>
        </Panel>
      </div>
    </div>
  );
}
