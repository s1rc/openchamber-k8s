import { describe, expect, test } from 'bun:test';
import { SHELL_COPIED, nodeShellCommand, shellCommand, shellQuote } from '../src/shared/shell.ts';

describe('shellQuote', () => {
  test('leaves safe words alone', () => {
    for (const word of ['api-1', 'default', 'team_a', 'a.b', '/var/log', 'a:b', 'a=b', '1.0']) expect(shellQuote(word)).toBe(word);
  });

  test('quotes spaces, dollars and quotes', () => {
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('$HOME')).toBe("'$HOME'");
    expect(shellQuote('a;rm -rf /')).toBe("'a;rm -rf /'");
    expect(shellQuote('it\'s')).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
  });
});

describe('shellCommand', () => {
  test('names the context, namespace, pod and container', () => {
    const text = shellCommand('initech-staging-us-east-1', 'contracts', 'api-1', 'api');
    expect(text).toContain('kubectl --context initech-staging-us-east-1');
    expect(text).toContain('-n contracts');
    expect(text).toContain('exec -it api-1 -c api');
    expect(text).toContain("'command -v bash >/dev/null && exec bash || exec sh'");
  });

  test('escapes every value it adds', () => {
    const text = shellCommand('ctx with space', 'ns', 'pod name', 'con tainer');
    expect(text).toContain("'ctx with space'");
    expect(text).toContain("'pod name'");
    expect(text).toContain("'con tainer'");
  });

  test('leaves the container out when none is named', () => {
    expect(shellCommand('ctx', 'ns', 'pod')).not.toContain('exec -it pod -c');
    expect(shellCommand('ctx', 'ns', 'pod')).toContain('exec -it pod --');
  });

  test('the node command quotes the node', () => {
    expect(nodeShellCommand('ctx', 'ip-10-0-0-1.us-east-1.compute.internal')).toContain('debug node/ip-10-0-0-1.us-east-1.compute.internal -it --image=busybox');
    expect(nodeShellCommand('ctx', 'bad node')).toContain("node/'bad node'");
  });

  test('the copy message names the terminal', () => {
    expect(SHELL_COPIED).toContain('OpenChamber');
    expect(SHELL_COPIED).not.toContain('\u2014');
  });
});
