import { useEffect, useRef, useState } from "preact/hooks";
import { BUILD_CHANNEL } from "../build-channel";

import { connectSidePanelPort, sendSidePanelRequest } from "../lib/extension";
import {
  EMPTY_CONTEXT_PRESENTATION,
  parseContextPresentation,
  type ContextPresentation,
} from "../lib/context-presentation";
import {
  EMPTY_RUNTIME_PRESENTATION,
  parseRuntimePresentation,
  runtimeStateLabel,
  type RuntimePresentation,
} from "../lib/runtime-presentation";
import { MAX_CONTEXT_MESSAGE_TEXT_BYTES, utf8ByteLength, type ContextEvent, type LocalApprovalInput, type LocalApprovalPresentation } from "../protocol/context";

type PanelResponse = { ok: true; context: unknown };
type StateResponse = { ok: true; state: unknown };
type AuthorityFence = {
  port: chrome.runtime.Port;
  epoch: number;
  connectionId: string;
  loadGenerationId: string;
};

export function App() {
  const [runtime, setRuntime] = useState<RuntimePresentation>(EMPTY_RUNTIME_PRESENTATION);
  const [context, setContext] = useState<ContextPresentation>(EMPTY_CONTEXT_PRESENTATION);
  const [portConnected, setPortConnected] = useState(false);
  const [contextBusy, setContextBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const portRef = useRef<chrome.runtime.Port | null>(null);
  const loadedConnectionRef = useRef("");
  const authorityRef = useRef({ epoch: 0, connectionId: "", loadGenerationId: "" });

  const captureAuthority = (port: chrome.runtime.Port): AuthorityFence => ({
    port,
    epoch: authorityRef.current.epoch,
    connectionId: authorityRef.current.connectionId,
    loadGenerationId: authorityRef.current.loadGenerationId,
  });
  const authorityIsCurrent = (fence: AuthorityFence): boolean => (
    portRef.current === fence.port
    && authorityRef.current.epoch === fence.epoch
    && authorityRef.current.connectionId === fence.connectionId
    && authorityRef.current.loadGenerationId === fence.loadGenerationId
  );

  useEffect(() => {
    const port = connectSidePanelPort();
    portRef.current = port;
    setPortConnected(true);
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) return;
      const candidate = message as { type?: unknown; state?: unknown; context?: unknown };
      if (candidate.type === "state") {
        const next = parseRuntimePresentation(candidate.state);
        authorityRef.current = {
          epoch: authorityRef.current.epoch + 1,
          connectionId: next.ready ? next.bridge.connection.connectionId ?? "" : "",
          loadGenerationId: next.ready ? next.bridge.loadGenerationId : "",
        };
        setRuntime(next);
        setContextBusy(false);
        setRefreshing(false);
        setSending(false);
        setPendingAction("");
        if (!next.ready) {
          loadedConnectionRef.current = "";
          setContext(EMPTY_CONTEXT_PRESENTATION);
        }
      }
      if (candidate.type === "context") setContext(parseContextPresentation(candidate.context));
    };
    port.onMessage.addListener(onMessage);
    return () => {
      port.onMessage.removeListener(onMessage);
      portRef.current = null;
      authorityRef.current = { epoch: authorityRef.current.epoch + 1, connectionId: "", loadGenerationId: "" };
      port.disconnect();
    };
  }, []);

  useEffect(() => {
    const connectionId = runtime.ready ? runtime.bridge.connection.connectionId ?? "" : "";
    const connectionKey = `${runtime.bridge.loadGenerationId}\u0000${connectionId}`;
    const port = portRef.current;
    if (!portConnected || !port || !connectionId || loadedConnectionRef.current === connectionKey) return;
    loadedConnectionRef.current = connectionKey;
    const fence = captureAuthority(port);
    setContextBusy(true);
    setNotice("");
    void sendSidePanelRequest<PanelResponse>(port, { type: "context_list" })
      .then(async (response) => {
        if (!authorityIsCurrent(fence)) return;
        const listed = parseContextPresentation(response.context);
        setContext(listed);
        if (!listed.selectedContextId && listed.suggestedContextId) {
          const restored = await sendSidePanelRequest<PanelResponse>(port, {
            type: "context_subscribe",
            params: { context_id: listed.suggestedContextId, history: "tail" },
          });
          if (!authorityIsCurrent(fence)) return;
          setContext(parseContextPresentation(restored.context));
        }
      })
      .catch(() => {
        if (!authorityIsCurrent(fence)) return;
        loadedConnectionRef.current = "";
        setNotice("Tasks are temporarily unavailable. Check the connection and try again.");
      })
      .finally(() => {
        if (authorityIsCurrent(fence)) setContextBusy(false);
      });
  }, [portConnected, runtime.ready, runtime.bridge.connection.connectionId, runtime.bridge.loadGenerationId]);

  const refresh = async () => {
    const port = portRef.current;
    if (!port) return;
    const fence = captureAuthority(port);
    setRefreshing(true);
    setNotice("");
    try {
      if (runtime.ready) {
        const response = await sendSidePanelRequest<PanelResponse>(port, { type: "context_list" });
        if (!authorityIsCurrent(fence)) return;
        setContext(parseContextPresentation(response.context));
      } else {
        const response = await sendSidePanelRequest<StateResponse>(port, { type: "refresh" });
        if (!authorityIsCurrent(fence)) return;
        const refreshed = parseRuntimePresentation(response.state);
        setRuntime((current) => ({ ...refreshed, panel: current.panel }));
      }
    } catch {
      if (!authorityIsCurrent(fence)) return;
      setNotice("Could not refresh tasks right now.");
    } finally {
      if (authorityIsCurrent(fence)) setRefreshing(false);
    }
  };

  const selectContext = async (contextId: string) => {
    const port = portRef.current;
    if (!port || contextBusy || (!contextId && !context.selectedContextId)) return;
    const fence = captureAuthority(port);
    setContextBusy(true);
    setNotice("");
    try {
      const response = contextId
        ? await sendSidePanelRequest<PanelResponse>(port, {
            type: "context_subscribe",
            params: { context_id: contextId, history: "tail" },
          })
        : await sendSidePanelRequest<PanelResponse>(port, {
            type: "context_unsubscribe",
            params: { context_id: context.selectedContextId },
          });
      if (!authorityIsCurrent(fence)) return;
      setContext(parseContextPresentation(response.context));
    } catch {
      if (!authorityIsCurrent(fence)) return;
      setNotice("That task could not be selected. Try again.");
    } finally {
      if (authorityIsCurrent(fence)) setContextBusy(false);
    }
  };

  const loadEarlier = async () => {
    const port = portRef.current;
    const selected = context.selected;
    if (!port || !selected || selected.historyBefore === null || contextBusy) return;
    const fence = captureAuthority(port);
    setContextBusy(true);
    setNotice("");
    try {
      const response = await sendSidePanelRequest<PanelResponse>(port, {
        type: "context_subscribe",
        params: { context_id: selected.summary.contextId, history_before: selected.historyBefore },
      });
      if (!authorityIsCurrent(fence)) return;
      setContext(parseContextPresentation(response.context));
    } catch {
      if (!authorityIsCurrent(fence)) return;
      setNotice("Earlier messages could not be loaded.");
    } finally {
      if (authorityIsCurrent(fence)) setContextBusy(false);
    }
  };

  const send = async (queued = false) => {
    const port = portRef.current;
    const selected = context.selected;
    const text = draft;
    if (
      !port
      || !runtime.ready
      || !selected
      || sending
      || contextBusy || Boolean(pendingAction)
      || text.trim().length === 0
      || utf8ByteLength(text) > MAX_CONTEXT_MESSAGE_TEXT_BYTES
    ) return;
    const fence = captureAuthority(port);
    setSending(true);
    setNotice("");
    const clientMessageId = `client:${crypto.randomUUID()}`;
    try {
      await sendSidePanelRequest(port, {
        type: queued ? "context_queue_add" : "context_send_message",
        params: {
          context_id: selected.summary.contextId,
          client_message_id: clientMessageId,
          text,
        },
      }, 120_000);
      if (!authorityIsCurrent(fence)) return;
      setDraft((current) => current === text ? "" : current);
      setNotice(queued ? "Message queued. Agent Zero can pick it up after its current work." : "Update sent to Agent Zero.");
    } catch {
      if (!authorityIsCurrent(fence)) return;
      setNotice("This update was not confirmed. It was not retried automatically.");
    } finally {
      if (authorityIsCurrent(fence)) setSending(false);
    }
  };

  const queueItem = async (action: "remove" | "send", itemId: string) => {
    const port = portRef.current;
    const selected = context.selected;
    if (!port || !runtime.ready || !selected || sending || pendingAction || contextBusy) return;
    const fence = captureAuthority(port);
    setPendingAction(itemId);
    setNotice("");
    try {
      await sendSidePanelRequest(port, { type: `context_queue_${action}`, params: { context_id: selected.summary.contextId, item_id: itemId } }, 120_000);
      if (!authorityIsCurrent(fence)) return;
      setNotice(action === "send" ? "Queue update confirmed. Check the conversation for the message." : "Queued message removed.");
    } catch {
      if (authorityIsCurrent(fence)) setNotice("The queue change was not confirmed. It was not retried automatically.");
    } finally {
      if (authorityIsCurrent(fence)) setPendingAction("");
    }
  };

  const decideApproval = async (approval: LocalApprovalPresentation, decision: LocalApprovalInput["decision"]) => {
    const port = portRef.current;
    if (!port || !runtime.ready || !context.selected || context.selected.summary.contextId !== approval.contextId
      || sending || pendingAction || contextBusy || Date.now() >= approval.expiresAtMs) return;
    const fence = captureAuthority(port);
    setPendingAction(approval.challengeId);
    setNotice("");
    try {
      await sendSidePanelRequest(port, { type: "browser_approval_decision", confirmed: true, params: {
        context_id: approval.contextId, challenge_id: approval.challengeId, kind: approval.kind, decision,
      } }, 30_000);
      if (!authorityIsCurrent(fence)) return;
      setNotice("Your choice was sent to Agent Zero. The task will report the browser result.");
    } catch {
      if (authorityIsCurrent(fence)) setNotice("That approval was not confirmed. It may have expired; check the task before trying again.");
    } finally {
      if (authorityIsCurrent(fence)) setPendingAction("");
    }
  };

  const label = runtimeStateLabel(runtime);
  const ready = runtime.ready;
  const blocked = runtime.bridge.phase === "BLOCKED";
  const canSend = Boolean(
    ready
    && context.selected
    && !sending
    && !contextBusy && !pendingAction
    && draft.trim().length > 0
    && utf8ByteLength(draft) <= MAX_CONTEXT_MESSAGE_TEXT_BYTES,
  );

  return (
    <div className="panel-shell">
      <header className="panel-header">
        <span className="brand-mark" aria-hidden="true">A0</span>
        <div className="panel-identity">
          {ready && context.contexts.length > 0 ? (
            <>
              <label className="visually-hidden" htmlFor="task-switcher">Selected Agent Zero task</label>
              <select
                id="task-switcher"
                value={context.selectedContextId ?? ""}
                disabled={contextBusy || sending || Boolean(pendingAction)}
                aria-label="Selected Agent Zero task"
                onChange={(event) => void selectContext(event.currentTarget.value)}
              >
                <option value="">Choose a task</option>
                {context.contexts.map((item) => <option value={item.contextId} key={item.contextId}>{item.label}</option>)}
              </select>
              <span title={runtime.panel.anchorOrigin ?? undefined}>
                {BUILD_CHANNEL.development ? `${BUILD_CHANNEL.label} · ` : ""}
                {runtime.panel.anchorOrigin ? `Anchored to ${runtime.panel.anchorOrigin}` : "No page anchor"}
              </span>
            </>
          ) : (
            <><strong>Agent Zero</strong><span>{BUILD_CHANNEL.development ? BUILD_CHANNEL.label : "Browser workspace"}</span></>
          )}
        </div>
        {ready && <span className="tab-count">{runtime.bridge.activeLeaseCount} tabs</span>}
        <button className="icon-button" type="button" aria-label="Open browser connection settings" title="Browser connection settings" onClick={() => chrome.runtime.openOptionsPage()}>
          <SettingsIcon />
        </button>
      </header>

      <div className={`connection-strip ${ready ? "is-ready" : blocked ? "is-blocked" : ""}`} role="status" aria-live="polite" aria-atomic="true">
        <span className="connection-dot" aria-hidden="true" />
        <span>{ready && context.selected ? taskStatus(context.selected.completionStatus, context.selected.summary.status) : label}</span>
        <button type="button" disabled={refreshing || contextBusy} onClick={() => void refresh()}>{refreshing ? "Checking…" : "Check"}</button>
      </div>

      <main className="panel-main">
        {ready
          ? <TaskWorkspace runtime={runtime} context={context} busy={contextBusy || sending || Boolean(pendingAction)} loadEarlier={loadEarlier} queueItem={queueItem} decideApproval={decideApproval} pendingAction={pendingAction} />
          : <RecoveryState runtime={runtime} />}
        {notice && <p className="panel-notice" role="status">{notice}</p>}
      </main>

      <footer className="panel-footer">
        {ready && context.selected ? (
          <div className="composer">
            <label className="visually-hidden" htmlFor="message-agent-zero">Message Agent Zero</label>
            <textarea
              id="message-agent-zero"
              rows={1}
              value={draft}
              placeholder={context.selected.completionStatus ? "Ask a follow-up…" : "Message Agent Zero…"}
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <button type="button" disabled={!canSend} aria-label="Send update" title="Send update" onClick={() => void send()}>
              {sending ? <span className="send-progress" aria-hidden="true">…</span> : <SendIcon />}
            </button>
          </div>
        ) : (
          <div className="composer-placeholder" aria-disabled="true">
            <span>{ready ? "Select a task to send an update" : BUILD_CHANNEL.development ? "Extension chat unavailable · use Agent Zero" : "Connect the browser companion to continue"}</span>
            <button type="button" disabled aria-label="Send message unavailable"><SendIcon /></button>
          </div>
        )}
        {ready && context.selected && <div className="composer-actions"><button type="button" disabled={!canSend} onClick={() => void send(true)}>Queue message</button><span>Send after current work</span></div>}
        {draft && utf8ByteLength(draft) > MAX_CONTEXT_MESSAGE_TEXT_BYTES && (
          <p className="composer-error" role="alert">Shorten this update before sending.</p>
        )}
        <p>Closing this panel does not stop work or close your tabs.</p>
      </footer>
    </div>
  );
}

function TaskWorkspace({
  runtime,
  context,
  busy,
  loadEarlier,
  queueItem, decideApproval, pendingAction,
}: {
  runtime: RuntimePresentation;
  context: ContextPresentation;
  busy: boolean;
  loadEarlier: () => Promise<void>;
  queueItem: (action: "remove" | "send", itemId: string) => Promise<void>;
  decideApproval: (approval: LocalApprovalPresentation, decision: LocalApprovalInput["decision"]) => Promise<void>;
  pendingAction: string;
}) {
  if (busy && context.contexts.length === 0) {
    return <section className="task-empty" aria-busy="true"><h1>Loading your tasks…</h1></section>;
  }
  if (context.contexts.length === 0) {
    return (
      <section className="task-empty">
        <h1>No authorized tasks yet</h1>
        <p>Start a task in Agent Zero, then check again. Only tasks advertised by your paired Agent Zero instance appear here.</p>
      </section>
    );
  }
  if (!context.selected) {
    return (
      <section className="task-empty">
        <h1>Choose a task to continue</h1>
        <p>The browser page stays anchored separately. Selecting a task does not share this page or start browser control.</p>
      </section>
    );
  }

  const selected = context.selected;
  return (
    <>
      {(selected.approvals?.length ?? 0) > 0 && (
        <section className="context-card approval-section" aria-labelledby="approval-title">
          <h2 id="approval-title">Your approval is needed</h2>
          <p>These choices apply only to this task. Nothing is approved automatically.</p>
          <ul className="task-control-list">
            {selected.approvals?.map((approval) => (
              <li key={approval.challengeId}>
                <strong>{approval.summary}</strong><p>{approval.origin}</p>
                <div className="task-control-actions">
                  {approval.options.map((decision) => (
                    <button key={decision} type="button" disabled={busy || Date.now() >= approval.expiresAtMs}
                      onClick={() => void decideApproval(approval, decision)}>
                      {pendingAction === approval.challengeId ? "Sending choice…" : approvalLabel(decision)}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {selected.completionStatus && (
        <section className={`completion-card is-${selected.completionStatus}`} aria-labelledby="completion-title">
          <h1 id="completion-title">{completionTitle(selected.completionStatus)}</h1>
          <p>{selected.completionStatus === "completed"
            ? "The task finished. You can send a follow-up without reopening browser control yourself."
            : selected.completionStatus === "canceled"
              ? "The task was canceled. Any retained tabs stay under your control."
              : "The task stopped with an error. Review it in Agent Zero before retrying effects."}</p>
        </section>
      )}

      <section className="conversation" aria-labelledby="conversation-title">
        <div className="section-heading">
          <h1 id="conversation-title">{selected.summary.label}</h1>
          {selected.hasMoreHistory && selected.historyBefore !== null && (
            <button type="button" disabled={busy} onClick={() => void loadEarlier()}>Earlier</button>
          )}
        </div>
        {selected.events.length > 0 ? (
          <ol className="event-list">
            {selected.events.map((event) => <EventItem event={event} key={`${event.sequence}:${event.correlationId ?? ""}`} />)}
          </ol>
        ) : (
          <div className="empty-conversation"><p>No messages have been projected for this task yet.</p></div>
        )}
      </section>

      <section className="activity-card" aria-labelledby="tabs-title">
        <div className="card-heading">
          <h2 id="tabs-title">Task tabs</h2>
          <span>{runtime.bridge.activeLeaseCount} active</span>
        </div>
        <div className="empty-activity">
          <p>Temporary task tabs are grouped and finalized by Agent Zero. Your existing tabs always stay open.</p>
        </div>
      </section>

      <section className="context-card" aria-labelledby="queue-title">
        <div className="card-heading"><h2 id="queue-title">Queued messages</h2><span>{selected.messageQueue?.length ?? 0}</span></div>
        {(selected.messageQueue?.length ?? 0) > 0 ? <ul className="task-control-list">
          {selected.messageQueue?.map((item) => <li key={item.id}>
            <p>{item.text || "Queued message"}</p>
            <div className="task-control-actions">
              <button type="button" disabled={busy} onClick={() => void queueItem("send", item.id)}>{pendingAction === item.id ? "Updating…" : "Send now"}</button>
              <button type="button" disabled={busy} onClick={() => void queueItem("remove", item.id)}>Remove</button>
            </div>
          </li>)}
        </ul> : <p>No queued messages from this browser. Use “Queue message” to save an update for after the current work.</p>}
      </section>

      {runtime.bridge.candidateReady && (
        <section className="context-card" aria-labelledby="staged-title">
          <div className="card-heading">
            <h2 id="staged-title">Page context in Chrome</h2>
            <span className="context-state is-ready">Not shared</span>
          </div>
          <p>This page remains only a local candidate until an authorized attachment flow is available.</p>
        </section>
      )}
    </>
  );
}

function EventItem({ event }: { event: ContextEvent }) {
  if (event.event === "message") {
    return (
      <li className={`message ${event.data.role === "user" ? "is-user" : "is-assistant"}`}>
        <span>{event.data.role === "user" ? "You" : "Agent Zero"}</span>
        <p>{event.data.text}</p>
      </li>
    );
  }
  return (
    <li className={`activity-event is-${event.data.status}`}>
      <span aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="7" />
        {event.data.status === "working" ? <path d="M10 6v4l2 2" /> : event.data.status === "failed" ? <path d="M10 6.5v4M10 13h.01" /> : <path d="m6.5 10 2.3 2.3 4.7-4.6" />}
      </svg></span>
      <p>{activityLabel(event.data.activity)} · {event.data.status}</p>
    </li>
  );
}

function activityLabel(activity: string): string {
  switch (activity) {
    case "assistant_work": return "Agent Zero working";
    case "browser": return "Browser activity";
    case "code": return "Code activity";
    case "subagent": return "Subagent activity";
    case "tool": return "Tool activity";
    default: return "Task status";
  }
}

function approvalLabel(decision: LocalApprovalInput["decision"]): string {
  if (decision === "deny" || decision === "decline") return "Don't allow";
  if (decision === "allow_turn") return "Allow for this turn";
  return "Allow once";
}

function taskStatus(completion: "completed" | "canceled" | "failed" | null, status: string): string {
  if (completion === "completed") return "Task complete";
  if (completion === "canceled") return "Task canceled";
  if (completion === "failed") return "Task failed";
  if (status === "running") return "Working";
  if (status === "paused") return "Paused";
  return "Connected · idle";
}

function completionTitle(status: "completed" | "canceled" | "failed"): string {
  if (status === "completed") return "Finished";
  if (status === "canceled") return "Canceled";
  return "Task failed";
}

function RecoveryState({ runtime }: { runtime: RuntimePresentation }) {
  const limited = BUILD_CHANNEL.development && runtime.limitedBrowserReady === true;
  const blocked = runtime.bridge.phase === "BLOCKED";
  const developmentPairing = BUILD_CHANNEL.development
    && runtime.bridge.connection.reasonCode === "development_pairing_only";
  const developmentPaired = developmentPairing && runtime.bridge.connection.reportedServerState === "paired";
  return (
    <section className="recovery-card">
      <h1>{limited ? "Ready for browser tasks" : developmentPaired ? "Pairing is saved" : blocked ? "Check your companion connection" : "Connect Chrome to Agent Zero"}</h1>
      <p>{limited
        ? "Continue in Agent Zero for tasks and site approvals. Development mode can work with owned tabs, read pages, navigate and scroll."
        : runtime.bridge.connection.limitedTransportReady
          ? "Checking existing browser tabs before enabling control. Chat in this extension remains unavailable."
        : developmentPairing
        ? developmentPaired
          ? "No new code is needed. Select this browser for your chat in Agent Zero Browser settings, then open connection details to reconnect."
          : "Pair once using a code from Agent Zero Browser settings → Development browser companion. Open setup to continue."
        : blocked
        ? "The companion could not be verified, so browser control is off. Open connection settings to check the installation."
        : "Set up the local companion and pair this Chrome profile once. Your pairing is saved across restarts."}</p>
      {limited && <p>Chat in this extension, screenshots, clicking and typing are not available in development mode.</p>}
      <button className="primary-button" type="button" onClick={() => chrome.runtime.openOptionsPage()}>
        {developmentPaired || limited ? "Open connection details" : blocked ? "Open repair steps" : "Open connection setup"}
      </button>
      <details className="reason-code"><summary>Connection diagnostic</summary><code>{runtime.bridge.connection.reasonCode}</code></details>
    </section>
  );
}

function SettingsIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Zm8 3.6-.1-1.1 2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.9-1.1L15.3 3h-4l-.4 2.9A8 8 0 0 0 9 7L6.6 6l-2 3.4 2 1.5A8 8 0 0 0 6.5 12c0 .4 0 .7.1 1.1l-2 1.5 2 3.4L9 17a8 8 0 0 0 1.9 1.1l.4 2.9h4l.4-2.9a8 8 0 0 0 1.9-1.1l2.4 1 2-3.4-2-1.5.1-.7v-.4Z" /></svg>;
}

function SendIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 17 8-17 8 3-7 8-1-8-1-3-7Z" /></svg>;
}
