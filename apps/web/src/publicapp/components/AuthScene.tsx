/**
 * Invite / sign-in card (docs/wizz-ui-draft.html's data-scene="invite").
 * The wireframe shows one card whose quiet link toggles to a plain sign-in;
 * here that's a real mode switch (signup needs an invite code, login
 * doesn't). Landing's two buttons both point at /app/auth — "Sign in" adds
 * `?mode=login` so this scene opens in the right mode without any shared
 * state (landing is a separate static page, contracts §0).
 *
 * Note: the wireframe's invite input carries a literal demo value
 * ("WZ-4F7K-2026") baked in for one-click clicking through the mockup —
 * treated as wireframe-authoring convenience, not a real default; the real
 * field starts empty with a placeholder, like the other two fields.
 */
import { useState, type FormEvent } from "react";
import { useFlow } from "../flow-context";

type AuthMode = "signup" | "login";

function initialMode(): AuthMode {
  return new URLSearchParams(window.location.search).get("mode") === "login" ? "login" : "signup";
}

export function AuthScene() {
  const { actions, authBusy, authError } = useFlow();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [inviteCode, setInviteCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (authBusy) return;
    if (mode === "signup") void actions.signup({ inviteCode, email, password });
    else void actions.login({ email, password });
  };

  return (
    <section className="centered">
      <div className="landing-brand brand display" style={{ marginBottom: 22 }}>
        wizz.video
      </div>
      <form className="card auth-card" onSubmit={submit}>
        <div className="label">{mode === "signup" ? "Redeem your invite" : "Sign in"}</div>
        {mode === "signup" && (
          <input
            placeholder="Invite code"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value)}
            autoComplete="off"
          />
        )}
        <input
          placeholder="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
        />
        {authError && <p className="auth-error">{authError}</p>}
        <button className="btn btn-primary" type="submit" disabled={authBusy}>
          {authBusy ? "…" : mode === "signup" ? "Create my account" : "Sign in"}
        </button>
        <button
          type="button"
          className="btn-quiet"
          style={{ fontSize: 12.5 }}
          onClick={() => setMode((m) => (m === "signup" ? "login" : "signup"))}
        >
          {mode === "signup"
            ? "I already have an account — sign in"
            : "I have an invite — create an account"}
        </button>
      </form>
    </section>
  );
}
