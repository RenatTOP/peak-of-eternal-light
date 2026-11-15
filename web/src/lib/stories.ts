// Stories: short step-by-step tours. Each step is an explanation plus the app state in link format
// (the same one Share makes), so every step shows a live calculation, not a picture.
// Figures in the texts come from this calculation (checked for the dates given in the steps).

export interface StoryStep {
  title: string;
  text: string;
  hash: string; // state as in a Share link (without #)
}

export interface Story {
  id: string;
  title: string;
  teaser: string;
  steps: StoryStep[];
}

const SEASONS = "connecting-ridge@2027-01-01~29.53;connecting-ridge@2027-04-01~29.53;"
  + "connecting-ridge@2027-07-01~29.53;connecting-ridge@2027-10-01~29.53";
const LANDINGS = "chandrayaan-3@2023-08-23~33;-13.316,25.251@2024-01-19~14;im1-odysseus@2024-02-22~14;"
  + "18.567,61.817@2025-03-02~16;im2-athena@2025-03-06~14";
const APOLLO11 = "pt=0.67408,23.4730&from=1969-07-20&days=29.53";

export const STORIES: Story[] = [
  {
    id: "light",
    title: "Light at the bottom of the Moon",
    teaser: "Why the south pole has places that almost never go dark, and craters that never see the Sun.",
    steps: [
      {
        title: "The Sun skims the pole",
        text: "The Moon’s spin axis is tilted only 1.5° from the Sun’s path, so at the south pole the Sun never climbs "
          + "higher than that. It circles the whole horizon once a lunar day (29.5 Earth days). The amber marker around "
          + "the globe shows where it is now. With the Sun this low, terrain decides everything.",
        hash: "site=connecting-ridge",
      },
      {
        title: "A peak of (almost) eternal light",
        text: "Connecting Ridge runs between Shackleton and de Gerlache craters. In 2027 sunlight reaches it 87% of the "
          + "time, where flat ground at the same latitude would get 52%. On the right, the amber band is the Sun’s path: "
          + "never more than about 2° up, yet it rarely drops behind the terrain. The longest night lasts 4.5 days.",
        hash: "site=connecting-ridge&view=map",
      },
      {
        title: "Stand on the ridge",
        text: "This is the view from the ridge, built from NASA terrain and the true position of the Sun. Light is always "
          + "nearly horizontal and shadows run for kilometres. That is why polar landers carry vertical solar panels that "
          + "turn to follow the Sun around the sky. Drag to look around.",
        hash: "site=connecting-ridge&view=3d&at=2027-01-05T12:00",
      },
      {
        title: "Darkness next door",
        text: "About 100 km from the ridge, the floor of Shoemaker crater gets 0% sunlight all year, and Shackleton, right "
          + "beside the ridge, has a floor like it. Floors like these (purple on the map) have been dark for billions of "
          + "years and stay colder than −170 °C, cold enough to trap water ice. That ice is why missions want to land on "
          + "the sunny rims right next to them.",
        hash: "site=shoemaker&view=map&layers=psr",
      },
      {
        title: "The date matters as much as the place",
        text: "Even the best ridge has seasons. The same Connecting Ridge, one lunar day at a time: 100% sunlight from "
          + "1 January 2027, but 59% from 1 April, when a lander would need a 7.5 kWh battery to get through. Choosing "
          + "a landing date is part of choosing a landing site.",
        hash: `tab=compare&sc=${SEASONS}`,
      },
    ],
  },
  {
    id: "earth",
    title: "Calling home",
    teaser: "Power is only half of it: a lander also needs Earth above its horizon to talk.",
    steps: [
      {
        title: "Earth hangs in one place",
        text: "The Moon keeps the same face towards Earth, so from any spot Earth stays in nearly the same part of the sky. "
          + "It only wobbles by up to about 7° over a month (libration). At the pole that wobble lifts Earth just above the "
          + "horizon or drops it below: Connecting Ridge sees Earth 55% of 2027, with gaps of up to 12 days. "
          + "The blue layer on the map shows where Earth is visible, on average.",
        hash: "site=connecting-ridge&view=map&layers=earth",
      },
      {
        title: "Power and radio are separate problems",
        text: "Haworth crater’s floor never sees the Sun, yet Earth is above its rim 28% of the time. A rover exploring it "
          + "could phone home on and off but would have to bring its power from outside. The four numbers on the left "
          + "always show both: solar energy and link to Earth.",
        hash: "site=haworth&view=map",
      },
      {
        title: "The far side never sees Earth",
        text: "Chang’e 4 landed in Von Kármán crater on the far side in January 2019. Here Earth stays 37–51° below the "
          + "horizon, all month, every month: the link to Earth is 0%. China could land there only because it had first "
          + "parked the Queqiao relay satellite beyond the Moon.",
        hash: "pt=-45.4446,177.5991&from=2019-01-03&days=29.53",
      },
      {
        title: "Near side, Earth overhead",
        text: "At Tranquility Base, near the centre of the near side, Earth stood 59–74° up for the whole month. Apollo "
          + "crews could talk to Houston straight away, with no relay and no gaps. The pole trades that easy link for "
          + "light.",
        hash: `${APOLLO11}&at=1969-07-20T20:17`,
      },
    ],
  },
  {
    id: "im1",
    title: "IM-1: a week at 80° south",
    teaser: "The first US landing since 1972, seen through its Sun, its Earth and its battery.",
    steps: [
      {
        title: "Odysseus",
        text: "On 22 February 2024 Intuitive Machines’ Nova-C lander Odysseus touched down near Malapert A, 80° south. It "
          + "came in on a 12° slope, broke a leg and tipped over. The card on the right is from our mission catalog, with "
          + "sources.",
        hash: "tab=missions&mission=im-1",
      },
      {
        title: "Touchdown",
        text: "At landing the Sun stood about 10° above the horizon and Earth 15°. This far from the pole the Sun still "
          + "rises and sets every lunar day: it is not a peak of light. The timeline below shows the days the lander "
          + "had: amber for Sun, blue for Earth.",
        hash: "site=im1-odysseus&from=2024-02-22&days=14&at=2024-02-22T23:24&craft=lander",
      },
      {
        title: "Sunset",
        text: "Sunset at the site came on 2 March 2024 at 18:00 UTC. A short-mission lander with a 3 kWh battery would "
          + "then live on the battery and, in this model, run empty two days later. Odysseus itself, lying on its side "
          + "with its panels badly aimed, went quiet earlier, on 29 February.",
        hash: "site=im1-odysseus&from=2024-02-22&days=14&at=2024-03-02T18:00&craft=lander",
      },
      {
        title: "Every landing on its own dates",
        text: "Recent landings side by side, each over its own mission dates and with the same long-lived lander: "
          + "Chandrayaan-3 at 69°S runs out of power after sunset, while Blue Ghost 1 in Mare Crisium had sunlight "
          + "92% of the time. Click a row to open it.",
        hash: `tab=compare&sc=${LANDINGS}`,
      },
    ],
  },
  {
    id: "apollo",
    title: "Apollo vs. Artemis",
    teaser: "Why Apollo landed at dawn near the equator, and why the south pole is a different world.",
    steps: [
      {
        title: "Landing at dawn",
        text: "Apollo 11 touched down on 20 July 1969 with the Sun 10.7° above the horizon. That was planned: low "
          + "morning light throws long shadows, so the crew could see craters and boulders on the way down, and the "
          + "ground had not yet heated up. Every Apollo landing was in the lunar morning.",
        hash: `${APOLLO11}&at=1969-07-20T20:17`,
      },
      {
        title: "Noon, then two weeks of night",
        text: "A week later the Sun stands almost overhead, 88° up, and the ground bakes at over 100 °C. Then comes a "
          + "night of almost 15 days. In the horizon panel the Sun’s track climbs straight up in the east and drops "
          + "straight down in the west: here it crosses the whole sky.",
        hash: `${APOLLO11}&at=1969-07-27T12:00`,
      },
      {
        title: "At the pole, the arch is flat",
        text: "On Connecting Ridge the Sun’s path is a thin band that never gets above 2°. No scorching noon and no "
          + "two-week night, but light that is always horizontal and a Sun that can hide behind any hill. Artemis "
          + "crews would work in permanent dawn.",
        hash: "site=connecting-ridge",
      },
    ],
  },
  {
    id: "rover",
    title: "Driving in the dark",
    teaser: "A rover’s straight-line drive across the pole, and the sunnier detour that saves it.",
    steps: [
      {
        title: "Eleven kilometres, straight",
        text: "A hypothetical rover leaves the Shackleton rim on 8 January 2027 and drives 11 km straight to Connecting "
          + "Ridge. The line on the map is coloured by what it meets: the straight route dips into a shadowed saddle, "
          + "and the battery runs out on the way (see the card on the left).",
        hash: "route=-89.78,203.8;-89.439,222.9&drive=battery&speed=250&ex=1&from=2027-01-08&days=30&craft=rover&view=map",
      },
      {
        title: "Find a sunnier path",
        text: "Now press “Suggest a sunnier path” on the left. Each leg is rerouted over ground that NASA’s maps show is lit more "
          + "often, avoiding slopes over 15°, and the drive is simulated again for the same dates. The detour is longer, "
          + "but this time the rover arrives and survives the month.",
        hash: "route=-89.78,203.8;-89.439,222.9&drive=battery&speed=250&ex=1&from=2027-01-08&days=30&craft=rover&view=map",
      },
    ],
  },
];

export interface GlossaryItem {
  term: string;
  text: string;
}

export const GLOSSARY: GlossaryItem[] = [
  { term: "Terrain horizon", text: "The skyline seen from a spot, traced here along 720 directions out to 300 km. The Sun or Earth counts as in view only above it." },
  { term: "Peak of eternal light", text: "A high point near a pole that is sunlit almost all the time. No spot on the Moon is lit forever; the best get roughly 85–90% over a year." },
  { term: "Permanent shadow", text: "Crater floors near the poles that sunlight never reaches. Colder than −170 °C, they can hold water ice. Shown in purple." },
  { term: "Lunar day", text: "29.5 Earth days from one sunrise to the next. Near the equator that is about 15 days of light, then about 15 of night." },
  { term: "Libration", text: "A slow wobble in how the Moon faces Earth, up to about 7–8°. It makes Earth rise and set for places near the poles and the edge of the near side." },
  { term: "Direct-to-Earth link", text: "Radio straight to antennas on Earth. It needs Earth above the local horizon; otherwise the lander needs a relay satellite." },
  { term: "CLPS", text: "Commercial Lunar Payload Services: NASA buys rides to the Moon for its instruments on landers built and flown by US companies." },
  { term: "Survival mode", text: "When the panels cannot cover normal operations, the craft runs only heaters and minimal electronics from its battery." },
  { term: "Visible share of the Sun", text: "The Sun is half a degree wide, so near the pole it often shows only partly over a ridge. Power is counted by the visible share of its disc." },
];
