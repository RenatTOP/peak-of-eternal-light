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
            <li><b>Rover traverse</b>: draw a route on the map. Every ~100–150 m along it the horizon is traced like a
              click anywhere, and the rover moves at a set speed while the Sun and Earth are placed in the sky of the spot
              where it is at each moment. Driving draws the operating load, in shadow from the battery; at 30% charge the
              rover parks to recharge and moves on at 80%, or, if it is steered from Earth, it also waits for Earth to rise.
              A year of departure dates shows when the traverse gets through and when the battery empties on the way.</li>
            <li><b>Around this spot</b>: 37 points in three hexagonal rings within 0.5–5 km each get their own traced
              horizon, run over the chosen period and craft. The spread is how much the result depends on where exactly
              the lander comes down; better spots must gain at least 2 points of energy (or 6 hours of night) and have a
              slope of 10° or less, measured on the same 80–120 m (or 474 m) terrain, so real slopes can only be steeper.</li>
            <li><b>Scenarios</b>: each pinned place and date range is run through exactly the same horizon, sky and
              power model as EXPLORE, with the craft set in POWER CHECK, and laid out by days since its own start, so a
              January and a July landing, or two different missions, line up side by side.</li>
            <li><b>Best landing dates</b>: for every day of the year, the same power model is run as if the craft landed
              that day with a full battery; a day is good if the charge never drops below 30% through the chosen
              mission length, tight if it survives with less, and red if the battery empties.</li>
            <li><b>Sunnier path</b>: each leg between your waypoints is rerouted as the cheapest path on a 100–600 m grid,
              where a step costs its length times (1 + 12 × darkness²), darkness being one minus NASA’s 18.6-year mean
              sunlight (plus an Earth term when the rover is steered from Earth), and steps steeper than 15° are not allowed.
              The traverse is then simulated again for your dates, so you see what the detour actually buys.</li>
          </ul>
          <p>
            Catalog sites use horizons precomputed from 5 m terrain. For any other point south of 60°S the near
            terrain (33–47 km) is traced live from LOLA tiles, 80 m poleward of 80°S and 120 m beyond, and distant
            mountains come from a precomputed grid (2 km / 5 km spacing), corrected for the observer’s height.
            Anywhere else on the Moon the horizon is traced live along 720 great circles from the global LOLA map:
            474 m terrain to 100 km and 1.9 km terrain from 100 to 300 km, where the Moon’s curvature already hides
            everything but large mountains. Landing sites off the pole (Apollo, Chang’e, SLIM, Blue Ghost 1) use horizons
            precomputed from 59 m SLDEM2015 terrain out to 40 km instead.
          </p>
        </Panel>
        <Panel>
          <Head num="02" label="DATA" />
          <ul>
            <li><b>Ephemerides</b>: NASA/JPL NAIF SPICE, DE440 planetary ephemeris and lunar orientation (MOON_ME), mid-1969 to 2035.</li>
            <li><b>Terrain</b>: LRO LOLA polar DEMs, 5 m at candidate sites, 20–240 m regional (Barker et al.);
              the rest of the Moon from the LOLA global map at 64 pixels per degree (PDS GDR, 474 m); landing sites
              off the pole from SLDEM2015, LOLA merged with Kaguya terrain-camera data at 512 pixels per degree (59 m, Barker et al. 2016).</li>
            <li><b>Near-site detail</b>: shape-from-shading 5 m terrain and LROC NAC mosaics of Artemis III regions (Bertone et al.).</li>
            <li><b>Reference maps</b> (also used to route the sunnier path): average illumination, Earth visibility and permanent shadow to 65°S (Mazarico et al., Barker et al.).
              NASA publishes none beyond 65°S, so the 60–66°S band on the map is computed here with the same horizon model, over the same 18.6 years.</li>
            <li><b>Missions</b>: NASA CLPS deliveries as of September 2026 (NASA Science CLPS pages and per-mission
              sources listed on each card). Planned landing regions are drawn as circles because exact sites are not published.
              For context the catalog also holds Apollo 11–17, other landers since 2013, and the impact sites of failed landings.</li>
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
            <b>Away from the pole</b>: the Sun’s elevation at the Apollo 11 and 12 touchdowns comes out at 10.70° and 5.14°,
            against 10.65° and 5.19° in the Apollo Lunar Surface Journal. At the Blue Ghost 1 site Firefly reported 346 hours
            of daylight after the 08:34 UTC landing and just over five hours of night before the last data at 23:15 UTC on
            16 March 2025, so daylight ended about 18:15–18:35. With the 59 m landing-site horizon the Sun starts to set at
            18:42 and is gone at 19:48; on the 474 m map it would be 19:16 and 20:22. Across the seven landing sites whose
            Sun sets within the mission window, the 59 m terrain moves sunset by −2 h to +9 min, mostly earlier: smoothed
            terrain hides hills and crater rims. Elsewhere off the pole expect timing errors of an hour or two; the nearest few
            hundred metres stay at the limit of even the 59 m map.
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
