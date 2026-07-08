/**
 * Regression coverage for the boundary-watcher mount-timing bug: the <video>
 * only mounts once `started` flips true (see Player.tsx's file header), so
 * the rVFC-arming effect's dependency array MUST include `started` or it
 * arms once against a still-null ref and never re-fires once the element
 * exists — the symptom being the preview free-running past a segment's
 * out-point to the end of the source file instead of advancing/stopping.
 *
 * Driven with react-dom/client + act rather than @testing-library/react:
 * this package has no existing component-test harness in publicapp/publicflow
 * (player-advance.test.ts et al. cover pure helpers only), so this stays
 * dependency-free and deliberately minimal — stub rVFC + Blob URLs (neither
 * exists in jsdom), mount through the exact started-gate ScreeningRoomScene
 * drives, and prove a simulated presented frame past the out-point actually
 * advances/stops. The boundary MATH itself (epsilon, next-index) is already
 * covered by player-advance.test.ts; this file only exercises the wiring.
 */
import { act, useCallback, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicCutSegment } from "../../publicflow/types";

// react-dom/client + manual act() (no @testing-library) needs this flag set
// itself — RTL normally sets it for you.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// HAS_RVFC is computed at Player.tsx's module-load time, so the stub must
// exist before that module is first imported — hence the dynamic import
// inside beforeAll rather than a static top-of-file one.
let Player: typeof import("./Player").Player;
let pendingTicks: Array<(now: number, meta: { mediaTime: number }) => void> = [];
const playMock = vi.fn().mockResolvedValue(undefined);

beforeAll(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLVideoElement.prototype as any).requestVideoFrameCallback = (
    cb: (now: number, meta: { mediaTime: number }) => void,
  ) => {
    pendingTicks.push(cb);
    return pendingTicks.length;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLVideoElement.prototype as any).cancelVideoFrameCallback = () => {};
  // jsdom's own play()/pause() just log a "not implemented" jsdomError (they
  // don't throw), but that's console noise this file doesn't need — and the
  // Replay path calls play() imperatively, which these tests DO assert on.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLVideoElement.prototype as any).play = playMock;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (HTMLVideoElement.prototype as any).pause = () => {};
  // jsdom implements neither side of the Blob URL API at all.
  URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
  URL.revokeObjectURL = vi.fn();
  ({ Player } = await import("./Player"));
});

const SEGMENTS: PublicCutSegment[] = [
  { clipId: "clip-a", inS: 0, outS: 5, why: "", thumbnailUrl: null },
  { clipId: "clip-b", inS: 0, outS: 5, why: "", thumbnailUrl: null },
];
const FAKE_FILE = new File(["data"], "clip.mp4", { type: "video/mp4" });

/**
 * Mirrors ScreeningRoomScene's own started/onStart wiring — Player is fully
 * controlled. `onIndexChange` MUST stay referentially stable across the
 * `started` flip (ScreeningRoomScene passes `setIndex` straight through), so
 * this wraps it with useCallback rather than a fresh inline closure per
 * render — otherwise crossBoundary (and thus the watcher effect) would pick
 * up a new dependency on every render for reasons unrelated to the bug this
 * file tests, masking a regression instead of catching it.
 */
function Harness({
  segments = SEGMENTS,
  onIndexChange,
}: {
  segments?: PublicCutSegment[];
  onIndexChange: (i: number) => void;
}) {
  const [index, setIndex] = useState(0);
  const [started, setStarted] = useState(false);
  const handleIndexChange = useCallback(
    (i: number) => {
      setIndex(i);
      onIndexChange(i);
    },
    [onIndexChange],
  );
  return (
    <Player
      segments={segments}
      index={index}
      onIndexChange={handleIndexChange}
      started={started}
      onStart={() => setStarted(true)}
      getFile={() => FAKE_FILE}
    />
  );
}

/** Clicks the big-play-button (flips `started`), then simulates the mounted video actually starting playback. */
function pressPlayAndFireVideoPlay(container: HTMLElement): HTMLVideoElement {
  const playButton = container.querySelector('button[aria-label="Play"]');
  if (!playButton) throw new Error("Play button not found — did `started` fail to gate the video as expected?");
  act(() => {
    playButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const video = container.querySelector("video");
  if (!video) throw new Error("<video> did not mount after `started` flipped true");
  act(() => {
    video.dispatchEvent(new Event("play"));
  });
  return video as HTMLVideoElement;
}

describe("Player boundary watcher arms against the mounted <video>", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    pendingTicks = [];
    playMock.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("re-arms once `started` flips true, so a presented frame past the out-point advances to the next segment", () => {
    const onIndexChange = vi.fn();
    act(() => {
      root.render(<Harness onIndexChange={onIndexChange} />);
    });

    // url resolves (getFile + createObjectURL) before the user ever presses
    // play — exactly the precondition that made the pre-fix effect arm once
    // against a null ref and never again.
    expect(container.querySelector("video")).toBeNull();

    pressPlayAndFireVideoPlay(container);
    expect(pendingTicks).toHaveLength(1); // arm() reached requestVideoFrameCallback on THIS element

    // A frame well before the out-point: updateElapsed's wiring (shared by
    // the same tick callback) is exercised the same way arming is, so a
    // regression there would show up here too.
    act(() => {
      pendingTicks[0](0, { mediaTime: 2.5 });
    });
    expect(container.querySelector(".osd span")?.textContent).toBe("00:00:02");

    // Simulate a presented frame past segment 0's out-point (5s).
    act(() => {
      pendingTicks[0](0, { mediaTime: 5.1 });
    });
    expect(onIndexChange).toHaveBeenCalledWith(1);
  });

  it("stops (shows Replay) once the LAST segment's frame passes its out-point, rather than free-running to the file's end", () => {
    const onIndexChange = vi.fn();
    act(() => {
      root.render(<Harness segments={[SEGMENTS[0]]} onIndexChange={onIndexChange} />);
    });

    pressPlayAndFireVideoPlay(container);
    expect(pendingTicks).toHaveLength(1);

    act(() => {
      pendingTicks[0](0, { mediaTime: 5.1 });
    });
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="Replay"]')).not.toBeNull();
  });

  it("Replay on a single-segment cut seeks back to the in-point imperatively (index never changes, so the seek effect can't re-fire)", () => {
    const seg: PublicCutSegment = { clipId: "clip-a", inS: 2, outS: 5, why: "", thumbnailUrl: null };
    const onIndexChange = vi.fn();
    act(() => {
      root.render(<Harness segments={[seg]} onIndexChange={onIndexChange} />);
    });

    const video = pressPlayAndFireVideoPlay(container);
    act(() => {
      pendingTicks[0](0, { mediaTime: 5.1 });
    });
    const replay = container.querySelector('button[aria-label="Replay"]');
    expect(replay).not.toBeNull();

    video.currentTime = 5.1;
    playMock.mockClear();
    act(() => {
      replay!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(video.currentTime).toBe(2);
    expect(playMock).toHaveBeenCalled();
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="Replay"]')).toBeNull();
  });
});
