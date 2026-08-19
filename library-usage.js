(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_LIBRARY_USAGE = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SORTS = new Set(["index", "usage", "correct", "wrong", "accuracy", "recent", "due"]);

  function validDate(value) {
    const text = String(value || "").trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
  }

  function dateScope(fromValue = "", toValue = "") {
    const from = validDate(fromValue);
    const to = validDate(toValue);
    if (!from && !to) return { active: false, from: "", to: "", label: "全部日期" };
    const label = from && to
      ? (from === to ? from : `${from} 至 ${to}`)
      : from
        ? `${from} 起`
        : `截至 ${to}`;
    return { active: true, from, to, label };
  }

  function describeRow(rowValue, fromValue = "", toValue = "") {
    const row = rowValue && typeof rowValue === "object" ? rowValue : {};
    const scope = dateScope(fromValue, toValue);
    const prefix = scope.active ? "区间" : "累计";
    const accuracy = row.accuracy == null ? "—" : `${Math.max(0, Math.min(100, Number(row.accuracy) || 0))}%`;
    return {
      scope,
      period: scope.active ? `所选区间 ${Math.max(0, Number(row.periodUsage) || 0)} 次` : "",
      results: `${prefix}对 ${Math.max(0, Number(row.independentCorrect) || 0)} · 错 ${Math.max(0, Number(row.wrong) || 0)} · 提示 ${Math.max(0, Number(row.assisted) || 0)}`,
      accuracy: `${prefix}正确率 ${accuracy}`
    };
  }

  function rowMap(value) {
    if (value instanceof Map) return value;
    return new Map((Array.isArray(value) ? value : [])
      .filter(row => row && row.id)
      .map(row => [String(row.id), row]));
  }

  function compareValue(left, right, sort) {
    if (sort === "usage") return Number(left.periodUsage || 0) - Number(right.periodUsage || 0);
    if (sort === "correct") return Number(left.independentCorrect || 0) - Number(right.independentCorrect || 0);
    if (sort === "wrong") return Number(left.wrong || 0) - Number(right.wrong || 0);
    if (sort === "accuracy") return (left.accuracy == null ? -1 : Number(left.accuracy)) - (right.accuracy == null ? -1 : Number(right.accuracy));
    if (sort === "recent") return String(left.lastUsedAt || "").localeCompare(String(right.lastUsedAt || ""));
    if (sort === "due") return String(left.nextDue || "").localeCompare(String(right.nextDue || ""));
    return Number(left.index || 0) - Number(right.index || 0);
  }

  function sortItems(itemsValue, rowsValue, sortValue = "index", orderValue = "asc") {
    const items = Array.isArray(itemsValue) ? itemsValue : [];
    const rows = rowMap(rowsValue);
    const sort = SORTS.has(sortValue) ? sortValue : "index";
    const multiplier = orderValue === "desc" ? -1 : 1;
    return items.map((item, originalIndex) => ({ item, originalIndex, row: rows.get(String(item && item.id || "")) || null }))
      .sort((left, right) => {
        // Planned/preview words do not have formal usage rows. Keep them stable
        // after learned words regardless of the selected direction.
        if (Boolean(left.row) !== Boolean(right.row)) return left.row ? -1 : 1;
        if (!left.row) return left.originalIndex - right.originalIndex;
        const compared = compareValue(left.row, right.row, sort) * multiplier;
        return compared || left.originalIndex - right.originalIndex || String(left.item.id || "").localeCompare(String(right.item.id || ""));
      })
      .map(entry => entry.item);
  }

  function revision(value) {
    const source = value && typeof value === "object" ? value : {};
    const summary = source.summary && typeof source.summary === "object" ? source.summary : {};
    const rows = Array.isArray(source.rows) ? source.rows : [];
    return [
      String(source.updatedAt || ""),
      Number(summary.events) || 0,
      ...rows.map(row => [row && row.id, row && row.todayUsage, row && row.totalUsage, row && row.nextDue].join(":"))
    ].join("|");
  }

  return { dateScope, describeRow, revision, sortItems };
});
