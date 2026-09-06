import { useEffect, useRef, useState } from "preact/hooks";
import { BUILD_CHANNEL } from "../build-channel";
import { AgentZeroLogo } from "../ui/AgentZeroLogo";

import { sendRuntimeMessage } from "../lib/extension";
import {
  EMPTY_RUNTIME_PRESENTATION,
  runtimeStateLabel,
  type RuntimePresentation,
} from "../lib/runtime-presentation";
import { PairingInputError, parsePairingSubmission } from "../lib/pairing";
import { observeOptionsRuntime } from "./runtime-observer";

const HEALTHY_PHASES = new Set(["READY"]);

export function App() {
  const [runtime, setRuntime] = useState<RuntimePresentation>(EMPTY_RUNTIME_PRESENTATION);
  const [checking, setChecking] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [serverBaseUrl, setServerBaseUrl] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingNotice, setPairingNotice] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialNotice, setCredentialNotice] = useState("");
  const [revokeConfirmed, setRevokeConfirmed] = useState(false);
  const observerRef = useRef<ReturnType<typeof observeOptionsRuntime> | null>(null);
  const operationRef = useRef(0);

  const ensureObserver = () => {
    if (!observerRef.current?.connected) {
      observerRef.current?.close();
      observerRef.current = observeOptionsRuntime((state) => {
        setRuntime(state);
        setLoadError("");
      }, () => {
        operationRef.current += 1;
        setChecking(false);
        setPairingBusy(false);
        setDisconnecting(false);
        setReconnecting(false);
        setCredentialBusy(false);
        setCredentialNotice("");
        setRuntime(EMPTY_RUNTIME_PRESENTATION);
        setLoadError("Live status disconnected. Check again to reconnect.");
      });
    }
    return observerRef.current;
  };

  const refresh = async () => {
    let observer: ReturnType<typeof observeOptionsRuntime>;
    try { observer = ensureObserver(); } catch {
      setLoadError("Could not subscribe to extension status. Reload this page and try again.");
      return;
    }
    const captured = observer.capture();
    setChecking(true);
    setLoadError("");
    try {
      const response = await sendRuntimeMessage<{ ok: boolean; state: unknown }>({ type: "refresh" });
      observer.applyResponse(captured, response.state);
    } catch (error) {
      if (observer.isCurrent(captured)) setLoadError(error instanceof Error ? error.message : "Could not read extension status.");
    } finally {
      if (observer.active) setChecking(false);
    }
  };

  useEffect(() => {
    void refresh();
    return () => {
      observerRef.current?.close();
      observerRef.current = null;
      operationRef.current += 1;
    };
  }, []);

  const updateCredential = async (action: "rotate" | "status" | "revoke") => {
    const observer = observerRef.current;
    if (!observer?.connected || credentialBusy || !runtime.ready || BUILD_CHANNEL.development || (action === "revoke" && !revokeConfirmed)) return;
    const operation = ++operationRef.current;
    setCredentialBusy(true);
    setCredentialNotice("");
    try {
      const response = await sendRuntimeMessage<{ ok: boolean; result: { status: string } }>({ type: "credential_control", action, confirmed: true });
      if (!observer.active || operation !== operationRef.current) return;
      if (!response.ok) throw new Error("Credential request failed");
      setCredentialNotice(response.result.status === "no_pending"
        ? "No key update is pending. Your saved pairing needs no changes."
        : response.result.status === "pending"
        ? "Key update saved. Reconnecting securely—your pairing stays saved."
        : response.result.status === "revoked"
        ? "Browser access removed from Agent Zero. Pair again only if you want to restore access."
        : response.result.status === "expired"
        ? "That key update expired. Your previous key is still saved; you can start a new update."
        : "The updated key is active.");
      setRevokeConfirmed(false);
    } catch {
      if (observer.active && operation === operationRef.current) setCredentialNotice("Could not confirm the key change. Your saved keys were kept. Reconnect and check the pending update; do not pair again.");
    } finally {
      if (observer.active && operation === operationRef.current) setCredentialBusy(false);
    }
  };

  const pairBrowser = async (event: Event) => {
    event.preventDefault();
    const observer = observerRef.current;
    if (pairingBusy || !observer?.connected) return;
    setPairingNotice("");

    let submission: ReturnType<typeof parsePairingSubmission>;
    try {
      submission = parsePairingSubmission(serverBaseUrl, pairingCode);
    } catch (error) {
      setPairingNotice(
        error instanceof PairingInputError && error.reasonCode === "INSECURE_SERVER_URL"
          ? "Use HTTPS unless Agent Zero is published on this computer through a loopback address."
          : error instanceof PairingInputError && error.reasonCode === "INVALID_PAIRING_CODE"
            ? "Enter the complete A0B1 pairing code shown by Agent Zero."
            : "Enter an Agent Zero HTTP(S) base URL without credentials, a query, or a fragment.",
      );
      return;
    }

    setPairingBusy(true);
    setPairingCode("");
    const captured = observer.capture();
    const operation = ++operationRef.current;
    try {
      const response = await sendRuntimeMessage<{ ok: boolean; state: unknown }>({
        type: "pair_browser",
        params: submission,
      });
      if (!observer.active || operation !== operationRef.current) return;
      observer.applyResponse(captured, response.state);
      setPairingNotice(BUILD_CHANNEL.development
        ? "Development identity paired. Select it in Agent Zero Browser settings, then reconnect after selection."
        : "Pairing completed. Chrome is reconnecting to Agent Zero.");
    } catch {
      if (observer.active && operation === operationRef.current) setPairingNotice("Pairing could not be confirmed. Check the saved pairing status first. If Agent Zero lists this browser but the companion has no saved pairing, remove that browser in Agent Zero before creating a new code.");
    } finally {
      if (observer.active) setPairingBusy(false);
    }
  };

  const disconnectBrowser = async () => {
    const observer = observerRef.current;
    if (!observer?.connected) return;
    if (disconnecting || !globalThis.confirm("Disconnect this Chrome profile from Agent Zero? Existing user tabs will stay open.")) return;
    const captured = observer.capture();
    const operation = ++operationRef.current;
    setDisconnecting(true);
    setPairingNotice("");
    try {
      const response = await sendRuntimeMessage<{ ok: boolean; state: unknown }>({
        type: "disconnect_browser",
        confirmed: true,
      });
      if (!observer.active || operation !== operationRef.current) return;
      observer.applyResponse(captured, response.state);
      setPairingNotice("This Chrome profile was disconnected from Agent Zero.");
    } catch {
      if (observer.active && operation === operationRef.current) setPairingNotice("The companion could not confirm disconnection. Check its status before retrying.");
    } finally {
      if (observer.active) setDisconnecting(false);
    }
  };

  const label = runtimeStateLabel(runtime);
  const limited = BUILD_CHANNEL.development && runtime.limitedBrowserReady === true;
  const connected = HEALTHY_PHASES.has(runtime.bridge.phase) && runtime.ready;
  const companionDetected = runtime.bridge.connection.state === "ready"
    || ["NEGOTIATING", "RECONCILING", "READY"].includes(runtime.bridge.phase);
  const paired = runtime.bridge.connection.reportedServerState === "paired"
    || runtime.bridge.connection.serverState === "paired"
    || runtime.bridge.connection.serverState === "paired_inactive";
  const reconnectAfterSelection = async () => {
    const observer = observerRef.current;
    if (!observer?.connected || reconnecting || !runtime.canReconnectDevelopmentBrowser) return;
    const operation = ++operationRef.current;
    const captured = observer.capture();
    setReconnecting(true);
    setPairingNotice("");
    try {
      const response = await sendRuntimeMessage<{ ok: boolean; state: unknown }>({ type: "reconnect_development_browser" });
      if (!observer.active || operation !== operationRef.current) return;
      if (!response.ok) throw new Error("Reconnect not accepted");
      observer.applyResponse(captured, response.state);
      setPairingNotice("Reconnecting to verify your server-side selection. Browser control stays off until reconciliation completes.");
    } catch {
      if (observer.active && operation === operationRef.current) setPairingNotice("Reconnect was not confirmed. Check the connection status and your selection in Agent Zero.");
    } finally {
      if (observer.active && operation === operationRef.current) setReconnecting(false);
    }
  };

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <AgentZeroLogo />
        <div className="header-copy">
          <div className="title-row"><h1>Browser connection</h1>{BUILD_CHANNEL.development && <span className="development-label">Development</span>}</div>
          <p>Agent Zero companion for this Chrome profile</p>
        </div>
        <span className={`state-pill ${connected || limited ? "is-ready" : runtime.bridge.phase === "BLOCKED" ? "is-blocked" : ""}`}>
          <span aria-hidden="true" className="state-dot" />
          {label}
        </span>
      </header>

      <section className="health-panel" aria-labelledby="health-title">
        <div className="section-heading">
          <div>
            <h2 id="health-title">Connection status</h2>
          </div>
          <button className="quiet-button" type="button" disabled={checking} onClick={() => void refresh()}>
            {checking ? "Checking…" : "Check again"}
          </button>
        </div>

        <ol className="health-list">
          <HealthRow state="ready" label="Chrome extension" detail="Installed in this profile" />
          <HealthRow
            state={companionDetected ? "ready" : runtime.bridge.phase === "BLOCKED" ? "blocked" : "waiting"}
            label="Local companion"
            detail={companionDetected ? "Detected on this computer" : "Not detected — see installation below"}
          />
          <HealthRow
            state={paired ? "ready" : companionDetected ? "waiting" : "inactive"}
            label="Agent Zero pairing"
            detail={BUILD_CHANNEL.development
              ? paired ? "Development pairing saved for this profile" : "Pair once using a code from Agent Zero"
              : paired ? "Pairing saved for this profile" : "Pair once using a code from Agent Zero"}
          />
          <HealthRow
            state={connected || limited ? "ready" : paired ? "waiting" : "inactive"}
            label="Browser control"
            detail={BUILD_CHANNEL.development
              ? limited ? "Ready for owned tabs, page reading, navigation and scrolling"
                : paired ? "Select this browser for your chat in Agent Zero, then reconnect"
                : "Available after pairing and browser selection"
              : connected
              ? `${runtime.bridge.actions.length} browser actions available`
              : paired
                ? runtime.bridge.phase === "BLOCKED" ? "Pairing saved — check the connection below" : "Pairing saved — reconnecting automatically"
                : "Available after setup and connection checks"}
          />
        </ol>

        {loadError ? <p className="notice is-error" role="alert">{loadError}</p> : null}
        {!loadError && !connected && !limited ? (
          <p className="notice" role="status">
            {runtime.bridge.phase === "BLOCKED"
              ? "The companion could not be verified. Open installation and repair below, then check again."
              : BUILD_CHANNEL.development && companionDetected
                ? runtime.bridge.connection.limitedTransportReady
                  ? "Checking existing browser tabs before enabling control."
                  : "Pairing and browser control are separate. Agent Zero must enable development control and select this browser for your chat."
                : paired && companionDetected
                  ? "Select this browser for your chat in Agent Zero. The connection checks retry automatically; you can close this page."
                  : "Waiting for the local companion. Check the installation below if it remains unavailable."}
            {!companionDetected ? <> <a href="#companion-install">Open installation steps</a></> : null}
          </p>
        ) : null}
      </section>

      {!paired ? (
        <section className="pairing-panel" aria-labelledby="pairing-title">
          <div className="pairing-copy">
            <h2 id="pairing-title">Pair this Chrome profile</h2>
            <p>Pair once. The companion remembers this profile across restarts; you do not need a new code for each task.</p>
            <p>{BUILD_CHANNEL.development
              ? "In Agent Zero, open Browser settings → Development browser companion and create a code. If this section is unavailable, ask the person managing Agent Zero to enable development setup."
              : "In Agent Zero, open Browser settings and create a five-minute pairing code. Enter it here with the address you use to open Agent Zero."}</p>
          </div>
          <form className="pairing-form" onSubmit={(event) => void pairBrowser(event)}>
            <label htmlFor="server-base-url">Agent Zero address</label>
            <input
              id="server-base-url"
              name="server-base-url"
              type="url"
              inputMode="url"
              autoComplete="url"
              maxLength={2048}
              value={serverBaseUrl}
              onInput={(event) => setServerBaseUrl(event.currentTarget.value)}
              placeholder="http://localhost:50080"
              required
            />
            <label htmlFor="pairing-code">Pairing code</label>
            <input
              id="pairing-code"
              name="pairing-code"
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellcheck={false}
              maxLength={256}
              value={pairingCode}
              onInput={(event) => setPairingCode(event.currentTarget.value)}
              placeholder="A0B1-…"
              aria-describedby="pairing-boundary"
              required
            />
            <button className="primary-button" type="submit" disabled={pairingBusy || !companionDetected}>
              {pairingBusy ? "Pairing…" : companionDetected ? "Pair browser" : "Companion required"}
            </button>
            <p id="pairing-boundary" className="form-boundary">The code is cleared after submission. Your companion keeps the saved credential outside the extension.</p>
            {pairingNotice ? <p className="form-notice" role="status">{pairingNotice}</p> : null}
          </form>
        </section>
      ) : (
        <section className="pairing-panel is-paired" aria-labelledby="paired-title">
          <div className="pairing-copy">
            <h2 id="paired-title">{limited ? "Ready for browser tasks" : "Pairing is saved"}</h2>
            <p>{BUILD_CHANNEL.development
              ? limited
                ? "Continue in Agent Zero for tasks and site approvals. Development mode supports owned tabs, page reading, navigation and scrolling. Chat in this extension, screenshots, clicking and typing are not available."
                : "No new pairing code is needed. In Agent Zero Browser settings → Development browser companion, choose Use this development browser for your chat. Then reconnect here."
              : connected
              ? "Continue in Agent Zero to choose browser tasks and approve site access."
              : "No new pairing code is needed. Select this browser for your chat in Agent Zero. Connection checks retry automatically; browser control stays off until they succeed."}</p>
          </div>
          <div className="paired-actions">
            {BUILD_CHANNEL.development && runtime.canReconnectDevelopmentBrowser ? (
              <button className="primary-button" type="button" disabled={reconnecting || disconnecting || checking} onClick={() => void reconnectAfterSelection()}>
                {reconnecting ? "Reconnecting…" : "Reconnect after selection"}
              </button>
            ) : null}
            <button className="quiet-button is-danger" type="button" disabled={disconnecting} onClick={() => void disconnectBrowser()}>
              {disconnecting ? "Disconnecting…" : "Disconnect profile"}
            </button>
            {pairingNotice ? <p className="form-notice" role="status">{pairingNotice}</p> : null}
          </div>
        </section>
      )}

      {!BUILD_CHANNEL.development && paired ? <details className="installation">
        <summary>Connection security</summary>
        <div className="installation-content">
          <p>Pairing is saved automatically. You do not need to update the key during normal use.</p>
          <button className="quiet-button" type="button" disabled={!connected || credentialBusy} onClick={() => void updateCredential("rotate")}>Update security key</button>{" "}
          <button className="quiet-button" type="button" disabled={!connected || credentialBusy} onClick={() => void updateCredential("status")}>Check pending update</button>
          <p>Remove access here to revoke this browser in Agent Zero and delete its saved local key. This requires pairing again.</p>
          <label><input type="checkbox" checked={revokeConfirmed} disabled={!connected || credentialBusy} onChange={(event) => setRevokeConfirmed(event.currentTarget.checked)} /> I want to remove this browser’s access</label>
          <p><button className="quiet-button is-danger" type="button" disabled={!connected || credentialBusy || !revokeConfirmed} onClick={() => void updateCredential("revoke")}>Remove browser access</button></p>
          {!connected ? <p className="card-note">Connect to Agent Zero before changing connection security.</p> : null}
          {credentialNotice ? <p className="form-notice" role="status">{credentialNotice}</p> : null}
        </div>
      </details> : null}

      <details id="companion-install" className="installation" open={!companionDetected}>
        <summary>Install or repair the native companion</summary>
        <div className="installation-content">
          <p>Install on the computer running Chrome.</p>
          <p>{BUILD_CHANNEL.development
            ? "Open your Agent Zero companion package. On macOS, open Install.command and follow the prompt. On Linux, run install.sh from that package. Updating keeps your saved pairing."
            : "On macOS, open Agent Zero Browser Setup from the official companion download and choose Install browser companion. You can close the installer when it finishes."}</p>
          {BUILD_CHANNEL.development ? <details>
            <summary>Using A0 CLI with a local source build</summary>
            <p>Use the absolute path to the companion from your package or source build.</p>
            <pre aria-label="Local source CLI install command"><code>a0 browser-extension development install --source-binary /absolute/path/to/a0-browser-bridge --browser chrome --yes</code></pre>
          </details> : <details>
            <summary>Install using A0 CLI instead</summary>
            <pre aria-label="CLI install command"><code>a0 browser-extension install</code></pre>
          </details>}
          <p className="card-note">{BUILD_CHANNEL.development
            ? "Use a local-development package for this Development extension. After installation, keep your existing pairing or pair this profile once."
            : <>Use <code>status</code> or <code>repair</code> in place of <code>install</code> when needed.</>}</p>
          <p>Agent Zero may run in Docker, but Chrome and its native companion run on your computer—not inside the container.</p>
          <p className="card-note">{BUILD_CHANNEL.development
            ? "Open Browser settings → Development browser companion. The server must enable source-build setup for its exact loopback URL."
            : "Open Agent Zero Browser settings to pair and choose this Chrome runtime."}</p>
        </div>
      </details>

      <section className="privacy-panel">
        <div>
          <h2>Credentials stay with the companion</h2>
        </div>
        <p>The host companion owns the paired credential. This extension keeps only opaque task handles, current browser leases, and a bounded redacted recovery ledger.</p>
      </section>

      <details className="diagnostics">
        <summary>Technical diagnostics</summary>
        <dl>
          <div><dt>Contract</dt><dd>{runtime.bridge.contract}</dd></div>
          <div><dt>Phase</dt><dd>{runtime.bridge.phase}</dd></div>
          <div><dt>Reason</dt><dd>{runtime.bridge.connection.reasonCode}</dd></div>
          <div><dt>Active leases</dt><dd>{runtime.bridge.activeLeaseCount}</dd></div>
          <div><dt>Capabilities</dt><dd>{runtime.bridge.capabilities.join(", ") || "None negotiated"}</dd></div>
          <div><dt>Activation gates</dt><dd>{runtime.bridge.connection.activationBlockers?.join(", ") || "None reported"}</dd></div>
        </dl>
      </details>
    </main>
  );
}

function HealthRow(props: {
  state: "ready" | "waiting" | "blocked" | "inactive";
  label: string;
  detail: string;
}) {
  return (
    <li className={`health-row is-${props.state}`}>
      <span className="health-icon" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="10" cy="10" r="7" />
          {props.state === "ready" ? <path d="m6.5 10 2.3 2.3 4.7-4.6" />
            : props.state === "blocked" ? <path d="M10 6.5v4M10 13h.01" /> : <path d="M7.5 10h5" />}
        </svg>
      </span>
      <div><strong>{props.label}</strong><span>{props.detail}</span></div>
    </li>
  );
}
