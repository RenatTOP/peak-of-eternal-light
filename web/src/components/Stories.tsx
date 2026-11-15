// STORIES: short tours of the app, a step player and the first-visit intro.
import { GLOSSARY, STORIES, type Story } from "../lib/stories";
import { Head, Panel } from "./hud";

export function StoriesPage({ onPlay }: { onPlay: (id: string) => void }) {
  return (
    <div className="stories-page scroll">
      <div className="stories-grid">
        <Panel className="stories-intro">
          <Head num="01" label="STORIES" right="each step is a live calculation, not a picture" />
          <p>
            Short guided tours. Each step opens the app on a real place and date and explains what you see:
            the numbers are computed right there, so you can stop at any step, poke around and carry on.
          </p>
        </Panel>
        {STORIES.map((s, n) => (
          <Panel key={s.id} className="story-card">
            <div className="story-num mono">{String(n + 1).padStart(2, "0")}</div>
            <h3>{s.title}</h3>
            <p>{s.teaser}</p>
            <ol>
              {s.steps.map((st) => <li key={st.title}>{st.title}</li>)}
            </ol>
            <button className="btn primary" onClick={() => onPlay(s.id)}>Play · {s.steps.length} steps</button>
          </Panel>
        ))}
        <Panel className="glossary">
          <Head num="02" label="KEY IDEAS" />
          <dl>
            {GLOSSARY.map((g) => (
              <div key={g.term}><dt>{g.term}</dt><dd>{g.text}</dd></div>
            ))}
          </dl>
        </Panel>
      </div>
    </div>
  );
}

interface PlayerProps {
  story: Story;
  step: number;
  onStep: (i: number) => void;
  onClose: () => void;
}

export function StoryPlayer({ story, step, onStep, onClose }: PlayerProps) {
  const st = story.steps[step];
  const last = step === story.steps.length - 1;
  return (
    <div className="story-player" role="dialog" aria-label={`Story: ${story.title}`} aria-live="polite">
      <div className="story-top">
        <span className="story-of">{story.title.toUpperCase()}</span>
        <span className="story-dots" aria-label={`Step ${step + 1} of ${story.steps.length}`}>
          {story.steps.map((_, i) => (
            <button key={i} className={i === step ? "on" : ""} onClick={() => onStep(i)} aria-label={`Step ${i + 1}`} />
          ))}
        </span>
        <button className="story-x" onClick={onClose} aria-label="Close the story">×</button>
      </div>
      <h3>{st.title}</h3>
      <p>{st.text}</p>
      <div className="story-nav">
        <button className="btn" disabled={step === 0} onClick={() => onStep(step - 1)}>Back</button>
        <button className="btn primary" onClick={() => (last ? onClose() : onStep(step + 1))}>
          {last ? "Finish" : `Next · ${step + 2}/${story.steps.length}`}
        </button>
      </div>
    </div>
  );
}

export function IntroCard({ onTour, onStories, onClose }: { onTour: () => void; onStories: () => void; onClose: () => void }) {
  return (
    <div className="stage-card intro-card">
      <Panel>
        <Head label="WELCOME" />
        <h3>Where on the Moon can a lander see the Sun, and Earth?</h3>
        <p>
          Pick any spot and any date. The app traces the real skyline around it from NASA’s laser altimeter maps
          and follows the true Sun and Earth, minute by minute: when there is sunlight for power, when Earth is up
          for radio, and whether a battery lasts the night.
        </p>
        <ol className="intro-steps">
          <li><b>01 · Place</b><span>a candidate site, a mission, or any spot on the globe</span></li>
          <li><b>02 · Time</b><span>a date and a period, at the bottom</span></li>
          <li><b>03 · Result</b><span>the skyline, the sky now, and the days of light and contact</span></li>
        </ol>
        <div className="btn-row">
          <button className="btn primary" onClick={onTour}>Take the 2-minute tour</button>
          <button className="btn" onClick={onStories}>All stories</button>
          <button className="btn" onClick={onClose}>Explore on my own</button>
        </div>
      </Panel>
    </div>
  );
}
