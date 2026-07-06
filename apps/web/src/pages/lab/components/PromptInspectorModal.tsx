import { useEffect } from "react";
import type { ChatMessage } from "@openreel/core";
import { DIRECTOR_MODEL } from "../../../services/openai-proxy";

interface PromptInspectorModalProps {
  messages: ChatMessage[];
  onClose: () => void;
  /** The model this conversation actually ran on (defaults to the flagship). */
  model?: string;
}

function roleStyle(model: string): Record<string, { label: string; cls: string }> {
  return {
    system: { label: "system prompt", cls: "bg-purple-500/15 text-purple-400" },
    user: { label: "sent to model", cls: "bg-primary/15 text-primary" },
    assistant: { label: `${model} replied`, cls: "bg-emerald-500/15 text-emerald-400" },
    tool: { label: "local result → model", cls: "bg-amber-500/15 text-amber-500" },
  };
}

function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

/**
 * Verbatim view of the director conversation: what left this machine (system
 * prompt, dossier text, brief, tool results) and what the model sent back.
 * This is the ENTIRE payload — no pixels, thumbnails, or embeddings.
 */
export function PromptInspectorModal({
  messages,
  onClose,
  model = DIRECTOR_MODEL,
}: PromptInspectorModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const totalChars = messages.reduce((n, m) => {
    let c = typeof m.content === "string" ? m.content.length : 0;
    if (m.role === "assistant" && m.tool_calls) {
      for (const t of m.tool_calls) c += t.function.arguments.length;
    }
    return n + c;
  }, 0);
  const roleStyles = roleStyle(model);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-background-secondary border border-border rounded-xl overflow-hidden max-w-3xl w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-border shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-medium text-text-primary">
              What gets sent to {model}
            </p>
            <p className="text-xs text-text-secondary">
              The complete conversation, verbatim — text only (~
              {Math.round(totalChars / 1000)}k chars). No frames, thumbnails or
              embeddings ever leave your machine.
            </p>
          </div>
          <button
            className="text-text-secondary hover:text-text-primary text-xl px-2 shrink-0"
            onClick={onClose}
            aria-label="Close inspector"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto p-4 space-y-3">
          {messages.map((m, i) => {
            const style = roleStyles[m.role] ?? roleStyles.user;
            return (
              <div key={i}>
                <span
                  className={`inline-block text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded ${style.cls}`}
                >
                  {style.label}
                </span>
                {typeof m.content === "string" && m.content && (
                  <pre className="mt-1 text-[11px] leading-snug font-mono text-text-primary whitespace-pre-wrap break-words bg-background border border-border rounded-md p-2">
                    {m.content}
                  </pre>
                )}
                {m.role === "assistant" &&
                  m.tool_calls?.map((t) => (
                    <pre
                      key={t.id}
                      className="mt-1 text-[11px] leading-snug font-mono text-emerald-300/90 whitespace-pre-wrap break-words bg-background border border-border rounded-md p-2"
                    >
                      {`→ ${t.function.name}(${prettyArgs(t.function.arguments)})`}
                    </pre>
                  ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
