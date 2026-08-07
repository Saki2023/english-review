(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ENGLISH_REVIEW_ANSWER_UTILS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EVIDENCE_REPAIR_VERSION = 4;
  const MISTAKE_AUTO_RESOLVE_STREAK = 2;
  const PARTIAL_TRANSLATION_SCORE = 0.8;
  const REQUIRED_ENGLISH_FUNCTION_WORDS = ["a", "an", "the", "on", "in", "am", "is", "are"];
  const CHINESE_MEASURE_WORDS = "个|只|头|张|支|块|家|本|辆|杯|条|位|件|台|把|朵|颗|枚";
  const OPTIONAL_CHINESE_SINGULAR_MEASURE_WORDS = "个|只|头|张|支|块|家|本|辆|条|位|件|台|把|朵|颗|枚";
  const CHINESE_QUANTITY_MEASURE_WORDS = `${CHINESE_MEASURE_WORDS}|双|对|碗|瓶|套|群`;
  const OPTIONAL_MEASURE_OMISSION_EXPLANATION = "中文省略了可选的“一+量词”，但主语、性质、对象和数量含义没有改变，本题判为正确。";
  const QUANTITY_CONFLICT_EXPLANATION = "中文数量与英文原句不一致；“一双/一对”等表示两个成对对象，不能替代英文单数 a/an。";

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

  function isReviewEligibleItem(item, currentDay, studyDate) {
    if (!item || item.preview === true) return false;
    const day = Number(item.day);
    const maximumDay = Number(currentDay);
    const learned = String(item.learned || "").trim();
    const date = String(studyDate || "").trim();
    if (!Number.isFinite(day) || day < 1 || !Number.isFinite(maximumDay) || day > maximumDay) return false;
    return Boolean(learned && date && learned <= date);
  }

  function englishAnswerMatches(answer, acceptedAnswers) {
    const normalized = normalizeEnglish(answer);
    return Boolean(normalized && acceptedAnswers.some(expected => normalizeEnglish(expected) === normalized));
  }

  function englishWords(value) {
    return normalizeEnglish(value).match(/[a-z]+(?:'[a-z]+)?/g) || [];
  }

  function englishFunctionWordsMatch(answer, acceptedAnswers) {
    const answerWords = englishWords(answer);
    const references = (Array.isArray(acceptedAnswers) ? acceptedAnswers : []).filter(value => englishWords(value).length);
    if (!answerWords.length || !references.length) return false;
    const answerCounts = Object.fromEntries(REQUIRED_ENGLISH_FUNCTION_WORDS.map(word => [word, answerWords.filter(token => token === word).length]));
    return references.some(reference => {
      const referenceWords = englishWords(reference);
      return REQUIRED_ENGLISH_FUNCTION_WORDS.every(word => answerCounts[word] === referenceWords.filter(token => token === word).length);
    });
  }

  function englishFunctionWordDifferences(answer, acceptedAnswers) {
    const answerWords = englishWords(answer);
    const references = (Array.isArray(acceptedAnswers) ? acceptedAnswers : []).filter(value => englishWords(value).length);
    if (!references.length) return [];
    const answerCounts = Object.fromEntries(REQUIRED_ENGLISH_FUNCTION_WORDS.map(word => [word, answerWords.filter(token => token === word).length]));
    return references.map(reference => {
      const referenceWords = englishWords(reference);
      return REQUIRED_ENGLISH_FUNCTION_WORDS.filter(word => answerCounts[word] !== referenceWords.filter(token => token === word).length);
    }).sort((left, right) => left.length - right.length)[0];
  }

  function englishWordResults(reference, answer) {
    const expected = englishWords(reference);
    const actual = englishWords(answer);
    const tokens = Array.from(new Set([...expected, ...actual]));
    return tokens.map(english => {
      const expectedCount = expected.filter(token => token === english).length;
      const actualCount = actual.filter(token => token === english).length;
      return {
        english,
        correct: expectedCount === actualCount,
        issue: expectedCount === actualCount ? "" : actualCount < expectedCount ? "missing" : "extra"
      };
    });
  }

  function englishSourceWordResults(reference, correct, problemWords = []) {
    const tokens = englishWords(reference).filter((token, index, all) => all.indexOf(token) === index);
    if (correct) return tokens.map(english => ({ english, correct: true, issue: "" }));
    const problems = new Set(englishWords((Array.isArray(problemWords) ? problemWords : []).join(" ")));
    if (!problems.size) return [];
    return tokens.map(english => ({ english, correct: !problems.has(english), issue: problems.has(english) ? "meaning" : "" }));
  }

  function tokenCounts(tokens) {
    return tokens.reduce((result, token) => {
      result[token] = (result[token] || 0) + 1;
      return result;
    }, {});
  }

  function englishTokenRole(token) {
    const value = String(token || "").toLocaleLowerCase();
    if (["a", "an", "the"].includes(value)) return "冠词";
    if (["on", "in", "at", "to", "from", "under", "over"].includes(value)) return "介词/位置词";
    if (["am", "is", "are", "was", "were"].includes(value)) return "be 动词";
    if (["i", "you", "he", "she", "it", "we", "they"].includes(value)) return "主语代词";
    return "关键词";
  }

  function englishAnswerDifferences(reference, answer) {
    const expected = englishWords(reference);
    const actual = englishWords(answer);
    const expectedCounts = tokenCounts(expected);
    const actualCounts = tokenCounts(actual);
    const missing = [];
    const extra = [];
    Object.entries(expectedCounts).forEach(([token, count]) => {
      const difference = count - (actualCounts[token] || 0);
      for (let index = 0; index < difference; index += 1) missing.push(token);
    });
    Object.entries(actualCounts).forEach(([token, count]) => {
      const difference = count - (expectedCounts[token] || 0);
      for (let index = 0; index < difference; index += 1) extra.push(token);
    });
    const positional = [];
    const limit = Math.max(expected.length, actual.length);
    for (let index = 0; index < limit; index += 1) {
      if (expected[index] && actual[index] && expected[index] !== actual[index]) {
        positional.push({ position: index + 1, expected: expected[index], actual: actual[index] });
      }
    }
    return { expected, actual, missing, extra, positional };
  }

  function chineseDifference(reference, answer) {
    const expected = normalizeChinese(reference);
    const actual = normalizeChinese(answer);
    if (!expected || !actual) return { expected, actual, expectedPart: expected, actualPart: actual };
    let prefix = 0;
    while (prefix < expected.length && prefix < actual.length && expected[prefix] === actual[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < expected.length - prefix && suffix < actual.length - prefix
      && expected[expected.length - suffix - 1] === actual[actual.length - suffix - 1]) suffix += 1;
    return {
      expected,
      actual,
      expectedPart: expected.slice(prefix, expected.length - suffix || undefined),
      actualPart: actual.slice(prefix, actual.length - suffix || undefined)
    };
  }

  function buildTranslationExplanation(input = {}) {
    const direction = input.direction === "zh-en" ? "zh-en" : "en-zh";
    const referenceAnswer = String(input.referenceAnswer || "").trim();
    const answer = String(input.answer || "").trim();
    const correct = input.correct === true;
    const gradingStatus = String(input.gradingStatus || (correct ? "correct" : "incorrect"));
    const providerExplanation = String(input.explanation || "").replace(/\s+/g, " ").trim();
    const problemWords = Array.from(new Set((Array.isArray(input.problemWords) ? input.problemWords : []).flatMap(englishWords))).slice(0, 8);

    if (correct && gradingStatus !== "partial") {
      return providerExplanation || "答案与参考答案意思一致，主语、核心动作和关键位置/数量信息完整。";
    }

    const parts = [];
    if (gradingStatus === "partial") {
      const expected = normalizeChinese(referenceAnswer);
      const actual = normalizeChinese(answer);
      const expectedMeasure = expected.match(/一([个只头张支块家本辆杯条位件台把朵颗枚])/);
      const actualMeasure = actual.match(/一([个只头张支块家本辆杯条位件台把朵颗枚])/);
      if (expectedMeasure && actualMeasure && expectedMeasure[1] !== actualMeasure[1]) {
        parts.push(`核心意思正确，但量词“${actualMeasure[1]}”与参考答案“${expectedMeasure[1]}”不同，建议使用“${expectedMeasure[1]}”`);
      } else {
        parts.push("核心意思基本正确，但有一处中文表达不够自然，请对照参考答案修正");
      }
    } else if (direction === "zh-en") {
      const difference = englishAnswerDifferences(referenceAnswer, answer);
      if (difference.missing.length) {
        const items = difference.missing.map(token => `${englishTokenRole(token)}“${token}”`);
        parts.push(`漏写${items.join("、")}`);
      }
      if (difference.extra.length) {
        const items = difference.extra.map(token => `${englishTokenRole(token)}“${token}”`);
        parts.push(`多写${items.join("、")}`);
      }
      if (difference.positional.length && !difference.missing.length && !difference.extra.length) {
        parts.push(difference.positional.slice(0, 2).map(item => `第${item.position}个词应为“${item.expected}”，你写成“${item.actual}”`).join("；"));
      } else if (difference.positional.length && difference.missing.length && difference.extra.length) {
        const item = difference.positional[0];
        parts.push(`第${item.position}个词应为“${item.expected}”，你写成“${item.actual}”`);
      }
      if (!parts.length) parts.push("英文拼写或词序与参考答案不一致，请逐词检查主语、动作和位置词");
    } else {
      const difference = chineseDifference(referenceAnswer, answer);
      if (difference.expectedPart || difference.actualPart) {
        const expectedPart = difference.expectedPart || "（缺少）";
        const actualPart = difference.actualPart || "（未填写）";
        parts.push(`中文答案在“${difference.expectedPart ? difference.expectedPart : difference.actualPart}”处与参考答案不同：应为“${expectedPart}”，你写成“${actualPart}”`);
      } else {
        parts.push("中文答案与参考答案不一致，请检查主语、核心动作、对象、数量/性质和位置信息是否完整");
      }
    }
    if (problemWords.length) parts.push(`重点检查单词：${problemWords.join("、")}`);
    if (providerExplanation && !parts.some(part => part === providerExplanation || part.includes(providerExplanation))) parts.push(providerExplanation);
    return Array.from(parts.join("；")).slice(0, 300).join("");
  }

  function relaxedChineseMeasureWords(value) {
    return normalizeChinese(value).replace(new RegExp(`一(?:${CHINESE_MEASURE_WORDS})(?=[\\u3400-\\u9fff])`, "g"), "一");
  }

  // In beginner location translations, Chinese may omit the optional locative
  // particle "里": "我们在学校" and "我们在学校里" express the same place.
  // Restrict the relaxation to a location introduced by 在/到/去 and require
  // either a multi-character place name or a small set of one-character place
  // nouns, so words such as "这里" are not silently changed in meaning.
  function relaxedChineseLocation(value) {
    return normalizeChinese(value).replace(/(在|到|去)((?:[\u3400-\u9fff]{2,}|家|店|校))里/g, "$1$2");
  }

  function measureStructure(value, pattern) {
    const normalized = relaxedChineseLocation(value);
    const expression = new RegExp(pattern, "g");
    const measures = [];
    let base = "";
    let cursor = 0;
    let match;
    while ((match = expression.exec(normalized))) {
      base += normalized.slice(cursor, match.index);
      measures.push({ offset: base.length, text: match[0], number: match[1] || "一", measure: match[2] || match[1] || "" });
      cursor = match.index + match[0].length;
    }
    base += normalized.slice(cursor);
    return { base, measures };
  }

  function optionalMeasureStructure(value) {
    return measureStructure(value, `一(${OPTIONAL_CHINESE_SINGULAR_MEASURE_WORDS})(?=[\\u3400-\\u9fff])`);
  }

  function quantityStructure(value) {
    return measureStructure(value, `([一二两三四五六七八九十])(${CHINESE_QUANTITY_MEASURE_WORDS})(?=[\\u3400-\\u9fff])`);
  }

  function measureMap(structure) {
    return new Map(structure.measures.map(item => [item.offset, item]));
  }

  function structureIsSubset(smaller, larger) {
    const largerMeasures = measureMap(larger);
    return smaller.measures.every(item => largerMeasures.get(item.offset)?.text === item.text);
  }

  function chineseOptionalMeasureOmissionMatches(answer, acceptedAnswers) {
    const actual = optionalMeasureStructure(answer);
    if (!actual.base) return false;
    return (Array.isArray(acceptedAnswers) ? acceptedAnswers : []).some(expectedValue => {
      const expected = optionalMeasureStructure(expectedValue);
      if (expected.base !== actual.base || expected.measures.length <= actual.measures.length) return false;
      return structureIsSubset(actual, expected);
    });
  }

  function optionalSingularQuantity(item) {
    return item && item.number === "一" && new RegExp(`^(?:${OPTIONAL_CHINESE_SINGULAR_MEASURE_WORDS})$`).test(item.measure);
  }

  function quantityStructuresConflict(expected, actual) {
    const expectedMeasures = measureMap(expected);
    const actualMeasures = measureMap(actual);
    const offsets = new Set([...expectedMeasures.keys(), ...actualMeasures.keys()]);
    for (const offset of offsets) {
      const expectedItem = expectedMeasures.get(offset);
      const actualItem = actualMeasures.get(offset);
      if (expectedItem?.text === actualItem?.text) continue;
      if (!expectedItem || !actualItem) {
        if (optionalSingularQuantity(expectedItem || actualItem)) continue;
        return true;
      }
      if (expectedItem.number === actualItem.number && optionalSingularQuantity(expectedItem) && optionalSingularQuantity(actualItem)) continue;
      return true;
    }
    return false;
  }

  function chineseQuantityConflict(answer, acceptedAnswers) {
    const actual = quantityStructure(answer);
    const comparable = (Array.isArray(acceptedAnswers) ? acceptedAnswers : [])
      .map(quantityStructure)
      .filter(expected => expected.base && expected.base === actual.base);
    return comparable.length > 0 && comparable.every(expected => quantityStructuresConflict(expected, actual));
  }

  function chineseSubjectMatchesEnglish(english, chinese) {
    const subject = normalizeEnglish(english).match(/^(it|he|she|i|we|sam|tom)\b/)?.[1] || "";
    if (!subject) return true;
    const expected = { it: "它", he: "他", she: "她", i: "我", we: "我们", sam: "萨姆", tom: "汤姆" }[subject];
    return normalizeChinese(chinese).startsWith(expected);
  }

  function chineseAnswerQuality(answer, acceptedAnswers) {
    const normalized = normalizeChinese(answer);
    const references = Array.isArray(acceptedAnswers) ? acceptedAnswers : [];
    if (normalized && references.some(expected => normalizeChinese(expected) === normalized)) {
      return { correct: true, gradingStatus: "correct", score: 1 };
    }
    const relaxedLocation = relaxedChineseLocation(answer);
    if (relaxedLocation && references.some(expected => relaxedChineseLocation(expected) === relaxedLocation)) {
      return { correct: true, gradingStatus: "correct", score: 1 };
    }
    if (chineseOptionalMeasureOmissionMatches(answer, references)) {
      return { correct: true, gradingStatus: "correct", score: 1 };
    }
    const relaxed = relaxedChineseMeasureWords(answer);
    if (relaxed && references.some(expected => relaxedChineseMeasureWords(expected) === relaxed)) {
      return { correct: true, gradingStatus: "partial", score: PARTIAL_TRANSLATION_SCORE };
    }
    return { correct: false, gradingStatus: "incorrect", score: 0 };
  }

  function chineseAnswerMatches(answer, acceptedAnswers) {
    return chineseAnswerQuality(answer, acceptedAnswers).gradingStatus === "correct";
  }

  function buildMistakePracticeQueue(rows, startTaskId, validTaskIds) {
    const filterKnownTasks = validTaskIds != null;
    const valid = new Set(validTaskIds || []);
    const seen = new Set();
    const taskIds = [];
    (Array.isArray(rows) ? rows : []).forEach(row => {
      const taskId = String(row && row.taskId || "");
      if (!taskId || seen.has(taskId) || (filterKnownTasks && !valid.has(taskId))) return;
      seen.add(taskId);
      taskIds.push(taskId);
    });
    const startIndex = taskIds.indexOf(String(startTaskId || ""));
    if (startIndex < 0) return [];
    return [...taskIds.slice(startIndex), ...taskIds.slice(0, startIndex)];
  }

  function mistakeCorrectStreak(attempts, taskId) {
    const target = String(taskId || "");
    if (!target) return 0;
    let streak = 0;
    const records = Array.isArray(attempts) ? attempts : [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const attempt = records[index] && typeof records[index] === "object" ? records[index] : {};
      if (String(attempt.taskId || "") !== target) continue;
      const score = Number.isFinite(Number(attempt.score)) ? Number(attempt.score) : (attempt.correct ? 1 : 0);
      const fullyCorrect = attempt.correct === true && attempt.gradingStatus !== "partial" && score >= 1;
      if (!fullyCorrect) break;
      streak += 1;
      if (streak >= MISTAKE_AUTO_RESOLVE_STREAK) break;
    }
    return streak;
  }

  function mistakeIsResolved(attempts, taskId) {
    return mistakeCorrectStreak(attempts, taskId) >= MISTAKE_AUTO_RESOLVE_STREAK;
  }

  function shouldSubmitOnEnter(event) {
    return Boolean(event && event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229);
  }

  function reviewTask(content, taskId) {
    const value = String(taskId || "");
    const separator = value.lastIndexOf(":");
    if (separator <= 0) return null;
    const itemId = value.slice(0, separator);
    const direction = value.slice(separator + 1);
    if (!["en-zh", "zh-en"].includes(direction)) return null;
    const items = [...(Array.isArray(content && content.words) ? content.words : []), ...(Array.isArray(content && content.sentences) ? content.sentences : [])];
    const item = items.find(candidate => candidate && candidate.id === itemId);
    return item ? { item, direction, taskId: value } : null;
  }

  function reviewTaskForRecord(content, value) {
    const record = value && typeof value === "object" ? value : {};
    const task = reviewTask(content, record.taskId);
    if (!task) return null;
    const source = record.reviewVariant && typeof record.reviewVariant === "object" ? record.reviewVariant : null;
    const variantId = String(record.variantId || "").trim();
    const snapshotId = String(source && source.id || "").trim();
    const english = String(source && source.english || "").trim();
    const chinese = String(source && source.chinese || "").trim();
    if (!source || !snapshotId || !english || !chinese || (variantId && snapshotId !== variantId)) return task;
    const acceptedEnglish = Array.isArray(source.acceptedEnglish) && source.acceptedEnglish.length ? source.acceptedEnglish : [english];
    const acceptedChinese = Array.isArray(source.acceptedChinese) && source.acceptedChinese.length ? source.acceptedChinese : [chinese];
    return {
      ...task,
      item: { ...task.item, english, chinese, acceptedEnglish, acceptedChinese },
      variantId: snapshotId,
      reviewVariant: { ...source, id: snapshotId, english, chinese, acceptedEnglish, acceptedChinese }
    };
  }

  function taskAcceptedAnswers(task) {
    return task.direction === "zh-en"
      ? (Array.isArray(task.item.acceptedEnglish) && task.item.acceptedEnglish.length ? task.item.acceptedEnglish : [task.item.english])
      : (Array.isArray(task.item.acceptedChinese) && task.item.acceptedChinese.length ? task.item.acceptedChinese : [task.item.chinese]);
  }

  function taskAnswerMatches(task, answer) {
    const accepted = taskAcceptedAnswers(task);
    return task.direction === "zh-en" ? englishAnswerMatches(answer, accepted) : chineseAnswerMatches(answer, accepted);
  }

  function answerIdentity(task, answer) {
    return task && task.direction === "zh-en" ? normalizeEnglish(answer) : normalizeChinese(answer);
  }

  function repairedMistake(task, attempt, index) {
    const date = String(attempt.date || "unknown");
    const safeTaskId = task.taskId.replace(/[^a-z0-9_-]+/gi, "-");
    return {
      id: `evidence-repair-v${EVIDENCE_REPAIR_VERSION}-${date}-${safeTaskId}-${index}`,
      attemptId: String(attempt.id || ""),
      taskId: task.taskId,
      variantId: String(attempt.variantId || task.variantId || ""),
      reviewVariant: task.reviewVariant ? { ...task.reviewVariant } : null,
      date,
      direction: task.direction,
      day: Number(task.item.day) || 0,
      prompt: task.direction === "en-zh" ? task.item.english : task.item.chinese,
      userAnswer: String(attempt.answer || "（未填写）"),
      correctAnswer: task.direction === "zh-en" ? task.item.english : task.item.chinese,
      note: String(attempt.detailedExplanation || attempt.explanation || "已按当前判题规则修正。").slice(0, 300)
    };
  }

  function repairReviewEvidence(content, value) {
    const source = value && typeof value === "object" ? value : {};
    const taskStates = { ...(source.taskStates && typeof source.taskStates === "object" ? source.taskStates : {}) };
    const history = Object.fromEntries(Object.entries(source.history && typeof source.history === "object" ? source.history : {}).map(([date, record]) => [date, { ...(record && typeof record === "object" ? record : {}) }]));
    const originalAttempts = Array.isArray(source.attempts) ? source.attempts : [];
    const dateDeltas = new Map();
    const affectedTaskIds = new Set();
    let changed = Number(source.evidenceRepairVersion) < EVIDENCE_REPAIR_VERSION;

    const attempts = originalAttempts.map(attemptValue => {
      const attempt = attemptValue && typeof attemptValue === "object" ? attemptValue : {};
      const task = reviewTaskForRecord(content, attempt);
      if (!task || typeof attempt.correct !== "boolean") return attempt;
      const accepted = taskAcceptedAnswers(task);
      let correct = attempt.correct;
      let gradingStatus = ["correct", "partial", "incorrect"].includes(attempt.gradingStatus) ? attempt.gradingStatus : (correct ? "correct" : "incorrect");
      let score = Number.isFinite(Number(attempt.score)) ? Math.max(0, Math.min(1, Number(attempt.score))) : (correct ? 1 : 0);
      let explanation = String(attempt.explanation || "");
      let detailedExplanation = String(attempt.detailedExplanation || "");
      let problemWords = Array.isArray(attempt.problemWords) ? attempt.problemWords : [];
      if (task.direction === "en-zh") {
        const quality = chineseAnswerQuality(attempt.answer, accepted);
        if (quality.gradingStatus === "correct" || quality.gradingStatus === "partial") {
          correct = true;
          gradingStatus = quality.gradingStatus;
          score = quality.score;
          const optionalMeasureOmission = chineseOptionalMeasureOmissionMatches(attempt.answer, accepted);
          explanation = quality.gradingStatus === "partial"
            ? "英语意思理解正确；中文量词不够自然，本题按部分正确记录。"
            : optionalMeasureOmission
              ? OPTIONAL_MEASURE_OMISSION_EXPLANATION
              : (attempt.correct ? (explanation || "中文表达与参考答案等义。") : "中文表达与参考答案等义，已按当前规则修正。");
          problemWords = [];
          detailedExplanation = buildTranslationExplanation({ direction: task.direction, referenceAnswer: task.item.chinese, answer: attempt.answer, correct: true, gradingStatus, explanation, problemWords });
        } else if (correct && chineseQuantityConflict(attempt.answer, accepted)) {
          correct = false;
          gradingStatus = "incorrect";
          score = 0;
          explanation = QUANTITY_CONFLICT_EXPLANATION;
          problemWords = [];
          detailedExplanation = buildTranslationExplanation({ direction: task.direction, referenceAnswer: task.item.chinese, answer: attempt.answer, correct: false, gradingStatus, explanation, problemWords });
        }
      } else {
        if (!correct && taskAnswerMatches(task, attempt.answer)) {
          correct = true;
          gradingStatus = "correct";
          score = 1;
        }
        if (correct && !englishFunctionWordsMatch(attempt.answer, accepted)) {
          correct = false;
          gradingStatus = "incorrect";
          score = 0;
          explanation = "冠词、介词或 be 动词有漏写或多写，已按当前规则修正。";
        }
      }
      const wordResults = task.direction === "zh-en"
        ? englishWordResults(task.item.english, attempt.answer)
        : englishSourceWordResults(task.item.english, correct, problemWords);
      const previousScore = Number.isFinite(Number(attempt.score)) ? Math.max(0, Math.min(1, Number(attempt.score))) : (attempt.correct ? 1 : 0);
      const next = { ...attempt, correct, score, gradingStatus, explanation, detailedExplanation, problemWords, wordResults };
      const attemptChanged = JSON.stringify(next) !== JSON.stringify(attempt);
      if (!attemptChanged) return attempt;
      changed = true;
      if (correct !== attempt.correct || gradingStatus !== attempt.gradingStatus) affectedTaskIds.add(task.taskId);
      const date = String(attempt.date || "");
      if (date && score !== previousScore) dateDeltas.set(date, (dateDeltas.get(date) || 0) + score - previousScore);
      return { ...next, gradingSource: `evidence-repair-v${EVIDENCE_REPAIR_VERSION}` };
    });

    dateDeltas.forEach((delta, date) => {
      const record = history[date];
      if (!record) return;
      const reviewed = Math.max(0, Number(record.reviewed) || 0);
      record.correct = Math.round(Math.max(0, Math.min(reviewed, (Number(record.correct) || 0) + delta)) * 100) / 100;
    });

    const attemptEntries = attempts.map((attempt, index) => ({ attempt, index, task: reviewTaskForRecord(content, attempt) })).filter(entry => entry.task);
    const attemptById = new Map(attemptEntries.map(entry => [String(entry.attempt.id || ""), entry]).filter(([id]) => id));

    let mistakes = (Array.isArray(source.mistakes) ? source.mistakes : []).filter(mistake => {
      const mistakeTask = reviewTaskForRecord(content, mistake);
      const normalizedAnswer = answerIdentity(mistakeTask, mistake && mistake.userAnswer);
      const requestedVariantId = String(mistake && mistake.variantId || "");
      const matchingAttempt = attemptById.get(String(mistake && mistake.attemptId || "")) || [...attemptEntries].reverse().find(entry => {
        if (entry.task.taskId !== String(mistake && mistake.taskId || "")) return false;
        if (requestedVariantId && String(entry.attempt.variantId || "") !== requestedVariantId) return false;
        return answerIdentity(entry.task, entry.attempt.answer) === normalizedAnswer;
      });
      const task = matchingAttempt ? matchingAttempt.task : mistakeTask;
      if (!task) return true;
      const shouldRemove = Boolean((matchingAttempt && matchingAttempt.attempt.correct === true) || taskAnswerMatches(task, mistake.userAnswer));
      if (shouldRemove) changed = true;
      return !shouldRemove;
    });

    mistakes = mistakes.filter(mistake => {
      const resolved = mistakeIsResolved(attempts, mistake && mistake.taskId);
      if (resolved) changed = true;
      return !resolved;
    });

    attempts.forEach((attempt, index) => {
      if (attempt.correct !== false || originalAttempts[index] && originalAttempts[index].correct !== true) return;
      const task = reviewTaskForRecord(content, attempt);
      if (!task) return;
      if (mistakeIsResolved(attempts, task.taskId)) return;
      const exists = mistakes.some(mistake => mistake.taskId === task.taskId && answerIdentity(task, mistake.userAnswer) === answerIdentity(task, attempt.answer));
      if (!exists) mistakes.push(repairedMistake(task, attempt, index));
    });

    affectedTaskIds.forEach(taskId => {
      const latest = [...attempts].reverse().find(attempt => attempt && attempt.taskId === taskId && typeof attempt.correct === "boolean");
      if (!latest) return;
      const previous = taskStates[taskId] && typeof taskStates[taskId] === "object" ? taskStates[taskId] : {};
      taskStates[taskId] = {
        ...previous,
        lastResult: latest.correct,
        level: latest.correct ? Math.max(1, Number(previous.level) || 0) : 0,
        lastReviewed: previous.lastReviewed || latest.date || ""
      };
    });

    return {
      changed,
      state: {
        ...source,
        evidenceRepairVersion: EVIDENCE_REPAIR_VERSION,
        taskStates,
        history,
        attempts,
        mistakes: mistakes.slice(-80)
      }
    };
  }

  return {
    EVIDENCE_REPAIR_VERSION,
    MISTAKE_AUTO_RESOLVE_STREAK,
    PARTIAL_TRANSLATION_SCORE,
    REQUIRED_ENGLISH_FUNCTION_WORDS,
    buildTranslationExplanation,
    buildMistakePracticeQueue,
    chineseOptionalMeasureOmissionMatches,
    chineseQuantityConflict,
    chineseAnswerQuality,
    chineseAnswerMatches,
    chineseSubjectMatchesEnglish,
    englishAnswerDifferences,
    englishAnswerMatches,
    englishFunctionWordDifferences,
    englishFunctionWordsMatch,
    englishSourceWordResults,
    englishWordResults,
    isReviewEligibleItem,
    mistakeCorrectStreak,
    mistakeIsResolved,
    normalizeChinese,
    normalizeEnglish,
    OPTIONAL_MEASURE_OMISSION_EXPLANATION,
    QUANTITY_CONFLICT_EXPLANATION,
    reviewTaskForRecord,
    repairReviewEvidence,
    shouldSubmitOnEnter
  };
});
