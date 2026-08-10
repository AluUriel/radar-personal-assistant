import path from "node:path";

const SIDECAR_ENVIRONMENT_NAMES = [
  "SIDECAR_SHARED_SECRET",
  "SIDECAR_PORT",
  "SIDECAR_HOST",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
];

const WINDOWS_RUNTIME_NAMES = ["SYSTEMROOT", "WINDIR", "TEMP", "TMP"];

export function restrictedSidecarEnvironment(environment) {
  const result = { NODE_ENV: "production" };
  for (const name of [...SIDECAR_ENVIRONMENT_NAMES, ...WINDOWS_RUNTIME_NAMES]) {
    if (environment[name] !== undefined) result[name] = environment[name];
  }
  return result;
}

export function restrictedSidecarArguments(scriptPath) {
  const absoluteScript = path.resolve(scriptPath);
  return [
    "--permission",
    `--allow-fs-read=${absoluteScript}`,
    absoluteScript,
  ];
}

