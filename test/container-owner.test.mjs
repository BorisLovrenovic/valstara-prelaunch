import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import test, { after } from 'node:test';
import { promisify } from 'node:util';

import {
  containerOwnerArguments,
  containerOwnerIsGone,
  currentContainerOwner,
  removeOrphanedContainers,
} from './helpers/container-owner.mjs';

// E11.6-11a (founder decision D-035 Q1, 2026-11-20): containers a killed run
// leaves behind are removed by owner label. This is leak hygiene, not the fix
// for "refused 300 connection attempts", whose cause is not proven
// (docs/testing/strategy.md#a-refused-300-connection-attempts).

const executeFile = promisify(execFile);
// The browser suites' own pinned image, so this test pulls nothing new. The
// containers are only created, never started.
const image =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const owner = currentContainerOwner();
const created = [];

async function docker(args) {
  return (await executeFile('docker', args)).stdout.trim();
}

async function createContainer(name, labelArguments) {
  const id = await docker([
    'create',
    '--name',
    `valstara-container-owner-${name}-${process.pid}`,
    ...labelArguments,
    image,
    'true',
  ]);
  created.push(id);
  return id;
}

async function exists(id) {
  return (await docker(['ps', '--all', '--quiet', '--no-trunc'])).includes(id);
}

// The ID of a process that has exited: started, then waited for.
async function deadProcessId() {
  const child = spawn(process.execPath, ['--eval', '']);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  return String(child.pid);
}

after(async () => {
  for (const id of created) {
    await docker(['rm', '--force', id]).catch((error) => {
      if (!/No such container/u.test(String(error.stderr))) throw error;
    });
  }
});

test('a dead owner’s container is removed; a live owner’s, an unlabelled and another host’s are kept', async () => {
  const deadPid = await deadProcessId();
  const deadOwner = await createContainer(
    'dead',
    containerOwnerArguments({ ...owner, pid: deadPid }),
  );
  const previousBoot = await createContainer(
    'previous-boot',
    containerOwnerArguments({ ...owner, bootId: 'a-previous-boot' }),
  );
  const liveOwner = await createContainer(
    'live',
    containerOwnerArguments(owner),
  );
  const unlabelled = await createContainer('unlabelled', []);
  const anotherHost = await createContainer(
    'another-host',
    containerOwnerArguments({
      ...owner,
      host: `another-${owner.host}`,
      pid: deadPid,
    }),
  );

  const removed = await removeOrphanedContainers();

  assert.ok(removed.includes(deadOwner), 'the dead owner’s container is named');
  assert.ok(removed.includes(previousBoot), 'a previous boot’s is named');
  for (const kept of [liveOwner, unlabelled, anotherHost]) {
    assert.ok(!removed.includes(kept), `${kept} is not named for removal`);
  }
  assert.equal(await exists(deadOwner), false, 'the dead owner’s is removed');
  assert.equal(
    await exists(previousBoot),
    false,
    'a previous boot’s is removed',
  );
  assert.equal(await exists(liveOwner), true, 'a live owner’s is kept');
  assert.equal(await exists(unlabelled), true, 'an unlabelled one is kept');
  assert.equal(await exists(anotherHost), true, 'another host’s is kept');
});

test('the owner labels carry the host name, boot ID, PID namespace and process ID', () => {
  assert.deepEqual(containerOwnerArguments(owner), [
    '--label',
    `com.valstara.test-owner.host=${owner.host}`,
    '--label',
    `com.valstara.test-owner.boot-id=${owner.bootId}`,
    '--label',
    `com.valstara.test-owner.pid-namespace=${owner.pidNamespace}`,
    '--label',
    `com.valstara.test-owner.pid=${process.pid}`,
  ]);
  if (process.platform === 'linux') {
    assert.match(owner.bootId, /^[0-9a-f-]{36}$/u);
    assert.match(owner.pidNamespace, /^pid:\[\d+\]$/u);
  }
});

test('an owner is judged gone only on this host, by boot ID or by a stopped process in its own PID namespace', () => {
  const here = {
    host: 'this-host',
    bootId: 'this-boot',
    pidNamespace: 'pid:[1]',
    pid: '4242',
  };
  const running = new Set([4242]);
  const judge = (labels) =>
    containerOwnerIsGone(labels, {
      owner: here,
      isRunning: (pid) => running.has(pid),
    });

  assert.equal(judge(here), false, 'a running owner');
  assert.equal(judge({ ...here, pid: '4243' }), true, 'a stopped owner');
  assert.equal(
    judge({ ...here, bootId: 'earlier-boot' }),
    true,
    'an owner from a previous boot, whatever its process ID',
  );
  assert.equal(
    judge({ ...here, host: 'other-host', pid: '4243' }),
    false,
    'another host’s owner',
  );
  assert.equal(
    judge({ ...here, host: 'other-host', bootId: 'earlier-boot' }),
    false,
    'another host’s owner, even from another boot',
  );
  assert.equal(
    judge({ ...here, pidNamespace: 'pid:[2]', pid: '4243' }),
    false,
    'a process ID in another PID namespace cannot be judged here',
  );
  for (const pid of ['', 'unknown', '0', '-1', '12a']) {
    assert.equal(judge({ ...here, pid }), false, `malformed PID ${pid}`);
  }
});

test('a container another process removes first is not an error; any other removal failure is', async () => {
  const here = {
    host: 'this-host',
    bootId: 'this-boot',
    pidNamespace: 'pid:[1]',
    pid: '1',
  };
  const listing = ['gone', 'raced']
    .map((id) =>
      [id, here.host, here.bootId, here.pidNamespace, '99999'].join('\t'),
    )
    .join('\n');
  const removeFailure = (stderr) =>
    Object.assign(new Error('docker rm failed'), { stderr });
  const calls = [];
  const removed = await removeOrphanedContainers({
    owner: here,
    isRunning: () => false,
    docker: async (args) => {
      calls.push(args);
      if (args[0] === 'ps') return `${listing}\n`;
      throw removeFailure(
        args[2] === 'gone'
          ? 'Error response from daemon: No such container: gone'
          : 'Error response from daemon: removal of container raced is already in progress',
      );
    },
  });
  assert.deepEqual(removed, ['gone', 'raced']);
  assert.deepEqual(calls.slice(1), [
    ['rm', '--force', 'gone'],
    ['rm', '--force', 'raced'],
  ]);

  await assert.rejects(
    removeOrphanedContainers({
      owner: here,
      isRunning: () => false,
      docker: async (args) => {
        if (args[0] === 'ps') return listing;
        throw removeFailure('Cannot connect to the Docker daemon');
      },
    }),
    /Could not remove container gone, whose owner is gone/u,
  );
});
