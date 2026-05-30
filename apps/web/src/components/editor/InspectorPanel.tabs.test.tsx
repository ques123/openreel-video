import "../../test/install-local-storage-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import type { Project } from "@openreel/core";
import { createEmptyProject } from "../../stores/project/project-helpers";
import { useProjectStore } from "../../stores/project-store";
import { useUIStore } from "../../stores/ui-store";
import { InspectorPanel } from "./InspectorPanel";

const clipId = "clip-vid";
const trackId = "track-vid";

function seedVideoClip(): Project {
  const project = createEmptyProject("Inspector Tabs Test");
  const seeded: Project = {
    ...project,
    timeline: {
      ...project.timeline,
      duration: 10,
      tracks: [
        {
          id: trackId,
          type: "video",
          name: "Video",
          clips: [
            {
              id: clipId,
              mediaId: "media-vid",
              trackId,
              startTime: 0,
              duration: 10,
              inPoint: 0,
              outPoint: 10,
              effects: [],
              audioEffects: [],
              transform: {
                position: { x: 0, y: 0 },
                scale: { x: 1, y: 1 },
                rotation: 0,
                anchor: { x: 0.5, y: 0.5 },
                opacity: 1,
              },
              volume: 1,
              keyframes: [],
            },
          ],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
  };
  useProjectStore.setState({ project: seeded });
  useUIStore.getState().select({ type: "clip", id: clipId, trackId });
  return seeded;
}

describe("InspectorPanel real tabs", () => {
  beforeEach(() => {
    useUIStore.setState({ inspectorActiveTab: "transform" });
    seedVideoClip();
  });

  afterEach(() => {
    cleanup();
    useUIStore.getState().clearSelection();
    useProjectStore.setState({ project: createEmptyProject("Reset") });
  });

  it("shows the video tab set", () => {
    render(<InspectorPanel />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Transform/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Audio/ })).toBeInTheDocument();
  });

  it("switching tabs swaps the visible panel (real isolation)", () => {
    const { container } = render(<InspectorPanel />);

    const transformSection = container.querySelector<HTMLDivElement>(
      '[data-section-id="transform"]',
    );
    expect(transformSection).not.toBeNull();
    const sectionToggle = transformSection?.querySelector("button");
    expect(sectionToggle).not.toBeNull();
    fireEvent.click(sectionToggle as HTMLButtonElement);

    expect(screen.getByText("Position X")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Audio/ }));
    expect(useUIStore.getState().inspectorActiveTab).toBe("audio");
    expect(screen.queryByText("Position X")).toBeNull();
  });
});
