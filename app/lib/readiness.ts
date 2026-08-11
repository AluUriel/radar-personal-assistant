export type ReadinessState = "configured" | "needs-configuration";

export interface IntegrationReadiness {
  id: "core" | "slack" | "gmail" | "intercom" | "discord" | "obsidian" | "generator";
  label: string;
  state: ReadinessState;
  missing: string[];
  issues: string[];
  detail: string;
}

type Environment = Record<string, string | undefined>;

const placeholderPatterns = [
  /^owner@meticuloushome\.com$/i,
  /^c:\\path\\to\\your\\vault$/i,
  /your-discord-knowledge-service/i,
];

function configuredValue(environment: Environment, name: string) {
  const value = environment[name]?.trim();
  return Boolean(value && !placeholderPatterns.some((pattern) => pattern.test(value)));
}

function evaluate(
  environment: Environment,
  id: IntegrationReadiness["id"],
  label: string,
  required: string[],
  detail: string,
  issues: string[] = [],
): IntegrationReadiness {
  const missing = required.filter((name) => !configuredValue(environment, name));
  return {
    id,
    label,
    state: missing.length || issues.length ? "needs-configuration" : "configured",
    missing,
    issues,
    detail,
  };
}

function urlIssue(environment: Environment, name: string) {
  const raw = environment[name]?.trim();
  if (!raw || !configuredValue(environment, name)) return [];
  try {
    const url = new URL(raw);
    const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
      return [`${name} must use HTTPS or loopback HTTP.`];
    }
    return [];
  } catch {
    return [`${name} is not a valid URL.`];
  }
}

export function buildIntegrationReadiness(environment: Environment): IntegrationReadiness[] {
  const coreRequired = ["RADAR_OWNER_EMAIL", "RADAR_INGEST_SECRET", "RADAR_URL"];
  const generatorIssues = [
    ...urlIssue(environment, "TEXT_GENERATOR_URL"),
    ...(configuredValue(environment, "TEXT_GENERATOR_API_KEY") && configuredValue(environment, "SIDECAR_SHARED_SECRET") &&
    environment.TEXT_GENERATOR_API_KEY?.trim() !== environment.SIDECAR_SHARED_SECRET?.trim()
      ? ["TEXT_GENERATOR_API_KEY and SIDECAR_SHARED_SECRET must match."]
      : []),
  ];

  return [
    evaluate(environment, "core", "Radar core", coreRequired, "Private owner access and authenticated ingestion.", urlIssue(environment, "RADAR_URL")),
    evaluate(environment, "slack", "Slack", [...coreRequired, "SLACK_ACCESS_TOKEN"], "Read-only workspace collection; identity is verified before messages are read."),
    evaluate(environment, "gmail", "Gmail", [...coreRequired, "GMAIL_CLIENT_ID", "GMAIL_REFRESH_TOKEN"], "Read-only mailbox collection; identity is verified before threads are read."),
    evaluate(environment, "intercom", "Intercom email", [...coreRequired, "GMAIL_CLIENT_ID", "GMAIL_REFRESH_TOKEN", "INTERCOM_GMAIL_QUERY"], "Intercom notifications are selected inside the verified Gmail mailbox."),
    evaluate(environment, "discord", "Discord", [...coreRequired, "DISCORD_MCP_URL", "DISCORD_MCP_API_KEY", "DISCORD_OWNER_USER_ID", "DISCORD_OWNER_QUERY"], "Read-only archive collection with an exact owner identity check.", urlIssue(environment, "DISCORD_MCP_URL")),
    evaluate(environment, "obsidian", "Obsidian", [...coreRequired, "OBSIDIAN_VAULT_PATH", "OBSIDIAN_SCOPE_PATH"], "Read-only knowledge indexing outside the vault with an explicitly approved path manifest."),
    evaluate(environment, "generator", "Isolated generator", ["TEXT_GENERATOR_URL", "TEXT_GENERATOR_API_KEY", "SIDECAR_SHARED_SECRET", "OPENAI_API_KEY", "OPENAI_MODEL"], "Local text-only process with no tools, writes, or source credentials.", generatorIssues),
  ];
}
