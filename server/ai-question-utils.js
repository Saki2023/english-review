"use strict";

function englishTokens(value) {
  return String(value || "").toLocaleLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
}

function safeQuestionFocus(english) {
  const tokens = englishTokens(english);
  if (tokens.includes("in") || tokens.includes("on")) return "介词辨析";
  if (tokens.includes("am") || tokens.includes("is")) return "be 动词句型";
  if (tokens.includes("a")) return "冠词与句型";
  return tokens.length === 1 ? "单词复习" : "句型练习";
}

module.exports = { englishTokens, safeQuestionFocus };
