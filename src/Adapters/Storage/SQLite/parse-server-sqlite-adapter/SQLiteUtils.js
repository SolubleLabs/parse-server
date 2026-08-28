"use strict";

// Standalone package copy of the built SQLite adapter utility helpers.

const stableStringify = require('safe-stable-stringify');
const numericArrayIndexPattern = /^(0|[1-9]\d*)$/;
const regexLiteralCharacterPattern = /[0-9 ]|\p{L}/u;
const allowedSQLiteRegexFlags = new Set(['i', 'm', 's', 'u', 'x']);
// eslint-disable-next-line no-control-regex
const asciiOnlyStringPattern = /^[\u0000-\u007F]*$/;
const maxRegexPlannerCacheSize = 512;
const missingRegexPlannerInfo = Symbol('missingRegexPlannerInfo');
const regexLeadingLiteralSetInfoCache = new Map();
const regexPrefixPrefilterInfoCache = new Map();

// Keep object-key order deterministic so equality-sensitive array operations
// behave consistently across logically equivalent payloads.
const canonicalJSONStringify = value => stableStringify(value);
const parseJSONArray = value => {
  try {
    const parsedValue = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsedValue) ? parsedValue : [];
  } catch {
    return [];
  }
};

// Treat only canonical non-negative integers as potential array indexes.
// Values like "01" stay object keys because Parse field paths can target both.
const isNumericArrayIndexComponent = value => typeof value === 'string' && numericArrayIndexPattern.test(value);
const isASCIIOnlyString = value => asciiOnlyStringPattern.test(value);
const getRegexPlannerCacheKey = (pattern, flags) => `${flags || ''}\u0000${pattern}`;
const getCachedRegexPlannerInfo = (cache, key) => {
  if (!cache.has(key)) {
    return undefined;
  }
  const cachedInfo = cache.get(key);
  cache.delete(key);
  cache.set(key, cachedInfo);
  return cachedInfo === missingRegexPlannerInfo ? null : cachedInfo;
};
const setCachedRegexPlannerInfo = (cache, key, info) => {
  if (cache.size >= maxRegexPlannerCacheSize) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, info == null ? missingRegexPlannerInfo : info);
  return info;
};
const cloneRegexPlannerInfo = info => {
  if (info == null) {
    return info;
  }
  if (Array.isArray(info.literals)) {
    return {
      ...info,
      literals: info.literals.slice()
    };
  }
  return {
    ...info
  };
};
const getDistinctRegexFlags = flags => Array.from(new Set((flags || '').split('').filter(Boolean)));
const removeRegexWhiteSpace = regex => {
  let normalizedRegex = regex;
  if (!normalizedRegex.endsWith('\n')) {
    normalizedRegex += '\n';
  }
  return normalizedRegex.replace(/([^\\])#.*\n/gim, '$1').replace(/^#.*\n/gim, '').replace(/([^\\])\s+/gim, '$1').replace(/^\s+/, '').trim();
};
const createLiteralRegex = remaining => remaining.split('').map(c => {
  if (regexLiteralCharacterPattern.test(c)) {
    return c;
  }
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}).join('');
const maxRegexPlannerQuantifierBound = 128;
const parseRegexPlannerQuantifierBound = valueText => {
  const value = Number(valueText);
  if (!Number.isSafeInteger(value) || value > maxRegexPlannerQuantifierBound) {
    return null;
  }
  return value;
};
const literalizeRegexPart = s => {
  const matcher1 = /\\Q((?!\\E).*)\\E$/;
  const result1 = s.match(matcher1);
  if (result1 && result1.length > 1 && result1.index > -1) {
    const prefix = s.substring(0, result1.index);
    const remaining = result1[1];
    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  }
  const matcher2 = /\\Q((?!\\E).*)$/;
  const result2 = s.match(matcher2);
  if (result2 && result2.length > 1 && result2.index > -1) {
    const prefix = s.substring(0, result2.index);
    const remaining = result2[1];
    return literalizeRegexPart(prefix) + createLiteralRegex(remaining);
  }
  return s.replace(/([^\\])(\\E)/g, '$1').replace(/([^\\])(\\Q)/g, '$1').replace(/^\\E/, '').replace(/^\\Q/, '');
};
const processRegexPattern = pattern => {
  if (pattern && pattern.startsWith('^')) {
    return '^' + literalizeRegexPart(pattern.slice(1));
  }
  if (pattern && pattern.endsWith('$')) {
    return literalizeRegexPart(pattern.slice(0, pattern.length - 1)) + '$';
  }
  return literalizeRegexPart(pattern);
};
const isRegexQuantifierStart = (pattern, index) => {
  const char = pattern[index];
  return char === '*' || char === '+' || char === '{' || char === '?' && index > 0 && pattern[index - 1] !== '(';
};
const hasPotentiallyUnsafeRegexBacktracking = pattern => {
  const stack = [];
  let inCharClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      i++; // skip next char
      continue;
    }
    if (char === '[') {
      inCharClass = true;
      continue;
    }
    if (char === ']') {
      inCharClass = false;
      continue;
    }
    if (inCharClass) {
      continue;
    }
    if (char === '(') {
      if (pattern[i + 1] === '?') {
        const groupPrefix = pattern[i + 2];

        // These `(?...)` forms still go through the normal stack check below.
        if (groupPrefix !== ':' && groupPrefix !== '=' && groupPrefix !== '!' && groupPrefix !== '<') {
          return true;
        }
      }
      stack.push({
        hasQuantifier: false,
        hasAlternation: false
      });
    } else if (char === '|') {
      if (stack.length > 0) {
        stack[stack.length - 1].hasAlternation = true;
      }
    } else if (char === ')') {
      const top = stack.pop();
      if (top) {
        const isQuantified = isRegexQuantifierStart(pattern, i + 1);
        if (isQuantified && (top.hasQuantifier || top.hasAlternation)) {
          return true;
        }
        if (stack.length > 0) {
          stack[stack.length - 1].hasAlternation = stack[stack.length - 1].hasAlternation || top.hasAlternation;
          stack[stack.length - 1].hasQuantifier = stack[stack.length - 1].hasQuantifier || top.hasQuantifier || isQuantified;
        }
      }
    } else if (isRegexQuantifierStart(pattern, i)) {
      if (stack.length > 0) {
        stack[stack.length - 1].hasQuantifier = true;
      }
    }
  }
  return false;
};
const normalizeRegexPattern = (pattern, flags) => {
  let normalizedPattern = pattern;
  let normalizedFlags = flags || '';
  const distinctFlags = getDistinctRegexFlags(normalizedFlags);
  for (const flag of distinctFlags) {
    if (!allowedSQLiteRegexFlags.has(flag)) {
      throw new Error(`Unsupported regular expression flag: ${flag}`);
    }
  }
  normalizedFlags = distinctFlags.join('');
  if (normalizedFlags.includes('x')) {
    normalizedPattern = removeRegexWhiteSpace(normalizedPattern);
    normalizedFlags = normalizedFlags.replace(/x/g, '');
  }
  normalizedPattern = processRegexPattern(normalizedPattern);
  if (hasPotentiallyUnsafeRegexBacktracking(normalizedPattern)) {
    throw new Error('Unsupported potentially unsafe regular expression construct');
  }
  return {
    pattern: normalizedPattern,
    flags: normalizedFlags
  };
};
const isRegexCharacterEscaped = (pattern, index) => {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && pattern[i] === '\\'; i -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
};
const hasRegexLineSensitiveEndAnchor = pattern => pattern.length > 0 && pattern[pattern.length - 1] === '$' && !isRegexCharacterEscaped(pattern, pattern.length - 1);
const getSimpleNormalizedRegexInfo = (pattern, flags) => {
  const distinctFlags = getDistinctRegexFlags(flags);
  if (distinctFlags.some(flag => flag !== 'i')) {
    return null;
  }
  let startIndex = 0;
  let endIndex = pattern.length;
  let anchoredStart = false;
  let anchoredEnd = false;
  if (pattern.startsWith('^')) {
    anchoredStart = true;
    startIndex = 1;
  }
  if (endIndex > startIndex && hasRegexLineSensitiveEndAnchor(pattern)) {
    anchoredEnd = true;
    endIndex -= 1;
  }
  let literal = '';
  for (let index = startIndex; index < endIndex; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      index += 1;
      if (index >= endIndex) {
        return null;
      }
      const escapedChar = pattern[index];
      if ('\\.^$|?*+()[]{}'.includes(escapedChar)) {
        literal += escapedChar;
        continue;
      }
      return null;
    }
    if (char === '^' || char === '$') {
      return null;
    }
    if ('.*+?()|[{'.includes(char)) {
      return null;
    }
    literal += char;
  }
  let mode = 'contains';
  if (anchoredStart && anchoredEnd) {
    mode = 'exact';
  } else if (anchoredStart) {
    mode = 'startsWith';
  } else if (anchoredEnd) {
    mode = 'endsWith';
  }
  return {
    literal,
    mode,
    caseInsensitive: distinctFlags.includes('i'),
    requiresResidual: anchoredEnd
  };
};
const isUncasedString = value => {
  for (const char of value) {
    if (char.toLocaleLowerCase('und') !== char.toLocaleUpperCase('und')) {
      return false;
    }
  }
  return true;
};
const readRegexQuantifier = (pattern, index) => {
  const char = pattern[index];
  if (char === '*') {
    return {
      min: 0,
      max: null,
      endIndex: index + 1
    };
  }
  if (char === '+') {
    return {
      min: 1,
      max: null,
      endIndex: index + 1
    };
  }
  if (char === '?') {
    return {
      min: 0,
      max: 1,
      endIndex: index + 1
    };
  }
  if (char !== '{') {
    return null;
  }
  let cursor = index + 1;
  let minimumText = '';
  while (cursor < pattern.length && /\d/.test(pattern[cursor])) {
    minimumText += pattern[cursor];
    cursor += 1;
  }
  if (!minimumText) {
    return null;
  }
  const minimumValue = parseRegexPlannerQuantifierBound(minimumText);
  if (minimumValue === null) {
    return null;
  }
  if (pattern[cursor] === '}') {
    return {
      min: minimumValue,
      max: minimumValue,
      endIndex: cursor + 1
    };
  }
  if (pattern[cursor] !== ',') {
    return null;
  }
  cursor += 1;
  if (pattern[cursor] === '}') {
    return {
      min: minimumValue,
      max: null,
      endIndex: cursor + 1
    };
  }
  let maximumText = '';
  while (cursor < pattern.length && /\d/.test(pattern[cursor])) {
    maximumText += pattern[cursor];
    cursor += 1;
  }
  if (pattern[cursor] !== '}' || !maximumText) {
    return null;
  }
  const maximumValue = parseRegexPlannerQuantifierBound(maximumText);
  if (maximumValue === null || maximumValue < minimumValue) {
    return null;
  }
  return {
    min: minimumValue,
    max: maximumValue,
    endIndex: cursor + 1
  };
};
const getRegexLiteralAtom = (pattern, index) => {
  const char = pattern[index];
  if (char === '\\') {
    const escapedChar = pattern[index + 1];
    if (!escapedChar) {
      return null;
    }
    if ('\\.^$|?*+()[]{}'.includes(escapedChar)) {
      return {
        literal: escapedChar,
        nextIndex: index + 2
      };
    }
    if (escapedChar === 'f') {
      return {
        literal: '\f',
        nextIndex: index + 2
      };
    }
    if (escapedChar === 'n') {
      return {
        literal: '\n',
        nextIndex: index + 2
      };
    }
    if (escapedChar === 'r') {
      return {
        literal: '\r',
        nextIndex: index + 2
      };
    }
    if (escapedChar === 't') {
      return {
        literal: '\t',
        nextIndex: index + 2
      };
    }
    if (escapedChar === 'v') {
      return {
        literal: '\v',
        nextIndex: index + 2
      };
    }
    return null;
  }
  if (char === '.' || char === '[' || char === '(' || char === ')' || char === '|') {
    return null;
  }
  if (char === '^' || char === '$' || char === '{' || char === '}' || char === '*' || char === '+' || char === '?') {
    return null;
  }
  return {
    literal: char,
    nextIndex: index + 1
  };
};
const getUncasedRegexPrefix = prefix => {
  let uncasedPrefix = '';
  for (const char of prefix) {
    if (char.toLocaleLowerCase('und') !== char.toLocaleUpperCase('und')) {
      break;
    }
    uncasedPrefix += char;
  }
  return uncasedPrefix;
};
const getRegexLiteralSetCaseMode = (literals, caseInsensitive) => {
  if (!caseInsensitive) {
    return 'caseSensitive';
  }
  let allASCII = true;
  let allUncased = true;
  for (const literal of literals) {
    if (allASCII && !isASCIIOnlyString(literal)) {
      allASCII = false;
    }
    if (allUncased && !isUncasedString(literal)) {
      allUncased = false;
    }
    if (!allASCII && !allUncased) {
      return null;
    }
  }
  if (allASCII) {
    return 'caseInsensitiveASCII';
  }
  if (allUncased) {
    return 'caseInsensitiveUncased';
  }
  return null;
};
const normalizeRegexLiteralSet = (literals, caseMode) => {
  const normalizedLiterals = [];
  const seen = new Set();
  for (const literal of literals) {
    const dedupeKey = caseMode === 'caseInsensitiveASCII' ? literal.toLocaleLowerCase('en-US') : literal;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalizedLiterals.push(literal);
  }
  return normalizedLiterals;
};
const collapseRegexPrefixSet = (prefixes, caseMode) => {
  const normalizedPrefixes = normalizeRegexLiteralSet(prefixes, caseMode).slice();
  normalizedPrefixes.sort((left, right) => left.localeCompare(right, 'und'));
  const collapsedPrefixes = [];
  let previousPrefix = null;
  for (const prefix of normalizedPrefixes) {
    const comparePrefix = caseMode === 'caseInsensitiveASCII' ? prefix.toLocaleLowerCase('en-US') : prefix;
    if (previousPrefix !== null && comparePrefix.startsWith(previousPrefix.comparePrefix)) {
      continue;
    }
    collapsedPrefixes.push(prefix);
    previousPrefix = {
      comparePrefix
    };
  }
  return collapsedPrefixes;
};
const maxRegexLeadingFiniteValues = maxRegexPlannerQuantifierBound;
const mergeFiniteRegexValues = (currentValues, additionalValues, maxValues) => {
  const mergedValues = currentValues.slice();
  const seenValues = new Set(currentValues);
  for (const value of additionalValues) {
    if (seenValues.has(value)) {
      continue;
    }
    seenValues.add(value);
    mergedValues.push(value);
    if (mergedValues.length > maxValues) {
      return null;
    }
  }
  return mergedValues;
};
const combineFiniteRegexValues = (leftValues, rightValues, maxValues) => {
  const combinedValues = [];
  const seenValues = new Set();
  for (const leftValue of leftValues) {
    for (const rightValue of rightValues) {
      const combinedValue = leftValue + rightValue;
      if (seenValues.has(combinedValue)) {
        continue;
      }
      seenValues.add(combinedValue);
      combinedValues.push(combinedValue);
      if (combinedValues.length > maxValues) {
        return null;
      }
    }
  }
  return combinedValues;
};
const expandFiniteRegexValues = (baseValues, minCount, maxCount, maxValues) => {
  let repeatedValues = [''];
  let expandedValues = minCount === 0 ? [''] : [];
  for (let count = 1; count <= maxCount; count += 1) {
    repeatedValues = combineFiniteRegexValues(repeatedValues, baseValues, maxValues);
    if (!repeatedValues) {
      return null;
    }
    if (count >= minCount) {
      expandedValues = mergeFiniteRegexValues(expandedValues, repeatedValues, maxValues);
      if (!expandedValues) {
        return null;
      }
    }
  }
  return expandedValues;
};
const getRegexCharClassAtom = (pattern, index) => {
  const char = pattern[index];
  if (char === '\\') {
    const escapedChar = pattern[index + 1];
    if (!escapedChar) {
      return null;
    }
    if ('\\.^$|?*+()[]{}-'.includes(escapedChar)) {
      return {
        literal: escapedChar,
        nextIndex: index + 2
      };
    }
    if (escapedChar === 'f') {
      return {
        literal: '\f',
        nextIndex: index + 2
      };
    }
    if (escapedChar === 'n') {
      return {
        literal: '\n',
        nextIndex: index + 2
      };
    }
    if (escapedChar === 'r') {
      return {
        literal: '\r',
        nextIndex: index + 2
      };
    }
    if (escapedChar === 't') {
      return {
        literal: '\t',
        nextIndex: index + 2
      };
    }
    if (escapedChar === 'v') {
      return {
        literal: '\v',
        nextIndex: index + 2
      };
    }
    return null;
  }
  if (char === ']' || char === '-') {
    return null;
  }
  return {
    literal: char,
    nextIndex: index + 1
  };
};
const parseRegexFiniteCharClass = (pattern, index) => {
  if (pattern[index] !== '[' || pattern[index + 1] === '^') {
    return null;
  }
  let cursor = index + 1;
  let values = [];
  while (cursor < pattern.length) {
    if (pattern[cursor] === ']') {
      if (values.length === 0) {
        return null;
      }
      return {
        values,
        nextIndex: cursor + 1
      };
    }
    const classAtom = getRegexCharClassAtom(pattern, cursor);
    if (!classAtom) {
      return null;
    }
    cursor = classAtom.nextIndex;
    if (pattern[cursor] === '-' && pattern[cursor + 1] !== ']') {
      const rangeEndAtom = getRegexCharClassAtom(pattern, cursor + 1);
      if (!rangeEndAtom || !isASCIIOnlyString(classAtom.literal) || !isASCIIOnlyString(rangeEndAtom.literal)) {
        return null;
      }
      const rangeStartCode = classAtom.literal.charCodeAt(0);
      const rangeEndCode = rangeEndAtom.literal.charCodeAt(0);
      if (rangeStartCode > rangeEndCode) {
        return null;
      }
      const rangeValues = [];
      for (let code = rangeStartCode; code <= rangeEndCode; code += 1) {
        rangeValues.push(String.fromCharCode(code));
      }
      values = mergeFiniteRegexValues(values, rangeValues, maxRegexLeadingFiniteValues);
      if (!values) {
        return null;
      }
      cursor = rangeEndAtom.nextIndex;
      continue;
    }
    values = mergeFiniteRegexValues(values, [classAtom.literal], maxRegexLeadingFiniteValues);
    if (!values) {
      return null;
    }
  }
  return null;
};
const parseRegexFiniteSequence = (pattern, index, stopCharacters) => {
  let cursor = index;
  let values = [''];
  let parsedAny = false;
  while (cursor < pattern.length) {
    if (stopCharacters.includes(pattern[cursor])) {
      if (parsedAny) {
        return {
          values,
          nextIndex: cursor
        };
      } else {
        return null;
      }
    }
    const segment = parseRegexFiniteSegment(pattern, cursor);
    if (!segment || segment.stopAfter) {
      return null;
    }
    values = combineFiniteRegexValues(values, segment.values, maxRegexLeadingFiniteValues);
    if (!values) {
      return null;
    }
    cursor = segment.nextIndex;
    parsedAny = true;
  }
  if (parsedAny) {
    return {
      values,
      nextIndex: cursor
    };
  } else {
    return null;
  }
};
const parseRegexFiniteGroup = (pattern, index) => {
  if (pattern[index] !== '(') {
    return null;
  }
  let cursor = index + 1;
  if (pattern[cursor] === '?') {
    if (pattern[cursor + 1] !== ':') {
      return null;
    }
    cursor += 2;
  }
  let groupValues = [];
  while (cursor < pattern.length) {
    const branch = parseRegexFiniteSequence(pattern, cursor, '|)');
    if (!branch) {
      return null;
    }
    groupValues = mergeFiniteRegexValues(groupValues, branch.values, maxRegexLeadingFiniteValues);
    if (!groupValues) {
      return null;
    }
    cursor = branch.nextIndex;
    if (pattern[cursor] === '|') {
      cursor += 1;
      continue;
    }
    if (pattern[cursor] === ')') {
      return {
        values: groupValues,
        nextIndex: cursor + 1
      };
    }
    return null;
  }
  return null;
};
const isRegexPurePrefixTail = (pattern, index) => index >= pattern.length || pattern.slice(index) === '.*';
const hasTopLevelRegexAlternation = (pattern, startIndex) => {
  let groupDepth = 0;
  let inCharClass = false;
  for (let index = startIndex; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (inCharClass) {
      if (char === ']') {
        inCharClass = false;
      }
      continue;
    }
    if (char === '[') {
      inCharClass = true;
      continue;
    }
    if (char === '(') {
      groupDepth += 1;
      continue;
    }
    if (char === ')') {
      if (groupDepth > 0) {
        groupDepth -= 1;
      }
      continue;
    }
    if (char === '|' && groupDepth === 0) {
      return true;
    }
  }
  return false;
};
const parseRegexFiniteSegment = (pattern, index) => {
  let segmentValues = null;
  let nextIndex = index;
  const literalAtom = getRegexLiteralAtom(pattern, index);
  if (literalAtom) {
    segmentValues = [literalAtom.literal];
    nextIndex = literalAtom.nextIndex;
  } else if (pattern[index] === '[') {
    const charClass = parseRegexFiniteCharClass(pattern, index);
    if (!charClass) {
      return null;
    }
    segmentValues = charClass.values;
    nextIndex = charClass.nextIndex;
  } else if (pattern[index] === '(') {
    const finiteGroup = parseRegexFiniteGroup(pattern, index);
    if (!finiteGroup) {
      return null;
    }
    segmentValues = finiteGroup.values;
    nextIndex = finiteGroup.nextIndex;
  } else {
    return null;
  }
  const quantifier = readRegexQuantifier(pattern, nextIndex);
  if (!quantifier) {
    return {
      values: segmentValues,
      nextIndex,
      stopAfter: false
    };
  }
  if (quantifier.max === null) {
    if (quantifier.min === 0) {
      return null;
    }
    const minimumValues = expandFiniteRegexValues(segmentValues, quantifier.min, quantifier.min, maxRegexLeadingFiniteValues);
    if (!minimumValues) {
      return null;
    }
    return {
      values: minimumValues,
      nextIndex: quantifier.endIndex,
      stopAfter: true
    };
  }
  const quantifiedValues = expandFiniteRegexValues(segmentValues, quantifier.min, quantifier.max, maxRegexLeadingFiniteValues);
  if (!quantifiedValues) {
    return null;
  }
  return {
    values: quantifiedValues,
    nextIndex: quantifier.endIndex,
    stopAfter: false
  };
};
const computeRegexLeadingLiteralSetInfo = (pattern, flags) => {
  const distinctFlags = getDistinctRegexFlags(flags);
  if (distinctFlags.some(flag => flag !== 'i')) {
    return null;
  }
  if (!pattern.startsWith('^')) {
    return null;
  }
  let cursor = 1;
  let literals = [''];
  let parsedAny = false;
  let stoppedOnOpenEndedSegment = false;
  while (cursor < pattern.length) {
    const segment = parseRegexFiniteSegment(pattern, cursor);
    if (!segment) {
      break;
    }
    const nextLiterals = combineFiniteRegexValues(literals, segment.values, maxRegexLeadingFiniteValues);
    if (!nextLiterals) {
      break;
    }
    literals = nextLiterals;
    cursor = segment.nextIndex;
    parsedAny = true;
    if (segment.stopAfter) {
      stoppedOnOpenEndedSegment = true;
      break;
    }
  }
  if (!parsedAny) {
    return null;
  }
  const caseMode = getRegexLiteralSetCaseMode(literals, distinctFlags.includes('i'));
  if (!caseMode) {
    return null;
  }
  if (!stoppedOnOpenEndedSegment && pattern.slice(cursor) === '$') {
    return {
      literals: normalizeRegexLiteralSet(literals, caseMode),
      matchMode: 'exact',
      caseMode,
      requiresResidual: true
    };
  }
  if (hasTopLevelRegexAlternation(pattern, cursor)) {
    return null;
  }
  const collapsedPrefixes = collapseRegexPrefixSet(literals, caseMode);
  if (collapsedPrefixes.length === 0 || collapsedPrefixes[0] === '') {
    return null;
  }
  return {
    literals: collapsedPrefixes,
    matchMode: 'prefix',
    caseMode,
    requiresResidual: !isRegexPurePrefixTail(pattern, cursor)
  };
};
const getRegexLeadingLiteralSetInfo = (pattern, flags) => {
  const cacheKey = getRegexPlannerCacheKey(pattern, flags);
  const cachedInfo = getCachedRegexPlannerInfo(regexLeadingLiteralSetInfoCache, cacheKey);
  if (cachedInfo !== undefined) {
    return cloneRegexPlannerInfo(cachedInfo);
  }
  return setCachedRegexPlannerInfo(regexLeadingLiteralSetInfoCache, cacheKey, cloneRegexPlannerInfo(computeRegexLeadingLiteralSetInfo(pattern, flags)));
};
const computeRegexPrefixPrefilterInfo = (pattern, flags) => {
  const distinctFlags = getDistinctRegexFlags(flags);
  const caseInsensitive = distinctFlags.includes('i');

  // `m` changes `^` into line-start semantics, so a plain string-prefix filter is no longer safe.
  if (distinctFlags.includes('m') || !pattern.startsWith('^')) {
    return null;
  }
  let index = 1;
  let literalPrefix = '';
  while (index < pattern.length) {
    const literalAtom = getRegexLiteralAtom(pattern, index);
    if (!literalAtom) {
      break;
    }
    const quantifier = readRegexQuantifier(pattern, literalAtom.nextIndex);
    const minimumCount = quantifier ? quantifier.min : 1;
    if (minimumCount === 0) {
      break;
    }
    literalPrefix += literalAtom.literal.repeat(minimumCount);
    index = quantifier ? quantifier.endIndex : literalAtom.nextIndex;
  }
  if (!literalPrefix) {
    return null;
  }
  if (hasTopLevelRegexAlternation(pattern, index)) {
    return null;
  }
  const requiresResidual = !isRegexPurePrefixTail(pattern, index);
  if (!caseInsensitive) {
    return {
      literalPrefix,
      mode: 'caseSensitive',
      requiresResidual
    };
  }
  if (isASCIIOnlyString(literalPrefix)) {
    return {
      literalPrefix,
      mode: 'caseInsensitiveASCII',
      requiresResidual
    };
  }
  const uncasedPrefix = getUncasedRegexPrefix(literalPrefix);
  if (!uncasedPrefix) {
    return null;
  }

  // Truncating an `/i` prefix to its uncased Unicode-safe run is only a prefilter.
  // A later cased literal still needs the residual regex to preserve correctness.
  const uncasedPrefixWasTruncated = uncasedPrefix.length !== literalPrefix.length;
  return {
    literalPrefix: uncasedPrefix,
    mode: 'caseInsensitiveUncased',
    requiresResidual: requiresResidual || uncasedPrefixWasTruncated
  };
};
const getRegexPrefixPrefilterInfo = (pattern, flags) => {
  const cacheKey = getRegexPlannerCacheKey(pattern, flags);
  const cachedInfo = getCachedRegexPlannerInfo(regexPrefixPrefilterInfoCache, cacheKey);
  if (cachedInfo !== undefined) {
    return cloneRegexPlannerInfo(cachedInfo);
  }
  return setCachedRegexPlannerInfo(regexPrefixPrefilterInfoCache, cacheKey, cloneRegexPlannerInfo(computeRegexPrefixPrefilterInfo(pattern, flags)));
};
module.exports = {
  canonicalJSONStringify,
  getRegexLeadingLiteralSetInfo,
  getRegexPrefixPrefilterInfo,
  getSimpleNormalizedRegexInfo,
  isNumericArrayIndexComponent,
  normalizeRegexPattern,
  parseJSONArray
};
