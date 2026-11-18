# Renovate on Gerrit: reviewers of an auto-approved change land in its attention set

On Gerrit, with `autoApprove: true`, Renovate pushes its change with its own
`Code-Review +2` and then adds the configured reviewers. Gerrit's
[automatic attention set rules](https://gerrit-review.googlesource.com/Documentation/user-attention-set.html#rules)
put every added reviewer in the attention set, so each auto-approved change
shows up in its reviewers' "Your turn" dashboard although it awaits nothing
from them. Gerrit has no server or project setting to turn that rule off.

Discussion: https://github.com/renovatebot/renovate/discussions/48063
Proposed fix: https://github.com/renovatebot/renovate/pull/48064

## Reproduction

Prerequisites: Docker with Compose v2, git, Node.js 24 or later (it runs the
TypeScript script directly). To run Renovate from source, also a Renovate
checkout with its dependencies installed (`pnpm install`). `RENOVATE_*`
variables of your shell are not passed to Renovate.

```sh
node scripts/run.ts released                 # renovate/renovate:44.252.0
node scripts/run.ts source ~/src/renovate    # any Renovate checkout, via pnpm start
docker compose down -v                       # clean up
```

Each invocation takes about 30 seconds once the images are pulled. It starts a
fresh Gerrit 3.15.0 (development auth, default `admin`/`secret`) and then:

1. creates the users `renovate` and `alice`, and the project
   `auto-approve-demo` with an outdated `package.json`, where registered users
   may vote `Code-Review -2..+2`;
2. runs Renovate once with `autoApprove: true` and `reviewers: ["alice"]`
   ([`config.js`](config.js)). It creates a change for `is-number`, votes
   `Code-Review +2` on it and adds `alice` as a reviewer;
3. reads the change's reviewers and attention set.

Renovate logs (debug) go to `logs/`. The script ends with `Reproduced` (exit
code 1) or `Not reproduced` (exit code 0). It fails if the change lacks
Renovate's `Code-Review +2` or `alice` as a reviewer, which means Renovate
stopped early.

## Current behavior

Output with Renovate 44.252.0:

```
==> Change created by Renovate
  change 1: Update dependency is-number to v7
  Code-Review approved by: renovate
  reviewers: ["renovate","alice"]
  attention set:
    alice: Reviewer was added

==> Reproduced: alice is in the attention set of the auto-approved change
```

Renovate run from source on `main` (`da9664321d`) gives the same output.

## Expected behavior

`alice` is a reviewer of the change but not in its attention set. Output with
the proposed fix (`d7c62c337f`, run from source):

```
==> Change created by Renovate
  change 1: Update dependency is-number to v7
  Code-Review approved by: renovate
  reviewers: ["renovate","alice"]
  attention set: (empty)

==> Not reproduced: alice reviews the auto-approved change without being in its attention set
```

Changes that are not approved, or approved by someone else, keep Gerrit's
behaviour with the fix; the unit tests of the pull request cover those cases.

## Files

- [`docker-compose.yml`](docker-compose.yml): Gerrit, and the released Renovate image (profile `renovate`)
- [`config.js`](config.js): self-hosted Renovate configuration
- [`project/`](project): content of the demo project's first commit
- [`scripts/run.ts`](scripts/run.ts): the whole scenario, from a clean Gerrit
