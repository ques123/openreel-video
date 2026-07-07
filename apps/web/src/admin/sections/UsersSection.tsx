/**
 * Users: search + list + a selected user's detail panel (recent events,
 * quota overrides, disable/enable, reset password). See
 * docs/wizz-video-plan.md §WS-C and docs/wizz-contracts.md §2 "Admin API".
 */
import { useEffect, useRef, useState } from "react";
import type { AdminUserSummary } from "@wizz/contracts";
import { adminListUsers } from "../../services/gateway";
import { AdminProbeResult, type ProbeState } from "../AdminProbeResult";
import { SectionPage } from "../SectionPage";
import { UserDetailPanel } from "./users/UserDetailPanel";
import { UsersTable } from "./users/UsersTable";

const SEARCH_DEBOUNCE_MS = 300;

export function UsersSection() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [state, setState] = useState<ProbeState<{ users: AdminUserSummary[] }>>({ status: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  useEffect(() => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [query]);

  const load = () => {
    setState((prev) => (prev.status === "ok" ? prev : { status: "loading" }));
    adminListUsers(debouncedQuery || undefined)
      .then((data) => setState({ status: "ok", data }))
      .catch((error: unknown) => setState({ status: "error", error }));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  return (
    <SectionPage
      title="Users"
      wide
      description="Search, inspect usage, override quotas, disable accounts, and reset passwords."
    >
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="search by email…"
        className="mb-3 w-full max-w-sm rounded-md border border-border bg-background px-2 py-1.5 text-sm text-text-primary placeholder:text-text-secondary/60 outline-none focus:border-primary"
      />
      <AdminProbeResult
        state={state}
        render={(data) => (
          <UsersTable users={data.users} selectedId={selectedId} onSelect={setSelectedId} />
        )}
      />
      {selectedId && (
        <div className="mt-4">
          <UserDetailPanel userId={selectedId} onClose={() => setSelectedId(null)} onChanged={load} />
        </div>
      )}
    </SectionPage>
  );
}
