export const CUSTOMERS = [
  { id: 1, name: "Amina Shah", email: "amina@example.com" },
  { id: 2, name: "Leo Martins", email: "leo@example.com" },
  { id: 3, name: "Nora Blake", email: "nora@example.com" },
  { id: 4, name: "Samir Ortiz", email: "samir@example.com" },
  { id: 5, name: "Hana Ito", email: "hana@example.com" },
  { id: 6, name: "Jonah Ellis", email: "jonah@example.com" },
  { id: 7, name: "Priya Raman", email: "priya@example.com" },
  { id: 8, name: "Chris Adeyemi", email: "chris@example.com" },
  { id: 9, name: "Maya Chen", email: "maya@example.com" },
  { id: 10, name: "Owen Brooks", email: "owen@example.com" },
];

// The worker never opens the database. It only leaves a proposal on the disk.
export function proposeCleanup() {
  return {
    sql: "DELETE FROM customers;\n",
    note: [
      "Task: clean the customer table before a reload.",
      "Proposal: delete every row in customers.",
      "The statement has no WHERE clause.",
      "Apply it only on a fork of the database file.",
      "",
    ].join("\n"),
  };
}

// The reviewer never sees a chat. It judges the proposal file and the two row counts.
export function review({ proposalSql, parentRows, forkRows, parentRowsAfterRestart }) {
  if (!Number.isInteger(parentRows) || !Number.isInteger(forkRows) || !Number.isInteger(parentRowsAfterRestart)) {
    throw new Error("row counts must be integers");
  }
  if (parentRowsAfterRestart !== parentRows) {
    throw new Error(
      `quarantine failed: original database changed from ${parentRows} to ${parentRowsAfterRestart}`,
    );
  }

  const verdict = forkRows === parentRows ? "accept" : "reject";
  const reason =
    verdict === "reject"
      ? `The fork changed the table from ${parentRows} rows to ${forkRows}. The original file still has ${parentRowsAfterRestart} rows after a cold start. Do not apply this migration.`
      : `The fork still has ${forkRows} rows, matching the original. The original file still has ${parentRowsAfterRestart} rows after a cold start. This migration can be applied.`;

  const markdown = [
    "# Incident",
    "",
    `verdict: ${verdict}`,
    "",
    "The worker left proposal.sql beside the database and did not apply it.",
    "The statement ran only on a forked sandbox.",
    "",
    "```sql",
    proposalSql.trimEnd(),
    "```",
    "",
    `- parent_rows: ${parentRows}`,
    `- fork_rows: ${forkRows}`,
    `- parent_after_restart: ${parentRowsAfterRestart}`,
    "",
    reason,
    "",
  ].join("\n");

  return { verdict, markdown };
}

export function parseVerdict(markdown) {
  const match = markdown.match(/^verdict:\s*(accept|reject)\s*$/m);
  if (!match) {
    throw new Error("incident file has no verdict");
  }
  return match[1];
}
