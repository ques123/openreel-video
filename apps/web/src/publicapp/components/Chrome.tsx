/**
 * The wireframe's app header (docs/wizz-ui-draft.html's .chrome). `minimal`
 * matches the directing/away/quota-exceeded scenes, which show only the
 * brand — no email/theme/sign-out cluster (their chrome's `.who` is empty).
 * The account "menu" is the wireframe's inline `.who` cluster (email, a
 * theme-cycle control, sign out) — there is no dropdown in the approved
 * design, so none is invented here.
 */
import { useFlow } from "../flow-context";
import type { WizzThemeMode } from "../theme";

function themeGlyph(mode: WizzThemeMode): string {
  switch (mode) {
    case "dark":
      return "☾";
    case "light":
      return "☀";
    default:
      return "◐";
  }
}

export function Chrome({ minimal }: { minimal?: boolean }) {
  const { email, theme, actions } = useFlow();

  return (
    <header className="chrome">
      <span className="brand display">wizz.video</span>
      {minimal ? (
        <span className="who" />
      ) : (
        <span className="who">
          {email}
          <button
            className="btn-quiet"
            onClick={theme.cycle}
            title={`Theme: ${theme.mode} (click to change)`}
            aria-label="Cycle theme"
          >
            {themeGlyph(theme.mode)}
          </button>
          <button className="btn-quiet" onClick={actions.logout}>
            sign out
          </button>
        </span>
      )}
    </header>
  );
}
