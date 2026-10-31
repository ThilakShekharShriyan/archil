import assert from "node:assert/strict";
import test from "node:test";
import { CUSTOMERS, parseVerdict, proposeCleanup, review } from "./agents.mjs";

test("seeds ten customers", () => {
  assert.equal(CUSTOMERS.length, 10);
  assert.equal(new Set(CUSTOMERS.map((row) => row.id)).size, 10);
});

test("worker proposes a cleanup and does not apply it", () => {
  const proposal = proposeCleanup();
  assert.match(proposal.sql, /^DELETE FROM customers;\n$/);
  assert.match(proposal.note, /fork/);
});

test("reviewer rejects a fork that lost rows and keeps the original", () => {
  const { verdict, markdown } = review({
    proposalSql: proposeCleanup().sql,
    parentRows: 10,
    forkRows: 0,
    parentRowsAfterRestart: 10,
  });
  assert.equal(verdict, "reject");
  assert.equal(parseVerdict(markdown), "reject");
  assert.match(markdown, /DELETE FROM customers;/);
  assert.match(markdown, /parent_rows: 10/);
  assert.match(markdown, /fork_rows: 0/);
});

test("reviewer accepts a fork that preserved the rows", () => {
  const { verdict } = review({
    proposalSql: "SELECT COUNT(*) FROM customers;\n",
    parentRows: 10,
    forkRows: 10,
    parentRowsAfterRestart: 10,
  });
  assert.equal(verdict, "accept");
});

test("reviewer refuses a result where the original file changed", () => {
  assert.throws(
    () =>
      review({
        proposalSql: proposeCleanup().sql,
        parentRows: 10,
        forkRows: 0,
        parentRowsAfterRestart: 9,
      }),
    /quarantine failed/,
  );
});
