"use strict";

// Standalone package copy of the built SQLite client helpers.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  canonicalJSONStringify,
  isNumericArrayIndexComponent,
  normalizeRegexPattern,
  parseJSONArray
} = require('./SQLiteUtils');
const DEFAULT_SQLITE_CACHE_SIZE_KB = 32768;
function resolveBetterSQLiteNativeBindingPath() {
  // Bundled runtimes already copy the native addon into `build/Release` beside the built entrypoint.
  const runtimeCandidatePaths = [path.resolve(__dirname, 'build', 'Release', 'better_sqlite3.node'), path.resolve(process.cwd(), 'build', 'Release', 'better_sqlite3.node')];
  for (const candidatePath of runtimeCandidatePaths) {
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  try {
    return require.resolve('better-sqlite3/build/Release/better_sqlite3.node');
  } catch {
    return null;
  }
}
function getSQLiteCacheSizeKb(options) {
  const rawValue = options.cacheSizeKb;
  if (rawValue === undefined || rawValue === null) {
    return DEFAULT_SQLITE_CACHE_SIZE_KB;
  }
  const cacheSizeKb = Number(rawValue);
  if (!Number.isFinite(cacheSizeKb) || cacheSizeKb <= 0) {
    return DEFAULT_SQLITE_CACHE_SIZE_KB;
  }
  return Math.trunc(cacheSizeKb);
}
const parseJSONContainer = (value, fallbackContainer) => {
  try {
    const parsedValue = typeof value === 'string' ? JSON.parse(value) : value;
    if (Array.isArray(parsedValue) || parsedValue && typeof parsedValue === 'object') {
      return parsedValue;
    }
  } catch {
    /* */
  }
  return fallbackContainer;
};
const parseJSONValue = value => {
  if (value === undefined) {
    return undefined;
  }
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return value;
  }
};
const createMissingNestedContainer = nextComponent => isNumericArrayIndexComponent(nextComponent) ? [] : {};
const getContainerEntry = (container, component) => {
  if (Array.isArray(container) && isNumericArrayIndexComponent(component)) {
    return container[Number(component)];
  }
  if (container && typeof container === 'object') {
    return container[component];
  }
  return undefined;
};
const setContainerEntry = (container, component, value) => {
  if (Array.isArray(container) && isNumericArrayIndexComponent(component)) {
    const index = Number(component);
    while (container.length < index) {
      container.push(null);
    }
    container[index] = value;
    return;
  }
  container[component] = value;
};
const removeContainerEntry = (container, component) => {
  if (Array.isArray(container) && isNumericArrayIndexComponent(component)) {
    const index = Number(component);
    if (index >= 0 && index < container.length) {
      // Preserve dotted array positions; Delete should clear the slot, not compact the array.
      container[index] = null;
    }
    return;
  }
  if (container && typeof container === 'object') {
    delete container[component];
  }
};
const ensureNestedContainer = (container, component, nextComponent) => {
  let entry = getContainerEntry(container, component);
  if (Array.isArray(entry) || entry && typeof entry === 'object') {
    return entry;
  }
  entry = createMissingNestedContainer(nextComponent);
  setContainerEntry(container, component, entry);
  return entry;
};
const applyDynamicPathMutation = (rootContainer, pathComponents, operation, rawValue) => {
  if (!Array.isArray(pathComponents) || pathComponents.length === 0) {
    return rootContainer;
  }
  let currentContainer = rootContainer;
  for (let index = 0; index < pathComponents.length - 1; index += 1) {
    currentContainer = ensureNestedContainer(currentContainer, pathComponents[index], pathComponents[index + 1]);
  }
  const targetComponent = pathComponents[pathComponents.length - 1];
  const currentValue = getContainerEntry(currentContainer, targetComponent);
  switch (operation) {
    case 'Delete':
      removeContainerEntry(currentContainer, targetComponent);
      return rootContainer;
    case 'Increment':
      {
        const baseValue = currentValue == null ? 0 : Number(currentValue);
        const amount = Number(rawValue);
        setContainerEntry(currentContainer, targetComponent, (Number.isFinite(baseValue) ? baseValue : 0) + (Number.isFinite(amount) ? amount : 0));
        return rootContainer;
      }
    case 'Add':
      {
        const targetArray = Array.isArray(currentValue) ? currentValue : [];
        const items = Array.isArray(rawValue) ? rawValue : [];
        setContainerEntry(currentContainer, targetComponent, targetArray.concat(items));
        return rootContainer;
      }
    case 'AddUnique':
      {
        const targetArray = Array.isArray(currentValue) ? currentValue : [];
        const items = Array.isArray(rawValue) ? rawValue : [];
        const nextArray = targetArray.slice();
        const seenValues = new Set(nextArray.map(item => canonicalJSONStringify(item)));
        for (const item of items) {
          const serializedItem = canonicalJSONStringify(item);
          if (!seenValues.has(serializedItem)) {
            seenValues.add(serializedItem);
            nextArray.push(item);
          }
        }
        setContainerEntry(currentContainer, targetComponent, nextArray);
        return rootContainer;
      }
    case 'Remove':
      {
        const targetArray = Array.isArray(currentValue) ? currentValue : [];
        const items = Array.isArray(rawValue) ? rawValue : [];
        const removeSet = new Set(items.map(item => canonicalJSONStringify(item)));
        setContainerEntry(currentContainer, targetComponent, targetArray.filter(item => !removeSet.has(canonicalJSONStringify(item))));
        return rootContainer;
      }
    case 'Set':
    default:
      setContainerEntry(currentContainer, targetComponent, rawValue);
      return rootContainer;
  }
};
function createClient(options) {
  const filename = options.filename || ':memory:';
  const dbOptions = {
    fileMustExist: options.fileMustExist || false,
    timeout: options.timeout ?? 5000,
    verbose: options.verbose || null
  };
  const nativeBindingPath = resolveBetterSQLiteNativeBindingPath();
  if (nativeBindingPath) {
    // Linux bundled runs can lose the right caller frame for `bindings()`. Hand the addon path in directly.
    dbOptions.nativeBinding = nativeBindingPath;
  }
  const cacheSizeKb = getSQLiteCacheSizeKb(options);
  const db = new Database(filename, dbOptions);

  // Performance Pragmas
  if (filename !== ':memory:' && !filename.includes('mode=memory')) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  // Keep the default cache modest for small Parse installs; callers can raise it.
  db.pragma(`cache_size = -${cacheSizeKb}`);
  db.pragma('foreign_keys = ON');
  // Reuse compiled regexes for a query's repeated row-level UDF calls.
  const maxCompiledRegexCacheSize = 256;
  const compiledRegexCache = new Map();
  const getCompiledRegex = (pattern, flags) => {
    const normalizedRegex = normalizeRegexPattern(String(pattern), flags ? String(flags) : '');
    const cacheKey = `${normalizedRegex.flags}\u0000${normalizedRegex.pattern}`;
    let compiledRegex = compiledRegexCache.get(cacheKey);
    if (compiledRegex) {
      compiledRegexCache.delete(cacheKey);
      compiledRegexCache.set(cacheKey, compiledRegex);
      return compiledRegex;
    }
    compiledRegex = new RegExp(normalizedRegex.pattern, normalizedRegex.flags);
    if (compiledRegexCache.size >= maxCompiledRegexCacheSize) {
      const oldestCacheKey = compiledRegexCache.keys().next().value;
      if (oldestCacheKey !== undefined) {
        compiledRegexCache.delete(oldestCacheKey);
      }
    }
    compiledRegexCache.set(cacheKey, compiledRegex);
    return compiledRegex;
  };

  // Register REGEXP function for SQLite `REGEXP` operator
  db.function('regexp', {
    deterministic: true
  }, (pattern, text) => {
    if (pattern == null || text == null) {
      return 0;
    }
    try {
      return getCompiledRegex(pattern).test(String(text)) ? 1 : 0;
    } catch {
      return 0;
    }
  });

  // Register REGEXP_WITH_FLAGS function for `$options: 'i'` queries
  db.function('regexp_flags', {
    deterministic: true
  }, (pattern, flags, text) => {
    if (pattern == null || text == null) {
      return 0;
    }
    try {
      return getCompiledRegex(pattern, flags).test(String(text)) ? 1 : 0;
    } catch {
      return 0;
    }
  });

  // Geo distance function (returns distance in radians)
  db.function('parse_geo_distance', {
    deterministic: true
  }, (lat1, lng1, lat2, lng2) => {
    if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) {
      return null;
    }
    const rad = d => d * Math.PI / 180;
    const rLat1 = rad(Number(lat1));
    const rLat2 = rad(Number(lat2));
    const rLng1 = rad(Number(lng1));
    const rLng2 = rad(Number(lng2));
    const dLat = rLat2 - rLat1;
    const dLng = rLng2 - rLng1;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return c;
  });

  // Geo within box function
  db.function('parse_within_box', {
    deterministic: true
  }, (lat, lng, swLat, swLng, neLat, neLng) => {
    if (lat == null || lng == null || swLat == null || swLng == null || neLat == null || neLng == null) {
      return 0;
    }
    lat = Number(lat);
    lng = Number(lng);
    swLat = Number(swLat);
    swLng = Number(swLng);
    neLat = Number(neLat);
    neLng = Number(neLng);
    const minLat = Math.min(swLat, neLat);
    const maxLat = Math.max(swLat, neLat);
    const minLng = Math.min(swLng, neLng);
    const maxLng = Math.max(swLng, neLng);
    return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng ? 1 : 0;
  });

  // Geo point in polygon function
  db.function('parse_within_polygon', {
    deterministic: true
  }, (lat, lng, polygonJson) => {
    if (lat == null || lng == null || !polygonJson) {
      return 0;
    }
    lat = Number(lat);
    lng = Number(lng);
    let coords;
    try {
      coords = typeof polygonJson === 'string' ? JSON.parse(polygonJson) : polygonJson;
      if (coords.__type === 'Polygon') {
        coords = coords.coordinates;
      }
    } catch {
      return 0;
    }
    if (!Array.isArray(coords) || coords.length === 0) {
      return 0;
    }
    const normalizeCoordinate = coordinate => {
      if (Array.isArray(coordinate) && coordinate.length === 2) {
        const latitude = Number(coordinate[0]);
        const longitude = Number(coordinate[1]);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          return [latitude, longitude];
        }
        return null;
      }
      if (coordinate && typeof coordinate === 'object') {
        const latitude = Number(coordinate.latitude);
        const longitude = Number(coordinate.longitude);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          return [latitude, longitude];
        }
      }
      return null;
    };
    const normalizedCoords = [];
    for (const coordinate of coords) {
      const normalizedCoordinate = normalizeCoordinate(coordinate);
      if (!normalizedCoordinate) {
        return 0;
      }
      normalizedCoords.push(normalizedCoordinate);
    }
    coords = normalizedCoords;
    const isSameCoordinate = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === 2 && right.length === 2 && Number(left[0]) === Number(right[0]) && Number(left[1]) === Number(right[1]);
    if (coords.length > 1 && isSameCoordinate(coords[0], coords[coords.length - 1])) {
      coords = coords.slice(0, -1);
    }
    if (coords.length < 3) {
      return 0;
    }
    const isPointOnSegment = (px, py, ax, ay, bx, by) => {
      const epsilon = 1e-10;
      const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
      if (Math.abs(cross) > epsilon) {
        return false;
      }
      const dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay);
      if (dot < -epsilon) {
        return false;
      }
      const squaredLength = (bx - ax) ** 2 + (by - ay) ** 2;
      if (dot - squaredLength > epsilon) {
        return false;
      }
      return true;
    };
    let inside = false;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      const p1 = coords[i];
      const p2 = coords[j];
      const xi = p1[0];
      const yi = p1[1];
      const xj = p2[0];
      const yj = p2[1];
      if (isPointOnSegment(lat, lng, xi, yi, xj, yj)) {
        return 1;
      }
      const intersect = yi > lng !== yj > lng && lat < (xj - xi) * (lng - yi) / (yj - yi) + xi;
      if (intersect) {
        inside = !inside;
      }
    }
    return inside ? 1 : 0;
  });
  db.function('parse_array_add_unique', {
    deterministic: true
  }, (targetStr, itemsStr) => {
    const target = parseJSONArray(targetStr);
    const items = parseJSONArray(itemsStr);

    // Normalize object key order once so equality behaves consistently.
    const targetSet = new Set(target.map(item => canonicalJSONStringify(item)));
    for (const item of items) {
      const serializedItem = canonicalJSONStringify(item);
      if (!targetSet.has(serializedItem)) {
        targetSet.add(serializedItem);
        target.push(item);
      }
    }
    return JSON.stringify(target);
  });
  db.function('parse_array_remove', {
    deterministic: true
  }, (targetStr, itemsStr) => {
    const target = parseJSONArray(targetStr);
    const items = parseJSONArray(itemsStr);
    const removeSet = new Set(items.map(item => canonicalJSONStringify(item)));
    const result = target.filter(item => !removeSet.has(canonicalJSONStringify(item)));
    return JSON.stringify(result);
  });

  // Numeric dot-path segments are ambiguous in Parse syntax. Resolve them against
  // the runtime parent container type for writes instead of relying on root-name heuristics.
  db.function('parse_json_apply_path_mutation', {
    deterministic: true
  }, (targetStr, pathStr, operation, valueStr) => {
    const pathComponents = parseJSONValue(pathStr);
    const rootContainer = parseJSONContainer(targetStr, isNumericArrayIndexComponent(pathComponents && pathComponents[0]) ? [] : {});
    const nextValue = applyDynamicPathMutation(rootContainer, Array.isArray(pathComponents) ? pathComponents : [], String(operation), parseJSONValue(valueStr));
    return JSON.stringify(nextValue);
  });
  return db;
}
module.exports = {
  createClient
};