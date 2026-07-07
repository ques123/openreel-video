/**
 * wizz.video public product root. Every scene in docs/wizz-ui-draft.html is
 * a component under publicapp/components/; which one renders is driven
 * entirely by the GenerateFlowState from use-generate-flow.ts (state-
 * machine.ts's `applyEvent`), except the editor, which is a route
 * independent of that state machine (a one-way door — see EditorRoute.tsx).
 *
 * File ownership: everything under src/publicapp/ belongs to WS-D. Shared
 * files (main.tsx, App.tsx, vite.config.ts, router hooks) belong to WS-C.
 */
import "../styles/wizz-tokens.css";
import "../styles/wizz-app.css";
import { FlowProvider, useFlow } from "./flow-context";
import { ToastProvider } from "./components/Toast";
import { AuthScene } from "./components/AuthScene";
import { GateScene } from "./components/GateScene";
import { StudioEmptyScene } from "./components/StudioEmptyScene";
import { StudioRestoreOfferScene } from "./components/StudioRestoreOfferScene";
import { BenchScene } from "./components/BenchScene";
import { DirectingScene } from "./components/DirectingScene";
import { ScreeningRoomScene } from "./components/ScreeningRoomScene";
import { AwayScene } from "./components/AwayScene";
import { QuotaExceededScene } from "./components/QuotaExceededScene";
import { EditorRoute } from "./components/EditorRoute";

function BootingScreen() {
  return (
    <div className="centered">
      <div className="landing-brand brand display">wizz.video</div>
    </div>
  );
}

function SceneRouter() {
  const { booted, route, state } = useFlow();

  if (!booted) return <BootingScreen />;

  // The editor is a one-way door independent of the generate flow's own
  // scene state — it stays reachable regardless of what state.name is.
  if (route === "editor") return <EditorRoute />;

  switch (state.name) {
    case "gate-unsupported":
      return <GateScene />;
    case "needs-auth":
      return <AuthScene />;
    case "studio-empty":
      return <StudioEmptyScene />;
    case "studio-restore-offer":
      return <StudioRestoreOfferScene />;
    case "bench":
      return <BenchScene />;
    case "directing":
      return <DirectingScene />;
    case "screening":
      return <ScreeningRoomScene />;
    case "service-away":
      return <AwayScene />;
    case "quota-exceeded":
      return <QuotaExceededScene />;
    default:
      return null;
  }
}

export default function PublicApp() {
  return (
    <div className="wizz">
      <FlowProvider>
        <ToastProvider>
          <SceneRouter />
        </ToastProvider>
      </FlowProvider>
    </div>
  );
}
