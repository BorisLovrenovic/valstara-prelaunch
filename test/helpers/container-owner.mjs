import { execFile } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Every per-process container a test or script starts carries its owner in
// these labels (E11.6-11a, founder decision D-035 Q1, 2026-11-20). A run that
// is killed skips its after() cleanup and leaves its container, and that
// container's `docker run` client, running. The next start of any labelled
// container removes the ones whose owner is gone. The owner is matched by
// label, never by container name: names vary by suite, and a name pattern
// missed the 2026-11-07 valstara-member-design orphan.
export const containerOwnerLabels = Object.freeze({
  host: 'com.valstara.test-owner.host',
  bootId: 'com.valstara.test-owner.boot-id',
  pidNamespace: 'com.valstara.test-owner.pid-namespace',
  pid: 'com.valstara.test-owner.pid',
});

const unknown = 'unknown';
const containerAlreadyGone = /No such container|already in progress/u;

function readOr(read) {
  try {
    return read().trim() || unknown;
  } catch {
    // Not Linux, or /proc is unavailable.
    return unknown;
  }
}

/**
 * This process as a container owner. The boot ID tells a process ID from a
 * previous boot apart from a live one. The PID namespace keeps a process ID
 * from being read in the wrong one: WSL distributions share a host name, a
 * boot ID and one Docker daemon, but not process IDs.
 */
export function currentContainerOwner() {
  return {
    host: hostname(),
    bootId: readOr(() =>
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'),
    ),
    pidNamespace: readOr(() => readlinkSync('/proc/self/ns/pid')),
    pid: String(process.pid),
  };
}

/** The `docker run` arguments that label a container with its owner. */
export function containerOwnerArguments(owner = currentContainerOwner()) {
  return Object.entries(containerOwnerLabels).flatMap(([field, label]) => [
    '--label',
    `${label}=${owner[field]}`,
  ]);
}

/** Whether a process with this ID is running in this PID namespace. */
export function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, under another user.
    return error.code === 'EPERM';
  }
}

/**
 * Whether a labelled container's owner is gone, judged from this process.
 * Another host's container is never judged. A different boot ID means the
 * owner died with the boot it ran in. Otherwise the owner is gone only when
 * its process, read in its own PID namespace, no longer runs. A container
 * whose owner cannot be judged (another PID namespace, a malformed process
 * ID) is kept.
 */
export function containerOwnerIsGone(
  labels,
  { owner = currentContainerOwner(), isRunning = processIsRunning } = {},
) {
  if (labels.host !== owner.host) return false;
  if (labels.bootId !== owner.bootId) return true;
  if (labels.pidNamespace !== owner.pidNamespace) return false;
  if (!/^[1-9]\d*$/u.test(labels.pid)) return false;
  return !isRunning(Number(labels.pid));
}

async function runDocker(args) {
  const { stdout } = await execFileAsync('docker', args, {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Force-removes every container carrying the owner labels whose owner is
 * gone, and resolves to their IDs. An unlabelled container, another host's
 * container and a live owner's container are never removed. A container
 * another process removes first is not an error; any other removal failure
 * is thrown.
 */
export async function removeOrphanedContainers({
  docker = runDocker,
  owner = currentContainerOwner(),
  isRunning = processIsRunning,
} = {}) {
  const fields = Object.keys(containerOwnerLabels);
  const format = [
    '{{.ID}}',
    ...fields.map((field) => `{{.Label "${containerOwnerLabels[field]}"}}`),
  ].join('\t');
  const listing = await docker([
    'ps',
    '--all',
    '--no-trunc',
    '--filter',
    `label=${containerOwnerLabels.pid}`,
    '--format',
    format,
  ]);
  const orphans = listing
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [id, ...values] = line.split('\t');
      return {
        id,
        labels: Object.fromEntries(
          fields.map((field, index) => [field, values[index] ?? '']),
        ),
      };
    })
    .filter(({ labels }) => containerOwnerIsGone(labels, { owner, isRunning }))
    .map(({ id }) => id);
  for (const id of orphans) {
    try {
      await docker(['rm', '--force', id]);
    } catch (error) {
      if (!containerAlreadyGone.test(String(error.stderr ?? error.message))) {
        throw new Error(
          `Could not remove container ${id}, whose owner is gone: ${error.message}`,
          { cause: error },
        );
      }
    }
  }
  return orphans;
}
