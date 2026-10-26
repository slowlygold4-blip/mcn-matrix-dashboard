import test from "node:test";
import assert from "node:assert/strict";
import { prepareAuthorBoardImport, validatedImportBoardName } from "../lib/author-board-import.mjs";

test("import default board fills only blanks and preserves explicit memberships and metadata", () => {
  const explicit = { sourceRow: 2, board: "老飞宇切片矩阵", boards: [{ name: "老飞宇切片矩阵", owner: "甲" }] };
  const multi = { sourceRow: 3, board: "", boards: [{ name: "安澜切片矩阵" }] };
  const blank = { sourceRow: 4, name: "作者", board: "", boards: [] };
  const result = prepareAuthorBoardImport([explicit, multi, blank], { defaultBoard: "一条小团团切片矩阵", boardCatalog: [{ name: "空目录" }] });
  assert.equal(result.rows[0], explicit);
  assert.equal(result.rows[1], multi);
  assert.equal(result.rows[2].board, "一条小团团切片矩阵");
  assert.deepEqual(result.rows[2].boards, [{ name: "一条小团团切片矩阵", sourceRow: 4 }]);
  assert.equal(blank.board, "");
  assert.equal(result.boardCatalog.length, 4);
});

test("default import does not guess a board and validates the whole catalog", () => {
  const row = { name: "团团作者", boards: [] };
  assert.equal(prepareAuthorBoardImport([row]).rows[0], row);
  assert.deepEqual(prepareAuthorBoardImport([row]).boardCatalog, []);
  for (const name of ["__all__", "__UNASSIGNED__", "x".repeat(121), {}, 123]) {
    assert.throws(() => validatedImportBoardName(name));
    assert.throws(() => prepareAuthorBoardImport([row], { defaultBoard: name }));
  }
  assert.throws(() => prepareAuthorBoardImport([row], { boardCatalog: [{ name: "正确" }, { name: "" }] }));
  assert.throws(() => prepareAuthorBoardImport([row], { boardCatalog: Array(201).fill("板块") }));
});
