(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_ANSWER_UTILS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function normalizeEnglish(value) {
    return String(value || "").toLowerCase().replace(/[“”‘’.,!?;:，。！？；：]/g, "").replace(/\s+/g, " ").trim();
  }

  function normalizeChinese(value) {
    return String(value || "")
      .replace(/[\s“”‘’.,!?;:，。！？；：、]/g, "")
      .replace(/\.\.\./g, "")
      .replace(/一(?:个|块)垫子/g, "一张垫子")
      .replace(/([上下里外前后])面/g, "$1")
      .trim();
  }

  function englishAnswerMatches(answer, acceptedAnswers) {
    const normalized = normalizeEnglish(answer);
    return Boolean(normalized && acceptedAnswers.some(expected => normalizeEnglish(expected) === normalized));
  }

  function chineseAnswerMatches(answer, acceptedAnswers) {
    const normalized = normalizeChinese(answer);
    return Boolean(normalized && acceptedAnswers.some(expected => normalizeChinese(expected) === normalized));
  }

  return { chineseAnswerMatches, englishAnswerMatches, normalizeChinese, normalizeEnglish };
});
