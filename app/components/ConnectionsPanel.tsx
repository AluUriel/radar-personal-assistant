"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type SourceState = "configured" | "needs-configuration";

interface ConnectionStatus {
  storage: { protectedBy: string; location: string };
  owner: { email: string };
  sources: {
    slack: { state: SourceState; oauthClientReady: boolean; clientId: string; accessTokenStored: boolean };
    gmail: { state: SourceState; oauthClientReady: boolean; clientId: string; refreshTokenStored: boolean; query: string; intercomQuery: string };
    discord: { state: SourceState; url: string; apiKeyStored: boolean; ownerUserId: string; ownerQuery: string };
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
      setMessage(`${section} settings were encrypted and saved. Restart Radar once after finishing all connections.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save these settings.");
    } finally {
      setBusy("");
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

        <form className="connection-card" onSubmit={(event) => void save("Slack", ["SLACK_CLIENT_ID"], ["SLACK_CLIENT_SECRET", "SLACK_ACCESS_TOKEN"], event)}>
          <div className="connection-title"><div><b>S</b><h3>Slack</h3></div><StateBadge state={status?.sources.slack.state ?? "needs-configuration"} /></div>
          <p>OAuth is the intended flow. Slack first requires one registered app and an HTTPS callback. Radar stores the resulting user token, never your password.</p>
          {field("SLACK_CLIENT_ID", "OAuth client ID", { placeholder: "From the registered Slack app" })}
          {field("SLACK_CLIENT_SECRET", status?.sources.slack.oauthClientReady ? "OAuth client secret (stored)" : "OAuth client secret", { secret: true, placeholder: "Leave blank to keep the stored value" })}
          <details><summary>Advanced temporary token fallback</summary>{field("SLACK_ACCESS_TOKEN", status?.sources.slack.accessTokenStored ? "User token (stored)" : "Read-only user token", { secret: true, placeholder: "xoxp-..." })}</details>
          <button disabled={Boolean(busy)}>{busy === "Slack" ? "Saving..." : "Save Slack setup"}</button>
        </form>

        <form className="connection-card" onSubmit={(event) => void save("Gmail", ["GMAIL_CLIENT_ID", "GMAIL_QUERY", "INTERCOM_GMAIL_QUERY"], ["GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"], event)}>
          <div className="connection-title"><div><b>@</b><h3>Gmail + Intercom</h3></div><StateBadge state={status?.sources.gmail.state ?? "needs-configuration"} /></div>
          <p>A Google OAuth client is registered once. Radar then keeps the refresh token locally and reads Gmail with the read-only scope.</p>
          {field("GMAIL_CLIENT_ID", "OAuth client ID")}
          {field("GMAIL_CLIENT_SECRET", status?.sources.gmail.oauthClientReady ? "OAuth client secret (stored)" : "OAuth client secret", { secret: true, placeholder: "Leave blank to keep the stored value" })}
          <details><summary>Advanced token import</summary>{field("GMAIL_REFRESH_TOKEN", status?.sources.gmail.refreshTokenStored ? "Refresh token (stored)" : "Refresh token", { secret: true })}</details>
          <div className="connection-row">{field("GMAIL_QUERY", "Mailbox query")}{field("INTERCOM_GMAIL_QUERY", "Intercom query")}</div>
          <button disabled={Boolean(busy)}>{busy === "Gmail" ? "Saving..." : "Save Gmail setup"}</button>
        </form>

        <form className="connection-card" onSubmit={(event) => void save("Discord", ["DISCORD_MCP_URL", "DISCORD_OWNER_USER_ID", "DISCORD_OWNER_QUERY"], ["DISCORD_MCP_API_KEY"], event)}>
          <div className="connection-title"><div><b>D</b><h3>Discord MCP</h3></div><StateBadge state={status?.sources.discord.state ?? "needs-configuration"} /></div>
          <p>The supplied read-only knowledge server is prefilled. Owner identity is verified before archive retrieval.</p>
          {field("DISCORD_MCP_URL", "MCP endpoint")}
          {field("DISCORD_MCP_API_KEY", status?.sources.discord.apiKeyStored ? "API key (stored)" : "API key", { secret: true, placeholder: "Leave blank if the server does not require one" })}
          <div className="connection-row">{field("DISCORD_OWNER_USER_ID", "Your Discord user ID")}{field("DISCORD_OWNER_QUERY", "Owner verification query")}</div>
          <button disabled={Boolean(busy)}>{busy === "Discord" ? "Saving..." : "Save Discord setup"}</button>
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

      <p className="connections-footnote">Saving configuration does not read any messages. Source collection remains blocked until identity checks pass, and a final sync requires your explicit approval.</p>
    </section>
  );
}
