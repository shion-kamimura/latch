// Settings and permissions in official Codex 0.163.0. No custom executor or auth.
export const SUPPORTED_CLI_VERSION = '0.163.0';
export const CODEX_POLICY = {
  default_permissions: 'latch',
  'permissions.latch.filesystem': { ':root': 'deny' },
  'permissions.latch.network.enabled': false,
  approval_policy: 'never',
  model_provider: 'openai',
  project_doc_max_bytes: 0,
  web_search: 'disabled',
  check_for_update_on_startup: false,
  'tools.update_plan.enabled': false,
  'tools.experimental_request_user_input.enabled': false,
  'features.shell_tool': false,
  'features.view_image': false,
  'features.js_repl': false,
  'features.code_mode': false,
  'features.code_mode_only': false,
  'features.apps': false,
  'features.plugins': false,
  'features.remote_plugin': false,
  'features.remote_control': false,
  'features.standalone_web_search': false,
  'features.image_generation': false,
  'features.plugin_hooks': false,
  'features.codex_hooks': false,
  'features.browser_use': false,
  'features.computer_use': false,
  'features.collab': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.memories': false,
  'features.memory_tool': false,
  'features.recommended_plugins': false,
  'features.tool_suggest': false,
  'features.skill_search': false,
  'features.skill_mcp_dependency_install': false,
  'features.skip_host_skill_discovery': true,
} as const;

function toml(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  return `{${Object.entries(value)
    .map(([key, entry]) => `${JSON.stringify(key)}=${toml(entry)}`)
    .join(',')}}`;
}
export function codexPolicyArguments(): string[] {
  return Object.entries(CODEX_POLICY).flatMap(([key, value]) => [
    '-c',
    `${key}=${toml(value)}`,
  ]);
}

const text = { type: 'string' };
const strings = { type: 'array', items: text };
const nullableText = { type: ['string', 'null'] };
function object(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}
const source = {
  anyOf: [
    object({
      kind: { type: 'string', enum: ['issue'] },
      line: { type: 'integer' },
    }),
    object({ kind: { type: 'string', enum: ['diff'] }, path: text }),
  ],
};
export function codexOutputSchema(
  output: 'requirements' | 'tests' = 'requirements',
): Record<string, unknown> {
  if (output === 'tests')
    return object({
      tests: {
        type: 'array',
        items: object({
          conditionId: text,
          name: text,
          rationale: text,
          code: text,
        }),
      },
    });
  const condition = object({
    text,
    source,
    ambiguity: nullableText,
    existingTestCandidateIds: strings,
    missingScenarios: {
      type: 'array',
      items: object({ description: text, rationale: text }),
    },
  });
  const requirement = object({
    text,
    origin: { type: 'string', enum: ['issue-explicit', 'diff-inferred'] },
    source,
    ambiguity: nullableText,
    conditions: { type: 'array', items: condition },
  });
  return object({
    requirements: { type: 'array', items: requirement },
    unverified: strings,
    notes: strings,
  });
}
