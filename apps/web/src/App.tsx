import { useEffect, useState } from "react";
import { supabase } from "./lib/supabase";

type Health = "checking" | "ready" | "unreachable";

export default function App() {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    // Lightweight confirmation that the browser Supabase client initialized
    // with the anon key. getSession() needs no tables and reads no private data.
    let cancelled = false;
    supabase.auth
      .getSession()
      .then(() => !cancelled && setHealth("ready"))
      .catch(() => !cancelled && setHealth("unreachable"));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "var(--space-12)",
        maxWidth: "62ch",
        margin: "0 auto",
      }}
    >
      <p
        style={{
          fontFamily: "var(--font-ui)",
          textTransform: "uppercase",
          letterSpacing: "0.18em",
          fontSize: "var(--text-xs)",
          color: "var(--surface-ink-soft)",
          marginBottom: "var(--space-4)",
        }}
      >
        Throughline
      </p>

      <h1 style={{ fontSize: "var(--text-display)", marginBottom: "var(--space-6)" }}>
        The River is universal.
        <br />
        Every family weaves its thread through it.
      </h1>

      <p
        style={{
          fontSize: "var(--text-lg)",
          color: "var(--surface-ink-soft)",
          maxWidth: "48ch",
        }}
      >
        A place where photographs, records, and the stories told around them rest
        together — gathered with care, kept close, and revisited at your own pace.
      </p>

      <div
        style={{
          marginTop: "var(--space-16)",
          paddingTop: "var(--space-4)",
          borderTop: "1px solid var(--color-hairline)",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          fontSize: "var(--text-sm)",
          color: "var(--surface-ink-soft)",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background:
              health === "ready"
                ? "#3f7d5a"
                : health === "unreachable"
                  ? "#a14b3a"
                  : "var(--color-deep-river-muted)",
          }}
        />
        {health === "checking" && "Connecting to the River…"}
        {health === "ready" && "Connected to the River."}
        {health === "unreachable" && "The River is out of reach right now."}
      </div>
    </main>
  );
}
