# Quarantine

An agent proposes a database cleanup. The SQL runs only on a fork of the sandbox. The original SQLite file is judged after the machine has been stopped and started again.

Built for [Agents Need Solid Ground](https://archil.com/), Archil's hackathon. Archil is the serverless runtime that gives agents file systems, sandboxes, and databases.

## What the demo proves

A parent sandbox holds ten customers in `/var/lib/app/customers.sqlite`. That file lives on the sandbox root disk, which is an Archil disk.

1. The worker writes `/var/lib/app/proposal.sql` and `/var/lib/app/proposal.md`. It never opens the database. The statement is `DELETE FROM customers`.
2. `fork()` copies the root disk. The delete runs only inside the fork.
3. The parent is stopped and started. The original file still has 10 rows, and `proposal.sql` is still there.
4. The reviewer has no chat history. It reads the proposal and the two row counts, then writes `/var/lib/app/INCIDENT.md` with `verdict: reject`.
5. The parent is stopped and started once more. The incident file and the 10 rows are still on disk.
6. Both sandboxes are stopped.

A successful run prints:

```text
parent_rows=10
fork_rows=0
parent_after_restart=10
incident=reject
sandboxes=stopped
```

The reviewer rejects the migration because the fork's row count differs from the original. If the original count changes across the cold start, the run fails instead of accepting the migration. A fork that keeps the same row count is an accept.

## Prize tracks

| Track | What to point at |
|---|---|
| Most creative agent project | Two agents, and the only handoff is files. The worker proposes the cleanup. The reviewer writes the verdict from the disk. |
| Best use of Archil sandboxes or file systems | The database is a file on the sandbox root disk. `fork()` quarantines the write. Stop and start leave the original rows and `INCIDENT.md` in place. |
| Best technical execution | `npm test` checks the verdict rules. `npm run demo` prints the scoreboard and stops both sandboxes when it finishes. |

The database stays on the root disk because a fork copies that disk. An extra disk mounted into the sandbox is shared with the fork, so a database on that mount would not be quarantined.

## Run it

Node.js 22.19 or newer. Credentials stay in `.env.local` and are not committed:

```text
ARCHIL_API_KEY=key-...
ARCHIL_REGION=aws-us-east-1
```

Create a key at [console.archil.com](https://console.archil.com). `ARCHIL_REGION` is one of `aws-us-east-1`, `aws-us-west-2`, `aws-eu-west-1`, or `gcp-us-central1`.

```bash
npm install
npm test
npm run demo
```

`npm test` checks the worker and reviewer without calling Archil. `npm run demo` loads `.env.local` and runs the sandbox. The agents are deterministic, so the demo does not need a model key. Each run creates a new parent and a new fork, then stops both. Compute billing ends when they stop. The disks remain until those sandboxes are deleted.

`npm run example` is a smaller check: write a file, stop the sandbox, start it, and read the file back.

## Layout

| File | Role |
|---|---|
| `examples/quarantine.mjs` | Creates the sandbox, seeds SQLite, forks, restarts, and prints the scoreboard |
| `examples/agents.mjs` | Worker proposal and reviewer verdict |
| `examples/agents.test.mjs` | Verdict rules |
| `examples/persistent-sandbox.mjs` | Smallest stop/start persistence check |

The sandbox uses the `python:3.13` image so the SQLite file can be created with Python's standard library. The control-plane client is the [`disk`](https://www.npmjs.com/package/disk) package.
