"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type SourceState = "configured" | "needs-configuration";

interface ConnectionStatus {
  storage: { protectedBy: string; location: string };
  owner: { email: string };
  sources: {
    slack: { state: SourceState; oauthClientReady: boolean; clientId: string; connectedEmail: string; connectedAt: string; accessTokenStored: boolean };
    gmail: { state: SourceState; oauthClientReady: boolean; clientId: string; connectedEmail: string; connectedAt: string; refreshTokenStored: boolean; query: string; intercomQuery: string };
    discord: { state: SourceState; url: string; apiKeyStored: boolean; oauthClientRegistered: boolean; connectedAt: string; ownerUserId: string; ownerQuery: string };
    obsidian: { state: SourceState; vaultPath: string; scopePath: string };
  };
  generator: { state: SourceState; apiKeyStored: boolean; model: string; authentication: string };
  restartRequired?: boolean;
}

type Values = Record<string, string>;

const EMPTY_VALUES: Values = {
  RADAR_OWNER_EMAIL: "",
  SLACK_CLIENT_ID: "",
  GMAIL_CLIENT_ID: "",
  GMAIL_QUERY: "in:anywhere -in:spam -in:trash",
  INTERCOM_GMAIL_QUERY: "from:intercom",
  DISCORD_MCP_URL: "https://discord-knowledge-mvp-production.up.railway.app/mcp",
  DISCORD_OWNER_USER_ID: "",
  DISCORD_OWNER_QUERY: "",
  OBSIDIAN_VAULT_PATH: "",
  OBSIDIAN_SCOPE_PATH: ".radar-data\\obsidian-scope.approved.json",
  OPENAI_MODEL: "gpt-5.6-sol",
};

function StateBadge({ state }: { state: SourceState }) {
  return <span className={`connection-state connection-state-${state}`}>{state === "configured" ? "Stored" : "Setup needed"}</span>;
}

async function localSetupFetch(pathname: "" | "/folder", init: RequestInit = {}) {
  const sameOrigin = await fetch(`/api/connections${pathname}`, { ...init, cache: "no-store" });
  if (sameOrigin.status !== 503) return sameOrigin;
  const directPath = pathname === "/folder" ? "/folders/obsidian" : "/connections";
  return fetch(`http://127.0.0.1:8790${directPath}`, { ...init, cache: "no-store" });
}

async function oauthStart(provider: "google" | "slack" | "discord") {
  return fetch(`http://127.0.0.1:8790/oauth/${provider}/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    cache: "no-store",
  });
}

export function ConnectionsPanel() {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [values, setValues] = useState<Values>(EMPTY_VALUES);
  const [secrets, setSecrets] = useState<Values>({});
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");

  const applyStatus = useCallback((next: ConnectionStatus) => {
    setStatus(next);
    setValues((current) => ({
      ...current,
      RADAR_OWNER_EMAIL: next.owner.email,
      SLACK_CLIENT_ID: next.sources.slack.clientId,
      GMAIL_CLIENT_ID: next.sources.gmail.clientId,
      GMAIL_QUERY: next.sources.gmail.query,
      INTERCOM_GMAIL_QUERY: next.sources.gmail.intercomQuery,
      DISCORD_MCP_URL: next.sources.discord.url,
      DISCORD_OWNER_USER_ID: next.sources.discord.ownerUserId,
      DISCORD_OWNER_QUERY: next.sources.discord.ownerQuery,
      OBSIDIAN_VAULT_PATH: next.sources.obsidian.vaultPath,
      OBSIDIAN_SCOPE_PATH: next.sources.obsidian.scopePath,
      OPENAI_MODEL: next.generator.model,
    }));
  }, []);

  const load = useCallback(async () => {
    try {
      const response = await localSetupFetch("");
      if (!response.ok) throw new Error("Start Radar with npm run radar:start to enable local setup.");
      applyStatus(await response.json() as ConnectionStatus);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Local setup is unavailable.");
    }
  }, [applyStatus]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function setValue(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
  }

  function setSecret(name: string, value: string) {
    setSecrets((current) => ({ ...current, [name]: value }));
  }

  async function save(section: string, valueNames: string[], secretNames: string[], event: FormEvent) {
    event.preventDefault();
    await persist(section, valueNames, secretNames, true);
  }

  async function persist(section: string, valueNames: string[], secretNames: string[], announce: boolean) {
    setBusy(section);
    setMessage("");
    const selectedSecrets = Object.fromEntries(secretNames.filter((name) => secrets[name]?.trim()).map((name) => [name, secrets[name]]));
    try {
      const response = await localSetupFetch("", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: Object.fromEntries(valueNames.map((name) => [name, values[name] ?? ""])),
          secrets: selectedSecrets,
        }),
      });
      const payload = await response.json() as ConnectionStatus & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save these settings.");
      applyStatus(payload);
      setSecrets((current) => ({ ...current, ...Object.fromEntries(secretNames.map((name) => [name, ""])) }));
      if (announce) setMessage(`${section} settings were encrypted and saved.`);
      return payload;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save these settings.");
    } finally {
      setBusy("");
    }
  }

  function providerConnected(provider: "google" | "slack" | "discord", current: ConnectionStatus) {
    if (provider === "google") return current.sources.gmail.refreshTokenStored;
    if (provider === "slack") return current.sources.slack.accessTokenStored;
    return current.sources.discord.apiKeyStored;
  }

  function connectionMarker(provider: "google" | "slack" | "discord", current?: ConnectionStatus | null) {
    if (!current) return "";
    if (provider === "google") return current.sources.gmail.connectedAt;
    if (provider === "slack") return current.sources.slack.connectedAt;
    return current.sources.discord.connectedAt;
  }

  async function authorize(
    provider: "google" | "slack" | "discord",
    label: string,
    valueNames: string[],
    secretNames: string[] = [],
  ) {
    const popup = window.open("", `radar-${provider}-oauth`, "popup,width=560,height=720");
    if (!popup) {
      setMessage(`Allow popups for Radar, then click Authorize ${label} again.`);
      return;
    }
    const previousMarker = connectionMarker(provider, status);
    popup.document.write("<!doctype html><title>Preparing authorization</title><body style='font:16px system-ui;padding:40px'>Preparing secure authorization…</body>");
    setBusy(`Authorize ${label}`);
    setMessage(`Preparing ${label} authorization…`);
    try {
      const saved = await persist(label, valueNames, secretNames, false);
      if (!saved) throw new Error(`Save the required ${label} setup first.`);
      setBusy(`Authorize ${label}`);
      const response = await oauthStart(provider);
      const payload = await response.json() as { authorizationUrl?: string; error?: string };
      if (!response.ok || !payload.authorizationUrl) throw new Error(payload.error ?? `${label} authorization could not start.`);
      popup.location.href = payload.authorizationUrl;
      setMessage(`Complete the ${label} approval in the popup. Radar will finish automatically.`);
      const deadline = Date.now() + 10 * 60_000;
      while (!popup.closed && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const statusResponse = await localSetupFetch("");
        if (!statusResponse.ok) continue;
        const current = await statusResponse.json() as ConnectionStatus;
        applyStatus(current);
        if (providerConnected(provider, current) && connectionMarker(provider, current) !== previousMarker) {
          setMessage(`${label} is authorized. No messages were read.`);
          break;
        }
      }
      if (!popup.closed) popup.close();
    } catch (error) {
      popup.close();
      setMessage(error instanceof Error ? error.message : `${label} authorization failed.`);
    } finally {
      setBusy("");
    }
  }

  async function importGoogleClient(file?: File) {
    if (!file) return;
    try {
      const document = JSON.parse(await file.text()) as { installed?: { client_id?: string; client_secret?: string } };
      const client = document.installed;
      if (!client?.client_id) throw new Error("Choose a Google Desktop OAuth client JSON file.");
      setValue("GMAIL_CLIENT_ID", client.client_id);
      if (client.client_secret) setSecret("GMAIL_CLIENT_SECRET", client.client_secret);
      setMessage("Google OAuth client loaded. Click Authorize Gmail to continue.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The Google OAuth client file could not be read.");
    }
  }

  async function chooseVault() {
    setBusy("Obsidian picker");
    setMessage("Choose your Obsidian vault in the Windows dialog.");
    try {
      const response = await localSetupFetch("/folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const payload = await response.json() as { selected?: string | null; error?: string };
      if (!response.ok) throw new Error(payload.error ?? "The folder picker failed.");
      if (payload.selected) setValue("OBSIDIAN_VAULT_PATH", payload.selected);
      setMessage(payload.selected ? "Vault selected. Save the Obsidian card to keep it." : "No folder was selected.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The folder picker failed.");
    } finally {
      setBusy("");
    }
  }

  const field = (name: string, label: string, options: { secret?: boolean; placeholder?: string } = {}) => (
    <label className="connection-field">
      <span>{label}</span>
      <input
        type={options.secret ? "password" : "text"}
        autoComplete="off"
        value={options.secret ? secrets[name] ?? "" : values[name] ?? ""}
        onChange={(event) => options.secret ? setSecret(name, event.target.value) : setValue(name, event.target.value)}
        placeholder={options.placeholder}
      />
    </label>
  );

  return (
    <section className="connections-panel" aria-label="Connections">
      <div className="connections-head">
        <div><p className="eyebrow">LOCAL CONNECTIONS</p><h2>Connect your sources</h2></div>
        <p>Credentials are encrypted for your Windows account and stored outside this repository and OneDrive. Radar never returns their values to the browser.</p>
      </div>

      {message && <p className="connection-message" role="status">{message}</p>}

      <div className="connection-grid">
        <form className="connection-card" onSubmit={(event) => void save("Identity", ["RADAR_OWNER_EMAIL"], [], event)}>
          <div className="connection-title"><div><b>01</b><h3>Your identity</h3></div><StateBadge state={status?.owner.email ? "configured" : "needs-configuration"} /></div>
          <p>Collectors verify this exact email before reading any Slack or Gmail content.</p>
          {field("RADAR_OWNER_EMAIL", "Owner email", { placeholder: "alu@meticuloushome.com" })}
          <button disabled={Boolean(busy)}>{busy === "Identity" ? "Saving..." : "Save identity"}</button>
        </form>

        <form className="connection-card" onSubmit={(event) => { event.preventDefault(); void authorize("slack", "Slack", ["SLACK_CLIENT_ID"]); }}>
          <div className="connection-title"><div><b>S</b><h3>Slack</h3></div><StateBadge state={status?.sources.slack.state ?? "needs-configuration"} /></div>
          <p>{status?.sources.slack.connectedEmail ? `Connected as ${status.sources.slack.connectedEmail}.` : "Authorize read-only access in Slack. Radar verifies the approved account before saving the connection."}</p>
          <details open={!status?.sources.slack.oauthClientReady}><summary>One-time Slack app setup</summary>
            <p className="connection-help">Create an internal Slack app, enable PKCE, add <code>http://localhost:8790/oauth/slack/callback</code>, then paste only its public client ID.</p>
            {field("SLACK_CLIENT_ID", "Slack app client ID", { placeholder: "123456789.123456789" })}
          </details>
          <button className="oauth-button" disabled={Boolean(busy) || !values.SLACK_CLIENT_ID}>
            {busy === "Authorize Slack" ? "Waiting for Slack…" : status?.sources.slack.accessTokenStored ? "Reauthorize Slack" : "Authorize Slack"}
          </button>
        </form>

        <form className="connection-card" onSubmit={(event) => { event.preventDefault(); void authorize("google", "Gmail", ["GMAIL_CLIENT_ID", "GMAIL_QUERY", "INTERCOM_GMAIL_QUERY"], ["GMAIL_CLIENT_SECRET"]); }}>
          <div className="connection-title"><div><b>@</b><h3>Gmail + Intercom</h3></div><StateBadge state={status?.sources.gmail.state ?? "needs-configuration"} /></div>
          <p>{status?.sources.gmail.connectedEmail ? `Connected as ${status.sources.gmail.connectedEmail}.` : "Authorize Gmail read-only access. Intercom notifications remain a mailbox filter, not a second account."}</p>
          <details open={!status?.sources.gmail.oauthClientReady}><summary>One-time Google app setup</summary>
            <p className="connection-help">Download a Desktop OAuth client JSON from Google Cloud, then import it here. Tokens are never copied manually.</p>
            <label className="client-file">Import Google client JSON<input type="file" accept="application/json,.json" onChange={(event) => void importGoogleClient(event.target.files?.[0])} /></label>
            {field("GMAIL_CLIENT_ID", "Google client ID")}
            {field("GMAIL_CLIENT_SECRET", "Google client secret (optional)", { secret: true, placeholder: "Loaded from the JSON file" })}
          </details>
          <details><summary>Mailbox filters</summary><div className="connection-row">{field("GMAIL_QUERY", "Mailbox query")}{field("INTERCOM_GMAIL_QUERY", "Intercom query")}</div></details>
          <button className="oauth-button" disabled={Boolean(busy) || !values.GMAIL_CLIENT_ID}>
            {busy === "Authorize Gmail" ? "Waiting for Google…" : status?.sources.gmail.refreshTokenStored ? "Reauthorize Gmail" : "Authorize Gmail"}
          </button>
        </form>

        <form className="connection-card" onSubmit={(event) => { event.preventDefault(); void authorize("discord", "Discord", ["DISCORD_MCP_URL", "DISCORD_OWNER_USER_ID", "DISCORD_OWNER_QUERY"]); }}>
          <div className="connection-title"><div><b>D</b><h3>Discord MCP</h3></div><StateBadge state={status?.sources.discord.state ?? "needs-configuration"} /></div>
          <p>{status?.sources.discord.apiKeyStored ? "OAuth access is connected. Owner details are still checked before archive retrieval." : "The supplied server supports automatic OAuth registration—no app key or token is required."}</p>
          <details><summary>Owner verification</summary>
            {field("DISCORD_MCP_URL", "MCP endpoint")}
            <div className="connection-row">{field("DISCORD_OWNER_USER_ID", "Your Discord user ID")}{field("DISCORD_OWNER_QUERY", "Owner verification query")}</div>
          </details>
          <button className="oauth-button" disabled={Boolean(busy)}>
            {busy === "Authorize Discord" ? "Waiting for Discord…" : status?.sources.discord.apiKeyStored ? "Reauthorize Discord" : "Authorize Discord"}
          </button>
        </form>

        <form className="connection-card" onSubmit={(event) => void save("Obsidian", ["OBSIDIAN_VAULT_PATH", "OBSIDIAN_SCOPE_PATH"], [], event)}>
          <div className="connection-title"><div><b>O</b><h3>Obsidian</h3></div><StateBadge state={status?.sources.obsidian.state ?? "needs-configuration"} /></div>
          <p>Select the local vault. Radar remains read-only and will still require approval of the exact folders it may index.</p>
          <div className="folder-field">{field("OBSIDIAN_VAULT_PATH", "Vault folder")}<button type="button" onClick={() => void chooseVault()} disabled={Boolean(busy)}>Choose folder</button></div>
          {field("OBSIDIAN_SCOPE_PATH", "Approved scope file")}
          <button disabled={Boolean(busy)}>{busy === "Obsidian" ? "Saving..." : "Save Obsidian setup"}</button>
        </form>

        <form className="connection-card" onSubmit={(event) => void save("Generator", ["OPENAI_MODEL"], ["OPENAI_API_KEY"], event)}>
          <div className="connection-title"><div><b>AI</b><h3>Draft generator</h3></div><StateBadge state={status?.generator.state ?? "needs-configuration"} /></div>
          <p>ChatGPT subscriptions authenticate Codex and ChatGPT, not ordinary API requests. Radar uses a separate API key so the generator stays text-only and tool-free.</p>
          {field("OPENAI_API_KEY", status?.generator.apiKeyStored ? "OpenAI API key (stored)" : "OpenAI API key", { secret: true, placeholder: "sk-..." })}
          {field("OPENAI_MODEL", "Model")}
          <button disabled={Boolean(busy)}>{busy === "Generator" ? "Saving..." : "Save generator setup"}</button>
        </form>
      </div>

      <p className="connections-footnote">Authorization does not read any messages. Source collection remains blocked until identity checks pass, and a first sync requires your explicit approval.</p>
    </section>
  );
}
