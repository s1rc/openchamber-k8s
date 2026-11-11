// OpenCode plugin: no imports at the top level (the host loads it with a bare import()).
// Phase 0 keeps a spike tool next to k8s_contexts to learn what OpenCode hands to execute().

type Json = Record<string, unknown>;

const describe = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  if (typeof value !== 'object') return value;
  if (depth >= 2) return `[${Array.isArray(value) ? 'array' : 'object'}]`;
  const out: Json = {};
  for (const key of Object.keys(value as Json).slice(0, 30)) out[key] = /token|secret|password|key/i.test(key) ? '[hidden]' : describe((value as Json)[key], depth + 1);
  return out;
};

const spawnKubectl = async (args: string[]): Promise<Json> => {
  const result: Json = { bun: typeof (globalThis as { Bun?: unknown }).Bun };
  try {
    const cp = await import('node:child_process');
    const path = `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`;
    const out = cp.spawnSync('kubectl', args, { encoding: 'utf8', timeout: 15000, env: { ...process.env, PATH: path } });
    result.nodeChildProcess = { ok: out.status === 0, status: out.status, stdout: String(out.stdout ?? '').trim().slice(0, 200), error: out.error ? String(out.error.message) : null };
  } catch (error) {
    result.nodeChildProcess = { ok: false, error: (error as Error).message };
  }
  return result;
};

const plugin = {
  id: 'k8s-tools',
  setup: async (ctx: { tool: { transform: (fn: (tools: { add: (tool: Json) => void }) => void) => Promise<void> } } & Json) => {
    const setupKeys = Object.keys(ctx);
    const setupInfo = { location: describe(ctx.location), worktree: describe(ctx.worktree), app: describe(ctx.app), sessionApi: describe(ctx.session), worktreeApi: describe(ctx.worktree) };
    await ctx.tool.transform((tools) => {
      tools.add({
        name: 'k8s_contexts',
        description: 'Lists the Kubernetes contexts on this machine.',
        options: { codemode: false },
        input: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          const spawned = await spawnKubectl(['config', 'get-contexts', '-o', 'name']);
          return { content: JSON.stringify(spawned) };
        },
      });
      tools.add({
        name: 'k8s_spike_plugin',
        description: 'Phase 0 spike: reports what the plugin runtime offers. Takes no input.',
        options: { codemode: false },
        input: { type: 'object', properties: {}, additionalProperties: false },
        async execute(...args: unknown[]) {
          const spawned = await spawnKubectl(['config', 'current-context']);
          const report = {
            setupKeys,
            setupInfo,
            argCount: args.length,
            args: args.map((arg) => describe(arg)),
            cwd: process.cwd(),
            ...spawned,
          };
          return { content: JSON.stringify(report) };
        },
      });
    });
  },
};

export default plugin;
