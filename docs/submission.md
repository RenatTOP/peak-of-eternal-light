# Peak of Eternal Light: submission draft

NASA Space Apps Challenge 2026 · challenge: **CLPS Lunar Mission Browser** · solo team "Peak of Eternal Light".

Drafted against the 2025 Project Submission Guide; the 2026 guide is due on 13 November 2026, so recheck the
fields and limits then. Items marked **TODO** need a decision or a link.

---

## Project name

Peak of Eternal Light

## Links

- Live app: **https://peak-of-eternal-light.pages.dev** `https://peak-of-eternal-light.pages.dev`
- Source code: https://github.com/RenatTOP/peak-of-eternal-light (
  publish the data release there: `python -m pipeline.data_release --repo RenatTOP/peak-of-eternal-light upload --reuse`)
- Demo video (30 s): **https://youtu.be/3BRtQrcwFNo** `https://youtu.be/3BRtQrcwFNo`
## High-level summary

Peak of Eternal Light is a web application that evaluates lunar landing sites and dates by two conditions a
lander depends on: sunlight for power and a line of sight to Earth for direct communication. Near the south pole
the Sun stays within about 1.5° of the horizon, so terrain up to hundreds of kilometres away controls both. For
any point on the Moon and any date between 1969 and 2035, the application derives the terrain horizon from NASA LOLA
elevation models and the positions of the Sun and Earth from NASA/JPL SPICE ephemerides. From these it computes
windows of illumination and Earth visibility, the time to the next sunset or Earthset, and whether a given battery
survives the night. It includes the CLPS deliveries, Apollo, Chang'e, SLIM and Chandrayaan-3, compares sites and
dates side by side, and shows how results change with the touchdown point. Mean illumination agrees with NASA's
published maps (r = 0.995); computed sunsets match the reported ends of Chandrayaan-3, IM-1 and Blue Ghost 1
operations. CLPS and Artemis missions to the south pole are planned around these windows; the application makes
the analysis available in any browser without specialist software.

## Project demo (30-second video)

Six shots of about five seconds, real screen captures of the live app, with one caption each:

| # | Shot | Caption |
|---|------|---------|
| 1 | Globe turning to the south pole, Sun marker on the ring | “At the lunar south pole the Sun never rises more than 1.5°.” |
| 2 | Polar map → Connecting Ridge, horizon panel with the Sun's band | “Terrain decides: 87% sunlight on this ridge, 0% in the crater next door.” |
| 3 | 3D view from the ridge, Sun skimming the skyline | “Traced from NASA LOLA terrain and JPL ephemerides.” |
| 4 | MISSIONS → IM-1 → sunset countdown, battery card turning red | “Every CLPS landing, with its sunset and its battery.” |
| 5 | COMPARE → Your scenarios, four seasons of one site | “Compare sites and dates side by side.” |
| 6 | Around this spot scan on Mons Mouton, then the app title | “Peak of Eternal Light · runs in any browser.” |

Fallback if a video is not possible: seven slides with the same six screens plus a title slide.

## Project details

### What it does

- **Any place, any date.** 18 catalog sites (candidate peaks, landed missions, permanently shadowed craters), any
  click on the globe or the polar map, or typed coordinates. Dates from July 1969 to 2035.
- **Sun and Earth against the real horizon.** For the chosen place the app draws the 360° skyline and the tracks
  of the Sun and Earth across it, lists every window of sunlight, of Earth contact and of both, and shows the four
  numbers that matter: solar energy, link to Earth, both at once, and the longest night.
- **Now and next.** At any moment: elevations, clearance over terrain, and a countdown to the next sunset, sunrise,
  Earthset or Earthrise, refined to the minute.
- **Power check.** A sun-tracking panel, a battery, an operating load and a survival load: does the craft get
  through the period, when does it run empty, what battery would never run empty. Presets for landers, a rover and
  a surface station.
- **Best landing dates.** For every day of a year, whether a mission of a chosen length would get through if it
  landed that day.
- **CLPS missions.** Every CLPS delivery flown or planned (as of September 2026), plus Apollo 11–17, Chandrayaan-3,
  Chang’e 3–6, SLIM and the impact sites of failed landers, each with sources; one click analyses the landing
  site over the mission's own dates, with the cursor at touchdown.
- **Scenarios.** Pin place-and-date pairs from anywhere in the app and compare them in one table, aligned by days
  since landing, with a battery verdict for each.
- **Around this spot.** 37 points within 0.5–5 km, each with its own horizon and slope: how much the result
  changes if the lander comes down off target, and whether a gentler, sunnier spot is close by.
- **Rover traverse.** Draw a route; the rover's horizon changes along it, the battery is simulated as it drives
  and parks, and a “sunnier path” reroutes each leg over ground that NASA's maps show is lit more often.
- **3D views.** Stand at the site and look around, or see the terrain and route from above, lit by the true Sun.
- **Uncertainty.** For the candidate sites, NASA's 100 terrain realisations within the LOLA error give a range
  for every number, not just one value.
- **Stories and a glossary.** Five guided tours (south pole light, calling home, IM-1, Apollo vs. Artemis,
  driving in the dark). Every step opens the real calculation, not a picture.
- **Share.** Every view, including scenarios and routes, is a link.

### How it works

1. **Python pipeline** (offline, ~80 GB of NASA data): reads the LOLA DEMs in windows, traces 720-direction
   horizons out to 300 km with nested terrain (5 m near the site, 20–240 m beyond), computes SPICE positions of
   the Sun and Earth in the Moon's body-fixed frame (DE440, MOON_ME), and prepares compact files for the browser:
   ephemerides every 6 hours for 1969–2035 (2.2 MB), catalog horizons, terrain tiles and a grid of distant
   horizons.
2. **Browser** (TypeScript, React, Three.js, Leaflet): interpolates the ephemerides, converts to local elevation
   and azimuth, and computes the visible share of the Sun's and Earth's discs above the horizon at every step. For
   any clicked point it traces the horizon live from terrain tiles: 80–120 m near the pole plus the precomputed
   distant grid, or the 474 m global LOLA map elsewhere. Landing sites off the pole use horizons precomputed from
   59 m SLDEM2015 terrain out to 40 km.
3. **Same formulas twice.** Every browser formula has a Python reference; over 120 automated tests (Python and TypeScript) check them
   (elevations to 3e-6°, horizons to 0.01°).

### Validation

- Against NASA's 18.6-year mean illumination and Earth visibility maps (Mazarico et al.) at 229 stratified
  points: r = 0.995 for both, bias −0.6 and +1.1 percentage points.
- Real events: Chandrayaan-3 sunset on 4 September 2023 (the day ISRO put Vikram to sleep); IM-1 sunset on
  2 March 2024; Chang’e 4 never sees Earth.
- Apollo: the Sun's elevation at the Apollo 11 and 12 touchdowns comes out at 10.70° and 5.14°, against 10.65°
  and 5.19° in the Apollo Lunar Surface Journal.
- Blue Ghost 1: Firefly's account (346 h of daylight, last data 23:15 UTC five hours into the night) puts the end
  of daylight at about 18:15–18:35 UTC on 16 March 2025; with the 59 m landing-site horizon our Sun starts to set at
  18:42 and is gone at 19:48 (on 474 m terrain: 19:16 and 20:22).
- Honest limits: elsewhere off the pole the horizon comes from 474 m terrain, so sunrise and sunset can be off by an
  hour or two; slopes are computed on 80–474 m terrain and real slopes can only be steeper.

### Who it is for and why it matters

- **Mission planners**: compare candidate sites and landing dates by power and direct-to-Earth contact, see the
  battery a craft needs, and see the risk of landing off target, all before any detailed study.
- **Educators and the public**: see why NASA and its partners are going to the south pole, why CLPS landers die
  at sunset, and why the far side needs a relay, with real data and in a few clicks.
- The tool makes NASA's polar terrain products and illumination science usable without GIS software or a
  download: a link opens exactly the scene being discussed.

### Tools

Python (NumPy, rasterio, spiceypy), TypeScript, React, Three.js, Leaflet, Vite, Vitest, Cloudflare Pages
(static hosting).

### Creativity

- The browser traces horizons itself, so any spot on the Moon can be analysed on the fly, not just a precomputed
  list.
- Time is the second axis everywhere: the countdown, best landing dates, scenarios aligned by days since landing.
- Uncertainty is shown, not hidden: terrain realisations, landing-accuracy spread, and the limits of each model.

## NASA data used

- **LRO LOLA 5 m/pixel DEMs and 100 error realisations** of the south polar candidate sites (Barker et al. 2021),
  NASA GSFC Planetary Geodesy Data Archive (PGDA): https://pgda.gsfc.nasa.gov/products/78
- **LRO LOLA south polar DEMs, 20–240 m/pixel**, and permanent shadow maps (Barker et al. 2023), PGDA:
  https://pgda.gsfc.nasa.gov/products/90
- **SLDEM2015**, LOLA merged with Kaguya terrain-camera data at 512 pixels/degree (Barker et al. 2016), PGDA:
  https://pgda.gsfc.nasa.gov/products/54
- **LOLA global gridded topography, 64 pixels/degree** (LRO-L-LOLA-4-GDR-V1.0), PDS Geosciences Node:
  https://pds-geosciences.wustl.edu/missions/lro/lola.htm
- **Shape-from-Shading 5 m terrain** of the Artemis III candidate regions from LROC NAC images (Bertone et al.,
  NASA GSFC): https://doi.org/10.5281/zenodo.17954508
- **South polar illumination and Earth visibility maps** (Mazarico et al. 2011), PGDA:
  https://pgda.gsfc.nasa.gov/products/69
- **NAIF SPICE kernels**: DE440 planetary ephemeris, lunar orientation and frames, leap seconds:
  https://naif.jpl.nasa.gov/pub/naif/generic_kernels/
- **NASA SVS CGI Moon Kit**: LROC WAC colour mosaic and LOLA topography for the globe:
  https://svs.gsfc.nasa.gov/4720
- **NASA CLPS deliveries** pages for the mission catalog: https://science.nasa.gov/lunar-science/clps-deliveries/
- **Apollo Lunar Surface Journal** for Apollo landing times and Sun angles: https://www.nasa.gov/history/alsj/

## Other data and references

- Mission facts for non-NASA landers: ISRO, CNSA, JAXA, Roscosmos, SpaceIL and ispace via the sources listed on
  each mission card.
- Mazarico E. et al. (2011), Icarus 211, 1066, doi:10.1016/j.icarus.2010.10.030
- Barker M. K. et al. (2016), Icarus 273, 346, doi:10.1016/j.icarus.2015.07.039
- Barker M. K. et al. (2021), Planet. Space Sci. 203, 105119, doi:10.1016/j.pss.2020.105119
- Barker M. K. et al. (2023), Planet. Sci. J. 4, 183, doi:10.3847/PSJ/acf3e1
- Bertone S. et al., Planet. Sci. J., doi:10.3847/PSJ/ae5b70

## Use of artificial intelligence

Form answer (2026 "Use of Super Intelligence"): Ideation or Brainstorming; Research or Information Gathering;
Data Analysis and Interpretation; Coding, Debugging, or Troubleshooting; Writing, Editing, or Translation.
Not used: building SI/ML into the project.

Disclosure in the project itself: README "Use of AI", DATA & METHOD page, `ai-disclosure` meta tag in
`web/index.html`, `description` in `web/package.json`. The team avatar and patches are AI-generated and carry a
visible "AI-GENERATED IMAGE" watermark.
