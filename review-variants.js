(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ENGLISH_REVIEW_VARIANTS = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VARIANTS = [
    variant("identity-i-sam", "identity", "I am Sam.", "我是萨姆。", ["我是萨姆", "我叫萨姆"], ["i", "am", "sam"]),
    variant("identity-i-man", "identity", "I am a man.", "我是一个男人。", ["我是一个男人", "我是男人"], ["i", "am", "a", "man"]),
    variant("identity-he-sam", "identity", "He is Sam.", "他是萨姆。", ["他是萨姆", "他叫萨姆"], ["he", "is", "sam"]),
    variant("identity-he-man", "identity", "He is a man.", "他是一个男人。", ["他是一个男人", "他是男人"], ["he", "is", "a", "man"]),
    variant("identity-she-mom", "identity", "She is a mom.", "她是一位妈妈。", ["她是一位妈妈", "她是一个妈妈", "她是妈妈"], ["she", "is", "a", "mom"]),
    variant("identity-sam-man", "identity", "Sam is a man.", "萨姆是一个男人。", ["萨姆是一个男人", "萨姆是男人"], ["sam", "is", "a", "man"]),
    variant("identity-tom-man", "identity", "Tom is a man.", "汤姆是一个男人。", ["汤姆是一个男人", "汤姆是男人"], ["tom", "is", "a", "man"]),
    variant("identity-he-tom", "identity", "He is Tom.", "他是汤姆。", ["他是汤姆", "他叫汤姆"], ["he", "is", "tom"]),

    variant("description-pig", "description", "It is a pig.", "它是一头猪。", ["它是一头猪", "它是一只猪", "它是猪"], ["it", "is", "a", "pig"]),
    variant("description-cat", "description", "It is a cat.", "它是一只猫。", ["它是一只猫", "它是猫"], ["it", "is", "a", "cat"]),
    variant("description-pen", "description", "It is a pen.", "它是一支笔。", ["它是一支笔", "它是笔"], ["it", "is", "a", "pen"]),
    variant("description-big-pig", "description", "It is a big pig.", "它是一头大猪。", ["它是一头大猪", "它是一只大猪"], ["it", "is", "a", "big", "pig"]),
    variant("description-big-cat", "description", "It is a big cat.", "它是一只大猫。", ["它是一只大猫", "它是一个大猫"], ["it", "is", "a", "big", "cat"]),
    variant("description-red-pen", "description", "It is a red pen.", "它是一支红色的笔。", ["它是一支红色的笔", "它是一支红笔", "它是红色的笔"], ["it", "is", "a", "red", "pen"]),
    variant("description-big", "description", "It is big.", "它很大。", ["它很大", "它是大的"], ["it", "is", "big"]),
    variant("description-red", "description", "It is red.", "它是红色的。", ["它是红色的", "它是红的"], ["it", "is", "red"]),
    variant("description-hot", "description", "It is hot.", "它很热。", ["它很热", "它是热的"], ["it", "is", "hot"]),
    variant("description-big-box", "description", "It is a big box.", "它是一个大箱子。", ["它是一个大箱子", "它是一个大盒子"], ["it", "is", "a", "big", "box"]),
    variant("description-red-box", "description", "It is a red box.", "它是一个红色的箱子。", ["它是一个红色的箱子", "它是一个红箱子", "它是一个红色的盒子"], ["it", "is", "a", "red", "box"]),
    variant("description-red-mat", "description", "It is a red mat.", "它是一张红色的垫子。", ["它是一张红色的垫子", "它是一张红垫子", "它是红色的垫子"], ["it", "is", "a", "red", "mat"]),
    variant("description-big-bed", "description", "It is a big bed.", "它是一张大床。", ["它是一张大床", "它是一个大床"], ["it", "is", "a", "big", "bed"]),
    variant("description-red-bed", "description", "It is a red bed.", "它是一张红色的床。", ["它是一张红色的床", "它是一张红床"], ["it", "is", "a", "red", "bed"]),

    variant("inside-she-shop", "inside", "She is in a shop.", "她在一家商店里。", ["她在一家商店里", "她在一个商店里", "她在商店里"], ["she", "is", "in", "a", "shop"]),
    variant("inside-he-shop", "inside", "He is in a shop.", "他在一家商店里。", ["他在一家商店里", "他在一个商店里", "他在商店里"], ["he", "is", "in", "a", "shop"]),
    variant("inside-tom-shop", "inside", "Tom is in a shop.", "汤姆在一家商店里。", ["汤姆在一家商店里", "汤姆在一个商店里", "汤姆在商店里"], ["tom", "is", "in", "a", "shop"]),
    variant("inside-sam-shop", "inside", "Sam is in a shop.", "萨姆在一家商店里。", ["萨姆在一家商店里", "萨姆在一个商店里", "萨姆在商店里"], ["sam", "is", "in", "a", "shop"]),
    variant("inside-it-box", "inside", "It is in a box.", "它在一个箱子里。", ["它在一个箱子里", "它在箱子里", "它在一个盒子里", "它在盒子里"], ["it", "is", "in", "a", "box"]),
    variant("inside-cat-box", "inside", "A cat is in a box.", "一只猫在一个箱子里。", ["一只猫在一个箱子里", "一只猫在箱子里", "一只猫在一个盒子里"], ["a", "cat", "is", "in", "box"]),
    variant("inside-pen-box", "inside", "A pen is in a box.", "一支笔在一个箱子里。", ["一支笔在一个箱子里", "一支笔在箱子里", "一支笔在一个盒子里"], ["a", "pen", "is", "in", "box"]),
    variant("inside-pig-box", "inside", "A pig is in a box.", "一头猪在一个箱子里。", ["一头猪在一个箱子里", "一只猪在箱子里", "一头猪在一个盒子里"], ["a", "pig", "is", "in", "box"]),

    variant("on-red-pen-box", "on", "A red pen is on a box.", "一支红色的笔在一个箱子上。", ["一支红色的笔在一个箱子上", "一支红笔在箱子上", "一支红色的笔在一个盒子上"], ["a", "red", "pen", "is", "on", "box"]),
    variant("on-pen-box", "on", "A pen is on a box.", "一支笔在一个箱子上。", ["一支笔在一个箱子上", "一支笔在箱子上", "一支笔在一个盒子上"], ["a", "pen", "is", "on", "box"]),
    variant("on-pen-mat", "on", "A pen is on a mat.", "一支笔在一张垫子上。", ["一支笔在一张垫子上", "一支笔在垫子上"], ["a", "pen", "is", "on", "mat"]),
    variant("on-pen-bed", "on", "A pen is on a bed.", "一支笔在一张床上。", ["一支笔在一张床上", "一支笔在床上"], ["a", "pen", "is", "on", "bed"]),
    variant("on-red-pen-mat", "on", "A red pen is on a mat.", "一支红色的笔在一张垫子上。", ["一支红色的笔在一张垫子上", "一支红笔在垫子上"], ["a", "red", "pen", "is", "on", "mat"]),
    variant("on-red-pen-bed", "on", "A red pen is on a bed.", "一支红色的笔在一张床上。", ["一支红色的笔在一张床上", "一支红笔在床上"], ["a", "red", "pen", "is", "on", "bed"]),
    variant("on-cat-mat", "on", "A cat is on a mat.", "一只猫在一张垫子上。", ["一只猫在一张垫子上", "一只猫在垫子上"], ["a", "cat", "is", "on", "mat"]),
    variant("on-box-mat", "on", "A box is on a mat.", "一个箱子在一张垫子上。", ["一个箱子在一张垫子上", "箱子在垫子上", "一个盒子在垫子上"], ["a", "box", "is", "on", "mat"]),
    variant("on-it-box", "on", "It is on a box.", "它在一个箱子上。", ["它在一个箱子上", "它在箱子上", "它在一个盒子上"], ["it", "is", "on", "a", "box"]),

    variant("sat-i-mat", "sat-on", "I sat on a mat.", "我坐在一张垫子上。", ["我坐在一张垫子上", "我坐在垫子上"], ["i", "sat", "on", "a", "mat"]),
    variant("sat-man-mat", "sat-on", "A man sat on a mat.", "一个男人坐在一张垫子上。", ["一个男人坐在一张垫子上", "一个男人坐在垫子上"], ["a", "man", "sat", "on", "mat"]),
    variant("sat-big-pig-mat", "sat-on", "A big pig sat on a mat.", "一头大猪坐在一张垫子上。", ["一头大猪坐在一张垫子上", "一只大猪坐在垫子上"], ["a", "big", "pig", "sat", "on", "mat"]),
    variant("sat-cat-mat", "sat-on", "A cat sat on a mat.", "一只猫坐在一张垫子上。", ["一只猫坐在一张垫子上", "一只猫坐在垫子上"], ["a", "cat", "sat", "on", "mat"]),
    variant("sat-big-cat-mat", "sat-on", "A big cat sat on a mat.", "一只大猫坐在一张垫子上。", ["一只大猫坐在一张垫子上", "一只大猫坐在垫子上"], ["a", "big", "cat", "sat", "on", "mat"]),
    variant("sat-hen-red-bed", "sat-on", "A hen sat on a red bed.", "一只母鸡坐在一张红色的床上。", ["一只母鸡坐在一张红色的床上", "一只母鸡坐在红床上"], ["a", "hen", "sat", "on", "red", "bed"]),
    variant("sat-tom-box", "sat-on", "Tom sat on a box.", "汤姆坐在一个箱子上。", ["汤姆坐在一个箱子上", "汤姆坐在箱子上", "汤姆坐在一个盒子上"], ["tom", "sat", "on", "a", "box"]),
    variant("sat-pig-mat", "sat-on", "A pig sat on a mat.", "一头猪坐在一张垫子上。", ["一头猪坐在一张垫子上", "一只猪坐在垫子上"], ["a", "pig", "sat", "on", "mat"]),
    variant("sat-cat-box", "sat-on", "A cat sat on a box.", "一只猫坐在一个箱子上。", ["一只猫坐在一个箱子上", "一只猫坐在箱子上", "一只猫坐在一个盒子上"], ["a", "cat", "sat", "on", "box"]),
    variant("sat-cat-bed", "sat-on", "A cat sat on a bed.", "一只猫坐在一张床上。", ["一只猫坐在一张床上", "一只猫坐在床上"], ["a", "cat", "sat", "on", "bed"]),
    variant("sat-big-cat-box", "sat-on", "A big cat sat on a box.", "一只大猫坐在一个箱子上。", ["一只大猫坐在一个箱子上", "一只大猫坐在箱子上", "一只大猫坐在一个盒子上"], ["a", "big", "cat", "sat", "on", "box"]),
    variant("sat-big-pig-bed", "sat-on", "A big pig sat on a bed.", "一头大猪坐在一张床上。", ["一头大猪坐在一张床上", "一只大猪坐在床上"], ["a", "big", "pig", "sat", "on", "bed"]),
    variant("sat-man-bed", "sat-on", "A man sat on a bed.", "一个男人坐在一张床上。", ["一个男人坐在一张床上", "一个男人坐在床上"], ["a", "man", "sat", "on", "bed"]),
    variant("sat-hen-mat", "sat-on", "A hen sat on a mat.", "一只母鸡坐在一张垫子上。", ["一只母鸡坐在一张垫子上", "一只母鸡坐在垫子上"], ["a", "hen", "sat", "on", "mat"]),
    variant("sat-hen-box", "sat-on", "A hen sat on a box.", "一只母鸡坐在一个箱子上。", ["一只母鸡坐在一个箱子上", "一只母鸡坐在箱子上", "一只母鸡坐在一个盒子上"], ["a", "hen", "sat", "on", "box"]),
    variant("sat-tom-mat", "sat-on", "Tom sat on a mat.", "汤姆坐在一张垫子上。", ["汤姆坐在一张垫子上", "汤姆坐在垫子上"], ["tom", "sat", "on", "a", "mat"]),
    variant("sat-tom-bed", "sat-on", "Tom sat on a bed.", "汤姆坐在一张床上。", ["汤姆坐在一张床上", "汤姆坐在床上"], ["tom", "sat", "on", "a", "bed"]),
    variant("sat-sam-mat", "sat-on", "Sam sat on a mat.", "萨姆坐在一张垫子上。", ["萨姆坐在一张垫子上", "萨姆坐在垫子上"], ["sam", "sat", "on", "a", "mat"]),
    variant("sat-sam-box", "sat-on", "Sam sat on a box.", "萨姆坐在一个箱子上。", ["萨姆坐在一个箱子上", "萨姆坐在箱子上", "萨姆坐在一个盒子上"], ["sam", "sat", "on", "a", "box"]),
    variant("sat-he-mat", "sat-on", "He sat on a mat.", "他坐在一张垫子上。", ["他坐在一张垫子上", "他坐在垫子上"], ["he", "sat", "on", "a", "mat"]),
    variant("sat-she-bed", "sat-on", "She sat on a bed.", "她坐在一张床上。", ["她坐在一张床上", "她坐在床上"], ["she", "sat", "on", "a", "bed"])
  ];

  function normalizeEnglish(value) {
    return String(value || "").toLowerCase().replace(/[.,!?;:]/g, "").replace(/\s+/g, " ").trim();
  }

  function englishTokens(value) {
    return String(value || "").toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) || [];
  }

  function variant(id, family, english, chinese, acceptedChinese, requiredWords) {
    return Object.freeze({
      id,
      family,
      english,
      chinese,
      acceptedChinese: Object.freeze(Array.from(new Set([chinese.replace(/[。！？]$/u, ""), ...acceptedChinese]))),
      acceptedEnglish: Object.freeze([normalizeEnglish(english)]),
      requiredWords: Object.freeze(requiredWords)
    });
  }

  function sentenceFamily(item) {
    const english = normalizeEnglish(item && item.english);
    if (!english) return "";
    if (english.includes(" sat on ")) return "sat-on";
    if (english.includes(" is in ")) return "inside";
    if (english.includes(" is on ")) return "on";
    if (english.startsWith("it is ")) return "description";
    if (/^(i am|he is|she is|sam is|tom is)\b/.test(english)) return "identity";
    return "";
  }

  function knownWordSet(content) {
    const currentDay = Math.max(0, Number(content && content.currentDay) || 0);
    return new Set((Array.isArray(content && content.words) ? content.words : [])
      .filter(item => !currentDay || (Number(item.day) || 0) <= currentDay)
      .map(item => normalizeEnglish(item.english))
      .filter(Boolean));
  }

  function eligibleSentenceVariants(content, baseItem) {
    const family = sentenceFamily(baseItem);
    if (!family) return [];
    const known = knownWordSet(content);
    return VARIANTS.filter(item => item.family === family && item.requiredWords.every(word => known.has(word)));
  }

  function sentenceVariantById(content, baseItem, id) {
    return eligibleSentenceVariants(content, baseItem).find(item => item.id === String(id || "")) || null;
  }

  function stableIndex(value, length) {
    let hash = 2166136261;
    for (const character of String(value || "")) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return length ? (hash >>> 0) % length : 0;
  }

  function generatedVariantId(family, english) {
    let hash = 2166136261;
    for (const character of normalizeEnglish(english)) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `ai-${family}-${(hash >>> 0).toString(36)}`;
  }

  function cleanText(value, maximum) {
    return Array.from(String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, maximum).join("");
  }

  function invalidGeneratedVariant(reasonCode, details = {}) {
    return { valid: false, reasonCode, variant: null, ...details };
  }

  function validateGeneratedSentenceVariant(content, baseItem, value) {
    if (!value || typeof value !== "object") return invalidGeneratedVariant("invalid-object");
    const english = cleanText(value.english, 180);
    const chinese = cleanText(value.chinese, 180);
    const family = sentenceFamily(baseItem);
    if (!english) return invalidGeneratedVariant("missing-english");
    if (!chinese) return invalidGeneratedVariant("missing-chinese", { english });
    if (!family) return invalidGeneratedVariant("unsupported-source-family", { english });
    const generatedFamily = sentenceFamily({ english });
    if (generatedFamily !== family) return invalidGeneratedVariant("wrong-family", { english, expectedFamily: family, actualFamily: generatedFamily });
    const known = knownWordSet(content);
    const tokens = englishTokens(english);
    if (!tokens.length) return invalidGeneratedVariant("no-english-words", { english });
    const unlearnedWords = Array.from(new Set(tokens.filter(token => !known.has(token))));
    if (unlearnedWords.length) return invalidGeneratedVariant("unlearned-word", { english, unlearnedWords });
    const normalized = normalizeEnglish(english);
    const acceptedChinese = [];
    [chinese, ...(Array.isArray(value.acceptedChinese) ? value.acceptedChinese : [])].forEach(answer => {
      const text = cleanText(answer, 180);
      if (text && !acceptedChinese.includes(text) && acceptedChinese.length < 8) acceptedChinese.push(text);
    });
    return { valid: true, reasonCode: "ok", english, normalizedEnglish: normalized, unlearnedWords: [], variant: {
      id: generatedVariantId(family, english),
      family,
      english,
      chinese,
      acceptedEnglish: [normalized],
      acceptedChinese,
      requiredWords: Array.from(new Set(tokens))
    } };
  }

  function sanitizeGeneratedSentenceVariant(content, baseItem, value, excludedEnglish = []) {
    const validation = validateGeneratedSentenceVariant(content, baseItem, value);
    if (!validation.valid) return null;
    const excluded = new Set([normalizeEnglish(baseItem && baseItem.english), ...(Array.isArray(excludedEnglish) ? excludedEnglish : []).map(normalizeEnglish)].filter(Boolean));
    if (excluded.has(validation.normalizedEnglish)) return null;
    return validation.variant;
  }

  function chooseSentenceVariant(content, baseItem, seed, excludedIds = []) {
    const eligible = eligibleSentenceVariants(content, baseItem);
    if (!eligible.length) return null;
    const excluded = new Set((Array.isArray(excludedIds) ? excludedIds : []).map(String));
    const fixedEnglish = new Set((Array.isArray(content && content.sentences) ? content.sentences : []).map(item => normalizeEnglish(item.english)));
    const baseEnglish = normalizeEnglish(baseItem && baseItem.english);
    const pools = [
      eligible.filter(item => !excluded.has(item.id) && normalizeEnglish(item.english) !== baseEnglish && !fixedEnglish.has(normalizeEnglish(item.english))),
      eligible.filter(item => !excluded.has(item.id) && normalizeEnglish(item.english) !== baseEnglish),
      eligible.filter(item => !excluded.has(item.id)),
      eligible.filter(item => normalizeEnglish(item.english) !== baseEnglish),
      eligible
    ];
    const pool = pools.find(items => items.length) || eligible;
    return pool[stableIndex(seed, pool.length)];
  }

  return {
    VARIANTS,
    chooseSentenceVariant,
    eligibleSentenceVariants,
    englishTokens,
    generatedVariantId,
    normalizeEnglish,
    sanitizeGeneratedSentenceVariant,
    sentenceFamily,
    sentenceVariantById,
    validateGeneratedSentenceVariant
  };
});
