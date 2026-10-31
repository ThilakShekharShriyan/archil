import * as archil from "disk";
import { CUSTOMERS, parseVerdict, proposeCleanup, review } from "./agents.mjs";

const APP_DIR = "/var/lib/app";
const DB_PATH = `${APP_DIR}/customers.sqlite`;
const PROPOSAL_SQL = `${APP_DIR}/proposal.sql`;
const PROPOSAL_NOTE = `${APP_DIR}/proposal.md`;
const INCIDENT_PATH = `${APP_DIR}/INCIDENT.md`;

const apiKey = process.env.ARCHIL_API_KEY;
const region = process.env.ARCHIL_REGION;

if (!apiKey || !region) {
  console.error("Set ARCHIL_API_KEY and ARCHIL_REGION, then run: npm run demo");
  process.exit(1);
}

archil.configure({ apiKey, region });

function python(source) {
  const encoded = Buffer.from(source, "utf8").toString("base64");
  return `python -c "import base64; exec(base64.b64decode('${encoded}').decode())"`;
}

async function exec(sandbox, command, label) {
  const result = await sandbox.exec(command);
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.status;
    throw new Error(`${label} failed (${result.exitCode}): ${detail}`);
  }
  return result.stdout;
}

async function ensureRunning(sandbox) {
  await sandbox.refresh();
  if (sandbox.status === "running") return;
  if (sandbox.status === "paused") {
    await sandbox.resume();
    return;
  }
  await sandbox.start();
}

async function writeText(sandbox, path, content, label) {
  const source = `
import os
os.makedirs(${JSON.stringify(APP_DIR)}, exist_ok=True)
path = ${JSON.stringify(path)}
content = ${JSON.stringify(content)}
with open(path, "w", encoding="utf-8") as handle:
    handle.write(content)
    handle.flush()
    os.fsync(handle.fileno())
print(path)
`;
  await exec(sandbox, python(source), label);
}

async function readText(sandbox, path, label) {
  const source = `
path = ${JSON.stringify(path)}
with open(path, encoding="utf-8") as handle:
    print(handle.read(), end="")
`;
  return exec(sandbox, python(source), label);
}

async function countCustomers(sandbox, label) {
  const source = `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(DB_PATH)})
try:
    print(conn.execute("select count(*) from customers").fetchone()[0])
finally:
    conn.close()
`;
  const stdout = await exec(sandbox, python(source), label);
  const count = Number(stdout.trim());
  if (!Number.isInteger(count)) {
    throw new Error(`${label} returned ${JSON.stringify(stdout)}`);
  }
  return count;
}

async function seedDatabase(sandbox) {
  const source = `
import json, os, sqlite3
rows = json.loads(${JSON.stringify(JSON.stringify(CUSTOMERS))})
os.makedirs(${JSON.stringify(APP_DIR)}, exist_ok=True)
path = ${JSON.stringify(DB_PATH)}
conn = sqlite3.connect(path)
try:
    conn.execute("drop table if exists customers")
    conn.execute("create table customers (id integer primary key, name text not null, email text not null)")
    conn.executemany(
        "insert into customers (id, name, email) values (:id, :name, :email)",
        rows,
    )
    conn.commit()
finally:
    conn.close()
fd = os.open(path, os.O_RDONLY)
os.fsync(fd)
os.close(fd)
print(len(rows))
`;
  const stdout = await exec(sandbox, python(source), "seed database");
  const seeded = Number(stdout.trim());
  if (seeded !== CUSTOMERS.length) {
    throw new Error(`seeded ${seeded} customers, expected ${CUSTOMERS.length}`);
  }
}

async function applyProposal(sandbox) {
  const source = `
import os, sqlite3
sql_path = ${JSON.stringify(PROPOSAL_SQL)}
db_path = ${JSON.stringify(DB_PATH)}
with open(sql_path, encoding="utf-8") as handle:
    sql = handle.read()
conn = sqlite3.connect(db_path)
try:
    conn.executescript(sql)
    conn.commit()
finally:
    conn.close()
fd = os.open(db_path, os.O_RDONLY)
os.fsync(fd)
os.close(fd)
print("applied")
`;
  await exec(sandbox, python(source), "apply proposal on fork");
}

async function stopQuiet(sandbox) {
  try {
    await sandbox.stop();
    console.log(`stopped ${sandbox.id}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`could not stop ${sandbox.id}: ${message}`);
    return false;
  }
}

const stamp = Date.now().toString(36);
const parent = await archil.createSandbox({
  name: `quarantine-${stamp}`,
  baseImage: "python:3.13",
  vcpuCount: 1,
  memSizeMiB: 512,
  maxTtlSeconds: 1200,
  idleTtlSeconds: 600,
});

let child = null;
let scoreboard = null;

try {
  console.log(`parent ${parent.id} is up`);
  await seedDatabase(parent);
  console.log(`seeded ${CUSTOMERS.length} customers`);

  const proposal = proposeCleanup();
  await writeText(parent, PROPOSAL_SQL, proposal.sql, "write proposal.sql");
  await writeText(parent, PROPOSAL_NOTE, proposal.note, "write proposal.md");
  const proposalOnDisk = await readText(parent, PROPOSAL_SQL, "read proposal.sql");
  if (proposalOnDisk !== proposal.sql) {
    throw new Error("proposal.sql on the disk does not match the worker output");
  }
  console.log("worker wrote proposal.sql");

  child = await parent.fork({ name: `quarantine-fork-${stamp}` });
  console.log(`forked ${child.id}`);
  await ensureRunning(parent);
  await ensureRunning(child);

  await applyProposal(child);
  const parentRows = await countCustomers(parent, "count parent");
  const forkRows = await countCustomers(child, "count fork");
  console.log(`parent_rows=${parentRows} fork_rows=${forkRows}`);

  await parent.stop();
  console.log("parent stopped");
  await parent.start();
  await ensureRunning(parent);
  console.log("parent started again");

  const parentRowsAfterRestart = await countCustomers(parent, "count parent after restart");
  const proposalAfterRestart = await readText(parent, PROPOSAL_SQL, "read proposal after restart");
  if (proposalAfterRestart !== proposal.sql) {
    throw new Error("proposal.sql did not survive stop/start");
  }

  const incident = review({
    proposalSql: proposalAfterRestart,
    parentRows,
    forkRows,
    parentRowsAfterRestart,
  });
  await writeText(parent, INCIDENT_PATH, incident.markdown, "write INCIDENT.md");

  await parent.stop();
  console.log("parent stopped with the incident file");
  await parent.start();
  await ensureRunning(parent);

  const incidentOnDisk = await readText(parent, INCIDENT_PATH, "read INCIDENT.md");
  const verdict = parseVerdict(incidentOnDisk);
  if (verdict !== incident.verdict) {
    throw new Error(`incident verdict changed across restart: ${verdict}`);
  }
  const rowsAfterIncidentRestart = await countCustomers(parent, "count parent after incident restart");
  if (rowsAfterIncidentRestart !== parentRowsAfterRestart) {
    throw new Error("customer count changed after the incident file was written");
  }

  console.log(incidentOnDisk.trimEnd());
  scoreboard = {
    parentRows,
    forkRows,
    parentRowsAfterRestart,
    verdict,
  };
} finally {
  const childStopped = child ? await stopQuiet(child) : true;
  const parentStopped = await stopQuiet(parent);
  if (scoreboard && childStopped && parentStopped) {
    console.log("");
    console.log(`parent_rows=${scoreboard.parentRows}`);
    console.log(`fork_rows=${scoreboard.forkRows}`);
    console.log(`parent_after_restart=${scoreboard.parentRowsAfterRestart}`);
    console.log(`incident=${scoreboard.verdict}`);
    console.log("sandboxes=stopped");
  } else if (scoreboard) {
    throw new Error("demo finished but a sandbox is still running");
  }
}
