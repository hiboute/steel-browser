import { useEffect, useMemo, useRef } from "react";
import { apiUrl, isPrimarySession, type SessionDetails } from "../api";
import { useColorScheme, usePageId } from "../hooks";
import { Details } from "./details";
import { Notice } from "./notice";

type BridgeMessage = {
  type?: string;
  requestId?: string;
  text?: string;
};

function LiveFrame({ url }: { url: string }) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const theme = useColorScheme();

  const src = useMemo(() => {
    const target = new URL(url, window.location.href);
    target.searchParams.set("theme", theme);
    target.searchParams.set("clipboardBridge", "true");
    return target;
  }, [url, theme]);

  useEffect(() => {
    const origin = src.origin;
    const post = (message: Record<string, unknown>) =>
      frame.current?.contentWindow?.postMessage(message, origin);

    const onMessage = async (event: MessageEvent<BridgeMessage | null>) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      const { type, requestId, text } = event.data ?? {};
      if (type === "requestClipboardRead") {
        try {
          const value = await navigator.clipboard.readText();
          post({ type: "clipboardReadResponse", requestId, text: value });
        } catch {
          post({ type: "clipboardReadResponse", requestId, error: "Failed to read clipboard" });
        }
      } else if (type === "requestClipboardWrite") {
        try {
          await navigator.clipboard.writeText(text ?? "");
          post({ type: "clipboardWriteResponse", requestId, success: true });
        } catch {
          post({
            type: "clipboardWriteResponse",
            requestId,
            success: false,
            error: "Failed to write to clipboard",
          });
        }
      }
    };

    const onKeyDown = async (event: KeyboardEvent) => {
      if (!container.current?.contains(document.activeElement)) return;
      if (!event.ctrlKey && !event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "c") {
        event.preventDefault();
        post({ type: "triggerCopy" });
      } else if (key === "v") {
        event.preventDefault();
        try {
          const text = await navigator.clipboard.readText();
          if (text) post({ type: "triggerPaste", text });
        } catch {
          return;
        }
      }
    };

    window.addEventListener("message", onMessage);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [src]);

  return (
    <div ref={container} className="player" tabIndex={0}>
      <iframe
        ref={frame}
        src={src.toString()}
        title="Live browser"
        className="live-frame"
        sandbox="allow-same-origin allow-scripts"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}

function DevTools({ session }: { session: SessionDetails }) {
  const pageId = usePageId(session);
  const query = pageId ? `?pageId=${encodeURIComponent(pageId)}` : "";

  return (
    <div className="dock">
      <iframe
        title="Chrome DevTools"
        className="dock-frame"
        src={apiUrl(`/v1/devtools/inspector.html${query}`)}
      />
    </div>
  );
}

export function Stage({
  session,
  devtoolsOpen,
}: {
  session: SessionDetails;
  devtoolsOpen: boolean;
}) {
  const running = ["live", "idle"].includes(session.status);
  const docked = running && devtoolsOpen && Boolean(session.debugUrl) && isPrimarySession(session);

  return (
    <section className="stage" data-devtools={docked ? "open" : "closed"} aria-label="Live view">
      {running && session.debugUrl ? (
        <LiveFrame url={session.debugUrl} />
      ) : (
        <div className="player">
          {session.status === "parked" ? (
            <div className="parked-preview">
              <img
                src={apiUrl(`/v1/sessions/${session.id}/thumbnail`)}
                alt="Browser when parked"
                onError={(e) => {
                  e.currentTarget.hidden = true;
                }}
              />
              <h2>Saved for later</h2>
              <p>This browser's state is parked. Resume it to continue from where you left off.</p>
              {session.tabs?.map((tab, i) => (
                <p key={i} className="field-hint">
                  {tab.title || tab.url}
                </p>
              ))}
            </div>
          ) : (
            <Notice title={session.status === "released" ? "Session released" : "No live view"}>
              {session.status === "released"
                ? "This browser is closed. Its activity, downloads, and recording are still available below."
                : session.isSelenium
                ? "Selenium sessions don't stream a live view."
                : "This session doesn't have a live view."}
            </Notice>
          )}
        </div>
      )}
      {docked && <DevTools session={session} />}
      <div className="stage-details">
        <Details session={session} />
      </div>
    </section>
  );
}
