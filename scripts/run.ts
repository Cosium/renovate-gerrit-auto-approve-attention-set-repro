import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

type Mode =
  | { readonly kind: 'released' }
  | { readonly kind: 'source'; readonly renovateClone: string };

interface Account {
  readonly username?: string;
}

interface Change {
  readonly _number: number;
  readonly subject: string;
  readonly labels?: {
    readonly 'Code-Review'?: { readonly approved?: Account };
  };
  readonly reviewers?: { readonly REVIEWER?: readonly Account[] };
  readonly attention_set?: Record<
    string,
    { readonly account: Account; readonly reason: string }
  >;
}

const reproDir = dirname(import.meta.dirname);
const admin = { username: 'admin', password: 'secret' };
const project = 'auto-approve-demo';

const parseMode = (args: readonly string[]): Mode => {
  const [kind, renovateClone] = args;
  if (kind === 'released') {
    return { kind };
  }
  if (kind === 'source' && renovateClone) {
    return { kind, renovateClone: resolve(renovateClone) };
  }
  console.error('usage: node scripts/run.ts released | source <renovate-clone>');
  process.exit(2);
};

const log = (message: string): void => {
  console.log(`\n==> ${message}`);
};

// The caller's own RENOVATE_* variables would otherwise change the run.
const buildEnvironment = (
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('RENOVATE_'),
    ),
  ),
  ...overrides,
});

const run = (
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): string =>
  execFileSync(command, args, {
    cwd: options.cwd ?? reproDir,
    env: buildEnvironment(options.env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const callGerrit = async <T>(
  gerritUrl: string,
  path: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): Promise<T> => {
  const response = await fetch(`${gerritUrl}/a/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Basic ${Buffer.from(`${admin.username}:${admin.password}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text}`);
  }
  // Gerrit prefixes JSON responses with )]}' to prevent XSSI.
  return JSON.parse(text.slice(text.indexOf('\n') + 1)) as T;
};

const computeLogName = (mode: Mode): string => {
  if (mode.kind === 'released') {
    return 'released';
  }
  return `source-${run('git', ['rev-parse', '--short', 'HEAD'], { cwd: mode.renovateClone }).trim()}`;
};

const runRenovate = (
  gerritUrl: string,
  mode: Mode,
  logName: string,
  renovatePassword: string,
  workDirectory: string,
): void => {
  log(`Renovate run (${logName}), log: logs/${logName}.log`);
  rmSync(join(reproDir, 'logs', `${logName}.log`), { force: true });
  if (mode.kind === 'released') {
    run(
      'docker',
      [
        'compose',
        'run',
        '--rm',
        '-e',
        `RENOVATE_GERRIT_PASSWORD=${renovatePassword}`,
        'renovate',
      ],
      { env: { LOG_NAME: logName } },
    );
    return;
  }
  // Renovate lower-cases LOG_FILE, which breaks paths with capitals, so its
  // JSON output is written to the log instead.
  execFileSync('pnpm', ['--silent', 'start'], {
    cwd: mode.renovateClone,
    env: buildEnvironment({
      RENOVATE_CONFIG_FILE: join(reproDir, 'config.js'),
      RENOVATE_GERRIT_PASSWORD: renovatePassword,
      GERRIT_URL: `${gerritUrl}/`,
      LOG_LEVEL: 'debug',
      LOG_FORMAT: 'json',
      RENOVATE_BASE_DIR: join(workDirectory, 'renovate'),
    }),
    stdio: [
      'ignore',
      openSync(join(reproDir, 'logs', `${logName}.log`), 'w'),
      'inherit',
    ],
  });
};

const findRenovateChange = async (gerritUrl: string): Promise<Change> => {
  const changes = await callGerrit<readonly Change[]>(
    gerritUrl,
    `changes/?q=owner:renovate+status:open+project:${project}&o=LABELS&o=DETAILED_ACCOUNTS`,
  );
  const [change] = changes;
  if (changes.length !== 1 || !change) {
    throw new Error(`Expected one open change of renovate, found ${changes.length}`);
  }
  return change;
};

// Gerrit listens on a port Docker picks, so another service on 8080 is no obstacle.
const startCleanGerrit = (): string => {
  log('Starting a clean Gerrit');
  try {
    run('docker', ['compose', 'down', '-v', '--remove-orphans']);
  } catch (error) {
    console.trace('Stopping a previous Gerrit failed', error);
  }
  run('docker', ['compose', 'up', '-d', '--wait', 'gerrit']);
  const gerritUrl = `http://${run('docker', ['compose', 'port', 'gerrit', '8080']).trim()}`;
  console.log(`Gerrit is on ${gerritUrl}`);
  return gerritUrl;
};

const prepareLogDirectory = (): void => {
  const logs = join(reproDir, 'logs');
  mkdirSync(logs, { recursive: true });
  // The Renovate container writes its logs as another user.
  chmodSync(logs, 0o777);
};

const createAccount = async (
  gerritUrl: string,
  username: string,
): Promise<string> => {
  const password = randomBytes(18).toString('base64');
  await callGerrit(gerritUrl, `accounts/${username}`, {
    method: 'PUT',
    body: {
      name: username,
      email: `${username}@example.org`,
      http_password: password,
    },
  });
  return password;
};

const createProject = async (
  gerritUrl: string,
  workDirectory: string,
): Promise<void> => {
  log(`Creating project ${project}, where renovate may vote Code-Review +2`);
  await callGerrit(gerritUrl, `projects/${project}`, {
    method: 'PUT',
    body: { branches: ['master'], create_empty_commit: true },
  });
  const administrators = await callGerrit<{ readonly id: string }>(
    gerritUrl,
    'groups/Administrators',
  );
  await callGerrit(gerritUrl, `projects/${project}/access`, {
    method: 'POST',
    body: {
      add: {
        'refs/heads/*': {
          permissions: {
            'label-Code-Review': {
              rules: {
                'global:Registered-Users': {
                  action: 'ALLOW',
                  min: -2,
                  max: 2,
                },
              },
            },
            push: { rules: { [administrators.id]: { action: 'ALLOW' } } },
          },
        },
      },
    },
  });
  const seed = join(workDirectory, 'seed');
  run('git', [
    'clone',
    '--quiet',
    `${gerritUrl.replace('://', `://${admin.username}:${admin.password}@`)}/a/${project}`,
    seed,
  ]);
  cpSync(join(reproDir, 'project'), seed, { recursive: true });
  run('git', ['add', '-A'], { cwd: seed });
  run(
    'git',
    [
      '-c',
      'user.name=Administrator',
      '-c',
      'user.email=admin@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '-m',
      'Add the demo project',
    ],
    { cwd: seed },
  );
  run('git', ['push', '--quiet', 'origin', 'HEAD:refs/heads/master'], {
    cwd: seed,
  });
};

const mode = parseMode(process.argv.slice(2));
const logName = computeLogName(mode);
const gerritUrl = startCleanGerrit();
const workDirectory = mkdtempSync(join(tmpdir(), 'auto-approve-'));
try {
  prepareLogDirectory();
  log('Creating users renovate and alice (reviewer)');
  const renovatePassword = await createAccount(gerritUrl, 'renovate');
  await createAccount(gerritUrl, 'alice');
  await createProject(gerritUrl, workDirectory);

  runRenovate(gerritUrl, mode, logName, renovatePassword, workDirectory);

  log('Change created by Renovate');
  const change = await findRenovateChange(gerritUrl);
  const reviewers = (change.reviewers?.REVIEWER ?? []).map(
    (reviewer) => reviewer.username,
  );
  const attentionSet = Object.values(change.attention_set ?? {});
  const approver = change.labels?.['Code-Review']?.approved?.username;
  console.log(`  change ${change._number}: ${change.subject}`);
  console.log(`  Code-Review approved by: ${approver ?? 'nobody'}`);
  console.log(`  reviewers: ${JSON.stringify(reviewers)}`);
  console.log(`  attention set:${attentionSet.length === 0 ? ' (empty)' : ''}`);
  for (const entry of attentionSet) {
    console.log(`    ${entry.account.username}: ${entry.reason}`);
  }
  if (approver !== 'renovate') {
    throw new Error(
      `The change is not approved by renovate, see logs/${logName}.log`,
    );
  }
  if (!reviewers.includes('alice')) {
    throw new Error(
      `alice is not a reviewer: Renovate stopped early, see logs/${logName}.log`,
    );
  }
  if (attentionSet.some((entry) => entry.account.username === 'alice')) {
    log('Reproduced: alice is in the attention set of the auto-approved change');
    process.exitCode = 1;
  } else {
    log('Not reproduced: alice reviews the auto-approved change without being in its attention set');
  }
} finally {
  rmSync(workDirectory, { recursive: true, force: true });
}
