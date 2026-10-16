/**
 * A minimal *real* implementation of the DSH `subprocess` service contract.
 *
 * The plugin reaches the outside world only through that service, and a standalone
 * Node process cannot borrow the harness's instance — so the integration test supplies
 * its own, with just the surface `runCommand` uses (`stdio` collect, `signal`,
 * `graceMs`, and a handle exposing `collected`, `done`, `terminate`, `waitForExit`).
 *
 * Every command's combined stdout/stderr is recorded, which is what lets the
 * integration test cross-check the plugin's diagnostic counts against the raw log.
 */
import { spawn } from 'node:child_process';

export function makeRealSubprocess() {
  const commands = [];
  const outputs = [];
  const children = new Set();

  const spawnSpec = (spec) => {
    const commandLine = spec.argv.join(' ');
    commands.push(commandLine);
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(spec.env ?? {}) },
    });
    children.add(child);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    let killed = false;
    const kill = () => {
      if (killed || child.exitCode !== null || child.signalCode !== null) return;
      killed = true;
      child.kill('SIGTERM');
      const escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, spec.graceMs ?? 3000);
      escalation.unref?.();
    };
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) kill();
      else spec.signal.addEventListener('abort', kill, { once: true });
    }

    const done = new Promise((resolve) => {
      child.on('close', (exitCode, signal) => {
        children.delete(child);
        outputs.push(`${stdout}${stderr.length > 0 ? `[stderr]\n${stderr}` : ''}`);
        resolve({ exitCode, signal: signal ?? null });
      });
      child.on('error', () => {
        outputs.push('');
        resolve({ exitCode: null, signal: null });
      });
    });

    // Read at call time: the plugin reads after `done` resolved, and a snapshot taken
    // when the handle was built would still be empty (that mistake made discovery look
    // like it had found nothing).
    const collected = {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
    };
    return {
      collected,
      done,
      terminate: kill,
      waitForExit: () => done.then(() => true, () => false),
    };
  };

  return {
    spawn: spawnSpec,
    /** Every command line the plugin asked for, in order. */
    commands,
    /** Combined stdout+stderr of each finished command, in completion order. */
    outputs,
    /** Everything the plugin has been shown, as one log. */
    log: () => outputs.join('\n'),
    killAll: () => {
      for (const child of children) child.kill('SIGKILL');
    },
  };
}
