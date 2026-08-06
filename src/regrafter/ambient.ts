import { createRequire } from "node:module";

import type { PiAppDefinition, PiExtensionDefinition, PiProfile } from "@osolmaz/pi-factory";

import { parseModel, type RegrafterConfig } from "./config.js";

export type AppProfile = {
  readonly app: PiAppDefinition;
  readonly profile: PiProfile;
};

const RESOURCE_FLAGS: readonly string[] = [
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes"
];

export function resolveAppProfile(
  app: PiAppDefinition,
  config: RegrafterConfig | undefined
): AppProfile {
  if (config === undefined) return { app, profile: "isolated" };
  if (config.model === undefined) {
    throw new Error(
      "regrafter config has no model; run: regrafter config set model <provider/model>"
    );
  }
  const { provider, model } = parseModel(config.model);
  return {
    app: {
      ...app,
      providers: [{ id: provider, source: "pi", models: [{ id: model, reasoning: true }] }],
      defaultProvider: provider,
      defaultModel: model,
      thinking: config.thinking ?? app.thinking,
      extensions: [...(app.extensions ?? []), ...providerExtensions(provider)],
      forwardedArgs: [...RESOURCE_FLAGS, ...(app.forwardedArgs ?? [])]
    },
    profile: "ambient"
  };
}

function providerExtensions(provider: string): readonly PiExtensionDefinition[] {
  if (provider === "huggingface") {
    return [{ path: createRequire(import.meta.url).resolve("pi-huggingface-oauth/index.ts") }];
  }
  return [];
}
