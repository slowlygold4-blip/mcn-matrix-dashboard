export function validatedImportBoardName(value, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === "")) return "";
  if (typeof value !== "string") throw new Error("板块名称必须是文字");
  const name = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if ((!name && !optional) || name.length > 120 || ["__all__", "__unassigned__"].includes(name.toLowerCase())) {
    throw new Error("板块名称须为 1–120 个字符，不能使用系统保留名称");
  }
  return name;
}

export function prepareAuthorBoardImport(rows, { defaultBoard, boardCatalog = [] } = {}) {
  const fallback = validatedImportBoardName(defaultBoard, { optional: true });
  if (!Array.isArray(boardCatalog) || boardCatalog.length > 200) throw new Error("板块目录最多支持 200 个名称");
  const names = boardCatalog.map((item) => validatedImportBoardName(typeof item === "string" ? item : item?.name));
  const prepared = rows.map((row) => {
    const explicit = [row.board, ...(Array.isArray(row.boards) ? row.boards.map((item) => typeof item === "string" ? item : item?.name) : [])]
      .filter((name) => typeof name === "string" && name.trim()).map((name) => validatedImportBoardName(name));
    names.push(...explicit);
    if (explicit.length || !fallback) return row;
    names.push(fallback);
    return { ...row, board: fallback, boards: [{ name: fallback, sourceRow: row.sourceRow }] };
  });
  const seen = new Set();
  return {
    rows: prepared,
    defaultBoard: fallback,
    boardCatalog: names.filter((name) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((name) => ({ name })),
  };
}
