/**
 * The screening room (docs/wizz-ui-draft.html's data-scene="screening"):
 * film title, real player, segment strip, and the four verbs — Download
 * (primary, first-class ending), Refine, Change setup, Open in editor
 * (quiet, one-way door) — plus the music A/B when the cut has one.
 */
import { useEffect, useState } from "react";
import { fmtDurationShort } from "../format";
import { useFlow } from "../flow-context";
import { useToast } from "./Toast";
import { Chrome } from "./Chrome";
import { Player } from "./Player";
import { SegmentStrip } from "./SegmentStrip";
import { RenderOverlay } from "./RenderOverlay";

export function ScreeningRoomScene() {
  const { state, currentCut, cutSeq, selectedTake, setSelectedTake, getFileForClip, actions } = useFlow();
  const toast = useToast();
  const [index, setIndex] = useState(0);
  const [started, setStarted] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineText, setRefineText] = useState("");

  // A fresh cut (new generate/refine) starts the player over — keyed on
  // cutSeq, NOT currentCut's object identity: the director's music-ready
  // update rebuilds the SAME cut with a new reference once Suno lands
  // (~60s later), which must NOT reset playback/refine state mid-watch.
  useEffect(() => {
    setIndex(0);
    setStarted(false);
    setRefineOpen(false);
    setRefineText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cutSeq]);

  if (state.name !== "screening" || !currentCut) return null;

  const submitRefine = () => {
    const text = refineText.trim();
    if (!text) return;
    actions.refine(text);
  };

  return (
    <div>
      <Chrome />
      <div className="wrap screening">
        <span className="label">Your cut</span>
        <div className="film-title">
          <h2 className="display">{currentCut.title}</h2>
          <span className="tc" style={{ color: "var(--dim)" }}>
            {fmtDurationShort(currentCut.totalS)} · {currentCut.segments.length} shot
            {currentCut.segments.length === 1 ? "" : "s"} · cut from {currentCut.clipCount} clip
            {currentCut.clipCount === 1 ? "" : "s"}
          </span>
        </div>

        <Player
          segments={currentCut.segments}
          index={index}
          onIndexChange={setIndex}
          started={started}
          onStart={() => setStarted(true)}
          getFile={getFileForClip}
        />

        <SegmentStrip
          segments={currentCut.segments}
          onJump={(i) => {
            setIndex(i);
            setStarted(true);
          }}
        />

        <div className="verbs">
          <button className="btn btn-primary" onClick={actions.beginRender}>
            Download my film
          </button>
          <button className="btn" onClick={() => setRefineOpen((v) => !v)}>
            Refine
          </button>
          <button className="btn" onClick={actions.changeSetup}>
            Change setup
          </button>
          <span className="spacer" />
          {currentCut.musicTakes && (
            <span className="music-ab" role="group" aria-label="Music takes">
              <button
                aria-pressed={selectedTake === "a"}
                onClick={() => {
                  setSelectedTake("a");
                  toast.show("Swaps the composed track under the same cut.");
                }}
              >
                track A
              </button>
              <button
                aria-pressed={selectedTake === "b"}
                onClick={() => {
                  setSelectedTake("b");
                  toast.show("Swaps the composed track under the same cut.");
                }}
              >
                track B
              </button>
            </span>
          )}
          <button
            className="btn"
            onClick={() => {
              void actions.openEditor().then((result) => {
                if (!result.ok) {
                  toast.show(result.error ?? "Couldn't open the editor — some source files are unavailable.");
                }
              });
            }}
          >
            Open in editor
          </button>
        </div>
        <p className="oneway" style={{ marginTop: 8, textAlign: "right" }}>
          the editor is the pro path — trim cuts, swap shots, ride the music. Edits there don&apos;t
          flow back here.
        </p>

        {refineOpen && (
          <div className="refine-box">
            <textarea
              className="brief"
              placeholder='What should change? — "moodier, lose the parking-lot shot, end on the kids"'
              value={refineText}
              onChange={(e) => setRefineText(e.target.value)}
            />
            <button className="btn btn-primary" style={{ alignSelf: "flex-end" }} onClick={submitRefine}>
              Re-cut
            </button>
          </div>
        )}
      </div>
      <RenderOverlay />
    </div>
  );
}
