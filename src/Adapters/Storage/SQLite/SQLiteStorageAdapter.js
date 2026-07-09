// @flow
import { StorageAdapter } from '../StorageAdapter';
import type { SchemaType, QueryType, QueryOptions } from '../StorageAdapter';
import { createClient } from './SQLiteClient';
import { getDatabaseOptionsFromURI } from './SQLiteConfigParser';
import PostgresStorageAdapter from '../Postgres/PostgresStorageAdapter';
import RestQuery from '../../../RestQuery';
import Parse from 'parse/node';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EJSON } from 'bson';
import Utils from '../../../Utils';
import { createSanitizedError } from '../../../Error';
import logger from '../../../logger';
const {
  getRegexLeadingLiteralSetInfo,
  getSimpleNormalizedRegexInfo,
  getRegexPrefixPrefilterInfo,
  isNumericArrayIndexComponent,
  normalizeRegexPattern,
} = require('./SQLiteUtils');

const defaultCLPS = Object.freeze({
  ACL: {
    '*': {
      read: true,
      write: true,
    },
  },
  find: { '*': true },
  count: { '*': true },
  get: { '*': true },
  create: { '*': true },
  update: { '*': true },
  delete: { '*': true },
  addField: { '*': true },
  protectedFields: { '*': [] },
});

const emptyCLPS = Object.freeze({
  find: {},
  count: {},
  get: {},
  create: {},
  update: {},
  delete: {},
  addField: {},
  protectedFields: {},
});

const internalClasses = new Set([
  '_GlobalConfig',
  '_GraphQLConfig',
  '_PushStatus',
  '_JobStatus',
  '_JobSchedule',
  '_Hooks',
  '_Audience',
  '_Idempotency',
]);

const aggregateHiddenFieldNames = new Set([
  '_hashed_password',
  '_rperm',
  '_wperm',
  '_acl',
  '_session_token',
  '_email_verify_token',
  '_perishable_token',
  '_perishable_token_expires_at',
  '_password_changed_at',
  '_tombstone',
  '_email_verify_token_expires_at',
  '_account_lockout_expires_at',
  '_failed_login_count',
  '_password_history',
]);

const aggregateDateMatchOperators = new Set([
  '$eq',
  '$ne',
  '$lt',
  '$lte',
  '$gt',
  '$gte',
  '$in',
  '$nin',
  '$all',
  '$exists',
]);
const sqliteShutdownDrainDelayMs = Math.max(
  0,
  Number.parseInt(process.env.PARSE_SQLITE_SHUTDOWN_DRAIN_MS || '2', 10) || 0
);
const nullFieldTrackerColumn = '_nullFields';
// Hidden write-order tie-breaker for Parse timestamps, which are only
// millisecond-precision once serialized for storage.
const writeSequenceColumn = '_writeSeq';
const sqliteEncodedTableNamePrefix = '__psa__';
const sqliteArrayIndexTableNamePrefix = '__arridx__';
const authDataFieldPrefix = '_auth_data_';
const arrayIndexValueTypeColumn = 'valueType';
const arrayIndexValueColumn = 'value';
const sqliteIndexedArrayScalarTypeNames = Object.freeze([
  'text',
  'integer',
  'real',
  'true',
  'false',
  'null',
]);
const sqliteIndexedArrayScalarTypeNameSQL = sqliteIndexedArrayScalarTypeNames
  .map(typeName => `'${typeName}'`)
  .join(', ');
const implicitSQLiteUserColumnFields = Object.freeze({
  _hashed_password: { type: 'String' },
  _password_history: { type: 'Array' },
  _email_verify_token_expires_at: { type: 'String' },
  _email_verify_token: { type: 'String' },
  _account_lockout_expires_at: { type: 'String' },
  _failed_login_count: { type: 'Number' },
  _perishable_token: { type: 'String' },
  _perishable_token_expires_at: { type: 'String' },
  _password_changed_at: { type: 'String' },
  authData: { type: 'Object' },
});
const hiddenUserSchemaFields = new Set([
  '_hashed_password',
  '_password_history',
  '_email_verify_token_expires_at',
  '_email_verify_token',
  '_account_lockout_expires_at',
  '_failed_login_count',
  '_perishable_token',
  '_perishable_token_expires_at',
  '_password_changed_at',
]);
const userDateLikeStringFields = new Set([
  '_email_verify_token_expires_at',
  '_account_lockout_expires_at',
  '_perishable_token_expires_at',
  '_password_changed_at',
]);

const isAdapterInternalColumn = (fieldName: string): boolean =>
  fieldName === nullFieldTrackerColumn || fieldName === writeSequenceColumn;

const getAuthDataProviderFieldName = (fieldName: string): ?string => {
  if (typeof fieldName !== 'string' || !fieldName.startsWith(authDataFieldPrefix)) {
    return null;
  }
  const provider = fieldName.slice(authDataFieldPrefix.length);
  if (!provider) {
    return null;
  }
  for (let i = 0; i < provider.length; i += 1) {
    const code = provider.charCodeAt(i);
    const isNumeric = code >= 48 && code <= 57;
    const isUpperAlpha = code >= 65 && code <= 90;
    const isLowerAlpha = code >= 97 && code <= 122;
    if (!(isNumeric || isUpperAlpha || isLowerAlpha || code === 95)) {
      return null;
    }
  }
  return provider;
};

const partitionFlattenedConstraintValues = (
  values: Array<any>
): { hasAny: boolean, hasNull: boolean, nonNulls: Array<any> } => {
  const nonNulls = [];
  let hasAny = false;
  let hasNull = false;

  for (const value of values) {
    if (Array.isArray(value)) {
      for (const nestedValue of value) {
        hasAny = true;
        if (nestedValue === null) {
          hasNull = true;
        } else {
          nonNulls.push(nestedValue);
        }
      }
    } else {
      hasAny = true;
      if (value === null) {
        hasNull = true;
      } else {
        nonNulls.push(value);
      }
    }
  }

  return { hasAny, hasNull, nonNulls };
};

const temporarySQLiteDirectories = new Set();
let sharedMemorySQLiteDatabase;
const unsafeRestQuery = RestQuery && RestQuery._UnsafeRestQuery;
const originalUnsafeRestQueryHandleInclude =
  unsafeRestQuery && unsafeRestQuery.prototype ? unsafeRestQuery.prototype.handleInclude : null;
let sqliteHandleIncludePatchRefCount = 0;
let patchedSQLiteHandleInclude;

const cloneRestResponseResults = results => {
  if (typeof structuredClone === 'function') {
    return structuredClone(results);
  }
  return JSON.parse(JSON.stringify(results));
};

const applySQLiteHandleIncludePatch = () => {
  if (!unsafeRestQuery || !originalUnsafeRestQueryHandleInclude) {
    return;
  }
  if (sqliteHandleIncludePatchRefCount === 0) {
    patchedSQLiteHandleInclude = async function handleIncludeSerially() {
      if (this.include.length == 0) {
        return;
      }

      const indexedResults = this.response.results.reduce((indexed, result, i) => {
        indexed[result.objectId] = i;
        return indexed;
      }, {});

      const executionTree = {};
      this.include.forEach(path => {
        let current = executionTree;
        path.forEach(node => {
          if (!current[node]) {
            current[node] = {
              path,
              children: {},
            };
          }
          current = current[node].children;
        });
      });

      const runSingleIncludePath = async path => {
        const isolatedQuery = {
          include: [path],
          response: {
            ...this.response,
            results: cloneRestResponseResults(this.response.results),
          },
          config: this.config,
          auth: this.auth,
          context: this.context,
          restOptions: this.restOptions,
        };
        await originalUnsafeRestQueryHandleInclude.call(isolatedQuery);
        return isolatedQuery.response;
      };

      const recursiveExecutionTree = async treeNode => {
        const { path, children } = treeNode;
        const newResponse = await runSingleIncludePath(path);
        newResponse.results.forEach(newObject => {
          if (Object.prototype.hasOwnProperty.call(newObject, path[0])) {
            this.response.results[indexedResults[newObject.objectId]][path[0]] = newObject[path[0]];
          }
        });
        for (const child of Object.values(children)) {
          await recursiveExecutionTree(child);
        }
      };

      for (const root of Object.values(executionTree)) {
        await recursiveExecutionTree(root);
      }
      this.include = [];
    };
    unsafeRestQuery.prototype.handleInclude = patchedSQLiteHandleInclude;
  }
  sqliteHandleIncludePatchRefCount += 1;
};

const createClosedSQLiteStatement = () => ({
  // After Parse Server begins shutdown some late async callbacks may still
  // probe storage. Returning empty results here lets teardown finish cleanly
  // instead of crashing on `null.prepare`.
  all() {
    return [];
  },
  get() {
    return undefined;
  },
  run() {
    return {
      changes: 0,
      lastInsertRowid: 0,
    };
  },
});

const releaseSQLiteHandleIncludePatch = () => {
  if (!unsafeRestQuery || !originalUnsafeRestQueryHandleInclude || sqliteHandleIncludePatchRefCount === 0) {
    return;
  }
  sqliteHandleIncludePatchRefCount -= 1;
  if (sqliteHandleIncludePatchRefCount === 0) {
    if (unsafeRestQuery.prototype.handleInclude === patchedSQLiteHandleInclude) {
      unsafeRestQuery.prototype.handleInclude = originalUnsafeRestQueryHandleInclude;
    }
    patchedSQLiteHandleInclude = null;
  }
};

const cleanupTemporarySQLiteDirectories = () => {
  for (const directory of temporarySQLiteDirectories) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
  temporarySQLiteDirectories.clear();
};

process.once('exit', cleanupTemporarySQLiteDirectories);

const createTemporarySQLiteDatabasePath = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parse-server-sqlite-'));
  temporarySQLiteDirectories.add(directory);
  return {
    directory,
    filename: path.join(directory, 'sqlite.db'),
  };
};

const getSharedMemorySQLiteDatabasePath = () => {
  if (!sharedMemorySQLiteDatabase) {
    sharedMemorySQLiteDatabase = {
      ...createTemporarySQLiteDatabasePath(),
      refCount: 0,
    };
  }
  sharedMemorySQLiteDatabase.refCount += 1;
  return sharedMemorySQLiteDatabase;
};

const releaseSharedMemorySQLiteDatabasePath = () => {
  if (!sharedMemorySQLiteDatabase) {
    return;
  }
  sharedMemorySQLiteDatabase.refCount = Math.max(0, sharedMemorySQLiteDatabase.refCount - 1);
  if (sharedMemorySQLiteDatabase.refCount > 0) {
    return;
  }

  const { directory } = sharedMemorySQLiteDatabase;
  temporarySQLiteDirectories.delete(directory);
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    /* */
  }
  sharedMemorySQLiteDatabase = null;
};

const isJoinTableClass = className =>
  typeof className === 'string' && className.indexOf('_Join:') === 0;

const isSQLiteInternalClass = (className: string): boolean =>
  internalClasses.has(className) || isJoinTableClass(className);

const getImplicitHiddenUserFieldSchema = (className: string, fieldName: string): ?any =>
  className === '_User' && hiddenUserSchemaFields.has(fieldName)
    ? implicitSQLiteUserColumnFields[fieldName]
    : undefined;

const defaultSchemaIndexFields = new Set(['_id', 'objectId', 'createdAt', 'updatedAt']);

const buildDefaultSchemaIndexes = () => ({
  _id_: { _id: 1 },
});

const encodeSQLiteTableNameToken = (className: string): string =>
  Buffer.from(className, 'utf8').toString('base64url');

const encodeSQLiteFieldToken = (fieldName: string): string =>
  Buffer.from(fieldName, 'utf8').toString('base64url');

const decodeSQLiteTableNameToken = (token: string): ?string => {
  try {
    return Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
};

const cloneIndexDefinition = index =>
  Object.keys(index || {}).reduce((output, key) => {
    output[key] = index[key];
    return output;
  }, {});

const buildAutomaticIndexName = index =>
  Object.entries(index)
    .map(([fieldName, direction]) =>
      `${fieldName}_${String(direction).replace(/[^A-Za-z0-9_]+/g, '_')}`
    )
    .join('_');

const isTextIndexDefinition = index => {
  const values = Object.values(index || {});
  return values.length > 0 && values.every(value => value === 'text');
};

const isUniqueConstraintError = err =>
  err &&
  (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    err.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    (err.message && err.message.includes('UNIQUE constraint failed')));

const buildDuplicateKeyLogMessage = (tableName, err) => {
  const expressionIndexMatch =
    err && err.message && err.message.match(/UNIQUE constraint failed:\s+index '([^']+)'/);
  if (expressionIndexMatch) {
    return `E11000 duplicate key error collection: ${tableName} index: ${expressionIndexMatch[1]} dup key`;
  }
  const uniqueMatch = err && err.message && err.message.match(/UNIQUE constraint failed:\s+(.+)/);
  if (!uniqueMatch) {
    return `E11000 duplicate key error collection: ${tableName}`;
  }
  const fields = uniqueMatch[1]
    .split(',')
    .map(field => field.trim().split('.').pop())
    .filter(Boolean);
  const indexName = fields.length > 0 ? `${fields.join('_')}_1` : 'unknown_1';
  return `E11000 duplicate key error collection: ${tableName} index: ${indexName} dup key`;
};

const getDuplicatedFieldFromUniqueConstraint = (className: string, err: any): ?string => {
  const message = (err && err.message) || '';
  const authDataMatch = message.match(/index '_User_unique_authData_([a-zA-Z0-9_]+)_id'/);
  if (className === '_User' && authDataMatch) {
    return `_auth_data_${authDataMatch[1]}`;
  }

  const uniqueMatch = message.match(/UNIQUE constraint failed:\s+(.+)/);
  if (!uniqueMatch) {
    return null;
  }
  const fields = uniqueMatch[1]
    .split(',')
    .map(field => field.trim().split('.').pop())
    .filter(Boolean);
  if (fields.length === 1) {
    return fields[0];
  }
  return null;
};

const toParseSchema = schema => {
  if (!schema) {
    return schema;
  }
  const fields = { ...((schema && schema.fields) || {}) };
  if (schema.className === '_User') {
    delete fields._hashed_password;
  }
  delete fields._wperm;
  delete fields._rperm;
  delete fields[nullFieldTrackerColumn];
  delete fields[writeSequenceColumn];

  let clps = defaultCLPS;
  if (schema.classLevelPermissions) {
    clps = { ...emptyCLPS, ...schema.classLevelPermissions };
  }

  const parseSchema = {
    className: schema.className,
    fields,
    classLevelPermissions: clps,
  };

  if (schema.indexes && Object.keys(schema.indexes).length > 0) {
    parseSchema.indexes = { ...schema.indexes };
  }

  return parseSchema;
};

const normalizeSchemaFieldDefinition = field => {
  if (!field || typeof field !== 'object' || Array.isArray(field)) {
    return field;
  }
  const normalizedField = { ...field };
  if (normalizedField.__type && !normalizedField.type) {
    normalizedField.type = normalizedField.__type;
  }
  delete normalizedField.__type;
  if (normalizedField.contents) {
    normalizedField.contents = normalizeSchemaFieldDefinition(normalizedField.contents);
  }
  return normalizedField;
};

const normalizeStoredSchemaObject = (className, schema) => {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }
  const normalizedSchema = {
    ...schema,
    className: className || schema.className,
  };
  const fields = { ...((schema && schema.fields) || {}) };
  for (const fieldName in fields) {
    if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) {
      continue;
    }
    fields[fieldName] = normalizeSchemaFieldDefinition(fields[fieldName]);
  }
  normalizedSchema.fields = fields;
  return normalizedSchema;
};

const toSQLiteSchema = schema => {
  if (!schema) {
    return schema;
  }
  schema.fields = schema.fields || {};
  if (!isJoinTableClass(schema.className)) {
    schema.fields._wperm = { type: 'Array', contents: { type: 'String' } };
    schema.fields._rperm = { type: 'Array', contents: { type: 'String' } };
  }
  if (schema.className === '_User') {
    for (const fieldName in implicitSQLiteUserColumnFields) {
      if (!Object.prototype.hasOwnProperty.call(implicitSQLiteUserColumnFields, fieldName)) {
        continue;
      }
      schema.fields[fieldName] = { ...implicitSQLiteUserColumnFields[fieldName] };
    }
  }
  return schema;
};

const normalizeSQLiteSchema = (className, schema) =>
  toSQLiteSchema({
    ...normalizeStoredSchemaObject(className, {
      ...(schema || {}),
      className,
      fields: {
        ...((schema && schema.fields) || {}),
      },
    }),
  });

const normalizeStorageFieldName = (fieldName: string): string => {
  if (fieldName === '_id') {
    return 'objectId';
  }
  if (fieldName === '_created_at') {
    return 'createdAt';
  }
  if (fieldName === '_updated_at') {
    return 'updatedAt';
  }
  return fieldName;
};

const parseTypeToSQLiteType = (type: any) => {
  if (!type) {
    return 'TEXT';
  }
  const typeName = typeof type === 'object' ? type.type : type;
  switch (typeName) {
    case 'String':
    case 'Date':
    case 'Object':
    case 'File':
    case 'Pointer':
    case 'GeoPoint':
    case 'Bytes':
    case 'Polygon':
    case 'Array':
    case 'Relation':
      return 'TEXT';
    case 'Boolean':
    case 'Number':
      return typeName === 'Boolean' ? 'INTEGER' : 'REAL';
    default:
      return 'TEXT';
  }
};

const inferFieldType = (key: string, value: any) => {
  if (key === 'authData') {
    return { type: 'Object' };
  }
  if (value && typeof value === 'object') {
    if (value.__type === 'Pointer') {
      return { type: 'Pointer', targetClass: value.className };
    }
    if (value.__type === 'Date' || Utils.isDate(value)) {
      return { type: 'Date' };
    }
    if (value.__type === 'File') {
      return { type: 'File' };
    }
    if (value.__type === 'GeoPoint') {
      return { type: 'GeoPoint' };
    }
    if (value.__type === 'Polygon') {
      return { type: 'Polygon' };
    }
    if (value.__type === 'Relation') {
      return { type: 'Relation', targetClass: value.className };
    }
    if (Array.isArray(value)) {
      return { type: 'Array' };
    }
    return { type: 'Object' };
  }
  if (typeof value === 'boolean') {
    return { type: 'Boolean' };
  }
  if (typeof value === 'number') {
    return { type: 'Number' };
  }
  return { type: 'String' };
};

const isSamePolygonCoordinate = (left: any, right: any) =>
  Array.isArray(left) &&
  Array.isArray(right) &&
  left.length === 2 &&
  right.length === 2 &&
  left[0] === right[0] &&
  left[1] === right[1];

const normalizePolygonCoordinates = (coordinates: any) => {
  if (!Array.isArray(coordinates) || coordinates.length < 3) {
    throw new Parse.Error(Parse.Error.INVALID_JSON, 'Polygon must have at least 3 values');
  }

  const normalizedCoordinates = coordinates.map(point => {
    if (!Array.isArray(point) || point.length !== 2) {
      throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad polygon value');
    }
    const latitude = Number(point[0]);
    const longitude = Number(point[1]);
    Parse.GeoPoint._validate(latitude, longitude);
    return [latitude, longitude];
  });

  if (
    !isSamePolygonCoordinate(
      normalizedCoordinates[0],
      normalizedCoordinates[normalizedCoordinates.length - 1]
    )
  ) {
    normalizedCoordinates.push([...normalizedCoordinates[0]]);
  }

  const uniqueCoordinates = normalizedCoordinates.filter((point, index, allPoints) => {
    return allPoints.findIndex(candidate => isSamePolygonCoordinate(candidate, point)) === index;
  });

  if (uniqueCoordinates.length < 3) {
    throw new Parse.Error(
      Parse.Error.INTERNAL_SERVER_ERROR,
      'GeoJSON: Loop must have at least 3 different vertices'
    );
  }

  return normalizedCoordinates;
};

const normalizePolygonValue = (value: any) => {
  if (!value || typeof value !== 'object' || value.__type !== 'Polygon') {
    return value;
  }

  return {
    ...value,
    coordinates: normalizePolygonCoordinates(value.coordinates),
  };
};

const normalizeStoredPolygonValue = (value: any) => {
  try {
    return normalizePolygonValue(value);
  } catch {
    return value;
  }
};

const normalizeGeoWithinPolygonValue = (polygon: any) => {
  if (polygon && typeof polygon === 'object' && polygon.__type === 'Polygon') {
    return {
      __type: 'Polygon',
      coordinates: normalizePolygonCoordinates(polygon.coordinates),
    };
  }

  if (!Array.isArray(polygon)) {
    throw new Parse.Error(
      Parse.Error.INVALID_JSON,
      "bad $geoWithin value; $polygon should be Polygon object or Array of Parse.GeoPoint's"
    );
  }

  if (polygon.length < 3) {
    throw new Parse.Error(
      Parse.Error.INVALID_JSON,
      'bad $geoWithin value; $polygon should contain at least 3 GeoPoints'
    );
  }

  return {
    __type: 'Polygon',
    coordinates: normalizePolygonCoordinates(
      polygon.map(point => {
        if (Array.isArray(point) && point.length === 2) {
          Parse.GeoPoint._validate(point[0], point[1]);
          return [Number(point[0]), Number(point[1])];
        }
        if (!isGeoPointValue(point)) {
          throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $geoWithin value');
        }
        Parse.GeoPoint._validate(point.latitude, point.longitude);
        return [Number(point.latitude), Number(point.longitude)];
      })
    ),
  };
};

const stringifySQLiteJSONValue = (value: any) =>
  JSON.stringify(value, (_key, currentValue) => {
    if (currentValue === undefined) {
      return null;
    }
    if (currentValue && typeof currentValue === 'object' && currentValue.__type === 'Polygon') {
      return normalizePolygonValue(currentValue);
    }
    if (
      currentValue &&
      typeof currentValue === 'object' &&
      currentValue.__type === 'Date' &&
      Utils.isDate(currentValue.iso)
    ) {
      return {
        ...currentValue,
        iso: currentValue.iso.toISOString(),
      };
    }
    return currentValue;
  });

const toSQLiteValue = (value: any) => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'object') {
    if (value.__type === 'Date') {
      if (value.iso === undefined || value.iso === null) {
        return null;
      }
      if (Utils.isDate(value.iso)) {
        return value.iso.toISOString();
      }
      return value.iso;
    }
    if (Utils.isDate(value)) {
      return value.toISOString();
    }
    if (value.__type === 'File') {
      return value.name;
    }
    if (value.__type === 'Pointer') {
      return value.objectId == null ? null : value.objectId;
    }
    if (value.__type === 'Bytes') {
      return stringifySQLiteJSONValue(value);
    }
    if (value.__type === 'GeoPoint') {
      return stringifySQLiteJSONValue(value);
    }
    if (value.__type === 'Polygon') {
      return stringifySQLiteJSONValue(value);
    }
    return stringifySQLiteJSONValue(value);
  }
  return value;
};

const shouldTrackCoercedNullStorageValue = (value: any, sqliteValue: any): boolean => {
  if (sqliteValue !== null) {
    return false;
  }
  if (value === null) {
    return true;
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (value.__type === 'Pointer') {
    return value.objectId == null;
  }
  if (value.__type === 'Date') {
    return value.iso == null;
  }
  return false;
};

const getUpdateValueForSchemaInference = (fieldName: string, fieldValue: any): any => {
  if (fieldValue === null || typeof fieldValue === 'undefined') {
    return undefined;
  }
  if (fieldName === 'authData') {
    return fieldValue;
  }
  if (!fieldValue || typeof fieldValue !== 'object' || Array.isArray(fieldValue)) {
    return fieldValue;
  }
  switch (fieldValue.__op) {
    case 'Increment':
      return fieldValue.amount;
    case 'Add':
    case 'AddUnique':
    case 'Remove':
      return fieldValue.objects;
    case 'Delete':
      return undefined;
    default:
      return fieldValue;
  }
};

const shouldTrackExplicitNullFields = (className: string): boolean =>
  className !== '_SCHEMA' && !isJoinTableClass(className);

const shouldPersistExplicitNullField = (className: string, fieldName: string): boolean =>
  shouldTrackExplicitNullFields(className) &&
  !(className === '_Session' && fieldName === 'expiresAt');

const parseTrackedNullFields = (value: any): Set<string> => {
  if (typeof value !== 'string' || value.length === 0) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(value);
    return new Set(Array.isArray(parsed) ? parsed.filter(field => typeof field === 'string') : []);
  } catch {
    return new Set();
  }
};

const getExplicitNullFieldMatchExpression = (fieldName: string): { sql: string, params: Array<any> } => ({
  sql:
    `EXISTS (` +
    `SELECT 1 FROM json_each(COALESCE(${quoteColumnName(nullFieldTrackerColumn)}, '[]')) ` +
    `WHERE json_each.value = ?` +
    `)`,
  params: [fieldName],
});

const waitForNextEventLoopTurn = (() => {
  let postMessageToNextTurn;
  if (typeof MessageChannel === 'function') {
    let pendingResolvers = [];
    let pendingResolverHead = 0;
    const { port1, port2 } = new MessageChannel();
    if (typeof port1.unref === 'function') {
      port1.unref();
    }
    if (typeof port2.unref === 'function') {
      port2.unref();
    }
    port1.onmessage = () => {
      const resolve = pendingResolvers[pendingResolverHead];
      if (resolve) {
        pendingResolvers[pendingResolverHead] = undefined;
        pendingResolverHead += 1;
        if (pendingResolverHead > 1024 && pendingResolverHead * 2 >= pendingResolvers.length) {
          pendingResolvers = pendingResolvers.slice(pendingResolverHead);
          pendingResolverHead = 0;
        }
        resolve();
      }
    };
    postMessageToNextTurn = () =>
      new Promise(resolve => {
        pendingResolvers.push(resolve);
        port2.postMessage(null);
      });
  } else {
    postMessageToNextTurn = () =>
      new Promise(resolve => {
        setImmediate(resolve);
      });
  }

  return () => postMessageToNextTurn();
})();

const shouldYieldBeforeTopLevelSQLiteOperation = (transactionalSession?: any): boolean =>
  !(transactionalSession && typeof transactionalSession.prepare === 'function');

const shouldIgnoreSQLiteOperationAfterShutdown = (dbHandle: any, isShutDown: boolean): boolean =>
  !dbHandle && isShutDown;

const waitForSQLiteShutdownDrainWindow = async () => {
  if (sqliteShutdownDrainDelayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, sqliteShutdownDrainDelayMs));
  } else {
    await new Promise(resolve => setImmediate(resolve));
  }
};

const toSQLiteJSONObjectValue = (value: any) => stringifySQLiteJSONValue(value);

const sqliteValueToParseValue = (value: any, type: any) => {
  if (value === null || value === undefined) {
    return null;
  }
  const typeName = typeof type === 'object' ? type.type : type;
  switch (typeName) {
    case 'String':
      return value;
    case 'Boolean':
      return Boolean(value);
    case 'Date':
      if (typeof value === 'string') {
        return { __type: 'Date', iso: value };
      }
      if (typeof value === 'number') {
        return { __type: 'Date', iso: new Date(value).toISOString() };
      }
      return value;
    case 'Object':
    case 'Array':
    case 'Bytes':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    case 'GeoPoint':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    case 'Polygon':
      if (typeof value === 'string') {
        try {
          return normalizeStoredPolygonValue(JSON.parse(value));
        } catch {
          return value;
        }
      }
      return normalizeStoredPolygonValue(value);
    case 'Pointer':
      if (typeof value === 'string') {
        return value;
      }
      return value;
    default:
      if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
  }
};

const quoteColumnName = (fieldName: string) => `"${fieldName.replace(/"/g, '""')}"`;

const validateObjectPathComponent = (component: string, fieldName: string) => {
  if (!/^[a-zA-Z0-9_\-$]+$/.test(component)) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, `Invalid key name: ${fieldName}`);
  }
};

const getDotFieldPathParts = (fieldName: string) => {
  const parts = fieldName.split('.');
  const rootFieldName = parts.shift();
  validateFieldName(rootFieldName);
  return {
    rootFieldName,
    components: parts,
  };
};

const getJsonRootTypeExpression = (expression: string) =>
  `(CASE WHEN ${expression} IS NOT NULL AND json_valid(${expression}) THEN json_type(${expression}) ELSE NULL END)`;

const buildJsonPathTraversalExpressions = (
  rootExpression: string,
  components: Array<string>,
  fieldName: string
) => {
  let jsonPath = '$';
  let hasAmbiguousNumericSegments = false;
  for (const component of components) {
    if (isNumericArrayIndexComponent(component)) {
      hasAmbiguousNumericSegments = true;
      jsonPath += `[${component}]`;
      continue;
    }
    validateObjectPathComponent(component, fieldName);
    jsonPath += `."${component}"`;
  }

  if (!hasAmbiguousNumericSegments) {
    return {
      hasAmbiguousNumericSegments,
      jsonPath,
      valueExpression: `json_extract(${rootExpression}, '${jsonPath}')`,
      typeExpression: `json_type(${rootExpression}, '${jsonPath}')`,
    };
  }

  let valueExpression = rootExpression;
  let typeExpression = getJsonRootTypeExpression(rootExpression);
  for (const component of components) {
    const currentValueExpression = valueExpression;
    const currentTypeExpression = typeExpression;
    if (isNumericArrayIndexComponent(component)) {
      const arrayPath = `$[${component}]`;
      const objectPath = `$."${component}"`;
      valueExpression =
        `(CASE ${currentTypeExpression} ` +
        `WHEN 'array' THEN json_extract(${currentValueExpression}, '${arrayPath}') ` +
        `WHEN 'object' THEN json_extract(${currentValueExpression}, '${objectPath}') ` +
        `ELSE NULL END)`;
      typeExpression =
        `(CASE ${currentTypeExpression} ` +
        `WHEN 'array' THEN json_type(${currentValueExpression}, '${arrayPath}') ` +
        `WHEN 'object' THEN json_type(${currentValueExpression}, '${objectPath}') ` +
        `ELSE NULL END)`;
      continue;
    }
    validateObjectPathComponent(component, fieldName);
    const objectPath = `$."${component}"`;
    valueExpression =
      `(CASE WHEN ${currentTypeExpression} IN ('array', 'object') ` +
      `THEN json_extract(${currentValueExpression}, '${objectPath}') ELSE NULL END)`;
    typeExpression =
      `(CASE WHEN ${currentTypeExpression} IN ('array', 'object') ` +
      `THEN json_type(${currentValueExpression}, '${objectPath}') ELSE NULL END)`;
  }

  return {
    hasAmbiguousNumericSegments,
    jsonPath,
    valueExpression,
    typeExpression,
  };
};

const buildDotFieldPath = (fieldName: string) => {
  const { rootFieldName, components } = getDotFieldPathParts(fieldName);
  return {
    rootFieldName,
    components,
    ...buildJsonPathTraversalExpressions(quoteColumnName(rootFieldName), components, fieldName),
  };
};

const buildArrayRootDotFieldPath = (
  fieldName: string,
  eachTableAlias = 'json_each'
) => {
  const { rootFieldName, components } = getDotFieldPathParts(fieldName);
  return {
    rootFieldName,
    components,
    ...buildJsonPathTraversalExpressions(`${eachTableAlias}.value`, components, fieldName),
  };
};

const doesSQLiteFieldExistInSchema = (schemaFields: { [string]: any }, fieldName: string): boolean =>
  defaultSchemaIndexFields.has(fieldName) ||
  fieldName === '_rperm' ||
  fieldName === '_wperm' ||
  Object.prototype.hasOwnProperty.call(schemaFields, fieldName);

const handleDotFields = object => {
  Object.keys(object).forEach(fieldName => {
    if (fieldName.indexOf('.') > -1) {
      const components = fieldName.split('.');
      const first = components.shift();
      object[first] = object[first] || {};
      let currentObj = object[first];
      let next;
      let value = object[fieldName];
      if (value && value.__op === 'Delete') {
        value = undefined;
      }
      while ((next = components.shift())) {
        currentObj[next] = currentObj[next] || {};
        if (components.length === 0) {
          currentObj[next] = value;
        }
        currentObj = currentObj[next];
      }
      delete object[fieldName];
    }
  });
  return object;
};

const validateNestedKeys = value => {
  if (
    value === null ||
    value === undefined ||
    Utils.isDate(value) ||
    typeof value !== 'object'
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => validateNestedKeys(item));
    return;
  }
  for (const key of Object.keys(value)) {
    if (key.includes('$') || key.includes('.')) {
      throw new Parse.Error(
        Parse.Error.INVALID_NESTED_KEY,
        "Nested keys should not contain the '$' or '.' characters"
      );
    }
    validateNestedKeys(value[key]);
  }
};

const cloneMutableValue = value => {
  if (value === undefined || value === null || typeof value !== 'object') {
    return value;
  }
  return structuredClone(value);
};

const isJsonEncodedValue = (value: any) => {
  if (value === null || value === undefined || Utils.isDate(value)) {
    return false;
  }
  if (Array.isArray(value)) {
    return true;
  }
  if (typeof value !== 'object') {
    return false;
  }
  return value.__type !== 'Date' && value.__type !== 'Pointer' && value.__type !== 'File';
};

const isQueryOperatorObject = (value: any) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Utils.isDate(value)) {
    return false;
  }
  if (value.__type) {
    return false;
  }
  return Object.keys(value).some(key => key.startsWith('$'));
};

const getParameterizedValueExpression = (value: any) => {
  return isJsonEncodedValue(value) ? 'json(?)' : '?';
};

const getNormalizedJsonArrayExpression = (expression: string) =>
  `CASE WHEN json_valid(${expression}) AND json_type(${expression}) = 'array' THEN ${expression} ELSE '[]' END`;

const getJsonContainerValueExpression = (
  expression: string,
  fallbackContainerType: 'object' | 'array' = 'object'
) =>
  `CASE WHEN json_valid(${expression}) AND json_type(${expression}) IN ('object', 'array') ` +
  `THEN ${expression} ELSE ${fallbackContainerType === 'array' ? "'[]'" : "'{}'"} END`;

const getJsonArrayValueExpression = (containerExpression: string, jsonPath: string) =>
  getNormalizedJsonArrayExpression(`json_extract(${containerExpression}, '${jsonPath}')`);

const getJSONArrayElementValueExpression = (
  valueExpression: string,
  typeExpression: string,
  jsonExpression: string
) =>
  `CASE ${typeExpression} ` +
  `WHEN 'object' THEN json(${jsonExpression}) ` +
  `WHEN 'array' THEN json(${jsonExpression}) ` +
  `WHEN 'true' THEN json('true') ` +
  `WHEN 'false' THEN json('false') ` +
  `WHEN 'null' THEN json('null') ` +
  `ELSE ${valueExpression} END`;

const buildJSONArrayAppendExpression = (targetExpression: string) => {
  const normalizedTargetExpression = getNormalizedJsonArrayExpression(targetExpression);
  const appendedElementExpression = getJSONArrayElementValueExpression(
    'item_value',
    'item_type',
    'item_json'
  );
  return (
    `(SELECT COALESCE(json_group_array(${appendedElementExpression}), '[]') ` +
    `FROM (` +
    `SELECT value AS item_value, json_each.type AS item_type, json_each.value AS item_json, ` +
    `CAST(json_each.key AS INTEGER) AS item_order ` +
    `FROM json_each(${normalizedTargetExpression}) ` +
    `UNION ALL ` +
    `SELECT value AS item_value, json_each.type AS item_type, json_each.value AS item_json, ` +
    `CAST(json_each.key AS INTEGER) + COALESCE(json_array_length(${normalizedTargetExpression}), 0) AS item_order ` +
    `FROM json_each(?) ` +
    `ORDER BY item_order))`
  );
};

const buildSingleEvaluationJSONMutationExpression = (
  currentObjectExpression: string,
  buildMutationExpression: (objectExpression: string) => string
) =>
  `(SELECT ${buildMutationExpression('__parse_current_json.obj')} ` +
  `FROM (SELECT ${currentObjectExpression} AS obj) AS __parse_current_json)`;

const buildDynamicJsonPathUpdateExpression = (
  currentObjectExpression: string,
  pathComponents: Array<string>,
  fieldValue: any
): { expression: string, params: Array<any> } => {
  let operation = 'Set';
  let rawValue = fieldValue;

  if (fieldValue === null) {
    rawValue = null;
  } else if (typeof fieldValue === 'object') {
    switch (fieldValue.__op) {
      case 'Increment':
        if (typeof fieldValue.amount !== 'number' || Number.isNaN(fieldValue.amount)) {
          throw new Parse.Error(Parse.Error.INVALID_JSON, 'Cannot increment by a non-numeric value.');
        }
        operation = 'Increment';
        rawValue = fieldValue.amount;
        break;
      case 'Add':
        operation = 'Add';
        rawValue = fieldValue.objects;
        break;
      case 'AddUnique':
        operation = 'AddUnique';
        rawValue = fieldValue.objects;
        break;
      case 'Remove':
        operation = 'Remove';
        rawValue = fieldValue.objects;
        break;
      case 'Delete':
        operation = 'Delete';
        rawValue = null;
        break;
      default:
        validateNestedKeys(fieldValue);
        break;
    }
  }

  return {
    expression: buildSingleEvaluationJSONMutationExpression(
      currentObjectExpression,
      objectExpression =>
        `json(parse_json_apply_path_mutation(${objectExpression}, ?, ?, ?))`
    ),
    params: [JSON.stringify(pathComponents), operation, toSQLiteJSONObjectValue(rawValue)],
  };
};

const buildJsonPathUpdateExpression = (
  currentObjectExpression: string,
  dotFieldPath: {
    hasAmbiguousNumericSegments: boolean,
    jsonPath: string,
    components: Array<string>,
  },
  fieldValue: any
): { expression: string, params: Array<any> } => {
  if (dotFieldPath.hasAmbiguousNumericSegments) {
    return buildDynamicJsonPathUpdateExpression(
      currentObjectExpression,
      dotFieldPath.components,
      fieldValue
    );
  }

  const { jsonPath } = dotFieldPath;
  if (fieldValue === null) {
    return {
      expression: buildSingleEvaluationJSONMutationExpression(
        currentObjectExpression,
        objectExpression => `json_set(${objectExpression}, '${jsonPath}', NULL)`
      ),
      params: [],
    };
  }

  if (typeof fieldValue === 'object') {
    if (fieldValue.__op === 'Increment') {
      if (typeof fieldValue.amount !== 'number' || Number.isNaN(fieldValue.amount)) {
        throw new Parse.Error(Parse.Error.INVALID_JSON, 'Cannot increment by a non-numeric value.');
      }
      return {
        expression: buildSingleEvaluationJSONMutationExpression(
          currentObjectExpression,
          objectExpression =>
            `json_set(${objectExpression}, '${jsonPath}', ` +
            `COALESCE(json_extract(${objectExpression}, '${jsonPath}'), 0) + ?)`
        ),
        params: [fieldValue.amount],
      };
    }
    if (fieldValue.__op === 'Add') {
      return {
        expression: buildSingleEvaluationJSONMutationExpression(
          currentObjectExpression,
          objectExpression => {
            const arrayValueExpression = getJsonArrayValueExpression(objectExpression, jsonPath);
            return (
              `json_set(${objectExpression}, '${jsonPath}', ` +
              `json(${buildJSONArrayAppendExpression(arrayValueExpression)}))`
            );
          }
        ),
        params: [JSON.stringify(fieldValue.objects)],
      };
    }
    if (fieldValue.__op === 'AddUnique') {
      return {
        expression: buildSingleEvaluationJSONMutationExpression(
          currentObjectExpression,
          objectExpression => {
            const arrayValueExpression = getJsonArrayValueExpression(objectExpression, jsonPath);
            return (
              `json_set(${objectExpression}, '${jsonPath}', ` +
              `json(parse_array_add_unique(${arrayValueExpression}, ?)))`
            );
          }
        ),
        params: [JSON.stringify(fieldValue.objects)],
      };
    }
    if (fieldValue.__op === 'Remove') {
      return {
        expression: buildSingleEvaluationJSONMutationExpression(
          currentObjectExpression,
          objectExpression => {
            const arrayValueExpression = getJsonArrayValueExpression(objectExpression, jsonPath);
            return (
              `json_set(${objectExpression}, '${jsonPath}', ` +
              `json(parse_array_remove(${arrayValueExpression}, ?)))`
            );
          }
        ),
        params: [JSON.stringify(fieldValue.objects)],
      };
    }
    if (fieldValue.__op === 'Delete') {
      return {
        expression: buildSingleEvaluationJSONMutationExpression(
          currentObjectExpression,
          objectExpression => `json_remove(${objectExpression}, '${jsonPath}')`
        ),
        params: [],
      };
    }
  }

  validateNestedKeys(fieldValue);
  return {
    expression: buildSingleEvaluationJSONMutationExpression(
      currentObjectExpression,
      objectExpression => `json_set(${objectExpression}, '${jsonPath}', json(?))`
    ),
    params: [toSQLiteJSONObjectValue(fieldValue)],
  };
};

const isPointerValue = (value: any) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  value.__type === 'Pointer' &&
  typeof value.objectId === 'string';

const usesSQLiteJSONBComparison = (value: any): boolean =>
  isJsonEncodedValue(value) ||
  (value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.__type &&
    value.__type !== 'Pointer' &&
    value.__type !== 'Date');

const getJSONArrayTableFunctionName = (comparisonValues: Array<any>): string =>
  comparisonValues.some(usesSQLiteJSONBComparison) ? 'jsonb_each' : 'json_each';

const getJsonValueMatchExpression = (
  valueExpression: string,
  comparisonValue: any
): { sql: string, params: Array<any> } => {
  const sqliteValue = toSQLiteValue(comparisonValue);
  if (sqliteValue == null) {
    return {
      sql: `${valueExpression} IS NULL`,
      params: [],
    };
  }
  if (isPointerValue(comparisonValue)) {
    return {
      sql:
        `((json_valid(${valueExpression}) AND json_type(${valueExpression}) = 'object' AND ` +
        `json_extract(${valueExpression}, '$.__type') = 'Pointer' AND ` +
        `json_extract(${valueExpression}, '$.className') = ? AND ` +
        `json_extract(${valueExpression}, '$.objectId') = ?) OR ${valueExpression} = ?)`,
      params: [comparisonValue.className, comparisonValue.objectId, comparisonValue.objectId],
    };
  }
  if (comparisonValue && typeof comparisonValue === 'object' && comparisonValue.__type === 'Date') {
    return {
      sql:
        `((json_valid(${valueExpression}) AND json_type(${valueExpression}) = 'object' AND jsonb(${valueExpression}) = jsonb(?)) ` +
        `OR ${valueExpression} = ?)`,
      params: [toSQLiteJSONObjectValue(comparisonValue), toSQLiteValue(comparisonValue)],
    };
  }
  if (usesSQLiteJSONBComparison(comparisonValue)) {
    return {
      sql: `CASE WHEN json_valid(${valueExpression}) THEN jsonb(${valueExpression}) = jsonb(?) ELSE 0 END`,
      params: [toSQLiteJSONObjectValue(comparisonValue)],
    };
  }
  return {
    sql: `${valueExpression} = ?`,
    params: [sqliteValue],
  };
};

const isSQLitePrimitiveSetComparisonValue = (value: any): boolean => {
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  return typeof value === 'number' && Number.isFinite(value);
};

const appendSQLiteSetMembershipClause = (
  sqlParts: Array<string>,
  params: Array<any>,
  valueExpression: string,
  comparisonValues: Array<any>
) => {
  if (comparisonValues.length === 0) {
    return;
  }
  sqlParts.push(`(${valueExpression} IN (SELECT value FROM json_each(?)))`);
  params.push(JSON.stringify(comparisonValues));
};

const appendSQLitePointerAnyMatchClauses = (
  sqlParts: Array<string>,
  params: Array<any>,
  valueExpression: string,
  pointerObjectIds: Array<string>,
  pointerObjectIdsByClassName: Map<string, Array<string>>
) => {
  if (pointerObjectIds.length === 0) {
    return;
  }

  appendSQLiteSetMembershipClause(sqlParts, params, valueExpression, pointerObjectIds);

  const pointerJsonClauses = [];
  for (const [className, classObjectIds] of pointerObjectIdsByClassName) {
    pointerJsonClauses.push(
      `(json_extract(${valueExpression}, '$.className') = ? AND ` +
        `json_extract(${valueExpression}, '$.objectId') IN (SELECT value FROM json_each(?)))`
    );
    params.push(className, JSON.stringify(classObjectIds));
  }

  if (pointerJsonClauses.length > 0) {
    // Pointer lists are usually same-class, so grouping by class keeps the SQL tree
    // shallow while still matching JSON-stored pointers by both class and objectId.
    sqlParts.push(
      `(json_valid(${valueExpression}) AND json_type(${valueExpression}) = 'object' AND ` +
        `json_extract(${valueExpression}, '$.__type') = 'Pointer' AND ` +
        `(${pointerJsonClauses.join(' OR ')}))`
    );
  }
};

const appendSQLiteDateAnyMatchClauses = (
  sqlParts: Array<string>,
  params: Array<any>,
  valueExpression: string,
  dateIsoValues: Array<string>
) => {
  if (dateIsoValues.length === 0) {
    return;
  }

  appendSQLiteSetMembershipClause(sqlParts, params, valueExpression, dateIsoValues);

  if (dateIsoValues.length > 0) {
    sqlParts.push(
      `(json_valid(${valueExpression}) AND json_type(${valueExpression}) = 'object' AND ` +
        `json_extract(${valueExpression}, '$.__type') = 'Date' AND ` +
        `json_extract(${valueExpression}, '$.iso') IN (SELECT value FROM json_each(?)))`
    );
    params.push(JSON.stringify(dateIsoValues));
  }
};

const getSQLiteAnyMatchExpression = (
  valueExpression: string,
  comparisonValues: Array<any>,
  getMatchExpression: (valueExpression: string, comparisonValue: any) => {
    sql: string,
    params: Array<any>,
  }
): { sql: string, params: Array<any> } => {
  const sqlParts = [];
  const params = [];
  const primitiveValues = [];
  const pointerObjectIds = [];
  const pointerObjectIdsByClassName = new Map();
  const dateIsoValues = [];

  for (const comparisonValue of comparisonValues) {
    if (isSQLitePrimitiveSetComparisonValue(comparisonValue)) {
      primitiveValues.push(toSQLiteValue(comparisonValue));
      continue;
    }
    if (isPointerValue(comparisonValue)) {
      pointerObjectIds.push(comparisonValue.objectId);
      const classObjectIds = pointerObjectIdsByClassName.get(comparisonValue.className);
      if (classObjectIds) {
        classObjectIds.push(comparisonValue.objectId);
      } else {
        pointerObjectIdsByClassName.set(comparisonValue.className, [comparisonValue.objectId]);
      }
      continue;
    }
    const sqliteDateValue =
      comparisonValue &&
      typeof comparisonValue === 'object' &&
      !Array.isArray(comparisonValue) &&
      comparisonValue.__type === 'Date'
        ? toSQLiteValue(comparisonValue)
        : null;
    if (
      comparisonValue &&
      typeof comparisonValue === 'object' &&
      !Array.isArray(comparisonValue) &&
      comparisonValue.__type === 'Date' &&
      sqliteDateValue != null
    ) {
      dateIsoValues.push(sqliteDateValue);
      continue;
    }

    const expression = getMatchExpression(valueExpression, comparisonValue);
    sqlParts.push(`(${expression.sql})`);
    params.push(...expression.params);
  }

  // Bind large containedIn sets once so SQLite does not hit expression-depth
  // limits from thousands of generated OR predicates.
  appendSQLiteSetMembershipClause(sqlParts, params, valueExpression, primitiveValues);
  appendSQLitePointerAnyMatchClauses(
    sqlParts,
    params,
    valueExpression,
    pointerObjectIds,
    pointerObjectIdsByClassName
  );
  appendSQLiteDateAnyMatchClauses(sqlParts, params, valueExpression, dateIsoValues);

  return {
    sql: sqlParts.join(' OR '),
    params,
  };
};

const getJsonValueAnyMatchExpression = (
  valueExpression: string,
  comparisonValues: Array<any>
): { sql: string, params: Array<any> } =>
  getSQLiteAnyMatchExpression(valueExpression, comparisonValues, getJsonValueMatchExpression);

const getArrayElementMatchExpression = (
  targetSql: string,
  comparisonValue: any
): { sql: string, params: Array<any> } => {
  const eachTableName = getJSONArrayTableFunctionName([comparisonValue]);
  const valueMatch = getJsonValueMatchExpression(`${eachTableName}.value`, comparisonValue);
  return {
    sql: `EXISTS (SELECT 1 FROM ${eachTableName}(${targetSql}) WHERE ${valueMatch.sql})`,
    params: valueMatch.params,
  };
};

const getArrayRootDotValueMatchExpression = (
  arraySourceExpression: string,
  valueExpression: string,
  comparisonValue: any
): { sql: string, params: Array<any> } => {
  const valueMatch = getJsonValueMatchExpression(valueExpression, comparisonValue);
  return {
    sql: `EXISTS (SELECT 1 FROM json_each(${arraySourceExpression}) WHERE ${valueMatch.sql})`,
    params: valueMatch.params,
  };
};

const getArrayRootDotAnyMatchExpression = (
  arraySourceExpression: string,
  valueExpression: string,
  comparisonValues: Array<any>
): { sql: string, params: Array<any> } => {
  const valueMatch = getJsonValueAnyMatchExpression(valueExpression, comparisonValues);
  return {
    sql: `EXISTS (SELECT 1 FROM json_each(${arraySourceExpression}) WHERE ${valueMatch.sql})`,
    params: valueMatch.params,
  };
};

const getArrayRootDotExistsExpression = (
  arraySourceExpression: string,
  typeExpression: string,
  shouldExist: boolean
): { sql: string, params: Array<any> } => ({
  sql: shouldExist
    ? `EXISTS (SELECT 1 FROM json_each(${arraySourceExpression}) WHERE ${typeExpression} IS NOT NULL)`
    : `NOT EXISTS (SELECT 1 FROM json_each(${arraySourceExpression}) WHERE ${typeExpression} IS NOT NULL)`,
  params: [],
});

const isGeoPointValue = (value: any) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  value.__type === 'GeoPoint' &&
  typeof value.latitude === 'number' &&
  typeof value.longitude === 'number';

const getArrayAnyMatchExpression = (
  targetSql: string,
  comparisonValues: Array<any>
): { sql: string, params: Array<any> } => {
  const eachTableName = getJSONArrayTableFunctionName(comparisonValues);
  const valueMatch = getJsonValueAnyMatchExpression(`${eachTableName}.value`, comparisonValues);
  return {
    sql: `EXISTS (SELECT 1 FROM ${eachTableName}(${targetSql}) WHERE ${valueMatch.sql})`,
    params: valueMatch.params,
  };
};

const getSQLiteArrayIndexScalarLookup = (
  comparisonValue: any
): { valueType: string, value: any } | null => {
  if (comparisonValue === null) {
    return {
      valueType: 'null',
      value: null,
    };
  }
  if (typeof comparisonValue === 'string') {
    return {
      valueType: 'text',
      value: comparisonValue,
    };
  }
  if (typeof comparisonValue === 'boolean') {
    return {
      valueType: comparisonValue ? 'true' : 'false',
      value: comparisonValue ? 1 : 0,
    };
  }
  if (typeof comparisonValue === 'number' && Number.isFinite(comparisonValue)) {
    return {
      valueType: Number.isInteger(comparisonValue) ? 'integer' : 'real',
      value: comparisonValue,
    };
  }
  return null;
};

const getSQLiteArrayIndexValueMatchExpression = (
  arrayIndexTableName: string,
  comparisonValue: any
): { sql: string, params: Array<any> } | null => {
  const lookup = getSQLiteArrayIndexScalarLookup(comparisonValue);
  if (!lookup) {
    return null;
  }

  return {
    sql:
      `${quoteColumnName('objectId')} IN (` +
      `SELECT ${quoteColumnName('objectId')} FROM ${arrayIndexTableName} ` +
      `WHERE ${quoteColumnName(arrayIndexValueTypeColumn)} = ? ` +
      `AND ${quoteColumnName(arrayIndexValueColumn)} = ?` +
      `)`,
    params: [lookup.valueType, lookup.value],
  };
};

const getScalarValueMatchExpression = (
  targetSql: string,
  comparisonValue: any
): { sql: string, params: Array<any> } => getJsonValueMatchExpression(targetSql, comparisonValue);

const getScalarAnyMatchExpression = (
  targetSql: string,
  comparisonValues: Array<any>
): { sql: string, params: Array<any> } =>
  getSQLiteAnyMatchExpression(targetSql, comparisonValues, getScalarValueMatchExpression);

const validateRegexPattern = (pattern: string, flags: string): { pattern: string, flags: string } => {
  try {
    const normalizedRegex = normalizeRegexPattern(pattern, flags);
    new RegExp(normalizedRegex.pattern, normalizedRegex.flags);
    return normalizedRegex;
  } catch (error) {
    throw createSanitizedError(
      Parse.Error.INTERNAL_SERVER_ERROR,
      `Invalid regular expression: ${error.message}`,
      undefined,
      'An internal server error occurred'
    );
  }
};

const escapeSQLiteLikePattern = (literal: string): string =>
  literal.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

const escapeSQLiteGlobPattern = (literal: string): string =>
  literal.replace(/\[/g, '[[]').replace(/\*/g, '[*]').replace(/\?/g, '[?]');

// eslint-disable-next-line no-control-regex
const asciiOnlyStringPattern = /^[\u0000-\u007F]*$/;
const isASCIIOnlyString = (value: string): boolean => asciiOnlyStringPattern.test(value);

/** Only bare text-ish columns can drop CAST() and still keep regex lowering semantics sane. */
const isLowerableRegexTextColumn = (
  schemaFields: { [string]: any },
  fieldName: string
): boolean => {
  if (fieldName === 'objectId' || fieldName === 'createdAt' || fieldName === 'updatedAt') {
    return true;
  }

  const field = schemaFields[fieldName];
  if (!field || typeof field !== 'object') {
    return false;
  }

  return field.type === 'String' || field.type === 'Date';
};

const getSimpleRegexMatchExpression = (
  targetSql: string,
  normalizedRegex: { pattern: string, flags: string },
  options?: {
    useRawTextTarget?: boolean,
  }
): { sql: string, params: Array<any>, requiresResidual: boolean } | null => {
  const regexInfo = getSimpleNormalizedRegexInfo(normalizedRegex.pattern, normalizedRegex.flags);
  if (!regexInfo) {
    return null;
  }

  // Raw text columns can use their normal index. JSON extracts and mixed-type slots still need CAST().
  const textTargetSql = options && options.useRawTextTarget ? targetSql : `CAST(${targetSql} AS TEXT)`;
  if (regexInfo.caseInsensitive) {
    if (!isASCIIOnlyString(regexInfo.literal)) {
      return null;
    }
    let likePattern = escapeSQLiteLikePattern(regexInfo.literal);
    if (regexInfo.mode === 'startsWith') {
      likePattern += '%';
    } else if (regexInfo.mode === 'endsWith') {
      likePattern = `%${likePattern}`;
    } else if (regexInfo.mode === 'contains') {
      likePattern = `%${likePattern}%`;
    }
    return {
      sql: `${textTargetSql} LIKE ? ESCAPE '\\'`,
      params: [likePattern],
      requiresResidual: regexInfo.requiresResidual,
    };
  }

  if (regexInfo.mode === 'exact') {
    return {
      sql: `${textTargetSql} = ?`,
      params: [regexInfo.literal],
      requiresResidual: regexInfo.requiresResidual,
    };
  }

  const globLiteral = escapeSQLiteGlobPattern(regexInfo.literal);
  let globPattern = globLiteral;
  if (regexInfo.mode === 'startsWith') {
    globPattern = `${globLiteral}*`;
  } else if (regexInfo.mode === 'endsWith') {
    globPattern = `*${globLiteral}`;
  } else if (regexInfo.mode === 'contains') {
    globPattern = `*${globLiteral}*`;
  }
  return {
    sql: `${textTargetSql} GLOB ?`,
    params: [globPattern],
    requiresResidual: regexInfo.requiresResidual,
  };
};

const getRegexTextTargetSQL = (
  targetSql: string,
  options?: {
    useRawTextTarget?: boolean,
  }
): string => ((options && options.useRawTextTarget) ? targetSql : `CAST(${targetSql} AS TEXT)`);

const getSQLiteExactSetRegexExpression = (
  targetSql: string,
  literals: Array<string>,
  caseMode: 'caseSensitive' | 'caseInsensitiveASCII' | 'caseInsensitiveUncased',
  options?: {
    useRawTextTarget?: boolean,
  }
): { sql: string, params: Array<any> } => {
  const textTargetSql = getRegexTextTargetSQL(targetSql, options);
  const placeholders = literals.map(() => '?').join(', ');

  if (caseMode === 'caseInsensitiveASCII') {
    return {
      sql: `(${textTargetSql} COLLATE NOCASE) IN (${placeholders})`,
      params: literals,
    };
  }

  if (literals.length === 1) {
    return {
      sql: `${textTargetSql} = ?`,
      params: literals,
    };
  }

  return {
    sql: `${textTargetSql} IN (${placeholders})`,
    params: literals,
  };
};

const getSQLitePrefixSetRegexExpression = (
  targetSql: string,
  prefixes: Array<string>,
  caseMode: 'caseSensitive' | 'caseInsensitiveASCII' | 'caseInsensitiveUncased',
  options?: {
    useRawTextTarget?: boolean,
  }
): { sql: string, params: Array<any> } => {
  const textTargetSql = getRegexTextTargetSQL(targetSql, options);
  const prefixClauses = [];
  const params = [];

  for (const prefix of prefixes) {
    if (caseMode === 'caseInsensitiveASCII') {
      prefixClauses.push(`${textTargetSql} LIKE ? ESCAPE '\\'`);
      params.push(`${escapeSQLiteLikePattern(prefix)}%`);
    } else {
      prefixClauses.push(`${textTargetSql} GLOB ?`);
      params.push(`${escapeSQLiteGlobPattern(prefix)}*`);
    }
  }

  if (prefixClauses.length === 1) {
    return {
      sql: prefixClauses[0],
      params,
    };
  }

  return {
    sql: `(${prefixClauses.join(' OR ')})`,
    params,
  };
};

const getRegexMatchPlan = (
  targetSql: string,
  normalizedRegex: { pattern: string, flags: string },
  options?: {
    useRawTextTarget?: boolean,
    allowPrefixPrefilter?: boolean,
  }
):
  | {
      sql: string,
      params: Array<any>,
      requiresResidual: boolean,
    }
  | null => {
  const leadingLiteralSetInfo = getRegexLeadingLiteralSetInfo(
    normalizedRegex.pattern,
    normalizedRegex.flags
  );
  if (leadingLiteralSetInfo) {
    let expression;
    if (leadingLiteralSetInfo.matchMode === 'exact') {
      expression = getSQLiteExactSetRegexExpression(
        targetSql,
        leadingLiteralSetInfo.literals,
        leadingLiteralSetInfo.caseMode,
        options
      );
    } else {
      expression = getSQLitePrefixSetRegexExpression(
        targetSql,
        leadingLiteralSetInfo.literals,
        leadingLiteralSetInfo.caseMode,
        options
      );
    }

    return {
      ...expression,
      requiresResidual: leadingLiteralSetInfo.requiresResidual,
    };
  }

  const simpleRegexMatch = getSimpleRegexMatchExpression(targetSql, normalizedRegex, options);
  if (simpleRegexMatch) {
    return simpleRegexMatch;
  }

  if (!(options && options.allowPrefixPrefilter)) {
    return null;
  }

  const prefixInfo = getRegexPrefixPrefilterInfo(
    normalizedRegex.pattern,
    normalizedRegex.flags
  );
  if (!prefixInfo) {
    return null;
  }

  const prefixExpression = getSQLitePrefixSetRegexExpression(
    targetSql,
    [prefixInfo.literalPrefix],
    prefixInfo.mode,
    options
  );

  return {
    ...prefixExpression,
    requiresResidual: prefixInfo.requiresResidual,
  };
};

const getSQLiteRegexResidualExpression = (
  targetSql: string,
  normalizedRegex: { pattern: string, flags: string }
): { sql: string, params: Array<any> } => {
  if (normalizedRegex.flags) {
    return {
      sql: `regexp_flags(?, ?, ${targetSql}) = 1`,
      params: [normalizedRegex.pattern, normalizedRegex.flags],
    };
  }

  return {
    sql: `${targetSql} REGEXP ?`,
    params: [normalizedRegex.pattern],
  };
};

const getSQLiteRegexValueMatchExpression = (
  targetSql: string,
  normalizedRegex: { pattern: string, flags: string },
  regexMatchPlan?: {
    sql: string,
    params: Array<any>,
    requiresResidual: boolean,
  } | null
): { sql: string, params: Array<any> } => {
  if (!regexMatchPlan) {
    return getSQLiteRegexResidualExpression(targetSql, normalizedRegex);
  }

  if (!regexMatchPlan.requiresResidual) {
    return {
      sql: regexMatchPlan.sql,
      params: regexMatchPlan.params,
    };
  }

  const residualExpression = getSQLiteRegexResidualExpression(targetSql, normalizedRegex);
  return {
    sql: `(${regexMatchPlan.sql}) AND ${residualExpression.sql}`,
    params: [...regexMatchPlan.params, ...residualExpression.params],
  };
};

const getSQLiteArrayIndexRegexMatchExpression = (
  arrayIndexTableName: string,
  normalizedRegex: { pattern: string, flags: string }
): { sql: string, params: Array<any> } => {
  const valueColumnSql = quoteColumnName(arrayIndexValueColumn);
  const regexMatchPlan = getRegexMatchPlan(valueColumnSql, normalizedRegex, {
    useRawTextTarget: true,
    allowPrefixPrefilter: true,
  });
  const regexValueMatch = getSQLiteRegexValueMatchExpression(
    valueColumnSql,
    normalizedRegex,
    regexMatchPlan
  );

  return {
    sql:
      `${quoteColumnName('objectId')} IN (` +
      `SELECT ${quoteColumnName('objectId')} FROM ${arrayIndexTableName} ` +
      `WHERE ${quoteColumnName(arrayIndexValueTypeColumn)} = 'text' ` +
      `AND ${regexValueMatch.sql}` +
      `)`,
    params: regexValueMatch.params,
  };
};

const transformDotField = (fieldName: string) => {
  if (fieldName.indexOf('.') === -1) {
    validateFieldName(fieldName);
    return quoteColumnName(fieldName);
  }
  return buildDotFieldPath(fieldName).valueExpression;
};

const validateFieldName = (name: string) => {
  if (typeof name !== 'string' || !name.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) {
    throw new Parse.Error(Parse.Error.INVALID_KEY_NAME, `Invalid field name: ${name}`);
  }
};

const isPlainObject = (value: any) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parseJSONValue = (value: any) => {
  if (typeof value !== 'string') {
    return value;
  }
  if (!value.startsWith('{') && !value.startsWith('[')) {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const isStartsWithRegexConstraint = value =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof value.$regex === 'string' &&
  /^\^\\Q.*\\E/.test(value.$regex);

const isAllValuesRegexOrNone = values => {
  if (!values || !Array.isArray(values) || values.length === 0) {
    return true;
  }
  const firstValueIsRegex = isStartsWithRegexConstraint(values[0]);
  if (values.length === 1) {
    return firstValueIsRegex;
  }
  for (let i = 1; i < values.length; i += 1) {
    if (firstValueIsRegex !== isStartsWithRegexConstraint(values[i])) {
      return false;
    }
  }
  return true;
};

const isAnyValueRegex = values =>
  Array.isArray(values) &&
  values.some(value => value && typeof value === 'object' && typeof value.$regex === 'string');

const sanitizeFTS5Identifier = (value: string) =>
  value.replace(/[^a-zA-Z0-9_]+/g, '_');

const escapeFTS5Query = (term: string) => `"${term.replace(/"/g, '""')}"`;

const parseTextSearch = (query: QueryType): ?{
  fieldName: string,
  searchTerm: string,
  language?: string,
  caseSensitive?: boolean,
  diacriticSensitive?: boolean,
  remainingQuery: QueryType,
} => {
  for (const fieldName of Object.keys(query)) {
    const value = query[fieldName];
    if (!isPlainObject(value) || !Object.prototype.hasOwnProperty.call(value, '$text')) {
      continue;
    }

    const textValue = value.$text;
    if (!isPlainObject(textValue) || !isPlainObject(textValue.$search)) {
      throw new Parse.Error(
        Parse.Error.INVALID_JSON,
        'bad $text: $search, should be object'
      );
    }

    const search = textValue.$search;
    if (typeof search.$term !== 'string') {
      throw new Parse.Error(
        Parse.Error.INVALID_JSON,
        'bad $text: $term, should be string'
      );
    }
    if (search.$language !== undefined && typeof search.$language !== 'string') {
      throw new Parse.Error(
        Parse.Error.INVALID_JSON,
        'bad $text: $language, should be string'
      );
    }
    if (search.$caseSensitive !== undefined && typeof search.$caseSensitive !== 'boolean') {
      throw new Parse.Error(
        Parse.Error.INVALID_JSON,
        'bad $text: $caseSensitive, should be boolean'
      );
    }
    if (
      search.$diacriticSensitive !== undefined &&
      typeof search.$diacriticSensitive !== 'boolean'
    ) {
      throw new Parse.Error(
        Parse.Error.INVALID_JSON,
        'bad $text: $diacriticSensitive, should be boolean'
      );
    }

    const remainingQuery = { ...query };
    if (Object.keys(value).length === 1) {
      delete remainingQuery[fieldName];
    } else {
      const nextFieldValue = { ...value };
      delete nextFieldValue.$text;
      remainingQuery[fieldName] = nextFieldValue;
    }

    return {
      fieldName,
      searchTerm: search.$term,
      language: search.$language,
      caseSensitive: search.$caseSensitive,
      diacriticSensitive: search.$diacriticSensitive,
      remainingQuery,
    };
  }

  return null;
};

export class SQLiteStorageAdapter implements StorageAdapter {
  canSortOnJoinTables: boolean;
  database: any;
  schemaCacheTtl: ?number;
  enableSchemaHooks: boolean;
  _db: any;
  _uri: string;
  _collectionPrefix: string;
  _onSchemaChange: () => mixed;
  _stmtCache: Map<string, any>;
  _existingClasses: Set<string>;
  _nullFieldTrackerReadyClasses: Set<string>;
  _schemaCache: Map<string, any>;
  _resolvedTableNames: Map<string, string>;
  _tableColumnsCache: Map<string, Array<string>>;
  _temporaryDirectory: ?string;
  _usesSharedMemoryDatabase: boolean;
  _lastWriteSequence: number;

  constructor(options: any = {}) {
    applySQLiteHandleIncludePatch();
    this._uri = options.uri || 'sqlite://:memory:';
    this._collectionPrefix = options.collectionPrefix || '';
    this.canSortOnJoinTables = true;
    const databaseOptions = options.databaseOptions || {};
    this.schemaCacheTtl = databaseOptions.schemaCacheTtl ?? null;
    this.enableSchemaHooks = !!databaseOptions.enableSchemaHooks;
    this._onSchemaChange = () => {};
    this._stmtCache = new Map();
    this._existingClasses = new Set();
    this._nullFieldTrackerReadyClasses = new Set();
    this._schemaCache = new Map();
    this._resolvedTableNames = new Map();
    this._tableColumnsCache = new Map();
    this._temporaryDirectory = null;
    this._usesSharedMemoryDatabase = false;
    this._lastWriteSequence = 0;
    this._isShutDown = false;

    const dbOptions = getDatabaseOptionsFromURI(this._uri);
    Object.assign(dbOptions, databaseOptions);
    if (dbOptions.cacheSizeKb == null && options.cacheSizeKb != null) {
      dbOptions.cacheSizeKb = options.cacheSizeKb;
    }
    if (dbOptions.filename === ':memory:') {
      const temporaryDatabase = getSharedMemorySQLiteDatabasePath();
      dbOptions.filename = temporaryDatabase.filename;
      this._usesSharedMemoryDatabase = true;
    }
    this._dbOptions = dbOptions;
    this._db = createClient(dbOptions);
    this._initSchemaTable();
    this.database = this._buildLegacyDatabaseCompat();
  }

  _prepare(sql: string, dbOverride?: any): any {
    const db = dbOverride || this._db;
    if (dbOverride) {
      return db.prepare(sql);
    }
    if (!db) {
      if (this._isShutDown) {
        return createClosedSQLiteStatement();
      }
      throw new Error('SQLite database handle is not available');
    }
    let stmt = this._stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      this._stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  _nextWriteSequence(): number {
    // Use a monotonic adapter-local counter so equal millisecond timestamps
    // still sort in write order without a pre-write round trip.
    const sequenceBase = Date.now() * 1000;
    this._lastWriteSequence =
      sequenceBase > this._lastWriteSequence
        ? sequenceBase
        : this._lastWriteSequence + 1;
    return this._lastWriteSequence;
  }

  _notifySchemaChange() {
    if (this.enableSchemaHooks) {
      this._onSchemaChange();
    }
  }

  watch(callback: () => void) {
    this._onSchemaChange = callback;
  }

  getIdempotencyIndexOptions() {
    return null;
  }

  async handleShutdown() {
    this._isShutDown = true;
    if (this._db) {
      try {
        this._db.close();
      } catch {
        /* */
      }
      this._db = null;
    }
    this._stmtCache.clear();
    this._existingClasses.clear();
    this._nullFieldTrackerReadyClasses.clear();
    this._schemaCache.clear();
    this._resolvedTableNames.clear();
    this._tableColumnsCache.clear();
    this._onSchemaChange = () => {};
    if (this._temporaryDirectory) {
      temporarySQLiteDirectories.delete(this._temporaryDirectory);
      try {
        fs.rmSync(this._temporaryDirectory, { recursive: true, force: true });
      } catch {
        /* */
      }
      this._temporaryDirectory = null;
    }
    if (this._usesSharedMemoryDatabase) {
      releaseSharedMemorySQLiteDatabasePath();
      this._usesSharedMemoryDatabase = false;
    }
    releaseSQLiteHandleIncludePatch();

    // SQLite teardown is synchronous, but immediate Parse restarts can still
    // race late shutdown callbacks. Keep the default drain window tiny and let
    // callers override it with PARSE_SQLITE_SHUTDOWN_DRAIN_MS.
    await waitForSQLiteShutdownDrainWindow();
  }

  _deleteExpiredIdempotencyRecords(dbOverride?: any) {
    try {
      this._prepare(
        `DELETE FROM ${this._tableName('_Idempotency')} WHERE "expire" IS NOT NULL AND "expire" < ?`,
        dbOverride
      ).run(new Date().toISOString());
    } catch {
      /* */
    }
  }

  _initSchemaTable() {
    this._db.exec(
      'CREATE TABLE IF NOT EXISTS "_SCHEMA" ("className" TEXT PRIMARY KEY, "schema" TEXT, "isParseClass" INTEGER)'
    );
    this._reloadSchemaStateFromDatabase();
  }

  _reloadSchemaStateFromDatabase() {
    this._stmtCache.clear();
    this._existingClasses.clear();
    this._nullFieldTrackerReadyClasses.clear();
    this._schemaCache.clear();
    this._resolvedTableNames.clear();
    this._tableColumnsCache.clear();
    try {
      const rows = this._db.prepare('SELECT "className", "schema" FROM "_SCHEMA"').all();
      for (const row of rows) {
        this._existingClasses.add(row.className);
        try {
          this._schemaCache.set(row.className, JSON.parse(row.schema));
        } catch {
          /* */
        }
      }
    } catch {
      /* */
    }
  }

  _preferredRawTableName(className: string): string {
    if (className === '_SCHEMA') {
      return '_SCHEMA';
    }
    // SQLite folds table identifiers case-insensitively, so custom classes need
    // a stable encoded table name to keep `Car` and `car` physically distinct.
    return `${this._collectionPrefix}${sqliteEncodedTableNamePrefix}${encodeSQLiteTableNameToken(className)}`;
  }

  _quoteRawTableName(rawTableName: string): string {
    return `"${rawTableName.replace(/"/g, '""')}"`;
  }

  _tableName(className: string, dbOverride?: any): string {
    return this._quoteRawTableName(this._rawTableName(className, dbOverride));
  }

  _tableNameExistsByRawName(rawTableName: string, dbOverride?: any): boolean {
    const db = dbOverride || this._db;
    return !!this._prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", db).get(
      rawTableName
    );
  }

  _rawTableName(className: string, dbOverride?: any): string {
    void dbOverride;
    if (className === '_SCHEMA') {
      return '_SCHEMA';
    }
    const cachedRawTableName = this._resolvedTableNames.get(className);
    if (cachedRawTableName) {
      return cachedRawTableName;
    }
    const preferredRawTableName = this._preferredRawTableName(className);
    this._resolvedTableNames.set(className, preferredRawTableName);
    return preferredRawTableName;
  }

  _joinTableClassName(fieldName: string, className: string): string {
    return `_Join:${fieldName}:${className}`;
  }

  _ensureNullFieldTrackerColumn(className: string, dbOverride?: any) {
    if (className === '_SCHEMA' || isJoinTableClass(className)) {
      return;
    }
    const db = dbOverride || this._db;
    const existingColumns = this._getTableColumns(className, db);
    const hasColumn = existingColumns.includes(nullFieldTrackerColumn);
    if (!hasColumn) {
      db.exec(
        `ALTER TABLE ${this._tableName(className, db)} ADD COLUMN "${nullFieldTrackerColumn}" TEXT`
      );
      this._setTableColumnsCache(className, [...existingColumns, nullFieldTrackerColumn], db);
    }
    this._nullFieldTrackerReadyClasses.add(className);
  }

  _tableExists(className: string, dbOverride?: any): boolean {
    const db = dbOverride || this._db;
    const rawName = this._rawTableName(className, db);
    return this._tableNameExistsByRawName(rawName, db);
  }

  _forgetCachedClass(className: string) {
    this._existingClasses.delete(className);
    this._nullFieldTrackerReadyClasses.delete(className);
    this._schemaCache.delete(className);
    this._resolvedTableNames.delete(className);
    this._tableColumnsCache.delete(className);
  }

  _shouldCacheTableColumns(connection?: any): boolean {
    return !connection || connection === this._db;
  }

  _setTableColumnsCache(className: string, columns: Array<string>, connection?: any): Array<string> {
    if (!this._shouldCacheTableColumns(connection)) {
      return columns;
    }
    const normalizedColumns = [...columns];
    this._tableColumnsCache.set(className, normalizedColumns);
    return normalizedColumns;
  }

  _getFreshTableColumns(className: string, connection?: any): Array<string> {
    const rawName = this._rawTableName(className, connection);
    const db = connection || this._db;
    const columns = db
      .prepare(`PRAGMA table_info(${this._quoteRawTableName(rawName)})`)
      .all()
      .map(column => column.name);
    return this._setTableColumnsCache(className, columns, connection);
  }

  async classExists(className: string, dbOverride?: any): Promise<boolean> {
    const db = dbOverride || this._db;
    if (this._existingClasses.has(className)) {
      if (!this._nullFieldTrackerReadyClasses.has(className)) {
        if (!this._tableExists(className, db)) {
          this._forgetCachedClass(className);
          return false;
        }
        this._ensureNullFieldTrackerColumn(className, db);
      }
      return true;
    }
    const tableExists = this._tableExists(className, db);
    if (tableExists) {
      this._existingClasses.add(className);
      this._ensureNullFieldTrackerColumn(className, db);
      return true;
    }
    return false;
  }

  _getTableColumns(className: string, connection?: any): Array<string> {
    if (this._shouldCacheTableColumns(connection)) {
      const cachedColumns = this._tableColumnsCache.get(className);
      if (cachedColumns) {
        return [...cachedColumns];
      }
    }
    return this._getFreshTableColumns(className, connection);
  }

  _getArrayElementIndexFieldInfo(
    schemaFields: any,
    fieldName: string
  ): ?{
    normalizedFieldName: string,
    rootFieldName: string,
    valueExpression: string,
    typeExpression: string,
  } {
    const normalizedFieldName = this._normalizeIndexFieldPath(fieldName);
    if (normalizedFieldName.indexOf('.') < 0) {
      const field = schemaFields && schemaFields[normalizedFieldName];
      if (!field || field.type !== 'Array') {
        return null;
      }
      return {
        normalizedFieldName,
        rootFieldName: normalizedFieldName,
        valueExpression: 'array_index_item.value',
        typeExpression: 'array_index_item.type',
      };
    }

    const arrayFieldPath = buildArrayRootDotFieldPath(normalizedFieldName, 'array_index_item');
    const rootField = schemaFields && schemaFields[arrayFieldPath.rootFieldName];
    if (
      !rootField ||
      rootField.type !== 'Array' ||
      arrayFieldPath.components.length === 0 ||
      isNumericArrayIndexComponent(arrayFieldPath.components[0])
    ) {
      return null;
    }

    return {
      normalizedFieldName,
      rootFieldName: arrayFieldPath.rootFieldName,
      valueExpression: arrayFieldPath.valueExpression,
      typeExpression: arrayFieldPath.typeExpression,
    };
  }

  _rawArrayElementIndexTableName(className: string, fieldName: string): string {
    return (
      `${this._rawTableName(className)}` +
      `${sqliteArrayIndexTableNamePrefix}${encodeSQLiteFieldToken(fieldName)}`
    );
  }

  _quotedArrayElementIndexTableName(className: string, fieldName: string): string {
    return `"${this._rawArrayElementIndexTableName(className, fieldName).replace(/"/g, '""')}"`;
  }

  _getArrayElementIndexArtifactNames(rawArrayIndexTableName: string): {
    insertTrigger: string,
    deleteTrigger: string,
    updateTrigger: string,
    lookupIndex: string,
    objectIdIndex: string,
  } {
    const artifactBaseName = sanitizeFTS5Identifier(rawArrayIndexTableName);
    return {
      insertTrigger: `"${`${artifactBaseName}_insert`.replace(/"/g, '""')}"`,
      deleteTrigger: `"${`${artifactBaseName}_delete`.replace(/"/g, '""')}"`,
      updateTrigger: `"${`${artifactBaseName}_update`.replace(/"/g, '""')}"`,
      lookupIndex: `"${`${artifactBaseName}_lookup`.replace(/"/g, '""')}"`,
      objectIdIndex: `"${`${artifactBaseName}_objectId`.replace(/"/g, '""')}"`,
    };
  }

  _dropArrayElementIndexArtifactsByRawTableName(
    rawArrayIndexTableName: string,
    transactionalSession?: any
  ): void {
    const db = transactionalSession || this._db;
    const arrayIndexTableName = `"${rawArrayIndexTableName.replace(/"/g, '""')}"`;
    const { insertTrigger, deleteTrigger, updateTrigger } =
      this._getArrayElementIndexArtifactNames(rawArrayIndexTableName);
    db.exec(`DROP TRIGGER IF EXISTS ${updateTrigger}`);
    db.exec(`DROP TRIGGER IF EXISTS ${deleteTrigger}`);
    db.exec(`DROP TRIGGER IF EXISTS ${insertTrigger}`);
    db.exec(`DROP TABLE IF EXISTS ${arrayIndexTableName}`);
  }

  _dropArrayElementIndexArtifactsForField(
    className: string,
    fieldName: string,
    schemaFields: any,
    transactionalSession?: any
  ): void {
    const arrayIndexField = this._getArrayElementIndexFieldInfo(schemaFields, fieldName);
    if (!arrayIndexField) {
      return;
    }
    this._dropArrayElementIndexArtifactsByRawTableName(
      this._rawArrayElementIndexTableName(className, arrayIndexField.normalizedFieldName),
      transactionalSession
    );
  }

  _dropArrayElementIndexArtifactsForClass(className: string, transactionalSession?: any): void {
    const db = transactionalSession || this._db;
    const rawArrayIndexPrefix = `${this._rawTableName(className)}${sqliteArrayIndexTableNamePrefix}`;
    const rows = this._prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      db
    ).all();

    for (const row of rows) {
      if (typeof row.name === 'string' && row.name.startsWith(rawArrayIndexPrefix)) {
        this._dropArrayElementIndexArtifactsByRawTableName(row.name, db);
      }
    }
  }

  _hasStoredIndexForField(className: string, fieldName: string, connection?: any): boolean {
    const storedSchema = this._getStoredSchemaObject(className, connection);
    const storedIndexes = (storedSchema && storedSchema.schema && storedSchema.schema.indexes) || {};

    for (const indexName in storedIndexes) {
      if (!Object.prototype.hasOwnProperty.call(storedIndexes, indexName)) {
        continue;
      }
      const indexDefinition = storedIndexes[indexName] || {};
      for (const indexFieldName in indexDefinition) {
        if (!Object.prototype.hasOwnProperty.call(indexDefinition, indexFieldName)) {
          continue;
        }
        if (this._normalizeIndexFieldPath(indexFieldName) === fieldName) {
          return true;
        }
      }
    }

    return false;
  }

  _getQuotedIndexedArrayElementTableName(
    className: string,
    schemaFields: any,
    fieldName: string,
    connection?: any
  ): ?string {
    const arrayIndexField = this._getArrayElementIndexFieldInfo(schemaFields, fieldName);
    if (!arrayIndexField) {
      return null;
    }
    if (!this._hasStoredIndexForField(className, arrayIndexField.normalizedFieldName, connection)) {
      return null;
    }
    return this._quotedArrayElementIndexTableName(className, arrayIndexField.normalizedFieldName);
  }

  async _ensureArrayElementIndex(
    className: string,
    schemaFields: any,
    fieldName: string,
    transactionalSession?: any
  ): Promise<void> {
    const arrayIndexField = this._getArrayElementIndexFieldInfo(schemaFields, fieldName);
    if (!arrayIndexField) {
      return;
    }

    const columns = this._getTableColumns(className, transactionalSession);
    if (!columns.includes(arrayIndexField.rootFieldName)) {
      return;
    }

    const db = transactionalSession || this._db;
    const tableName = this._tableName(className);
    const arrayIndexTableName = this._quotedArrayElementIndexTableName(
      className,
      arrayIndexField.normalizedFieldName
    );
    const rawArrayIndexTableName = this._rawArrayElementIndexTableName(
      className,
      arrayIndexField.normalizedFieldName
    );
    const {
      insertTrigger,
      deleteTrigger,
      updateTrigger,
      lookupIndex,
      objectIdIndex,
    } = this._getArrayElementIndexArtifactNames(rawArrayIndexTableName);
    const rootColumnSql = `new.${quoteColumnName(arrayIndexField.rootFieldName)}`;
    const quotedObjectId = quoteColumnName('objectId');
    const quotedValueType = quoteColumnName(arrayIndexValueTypeColumn);
    const quotedValue = quoteColumnName(arrayIndexValueColumn);

    // Array membership semantics only care whether one element matches, so the
    // shadow table can tolerate duplicate rows from duplicate array elements.
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${arrayIndexTableName} (` +
        `${quotedObjectId} TEXT NOT NULL, ` +
        `${quotedValueType} TEXT NOT NULL, ` +
        `${quotedValue}` +
        `)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${lookupIndex} ON ${arrayIndexTableName} (` +
        `${quotedValueType}, ${quotedValue}, ${quotedObjectId}` +
        `)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${objectIdIndex} ON ${arrayIndexTableName} (` +
        `${quotedObjectId}` +
        `)`
    );

    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${insertTrigger} AFTER INSERT ON ${tableName} BEGIN ` +
        `DELETE FROM ${arrayIndexTableName} WHERE ${quotedObjectId} = new.${quotedObjectId}; ` +
        `INSERT INTO ${arrayIndexTableName}(${quotedObjectId}, ${quotedValueType}, ${quotedValue}) ` +
        `SELECT new.${quotedObjectId}, ${arrayIndexField.typeExpression}, ${arrayIndexField.valueExpression} ` +
        `FROM json_each(COALESCE(${rootColumnSql}, '[]')) AS array_index_item ` +
        `WHERE ${arrayIndexField.typeExpression} IN (${sqliteIndexedArrayScalarTypeNameSQL}); ` +
        `END`
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${deleteTrigger} AFTER DELETE ON ${tableName} BEGIN ` +
        `DELETE FROM ${arrayIndexTableName} WHERE ${quotedObjectId} = old.${quotedObjectId}; ` +
        `END`
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${updateTrigger} AFTER UPDATE OF ${quoteColumnName(
        arrayIndexField.rootFieldName
      )} ON ${tableName} BEGIN ` +
        `DELETE FROM ${arrayIndexTableName} WHERE ${quotedObjectId} = old.${quotedObjectId}; ` +
        `INSERT INTO ${arrayIndexTableName}(${quotedObjectId}, ${quotedValueType}, ${quotedValue}) ` +
        `SELECT new.${quotedObjectId}, ${arrayIndexField.typeExpression}, ${arrayIndexField.valueExpression} ` +
        `FROM json_each(COALESCE(${rootColumnSql}, '[]')) AS array_index_item ` +
        `WHERE ${arrayIndexField.typeExpression} IN (${sqliteIndexedArrayScalarTypeNameSQL}); ` +
        `END`
    );

    const backfillField = this._getArrayElementIndexFieldInfo(
      schemaFields,
      arrayIndexField.normalizedFieldName
    );
    if (!backfillField) {
      return;
    }

    db.exec(`DELETE FROM ${arrayIndexTableName}`);
    db.exec(
      `INSERT INTO ${arrayIndexTableName}(${quotedObjectId}, ${quotedValueType}, ${quotedValue}) ` +
        `SELECT base.${quotedObjectId}, ${backfillField.typeExpression}, ${backfillField.valueExpression} ` +
        `FROM ${tableName} AS base, ` +
        `json_each(COALESCE(base.${quoteColumnName(backfillField.rootFieldName)}, '[]')) AS array_index_item ` +
        `WHERE ${backfillField.typeExpression} IN (${sqliteIndexedArrayScalarTypeNameSQL})`
    );
  }

  _rawFTSTableName(className: string, fieldName: string, diacriticSensitive: boolean): string {
    const suffix = diacriticSensitive ? 'accent' : 'folded';
    return `${this._rawTableName(className)}__fts__${sanitizeFTS5Identifier(fieldName)}__${suffix}`;
  }

  _quotedFTSTableName(className: string, fieldName: string, diacriticSensitive: boolean): string {
    return `"${this._rawFTSTableName(className, fieldName, diacriticSensitive).replace(/"/g, '""')}"`;
  }

  _getFTS5TriggerNames(rawFTSTableName: string): {
    insertTrigger: string,
    deleteTrigger: string,
    updateTrigger: string,
  } {
    const triggerBaseName = sanitizeFTS5Identifier(rawFTSTableName);
    return {
      insertTrigger: `"${`${triggerBaseName}_insert`.replace(/"/g, '""')}"`,
      deleteTrigger: `"${`${triggerBaseName}_delete`.replace(/"/g, '""')}"`,
      updateTrigger: `"${`${triggerBaseName}_update`.replace(/"/g, '""')}"`,
    };
  }

  _dropFTS5ArtifactsByRawTableName(rawFTSTableName: string, transactionalSession?: any): void {
    const db = transactionalSession || this._db;
    const ftsTableName = `"${rawFTSTableName.replace(/"/g, '""')}"`;
    const { insertTrigger, deleteTrigger, updateTrigger } =
      this._getFTS5TriggerNames(rawFTSTableName);
    db.exec(`DROP TRIGGER IF EXISTS ${updateTrigger}`);
    db.exec(`DROP TRIGGER IF EXISTS ${deleteTrigger}`);
    db.exec(`DROP TRIGGER IF EXISTS ${insertTrigger}`);
    db.exec(`DROP TABLE IF EXISTS ${ftsTableName}`);
  }

  _dropFTS5ArtifactsForField(
    className: string,
    fieldName: string,
    transactionalSession?: any
  ): void {
    validateFieldName(fieldName);
    this._dropFTS5ArtifactsByRawTableName(
      this._rawFTSTableName(className, fieldName, false),
      transactionalSession
    );
    this._dropFTS5ArtifactsByRawTableName(
      this._rawFTSTableName(className, fieldName, true),
      transactionalSession
    );
  }

  _dropFTS5ArtifactsForClass(className: string, transactionalSession?: any): void {
    const db = transactionalSession || this._db;
    const rawFTSPrefix = `${this._rawTableName(className)}__fts__`;
    const rows = this._prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      db
    ).all();

    for (const row of rows) {
      if (typeof row.name === 'string' && row.name.startsWith(rawFTSPrefix)) {
        this._dropFTS5ArtifactsByRawTableName(row.name, db);
      }
    }
  }

  async _ensureFTS5Index(
    className: string,
    fieldName: string,
    diacriticSensitive: boolean,
    transactionalSession?: any
  ): Promise<void> {
    validateFieldName(fieldName);
    const columns = this._getTableColumns(className, transactionalSession);
    if (!columns.includes(fieldName)) {
      return;
    }

    const db = transactionalSession || this._db;
    const rawTableName = this._rawTableName(className);
    const tableName = this._tableName(className);
    const rawFTSTableName = this._rawFTSTableName(className, fieldName, diacriticSensitive);
    const ftsTableName = this._quotedFTSTableName(className, fieldName, diacriticSensitive);
    const tokenizer = diacriticSensitive ? 'unicode61 remove_diacritics 0' : 'unicode61 remove_diacritics 1';

    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTableName} USING fts5(` +
      `"${fieldName.replace(/"/g, '""')}", ` +
      `content='${rawTableName.replace(/'/g, "''")}', ` +
      `content_rowid='rowid', ` +
      `tokenize='${tokenizer}'` +
      `)`
    );

    const { insertTrigger, deleteTrigger, updateTrigger } =
      this._getFTS5TriggerNames(rawFTSTableName);
    const quotedFieldName = quoteColumnName(fieldName);

    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${insertTrigger} AFTER INSERT ON ${tableName} BEGIN ` +
      `INSERT INTO ${ftsTableName}(rowid, ${quotedFieldName}) VALUES (new.rowid, new.${quotedFieldName}); ` +
      `END`
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${deleteTrigger} AFTER DELETE ON ${tableName} BEGIN ` +
      `INSERT INTO ${ftsTableName}(${ftsTableName}, rowid, ${quotedFieldName}) ` +
      `VALUES('delete', old.rowid, old.${quotedFieldName}); ` +
      `END`
    );
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${updateTrigger} AFTER UPDATE OF ${quotedFieldName} ON ${tableName} BEGIN ` +
      `INSERT INTO ${ftsTableName}(${ftsTableName}, rowid, ${quotedFieldName}) ` +
      `VALUES('delete', old.rowid, old.${quotedFieldName}); ` +
      `INSERT INTO ${ftsTableName}(rowid, ${quotedFieldName}) VALUES (new.rowid, new.${quotedFieldName}); ` +
      `END`
    );

    db.prepare(`INSERT INTO ${ftsTableName}(${ftsTableName}) VALUES('rebuild')`).run();
  }

  async _ensureColumnsExist(className: string, row: Object, schema?: SchemaType, dbOverride?: any): Promise<void> {
    const db = dbOverride || this._db;
    const tableName = this._tableName(className);
    const existingCols = new Set(this._getTableColumns(className, db));

    const fields = schema ? schema.fields || {} : {};
    const cachedSchema = this._schemaCache.get(className) || { fields: {} };
    let schemaChanged = false;

    for (const key in row) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) {
        continue;
      }
      if (key === nullFieldTrackerColumn) {
        if (!existingCols.has(key)) {
          db.exec(`ALTER TABLE ${tableName} ADD COLUMN "${key}" TEXT`);
          existingCols.add(key);
        }
        continue;
      }
      if (key === writeSequenceColumn) {
        if (!existingCols.has(key)) {
          db.exec(`ALTER TABLE ${tableName} ADD COLUMN "${key}" INTEGER`);
          existingCols.add(key);
        }
        continue;
      }
      if (key.indexOf('.') >= 0) {
        const rootKey = key.split('.')[0];
        const rootFieldType =
          fields[rootKey] ||
          cachedSchema.fields[rootKey] ||
          getImplicitHiddenUserFieldSchema(className, rootKey);
        if (!existingCols.has(rootKey)) {
          if (row[key] === null && !rootFieldType) {
            continue;
          }
          db.exec(`ALTER TABLE ${tableName} ADD COLUMN "${rootKey.replace(/"/g, '""')}" TEXT`);
          existingCols.add(rootKey);
          if (!rootFieldType) {
            cachedSchema.fields[rootKey] = { type: 'Object' };
            this._schemaCache.set(className, cachedSchema);
            schemaChanged = true;
          }
        }
        continue;
      }
      let fieldType =
        fields[key] || cachedSchema.fields[key] || getImplicitHiddenUserFieldSchema(className, key);
      if (!fieldType) {
        if (row[key] === null) {
          continue;
        }
        fieldType = inferFieldType(key, row[key]);
        cachedSchema.fields[key] = fieldType;
        this._schemaCache.set(className, cachedSchema);
        schemaChanged = true;
      }
      if (!existingCols.has(key)) {
        const sqliteType = parseTypeToSQLiteType(fieldType);
        db.exec(`ALTER TABLE ${tableName} ADD COLUMN "${key.replace(/"/g, '""')}" ${sqliteType}`);
        existingCols.add(key);
      }
    }

    if (schemaChanged) {
      const storedSchema = this._getStoredSchemaObject(className, dbOverride);
      const schemaObj = storedSchema ? storedSchema.schema : { className, fields: {} };
      schemaObj.fields = {
        ...(schemaObj.fields || {}),
        ...cachedSchema.fields,
      };
      this._saveStoredSchemaObject(
        className,
        schemaObj,
        storedSchema ? storedSchema.isParseClass : undefined,
        dbOverride
      );
    }

    this._setTableColumnsCache(className, [...existingCols], db);
  }

  async setClassLevelPermissions(className: string, clps: any): Promise<void> {
    const row = this._prepare('SELECT "schema" FROM "_SCHEMA" WHERE "className" = ?')
      .get(className);
    if (!row) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, `Class ${className} does not exist.`);
    }
    let schemaObj = {};
    try {
      schemaObj = JSON.parse(row.schema);
    } catch {
      /* */
    }
    schemaObj.classLevelPermissions = clps;
    this._schemaCache.set(className, schemaObj);
    this._prepare('UPDATE "_SCHEMA" SET "schema" = ? WHERE "className" = ?')
      .run(JSON.stringify(schemaObj), className);
    this._notifySchemaChange();
  }

  async createClass(className: string, schema: SchemaType, dbOverride?: any): Promise<any> {
    const db = dbOverride || this._db;
    const tableName = this._tableName(className);
    const existing = this._prepare(
      'SELECT "className" FROM "_SCHEMA" WHERE "className" = ?',
      dbOverride
    )
      .get(className);
    if (existing) {
      throw new Parse.Error(Parse.Error.DUPLICATE_VALUE, `Class ${className} already exists.`);
    }

    const storedSchema = cloneMutableValue(schema) || { fields: {} };
    storedSchema.className = className;
    storedSchema.fields = { ...(storedSchema.fields || {}) };

    const sqliteSchema = normalizeSQLiteSchema(className, cloneMutableValue(storedSchema));
    const fields = Object.assign({}, sqliteSchema ? sqliteSchema.fields : {});

    const colDefs = [];
    for (const fieldName in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) {
        continue;
      }
      const fieldType = fields[fieldName];
      if (fieldType.type === 'Relation') {
        continue;
      }
      const sqliteType = parseTypeToSQLiteType(fieldType);
      if (fieldName === 'objectId') {
        colDefs.push(`"objectId" TEXT PRIMARY KEY`);
      } else {
        colDefs.push(`"${fieldName.replace(/"/g, '""')}" ${sqliteType}`);
      }
    }

    if (!fields.objectId) {
      colDefs.unshift(`"objectId" TEXT PRIMARY KEY`);
    }
    colDefs.push(`"${nullFieldTrackerColumn}" TEXT`);
    colDefs.push(`"${writeSequenceColumn}" INTEGER`);

    const createStmt = `CREATE TABLE IF NOT EXISTS ${tableName} (${colDefs.join(', ')})`;
    db.exec(createStmt);
    const createdColumns = [];
    let hasObjectIdColumn = false;
    for (const fieldName in fields) {
      if (!Object.prototype.hasOwnProperty.call(fields, fieldName)) {
        continue;
      }
      if (fields[fieldName].type === 'Relation') {
        continue;
      }
      if (fieldName === 'objectId') {
        hasObjectIdColumn = true;
      }
      createdColumns.push(fieldName);
    }
    if (!hasObjectIdColumn) {
      createdColumns.unshift('objectId');
    }
    createdColumns.push(nullFieldTrackerColumn);
    createdColumns.push(writeSequenceColumn);
    this._setTableColumnsCache(className, createdColumns, db);

    const isParseClass = isSQLiteInternalClass(className) ? 0 : 1;
    const finalSchema = storedSchema;
    this._saveStoredSchemaObject(className, finalSchema, isParseClass, dbOverride);

    if (schema && schema.indexes) {
      await this.setIndexesWithSchemaFormat(
        className,
        schema.indexes,
        {},
        storedSchema.fields,
        dbOverride
      );
    }

    if (!dbOverride || dbOverride === this._db) {
      this._notifySchemaChange();
    }
    return toParseSchema(finalSchema);
  }

  async _ensureClassExists(className: string, schema: SchemaType, dbOverride?: any): Promise<void> {
    const db = dbOverride || this._db;
    if (await this.classExists(className, db)) {
      return;
    }
    try {
      await this.createClass(className, schema, db);
    } catch (error) {
      if (error.code !== Parse.Error.DUPLICATE_VALUE || !(await this.classExists(className, db))) {
        throw error;
      }
    }
  }

  async addFieldIfNotExists(className: string, fieldName: string, type: any): Promise<void> {
    const tableName = this._tableName(className);

    if (!(await this.classExists(className))) {
      await this._ensureClassExists(className, { fields: { [fieldName]: type } });
      return;
    }

    if (type && type.type === 'GeoPoint') {
      const schemaObj = await this.getClass(className);
      if (
        schemaObj.fields &&
        Object.keys(schemaObj.fields).some(
          existingField =>
            existingField !== fieldName && schemaObj.fields[existingField].type === 'GeoPoint'
        )
      ) {
        throw new Parse.Error(
          Parse.Error.INCORRECT_TYPE,
          'SQLite only supports one GeoPoint field in a class.'
        );
      }
    }

    if (type.type !== 'Relation') {
      const columns = this._getTableColumns(className);
      const exists = columns.includes(fieldName);
      if (!exists) {
        const sqliteType = parseTypeToSQLiteType(type);
        this._db.exec(
          `ALTER TABLE ${tableName} ADD COLUMN "${fieldName.replace(/"/g, '""')}" ${sqliteType}`
        );
        this._setTableColumnsCache(className, [...columns, fieldName]);
      }
    }

    const row = this._prepare('SELECT "schema" FROM "_SCHEMA" WHERE "className" = ?')
      .get(className);
    let schemaObj = {};
    if (row) {
      try {
        schemaObj = JSON.parse(row.schema);
      } catch {
        /* */
      }
    }
    schemaObj.fields = schemaObj.fields || {};
    schemaObj.fields[fieldName] = type;
    this._schemaCache.set(className, schemaObj);
    this._prepare('INSERT INTO "_SCHEMA" ("className", "schema", "isParseClass") VALUES (?, ?, 1) ON CONFLICT("className") DO UPDATE SET "schema" = excluded."schema"')
      .run(className, JSON.stringify(schemaObj));
    this._notifySchemaChange();
  }

  async updateFieldOptions(className: string, fieldName: string, type: any): Promise<void> {
    await this.addFieldIfNotExists(className, fieldName, type);
  }

  async deleteClass(className: string): Promise<any> {
    const tableName = this._tableName(className);
    const row = this._prepare('SELECT "schema" FROM "_SCHEMA" WHERE "className" = ?')
      .get(className);
    if (row) {
      try {
        const schema = JSON.parse(row.schema);
        if (schema && schema.fields) {
          for (const field in schema.fields) {
            if (!Object.prototype.hasOwnProperty.call(schema.fields, field)) {
              continue;
            }
            if (schema.fields[field].type === 'Relation') {
              const joinTableName = this._tableName(this._joinTableClassName(field, className));
              this._db.exec(`DROP TABLE IF EXISTS ${joinTableName}`);
            }
          }
        }
      } catch {
        /* */
      }
    }
    this._dropArrayElementIndexArtifactsForClass(className);
    this._dropFTS5ArtifactsForClass(className);
    this._db.exec(`DROP TABLE IF EXISTS ${tableName}`);
    this._prepare('DELETE FROM "_SCHEMA" WHERE "className" = ?').run(className);
    this._forgetCachedClass(className);
    this._notifySchemaChange();
    return className.indexOf('_Join:') !== 0;
  }

  async deleteAllClasses(): Promise<void> {
    const rows = this._prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    for (const row of rows) {
      this._db.exec(`DROP TABLE IF EXISTS "${row.name.replace(/"/g, '""')}"`);
    }
    this._stmtCache.clear();
    this._existingClasses.clear();
    this._nullFieldTrackerReadyClasses.clear();
    this._schemaCache.clear();
    this._resolvedTableNames.clear();
    this._tableColumnsCache.clear();
    this._initSchemaTable();
    this._notifySchemaChange();
  }

  async deleteFields(className: string, schema: SchemaType, fieldNames: Array<string>): Promise<void> {
    const row = this._prepare('SELECT "schema" FROM "_SCHEMA" WHERE "className" = ?')
      .get(className);
    if (!row) {
      return;
    }

    const schemaObj = JSON.parse(row.schema);
    const deletedFieldNames = new Set(fieldNames);
    const relationalFieldNames = new Set();
    for (const fieldName of fieldNames) {
      if (schemaObj.fields && schemaObj.fields[fieldName]) {
        if (schemaObj.fields[fieldName].type === 'Relation') {
          relationalFieldNames.add(fieldName);
          const joinTableName = this._tableName(this._joinTableClassName(fieldName, className));
          this._db.exec(`DROP TABLE IF EXISTS ${joinTableName}`);
        }
        delete schemaObj.fields[fieldName];
      }
    }

    if (schemaObj.indexes) {
      for (const indexName in schemaObj.indexes) {
        if (!Object.prototype.hasOwnProperty.call(schemaObj.indexes, indexName)) {
          continue;
        }
        const index = schemaObj.indexes[indexName];
        const indexFields = [];
        if (index) {
          for (const fieldName in index) {
            if (Object.prototype.hasOwnProperty.call(index, fieldName)) {
              indexFields.push(fieldName);
            }
          }
        }
        if (indexFields.some(fieldName => deletedFieldNames.has(fieldName))) {
          delete schemaObj.indexes[indexName];
        }
      }
      if (Object.keys(schemaObj.indexes).length === 0) {
        delete schemaObj.indexes;
      }
    }

    const deletedColumnNames = fieldNames.filter(fieldName => !relationalFieldNames.has(fieldName));
    for (const fieldName of deletedColumnNames) {
      this._dropArrayElementIndexArtifactsForField(className, fieldName, schema.fields || {});
      this._dropFTS5ArtifactsForField(className, fieldName);
    }
    if (deletedColumnNames.length > 0) {
      const rawName = this._rawTableName(className);
      const tableName = this._tableName(className);
      const rebuildTableRawName =
        `${rawName}__rebuild__${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const rebuildTableName = `"${rebuildTableRawName.replace(/"/g, '""')}"`;
      const tableInfo = this._db.prepare(`PRAGMA table_info(${this._quoteRawTableName(rawName)})`).all();
      const keptColumns = tableInfo.filter(column => !deletedFieldNames.has(column.name));

      if (keptColumns.length > 0) {
        const columnDefinitions = keptColumns.map(column => {
          let definition = `${quoteColumnName(column.name)} ${column.type || 'TEXT'}`;
          if (column.notnull) {
            definition += ' NOT NULL';
          }
          if (column.dflt_value !== null && column.dflt_value !== undefined) {
            definition += ` DEFAULT ${column.dflt_value}`;
          }
          if (column.pk) {
            definition += ' PRIMARY KEY';
          }
          return definition;
        });
        const keptColumnNames = keptColumns.map(column => quoteColumnName(column.name));

        this._db.exec(`CREATE TABLE ${rebuildTableName} (${columnDefinitions.join(', ')})`);
        this._db.exec(
          `INSERT INTO ${rebuildTableName} (${keptColumnNames.join(', ')}) ` +
            `SELECT ${keptColumnNames.join(', ')} FROM ${tableName}`
        );
        this._db.exec(`DROP TABLE ${tableName}`);
        this._db.exec(
          `ALTER TABLE ${rebuildTableName} RENAME TO "${rawName.replace(/"/g, '""')}"`
        );
        this._stmtCache.clear();
        this._setTableColumnsCache(
          className,
          keptColumns.map(column => column.name),
          this._db
        );
      }
    }

    this._schemaCache.set(className, schemaObj);
    this._prepare('UPDATE "_SCHEMA" SET "schema" = ? WHERE "className" = ?')
      .run(JSON.stringify(schemaObj), className);

    if (schemaObj.indexes && Object.keys(schemaObj.indexes).length > 0) {
      await this.setIndexesWithSchemaFormat(className, schemaObj.indexes, {}, schemaObj.fields);
    }

    this._notifySchemaChange();
  }

  async getAllClasses(): Promise<Array<any>> {
    const rows = this._prepare('SELECT * FROM "_SCHEMA" WHERE "isParseClass" = 1').all();
    return rows.map(row => {
      let schemaObj = {};
      try {
        schemaObj = JSON.parse(row.schema);
      } catch {
        schemaObj = {};
      }
      return toParseSchema({ className: row.className, ...schemaObj });
    });
  }

  async getClass(className: string): Promise<any> {
    const row = this._prepare('SELECT "schema" FROM "_SCHEMA" WHERE "className" = ?')
      .get(className);
    if (!row) {
      throw undefined;
    }
    let schemaObj = {};
    try {
      schemaObj = JSON.parse(row.schema);
    } catch {
      schemaObj = {};
    }
    return toParseSchema({ className, ...schemaObj });
  }

  _getStoredSchemaObject(className: string, connection?: any): any {
    const row = this._prepare(
      'SELECT "schema", "isParseClass" FROM "_SCHEMA" WHERE "className" = ?',
      connection
    )
      .get(className);
    if (!row) {
      return null;
    }
    let schemaObj = {};
    try {
      schemaObj = JSON.parse(row.schema);
    } catch {
      schemaObj = {};
    }
    schemaObj = normalizeStoredSchemaObject(className, schemaObj);
    return {
      isParseClass: row.isParseClass,
      schema: schemaObj,
    };
  }

  _saveStoredSchemaObject(
    className: string,
    schemaObj: any,
    isParseClass?: ?number,
    connection?: any
  ): void {
    const normalizedSchemaObj = normalizeStoredSchemaObject(className, schemaObj || {});
    const stored = this._getStoredSchemaObject(className, connection);
    const parseClassFlag =
      isParseClass !== undefined && isParseClass !== null
        ? isParseClass
        : stored && stored.isParseClass !== undefined
          ? stored.isParseClass
          : isSQLiteInternalClass(className)
            ? 0
            : 1;

    this._prepare(
      'INSERT INTO "_SCHEMA" ("className", "schema", "isParseClass") VALUES (?, ?, ?) ON CONFLICT("className") DO UPDATE SET "schema" = excluded."schema", "isParseClass" = excluded."isParseClass"',
      connection
    ).run(className, JSON.stringify(normalizedSchemaObj), parseClassFlag);
    if (!connection || connection === this._db) {
      this._existingClasses.add(className);
      if (className === '_SCHEMA' || isJoinTableClass(className)) {
        this._nullFieldTrackerReadyClasses.delete(className);
      } else {
        this._nullFieldTrackerReadyClasses.add(className);
      }
      this._schemaCache.set(className, normalizedSchemaObj);
    }
  }

  _normalizeIndexColumnName(fieldName: string): string {
    if (fieldName === '_id' || fieldName === 'objectId') {
      return 'objectId';
    }
    if (fieldName.startsWith('_p_')) {
      return fieldName.replace(/^_p_/, '');
    }
    return fieldName;
  }

  _normalizeIndexFieldPath(fieldName: string): string {
    if (fieldName.indexOf('.') < 0) {
      return this._normalizeIndexColumnName(fieldName);
    }
    const parts = fieldName.split('.');
    const rootFieldName = this._normalizeIndexColumnName(parts.shift());
    return [rootFieldName, ...parts].join('.');
  }

  _buildIndexFieldExpression(fieldName: string): { expression: string, requiredColumns: Array<string> } {
    const normalizedFieldName = this._normalizeIndexFieldPath(fieldName);
    if (normalizedFieldName.indexOf('.') < 0) {
      validateFieldName(normalizedFieldName);
      return {
        expression: quoteColumnName(normalizedFieldName),
        requiredColumns: [normalizedFieldName],
      };
    }

    const dotFieldPath = buildDotFieldPath(normalizedFieldName);
    return {
      expression: dotFieldPath.valueExpression,
      requiredColumns: [dotFieldPath.rootFieldName],
    };
  }

  _fieldExistsForIndex(fields: any, fieldName: string): boolean {
    if (defaultSchemaIndexFields.has(fieldName)) {
      return true;
    }
    const normalizedFieldName = this._normalizeIndexFieldPath(fieldName);
    if (normalizedFieldName.indexOf('.') >= 0) {
      const [rootFieldName] = normalizedFieldName.split('.');
      return Object.prototype.hasOwnProperty.call(fields || {}, rootFieldName);
    }
    return Object.prototype.hasOwnProperty.call(fields || {}, normalizedFieldName);
  }

  _buildSchemaIndexesObject(indexes: Array<any>): any {
    return indexes.reduce((output, index) => {
      output[index.name] = cloneIndexDefinition(index.key);
      return output;
    }, {});
  }

  _buildRawStorageObject(row: any): any {
    const output = {};
    const legacyACL = {};

    const sourceRow = row || {};
    for (const key in sourceRow) {
      if (!Object.prototype.hasOwnProperty.call(sourceRow, key) || isAdapterInternalColumn(key)) {
        continue;
      }
      let value = sourceRow[key];
      if (typeof value === 'string') {
        try {
          value = JSON.parse(value);
        } catch {
          /* */
        }
      }
      output[key] = value;
    }

    if (Array.isArray(output._wperm)) {
      output._wperm.forEach(entry => {
        legacyACL[entry] = { w: true };
      });
    }
    if (Array.isArray(output._rperm)) {
      output._rperm.forEach(entry => {
        if (!legacyACL[entry]) {
          legacyACL[entry] = { r: true };
        } else {
          legacyACL[entry].r = true;
        }
      });
    }
    if (Object.keys(legacyACL).length > 0) {
      output._acl = legacyACL;
    }

    return output;
  }

  _transformDuplicateKeyError(err: any, className: string): any {
    if (!isUniqueConstraintError(err)) {
      return err;
    }
    logger.error(
      'Duplicate key error:',
      buildDuplicateKeyLogMessage(this._collectionPrefix + className, err)
    );
    const duplicatedField = getDuplicatedFieldFromUniqueConstraint(className, err);
    const parseError = new Parse.Error(
      Parse.Error.DUPLICATE_VALUE,
      'A duplicate value for a field with unique values was provided'
    );
    parseError.underlyingError = err;
    if (duplicatedField) {
      parseError.userInfo = { duplicated_field: duplicatedField };
    }
    return parseError;
  }

  _parseObjectToSQLiteRow(className: string, object: any): Object {
    const row = {};
    const copy = handleDotFields({ ...object });
    const explicitNullFields = new Set();
    validateNestedKeys(copy);
    for (const key in copy) {
      if (!Object.prototype.hasOwnProperty.call(copy, key)) {
        continue;
      }
      const provider = getAuthDataProviderFieldName(key);
      if (provider) {
        copy.authData = copy.authData || {};
        copy.authData[provider] = copy[key];
        delete copy[key];
      }
    }
    for (const key in copy) {
      if (!Object.prototype.hasOwnProperty.call(copy, key)) {
        continue;
      }
      const val = copy[key];
      if (typeof val === 'undefined') {
        continue;
      }
      const sqliteValue = toSQLiteValue(val);
      row[key] = sqliteValue;
      if (
        shouldPersistExplicitNullField(className, key) &&
        shouldTrackCoercedNullStorageValue(val, sqliteValue)
      ) {
        explicitNullFields.add(key);
      }
    }
    if (explicitNullFields.size > 0) {
      row[nullFieldTrackerColumn] = JSON.stringify([...explicitNullFields]);
    }
    return row;
  }

  _sqliteRowToParseObject(className: string, row: any, schema: SchemaType): Object {
    if (!row) {
      return null;
    }
    const object = {};
    const cachedSchema = this._schemaCache.get(className);
    const fields = Object.assign({}, cachedSchema ? cachedSchema.fields : {}, schema ? schema.fields : {});
    const explicitNullFields = parseTrackedNullFields(row[nullFieldTrackerColumn]);

    for (const key in row) {
      if (!Object.prototype.hasOwnProperty.call(row, key) || isAdapterInternalColumn(key)) {
        continue;
      }
      const val = row[key];
      if (val === undefined) {
        continue;
      }
      if (val === null) {
        if (key === 'createdAt' || key === 'updatedAt' || key === '_created_at' || key === '_updated_at') {
          continue;
        }
        if (className === '_User' && (hiddenUserSchemaFields.has(key) || key === 'authData')) {
          continue;
        }
        if (explicitNullFields.has(key)) {
          object[key] = null;
        }
        continue;
      }
      if (key === 'createdAt' || key === 'updatedAt' || key === '_created_at' || key === '_updated_at') {
        const targetKey = key === '_created_at' ? 'createdAt' : key === '_updated_at' ? 'updatedAt' : key;
        object[targetKey] = typeof val === 'string' ? val : new Date(val).toISOString();
        continue;
      }
      if (className === '_Audience') {
        if (key === 'lastUsed' || key === '_last_used') {
          object.lastUsed = typeof val === 'string' ? new Date(val).toISOString() : new Date(val).toISOString();
          continue;
        }
        if (key === 'timesUsed' || key === 'times_used') {
          object.timesUsed = val;
          continue;
        }
      }

      let fieldSchema = fields[key];
      if (key === 'authData' && (!fieldSchema || fieldSchema.type !== 'Object')) {
        fieldSchema = { type: 'Object' };
      }
      if (fieldSchema) {
        if (
          className === '_User' &&
          userDateLikeStringFields.has(key) &&
          typeof val === 'string' &&
          !isNaN(Date.parse(val))
        ) {
          object[key] = {
            __type: 'Date',
            iso: new Date(val).toISOString(),
          };
          continue;
        }
        if (fieldSchema.type === 'Pointer' && typeof val === 'string') {
          object[key] = {
            __type: 'Pointer',
            className: fieldSchema.targetClass,
            objectId: val,
          };
          continue;
        }
        if (fieldSchema.type === 'Relation') {
          object[key] = {
            __type: 'Relation',
            className: fieldSchema.targetClass,
          };
          continue;
        }
        if (fieldSchema.type === 'File' && typeof val === 'string') {
          object[key] = {
            __type: 'File',
            name: val,
          };
          continue;
        }
        if (fieldSchema.type === 'Date' && typeof val === 'string') {
          object[key] = {
            __type: 'Date',
            iso: val,
          };
          continue;
        }
      }

      object[key] = sqliteValueToParseValue(val, fieldSchema);
    }

    // Explicit nulls may be tracked without a backing SQLite column when Parse
    // accepted a null write before the field had any concrete schema type.
    explicitNullFields.forEach(fieldName => {
      if (fieldName in object) {
        return;
      }
      if (
        fieldName === 'createdAt' ||
        fieldName === 'updatedAt' ||
        fieldName === '_created_at' ||
        fieldName === '_updated_at'
      ) {
        return;
      }
      if (className === '_User' && (hiddenUserSchemaFields.has(fieldName) || fieldName === 'authData')) {
        return;
      }
      object[fieldName] = null;
    });

    if (fields) {
      for (const key in fields) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) {
          continue;
        }
        if (fields[key].type === 'Relation' && !object[key]) {
          object[key] = {
            __type: 'Relation',
            className: fields[key].targetClass,
          };
        }
      }
    }

    return object;
  }

  async createObject(
    className: string,
    schema: SchemaType,
    object: any,
    transactionalSession?: any
  ): Promise<any> {
    // `better-sqlite3` completes adapter work synchronously in-process. A
    // single top-level hop keeps request scheduling closer to Mongo/Postgres,
    // which avoids SQLite-only timing skew in triggers and background tasks.
    if (shouldYieldBeforeTopLevelSQLiteOperation(transactionalSession)) {
      await waitForNextEventLoopTurn();
    }
    const db = transactionalSession || this._db;
    if (shouldIgnoreSQLiteOperationAfterShutdown(db, this._isShutDown)) {
      return { ops: [object] };
    }
    await this._ensureClassExists(className, schema, db);
    const row = this._parseObjectToSQLiteRow(className, object);
    row[writeSequenceColumn] = this._nextWriteSequence();
    await this._ensureColumnsExist(className, row, schema, db);
    const existingTableColumns = new Set(this._getTableColumns(className, db));
    if (className === '_Idempotency') {
      this._deleteExpiredIdempotencyRecords(db);
    }

    const persistedRow = {};
    for (const key in row) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) {
        continue;
      }
      if (key === nullFieldTrackerColumn || row[key] !== null || existingTableColumns.has(key)) {
        persistedRow[key] = row[key];
      }
    }

    const cols = [];
    const placeholders = [];
    const values = [];
    for (const key in persistedRow) {
      if (!Object.prototype.hasOwnProperty.call(persistedRow, key)) {
        continue;
      }
      cols.push(quoteColumnName(key));
      placeholders.push('?');
      values.push(persistedRow[key]);
    }

    const stmtSql = `INSERT INTO ${this._tableName(className)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
    try {
      if (shouldYieldBeforeTopLevelSQLiteOperation(transactionalSession)) {
        await waitForNextEventLoopTurn();
      }
      this._prepare(stmtSql, transactionalSession).run(...values);
    } catch (err) {
      throw this._transformDuplicateKeyError(err, className);
    }
    return { ops: [object] };
  }

  _buildWhereClause(
    className: string,
    schema: SchemaType,
    query: QueryType,
    caseInsensitive: boolean = false,
    preserveSpecialFieldNames: boolean = false
  ): { sql: string, params: Array<any>, orderBys: Array<string>, orderByParams: Array<any> } {
    if (!query) {
      return { sql: '', params: [], orderBys: [], orderByParams: [] };
    }
    const cachedSchema = this._schemaCache.get(className);
    const schemaFields = {
      ...((cachedSchema && cachedSchema.fields) || {}),
      ...((schema && schema.fields) || {}),
    };
    const conditions = [];
    const params = [];
    const orderBys = [];
    const orderByParams = [];

    for (const key in query) {
      if (!Object.prototype.hasOwnProperty.call(query, key)) {
        continue;
      }
      const val = query[key];
      const isDotNotation = key.indexOf('.') >= 0;
      const authDataProvider = getAuthDataProviderFieldName(key);
      const normalizedKey =
        !preserveSpecialFieldNames && !authDataProvider && !isDotNotation
          ? normalizeStorageFieldName(key)
          : key;

      if (key === '$or' || key === '$and' || key === '$nor') {
        const subConds = [];
        for (const subQuery of val) {
          const res = this._buildWhereClause(
            className,
            schema,
            subQuery,
            caseInsensitive,
            preserveSpecialFieldNames
          );
          if (res.sql) {
            subConds.push(`(${res.sql})`);
            params.push(...res.params);
          }
        }
        if (subConds.length > 0) {
          if (key === '$or') {
            conditions.push(`(${subConds.join(' OR ')})`);
          } else if (key === '$and') {
            conditions.push(`(${subConds.join(' AND ')})`);
          } else if (key === '$nor') {
            conditions.push(`NOT (${subConds.join(' OR ')})`);
          }
        }
        continue;
      }

      if (schemaFields[normalizedKey] && schemaFields[normalizedKey].type === 'Relation') {
        continue;
      }

      if (schemaFields[normalizedKey]) {
        const fieldType = schemaFields[normalizedKey].type;
        if (fieldType === 'Number' && typeof val === 'boolean') {
          conditions.push('1 = 0');
          continue;
        }
        if (fieldType === 'Boolean' && typeof val === 'number') {
          conditions.push('1 = 0');
          continue;
        }
      }

      if (isQueryOperatorObject(val)) {
        for (const op in val) {
          if (!Object.prototype.hasOwnProperty.call(val, op)) {
            continue;
          }
          const opVal = val[op];
          if (opVal && typeof opVal === 'object' && opVal.$relativeTime) {
            if (['$lt', '$lte', '$gt', '$gte'].indexOf(op) === -1) {
              throw new Parse.Error(
                Parse.Error.INVALID_JSON,
                '$relativeTime can only be used with the $lt, $lte, $gt, and $gte operators'
              );
            }
            if (schemaFields[key] && schemaFields[key].type !== 'Date') {
              throw new Parse.Error(
                Parse.Error.INVALID_JSON,
                '$relativeTime can only be used with Date field'
              );
            }
            const parserResult = Utils.relativeTimeToDate(opVal.$relativeTime);
            if (parserResult.status === 'success') {
              val[op] = parserResult.result;
            } else {
              throw new Parse.Error(
                Parse.Error.INVALID_JSON,
                `bad $relativeTime (${opVal.$relativeTime}) value. ${parserResult.info}`
              );
            }
          }
        }
      }

      const dotFieldPath = isDotNotation ? buildDotFieldPath(key) : null;
      const dotFieldRootExists =
        dotFieldPath && doesSQLiteFieldExistInSchema(schemaFields, dotFieldPath.rootFieldName);
      const dotFieldUsesRootArrayTraversal =
        dotFieldPath &&
        dotFieldRootExists &&
        schemaFields[dotFieldPath.rootFieldName] &&
        schemaFields[dotFieldPath.rootFieldName].type === 'Array' &&
        dotFieldPath.components.length > 0 &&
        !isNumericArrayIndexComponent(dotFieldPath.components[0]);
      const dotFieldArrayPath = dotFieldUsesRootArrayTraversal
        ? buildArrayRootDotFieldPath(key)
        : null;
      const dotFieldArraySourceSql = dotFieldArrayPath
        ? quoteColumnName(dotFieldArrayPath.rootFieldName)
        : null;
      let targetSql;
      if (authDataProvider) {
        targetSql = `json_extract("authData", '$.${authDataProvider}')`;
      } else if (isDotNotation) {
        if (dotFieldArrayPath) {
          targetSql = dotFieldArrayPath.valueExpression;
        } else if (dotFieldRootExists) {
          targetSql = dotFieldPath.valueExpression;
        } else {
          targetSql = 'NULL';
        }
      } else {
        validateFieldName(normalizedKey);
        const fieldExistsInSchema = doesSQLiteFieldExistInSchema(schemaFields, normalizedKey);
        targetSql = fieldExistsInSchema ? quoteColumnName(normalizedKey) : 'NULL';
      }

      let dotFieldTypeSql = null;
      if (dotFieldArrayPath) {
        dotFieldTypeSql = dotFieldArrayPath.typeExpression;
      } else if (dotFieldPath && dotFieldRootExists) {
        dotFieldTypeSql = dotFieldPath.typeExpression;
      }
      const usesCaseInsensitiveComparison =
        caseInsensitive &&
        !authDataProvider &&
        !isDotNotation &&
        (normalizedKey === 'username' || normalizedKey === 'email');
      const isArrayField =
        normalizedKey === '_rperm' ||
        normalizedKey === '_wperm' ||
        (schemaFields[normalizedKey] && schemaFields[normalizedKey].type === 'Array');
      const explicitNullFieldMatch =
        shouldTrackExplicitNullFields(className) && !authDataProvider && !isDotNotation
          ? getExplicitNullFieldMatchExpression(normalizedKey)
          : null;
      /** Bare text columns can keep index-friendly LIKE/GLOB/=`...` lowering without CAST(... AS TEXT). */
      const canUseLoweredRegexRawTextTarget =
        !authDataProvider &&
        !isDotNotation &&
        !isArrayField &&
        targetSql !== 'NULL' &&
        isLowerableRegexTextColumn(schemaFields, normalizedKey);
      let indexedArrayElementTableName = null;
      if (isArrayField || dotFieldArraySourceSql) {
        indexedArrayElementTableName = this._getQuotedIndexedArrayElementTableName(
          className,
          schemaFields,
          isArrayField ? normalizedKey : key
        );
      }

      if (val === null || val === undefined) {
        if (dotFieldArraySourceSql) {
          conditions.push(
            `EXISTS (SELECT 1 FROM json_each(${dotFieldArraySourceSql}) WHERE ${targetSql} IS NULL)`
          );
        } else {
          conditions.push(`${targetSql} IS NULL`);
        }
        continue;
      }

      if (isQueryOperatorObject(val)) {
        for (const op in val) {
          if (!Object.prototype.hasOwnProperty.call(val, op)) {
            continue;
          }
          const opVal = val[op];
          if (op === '$eq') {
            if (opVal === null) {
              if (dotFieldArraySourceSql) {
                conditions.push(
                  `EXISTS (SELECT 1 FROM json_each(${dotFieldArraySourceSql}) WHERE ${targetSql} IS NULL)`
                );
              } else {
                conditions.push(`${targetSql} IS NULL`);
              }
            } else if (isArrayField) {
              const indexedArrayValueMatch = indexedArrayElementTableName
                ? getSQLiteArrayIndexValueMatchExpression(indexedArrayElementTableName, opVal)
                : null;
              if (indexedArrayValueMatch) {
                conditions.push(indexedArrayValueMatch.sql);
                params.push(...indexedArrayValueMatch.params);
              } else {
                const elementMatch = getArrayElementMatchExpression(targetSql, opVal);
                conditions.push(elementMatch.sql);
                params.push(...elementMatch.params);
              }
            } else if (dotFieldArraySourceSql) {
              const indexedArrayValueMatch = indexedArrayElementTableName
                ? getSQLiteArrayIndexValueMatchExpression(indexedArrayElementTableName, opVal)
                : null;
              if (indexedArrayValueMatch) {
                conditions.push(indexedArrayValueMatch.sql);
                params.push(...indexedArrayValueMatch.params);
              } else {
                const valueMatch = getArrayRootDotValueMatchExpression(
                  dotFieldArraySourceSql,
                  targetSql,
                  opVal
                );
                conditions.push(`(${valueMatch.sql})`);
                params.push(...valueMatch.params);
              }
            } else if (usesCaseInsensitiveComparison && typeof opVal === 'string') {
              conditions.push(`(LOWER(${targetSql}) = LOWER(?))`);
              params.push(opVal);
            } else {
              const valueMatch = getScalarValueMatchExpression(targetSql, opVal);
              conditions.push(`(${valueMatch.sql})`);
              params.push(...valueMatch.params);
            }
          } else if (op === '$ne') {
            if (opVal === null) {
              if (dotFieldArraySourceSql) {
                const existsMatch = getArrayRootDotExistsExpression(
                  dotFieldArraySourceSql,
                  dotFieldTypeSql,
                  true
                );
                conditions.push(existsMatch.sql);
                params.push(...existsMatch.params);
              } else {
                conditions.push(`${targetSql} IS NOT NULL`);
              }
            } else if (isArrayField) {
              const elementMatch = getArrayElementMatchExpression(targetSql, opVal);
              conditions.push(`(${targetSql} IS NULL OR NOT (${elementMatch.sql}))`);
              params.push(...elementMatch.params);
            } else if (dotFieldArraySourceSql) {
              const valueMatch = getArrayRootDotValueMatchExpression(
                dotFieldArraySourceSql,
                targetSql,
                opVal
              );
              conditions.push(`NOT (${valueMatch.sql})`);
              params.push(...valueMatch.params);
            } else if (usesCaseInsensitiveComparison && typeof opVal === 'string') {
              conditions.push(`(${targetSql} IS NULL OR LOWER(${targetSql}) != LOWER(?))`);
              params.push(opVal);
            } else {
              const valueMatch = getScalarValueMatchExpression(targetSql, opVal);
              conditions.push(`(${targetSql} IS NULL OR NOT (${valueMatch.sql}))`);
              params.push(...valueMatch.params);
            }
          } else if (op === '$lt') {
            if (dotFieldArraySourceSql) {
              conditions.push(
                `EXISTS (SELECT 1 FROM json_each(${dotFieldArraySourceSql}) WHERE ${targetSql} < ?)`
              );
            } else {
              conditions.push(`${targetSql} < ?`);
            }
            params.push(toSQLiteValue(opVal));
          } else if (op === '$lte') {
            if (dotFieldArraySourceSql) {
              conditions.push(
                `EXISTS (SELECT 1 FROM json_each(${dotFieldArraySourceSql}) WHERE ${targetSql} <= ?)`
              );
            } else {
              conditions.push(`${targetSql} <= ?`);
            }
            params.push(toSQLiteValue(opVal));
          } else if (op === '$gt') {
            if (dotFieldArraySourceSql) {
              conditions.push(
                `EXISTS (SELECT 1 FROM json_each(${dotFieldArraySourceSql}) WHERE ${targetSql} > ?)`
              );
            } else {
              conditions.push(`${targetSql} > ?`);
            }
            params.push(toSQLiteValue(opVal));
          } else if (op === '$gte') {
            if (dotFieldArraySourceSql) {
              conditions.push(
                `EXISTS (SELECT 1 FROM json_each(${dotFieldArraySourceSql}) WHERE ${targetSql} >= ?)`
              );
            } else {
              conditions.push(`${targetSql} >= ?`);
            }
            params.push(toSQLiteValue(opVal));
          } else if (op === '$in') {
            if (!Array.isArray(opVal)) {
              throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $in value');
            }
            const {
              hasAny: hasInValues,
              hasNull: hasNull,
              nonNulls,
            } = partitionFlattenedConstraintValues(opVal);
            if (hasInValues) {
              if (isArrayField) {
                if (nonNulls.length > 0) {
                  const anyMatch = getArrayAnyMatchExpression(targetSql, nonNulls);
                  if (hasNull) {
                    conditions.push(`(${targetSql} IS NULL OR (${anyMatch.sql}))`);
                  } else {
                    conditions.push(`(${anyMatch.sql})`);
                  }
                  params.push(...anyMatch.params);
                } else if (hasNull) {
                  conditions.push(`${targetSql} IS NULL`);
                } else {
                  conditions.push('1 = 0');
                }
              } else if (dotFieldArraySourceSql) {
                if (nonNulls.length > 0) {
                  const anyMatch = getArrayRootDotAnyMatchExpression(
                    dotFieldArraySourceSql,
                    targetSql,
                    nonNulls
                  );
                  if (hasNull) {
                    conditions.push(
                      `(${anyMatch.sql} OR EXISTS (SELECT 1 FROM json_each(${dotFieldArraySourceSql}) WHERE ${targetSql} IS NULL))`
                    );
                  } else {
                    conditions.push(`(${anyMatch.sql})`);
                  }
                  params.push(...anyMatch.params);
                } else if (hasNull) {
                  conditions.push(
                    `EXISTS (SELECT 1 FROM json_each(${dotFieldArraySourceSql}) WHERE ${targetSql} IS NULL)`
                  );
                } else {
                  conditions.push('1 = 0');
                }
              } else if (dotFieldTypeSql) {
                if (nonNulls.length > 0) {
                  const scalarMatch = getScalarAnyMatchExpression(targetSql, nonNulls);
                  const arrayMatch = getArrayAnyMatchExpression(targetSql, nonNulls);
                  const arrayTypeCondition = `COALESCE(${dotFieldTypeSql}, '') = 'array'`;
                  const scalarTypeCondition = `COALESCE(${dotFieldTypeSql}, '') != 'array'`;
                  if (hasNull) {
                    conditions.push(
                      `((` +
                        `${arrayTypeCondition} AND (${targetSql} IS NULL OR (${arrayMatch.sql}))) OR ` +
                        `(${scalarTypeCondition} AND (${targetSql} IS NULL OR (${scalarMatch.sql}))))`
                    );
                  } else {
                    conditions.push(
                      `((` +
                        `${arrayTypeCondition} AND (${arrayMatch.sql})) OR ` +
                        `(${scalarTypeCondition} AND (${scalarMatch.sql})))`
                    );
                  }
                  params.push(...arrayMatch.params, ...scalarMatch.params);
                } else if (hasNull) {
                  conditions.push(`${targetSql} IS NULL`);
                } else {
                  conditions.push('1 = 0');
                }
              } else {
                if (nonNulls.length > 0) {
                  const scalarMatch = getScalarAnyMatchExpression(targetSql, nonNulls);
                  if (hasNull) {
                    conditions.push(`(${targetSql} IS NULL OR (${scalarMatch.sql}))`);
                  } else {
                    conditions.push(`(${scalarMatch.sql})`);
                  }
                  params.push(...scalarMatch.params);
                } else if (hasNull) {
                  conditions.push(`${targetSql} IS NULL`);
                } else {
                  conditions.push('1 = 0');
                }
              }
            } else if (!isArrayField) {
              conditions.push('1 = 0');
            }
          } else if (op === '$nin') {
            if (!Array.isArray(opVal)) {
              throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $nin value');
            }
            const {
              hasAny: hasNinValues,
              hasNull: hasNull,
              nonNulls,
            } = partitionFlattenedConstraintValues(opVal);
            if (hasNinValues) {
              if (isArrayField) {
                if (nonNulls.length > 0) {
                  const anyMatch = getArrayAnyMatchExpression(targetSql, nonNulls);
                  if (hasNull) {
                    conditions.push(`(${targetSql} IS NOT NULL AND NOT (${anyMatch.sql}))`);
                  } else {
                    conditions.push(`(${targetSql} IS NULL OR NOT (${anyMatch.sql}))`);
                  }
                  params.push(...anyMatch.params);
                } else if (hasNull) {
                  conditions.push(`${targetSql} IS NOT NULL`);
                }
              } else if (dotFieldArraySourceSql) {
                if (nonNulls.length > 0) {
                  const anyMatch = getArrayRootDotAnyMatchExpression(
                    dotFieldArraySourceSql,
                    targetSql,
                    nonNulls
                  );
                  if (hasNull) {
                    const existsMatch = getArrayRootDotExistsExpression(
                      dotFieldArraySourceSql,
                      dotFieldTypeSql,
                      true
                    );
                    conditions.push(`(${existsMatch.sql} AND NOT (${anyMatch.sql}))`);
                    params.push(...existsMatch.params, ...anyMatch.params);
                  } else {
                    conditions.push(`NOT (${anyMatch.sql})`);
                    params.push(...anyMatch.params);
                  }
                } else if (hasNull) {
                  const existsMatch = getArrayRootDotExistsExpression(
                    dotFieldArraySourceSql,
                    dotFieldTypeSql,
                    true
                  );
                  conditions.push(existsMatch.sql);
                  params.push(...existsMatch.params);
                }
              } else if (dotFieldTypeSql) {
                if (nonNulls.length > 0) {
                  const scalarMatch = getScalarAnyMatchExpression(targetSql, nonNulls);
                  const arrayMatch = getArrayAnyMatchExpression(targetSql, nonNulls);
                  const arrayTypeCondition = `COALESCE(${dotFieldTypeSql}, '') = 'array'`;
                  const scalarTypeCondition = `COALESCE(${dotFieldTypeSql}, '') != 'array'`;
                  if (hasNull) {
                    conditions.push(
                      `((` +
                        `${arrayTypeCondition} AND ${targetSql} IS NOT NULL AND NOT (${arrayMatch.sql})) OR ` +
                        `(${scalarTypeCondition} AND ${targetSql} IS NOT NULL AND NOT (${scalarMatch.sql})))`
                    );
                  } else {
                    conditions.push(
                      `((` +
                        `${arrayTypeCondition} AND (${targetSql} IS NULL OR NOT (${arrayMatch.sql}))) OR ` +
                        `(${scalarTypeCondition} AND (${targetSql} IS NULL OR NOT (${scalarMatch.sql}))))`
                    );
                  }
                  params.push(...arrayMatch.params, ...scalarMatch.params);
                } else if (hasNull) {
                  conditions.push(`${targetSql} IS NOT NULL`);
                }
              } else {
                if (nonNulls.length > 0) {
                  const scalarMatch = getScalarAnyMatchExpression(targetSql, nonNulls);
                  if (hasNull) {
                    conditions.push(`(${targetSql} IS NOT NULL AND NOT (${scalarMatch.sql}))`);
                  } else {
                    conditions.push(`(${targetSql} IS NULL OR NOT (${scalarMatch.sql}))`);
                  }
                  params.push(...scalarMatch.params);
                } else if (hasNull) {
                  conditions.push(`${targetSql} IS NOT NULL`);
                }
              }
            }
          } else if (op === '$exists') {
            if (opVal) {
              if (dotFieldArraySourceSql) {
                const existsMatch = getArrayRootDotExistsExpression(
                  dotFieldArraySourceSql,
                  dotFieldTypeSql,
                  true
                );
                conditions.push(existsMatch.sql);
                params.push(...existsMatch.params);
              } else if (explicitNullFieldMatch) {
                conditions.push(`(${targetSql} IS NOT NULL OR ${explicitNullFieldMatch.sql})`);
                params.push(...explicitNullFieldMatch.params);
              } else {
                conditions.push(`${targetSql} IS NOT NULL`);
              }
            } else {
              if (dotFieldArraySourceSql) {
                const existsMatch = getArrayRootDotExistsExpression(
                  dotFieldArraySourceSql,
                  dotFieldTypeSql,
                  false
                );
                conditions.push(existsMatch.sql);
                params.push(...existsMatch.params);
              } else if (explicitNullFieldMatch) {
                conditions.push(`(${targetSql} IS NULL AND NOT ${explicitNullFieldMatch.sql})`);
                params.push(...explicitNullFieldMatch.params);
              } else {
                conditions.push(`${targetSql} IS NULL`);
              }
            }
          } else if (op === '$regex') {
            const normalizedRegex = validateRegexPattern(opVal, val.$options || '');
            const regexMatchPlan = getRegexMatchPlan(
              isArrayField ? 'value' : targetSql,
              normalizedRegex,
              {
                useRawTextTarget: canUseLoweredRegexRawTextTarget,
                allowPrefixPrefilter: canUseLoweredRegexRawTextTarget,
              }
            );
            if (isArrayField) {
              if (indexedArrayElementTableName) {
                const indexedRegexMatch = getSQLiteArrayIndexRegexMatchExpression(
                  indexedArrayElementTableName,
                  normalizedRegex
                );
                conditions.push(indexedRegexMatch.sql);
                params.push(...indexedRegexMatch.params);
              } else {
                const valueRegexMatch = getSQLiteRegexValueMatchExpression(
                  'value',
                  normalizedRegex,
                  regexMatchPlan
                );
                conditions.push(
                  `EXISTS (SELECT 1 FROM json_each(${targetSql}) WHERE ${valueRegexMatch.sql})`
                );
                params.push(...valueRegexMatch.params);
              }
            } else if (dotFieldArraySourceSql) {
              if (indexedArrayElementTableName) {
                const indexedRegexMatch = getSQLiteArrayIndexRegexMatchExpression(
                  indexedArrayElementTableName,
                  normalizedRegex
                );
                conditions.push(indexedRegexMatch.sql);
                params.push(...indexedRegexMatch.params);
              } else {
                const valueRegexMatch = getSQLiteRegexValueMatchExpression(
                  targetSql,
                  normalizedRegex,
                  regexMatchPlan
                );
                conditions.push(
                  `EXISTS (SELECT 1 FROM json_each(${dotFieldArraySourceSql}) WHERE ${valueRegexMatch.sql})`
                );
                params.push(...valueRegexMatch.params);
              }
            } else {
              const scalarRegexMatch = getSQLiteRegexValueMatchExpression(
                targetSql,
                normalizedRegex,
                regexMatchPlan
              );
              conditions.push(scalarRegexMatch.sql);
              params.push(...scalarRegexMatch.params);
            }
          } else if (op === '$nearSphere') {
            const point = opVal;
            if (!isGeoPointValue(point)) {
              throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $nearSphere value');
            }
            Parse.GeoPoint._validate(point.latitude, point.longitude);
            const lat = point.latitude;
            const lng = point.longitude;
            const maxDistance = val.$maxDistance;
            const distanceExpression =
              `parse_geo_distance(` +
              `json_extract(${targetSql}, '$.latitude'), ` +
              `json_extract(${targetSql}, '$.longitude'), ?, ?)`;
            if (maxDistance !== undefined) {
              conditions.push(`${distanceExpression} <= ?`);
              params.push(lat, lng, maxDistance);
            }
            orderBys.push(`${distanceExpression} ASC`);
            orderByParams.push(lat, lng);
          } else if (op === '$maxDistance') {
            if (!val.$nearSphere) {
              throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad constraint: $maxDistance');
            }
          } else if (op === '$within') {
            if (opVal.$box) {
              const box = opVal.$box;
              conditions.push(`parse_within_box(json_extract(${targetSql}, '$.latitude'), json_extract(${targetSql}, '$.longitude'), ?, ?, ?, ?) = 1`);
              params.push(box[0].latitude, box[0].longitude, box[1].latitude, box[1].longitude);
            } else {
              throw new Parse.Error(Parse.Error.INVALID_JSON, 'malformatted $within arg');
            }
          } else if (op === '$geoWithin') {
            if (opVal.$centerSphere) {
              const cs = opVal.$centerSphere;
              if (!Array.isArray(cs) || cs.length < 2) {
                throw new Parse.Error(
                  Parse.Error.INVALID_JSON,
                  'bad $geoWithin value; $centerSphere should be an array of Parse.GeoPoint and distance'
                );
              }
              const point = cs[0];
              const maxDistanceRad = cs[1];
              let lat;
              let lng;
              if (Array.isArray(point) && point.length === 2) {
                Parse.GeoPoint._validate(point[1], point[0]);
                lat = point[1];
                lng = point[0];
              } else if (isGeoPointValue(point)) {
                Parse.GeoPoint._validate(point.latitude, point.longitude);
                lat = point.latitude;
                lng = point.longitude;
              } else {
                throw new Parse.Error(
                  Parse.Error.INVALID_JSON,
                  'bad $geoWithin value; $centerSphere geo point invalid'
                );
              }
              if (isNaN(maxDistanceRad) || maxDistanceRad < 0) {
                throw new Parse.Error(
                  Parse.Error.INVALID_JSON,
                  'bad $geoWithin value; $centerSphere distance invalid'
                );
              }
              conditions.push(`parse_geo_distance(json_extract(${targetSql}, '$.latitude'), json_extract(${targetSql}, '$.longitude'), ?, ?) <= ?`);
              params.push(lat, lng, maxDistanceRad);
            } else if (opVal.$polygon) {
              const poly = normalizeGeoWithinPolygonValue(opVal.$polygon);
              conditions.push(`parse_within_polygon(json_extract(${targetSql}, '$.latitude'), json_extract(${targetSql}, '$.longitude'), ?) = 1`);
              params.push(JSON.stringify(poly));
            }
          } else if (op === '$geoIntersects') {
            if (opVal.$point && schemaFields[key] && schemaFields[key].type === 'Polygon') {
              const point = opVal.$point;
              if (!isGeoPointValue(point)) {
                throw new Parse.Error(
                  Parse.Error.INVALID_JSON,
                  'bad $geoIntersect value; $point should be GeoPoint'
                );
              }
              Parse.GeoPoint._validate(point.latitude, point.longitude);
              conditions.push(`parse_within_polygon(?, ?, ${targetSql}) = 1`);
              params.push(point.latitude, point.longitude);
            } else if (opVal.$polygon) {
              const poly = normalizeGeoWithinPolygonValue(opVal.$polygon);
              conditions.push(`parse_within_polygon(json_extract(${targetSql}, '$.latitude'), json_extract(${targetSql}, '$.longitude'), ?) = 1`);
              params.push(JSON.stringify(poly));
            }
          } else if (op === '$options') {
            if (!Object.prototype.hasOwnProperty.call(val, '$regex')) {
              throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad constraint: $options');
            }
          } else if (op === '$all') {
            if (Array.isArray(opVal)) {
              if (opVal.length === 0) {
                conditions.push('1 = 0');
              } else if (isAnyValueRegex(opVal)) {
                if (!isAllValuesRegexOrNone(opVal)) {
                  throw new Parse.Error(
                    Parse.Error.INVALID_JSON,
                    'All $all values must be of regex type or none: ' + opVal
                  );
                }
                if (!isArrayField) {
                  conditions.push('1 = 0');
                  continue;
                }
                for (const elem of opVal) {
                  const normalizedRegex = validateRegexPattern(elem.$regex, elem.$options || '');
                  if (indexedArrayElementTableName) {
                    const indexedRegexMatch = getSQLiteArrayIndexRegexMatchExpression(
                      indexedArrayElementTableName,
                      normalizedRegex
                    );
                    conditions.push(indexedRegexMatch.sql);
                    params.push(...indexedRegexMatch.params);
                  } else {
                    const regexMatchPlan = getRegexMatchPlan('value', normalizedRegex);
                    const valueRegexMatch = getSQLiteRegexValueMatchExpression(
                      'value',
                      normalizedRegex,
                      regexMatchPlan
                    );
                    conditions.push(
                      `EXISTS (SELECT 1 FROM json_each(${targetSql}) WHERE ${valueRegexMatch.sql})`
                    );
                    params.push(...valueRegexMatch.params);
                  }
                }
              } else {
                for (const elem of opVal) {
                  if (isArrayField) {
                    const indexedArrayValueMatch = indexedArrayElementTableName
                      ? getSQLiteArrayIndexValueMatchExpression(indexedArrayElementTableName, elem)
                      : null;
                    if (indexedArrayValueMatch) {
                      conditions.push(indexedArrayValueMatch.sql);
                      params.push(...indexedArrayValueMatch.params);
                    } else {
                      const elementMatch = getArrayElementMatchExpression(targetSql, elem);
                      conditions.push(elementMatch.sql);
                      params.push(...elementMatch.params);
                    }
                  } else {
                    const valueMatch = getScalarValueMatchExpression(targetSql, elem);
                    conditions.push(`(${valueMatch.sql})`);
                    params.push(...valueMatch.params);
                  }
                }
              }
            }
          } else if (op === '$containedBy') {
            if (!Array.isArray(opVal)) {
              throw new Parse.Error(Parse.Error.INVALID_JSON, 'bad $containedBy: should be an array');
            }
            if (opVal.length === 0) {
              conditions.push(`(${targetSql} IS NULL OR json_array_length(${targetSql}) = 0)`);
            } else {
              if (isArrayField) {
                const eachTableName = getJSONArrayTableFunctionName(opVal);
                const valueMatch = getJsonValueAnyMatchExpression(
                  `${eachTableName}.value`,
                  opVal
                );
                conditions.push(
                  `(${targetSql} IS NULL OR NOT EXISTS (SELECT 1 FROM ${eachTableName}(${targetSql}) WHERE NOT (${valueMatch.sql})))`
                );
                params.push(...valueMatch.params);
              } else {
                const scalarMatch = getScalarAnyMatchExpression(targetSql, opVal);
                conditions.push(`(${targetSql} IS NULL OR (${scalarMatch.sql}))`);
                params.push(...scalarMatch.params);
              }
            }
          } else {
            throw new Parse.Error(Parse.Error.INVALID_JSON, `bad constraint: ${op}`);
          }
        }
      } else {
        if (isArrayField) {
          const indexedArrayValueMatch = indexedArrayElementTableName
            ? getSQLiteArrayIndexValueMatchExpression(indexedArrayElementTableName, val)
            : null;
          if (indexedArrayValueMatch) {
            conditions.push(indexedArrayValueMatch.sql);
            params.push(...indexedArrayValueMatch.params);
          } else {
            const elementMatch = getArrayElementMatchExpression(targetSql, val);
            conditions.push(elementMatch.sql);
            params.push(...elementMatch.params);
          }
        } else if (dotFieldArraySourceSql) {
          const indexedArrayValueMatch = indexedArrayElementTableName
            ? getSQLiteArrayIndexValueMatchExpression(indexedArrayElementTableName, val)
            : null;
          if (indexedArrayValueMatch) {
            conditions.push(indexedArrayValueMatch.sql);
            params.push(...indexedArrayValueMatch.params);
          } else {
            const valueMatch = getArrayRootDotValueMatchExpression(
              dotFieldArraySourceSql,
              targetSql,
              val
            );
            conditions.push(valueMatch.sql);
            params.push(...valueMatch.params);
          }
        } else if (usesCaseInsensitiveComparison && typeof val === 'string') {
          conditions.push(`(LOWER(${targetSql}) = LOWER(?))`);
          params.push(val);
        } else {
          const valueMatch = getScalarValueMatchExpression(targetSql, val);
          conditions.push(`(${valueMatch.sql})`);
          params.push(...valueMatch.params);
        }
      }
    }

    return {
      sql: conditions.join(' AND '),
      params,
      orderBys,
      orderByParams,
    };
  }

  async find(
    className: string,
    schema: SchemaType,
    query: QueryType,
    { skip, limit, sort, keys, caseInsensitive }: QueryOptions = {},
    transactionalSession?: any
  ): Promise<Array<any>> {
    // See `createObject()` for why top-level adapter entrypoints yield once.
    if (shouldYieldBeforeTopLevelSQLiteOperation(transactionalSession)) {
      await waitForNextEventLoopTurn();
    }
    schema = normalizeSQLiteSchema(className, schema);
    const db = transactionalSession || this._db;
    const textSearch = parseTextSearch(query);
    const where = this._buildWhereClause(
      className,
      schema,
      textSearch ? textSearch.remainingQuery : query,
      Boolean(caseInsensitive)
    );
    if (!(await this.classExists(className, db))) {
      return [];
    }
    const tableName = this._tableName(className);
    const queryParams = [...where.params];

    let selectSql = '*';
    let includeTextScore = false;
    if (keys && keys.length > 0) {
      const selectedCols = [];
      for (const key of keys) {
        if (!key || key.length === 0) {
          continue;
        }
        const expandedKeys = key === 'ACL' ? ['_rperm', '_wperm'] : [key];
        for (const selectedKey of expandedKeys) {
          const rootFieldName =
            selectedKey.indexOf('.') >= 0 ? selectedKey.split('.')[0] : selectedKey;
          if (
            selectedKey !== '$score' &&
            (!schema.fields[rootFieldName] || schema.fields[rootFieldName].type === 'Relation')
          ) {
            continue;
          }
          if (selectedKey.indexOf('.') >= 0) {
            selectedCols.push(
              `${transformDotField(selectedKey)} as "${selectedKey.replace(/"/g, '""')}"`
            );
          } else if (selectedKey === '$score') {
            includeTextScore = true;
          } else {
            validateFieldName(selectedKey);
            selectedCols.push(quoteColumnName(selectedKey));
          }
        }
      }
      if (selectedCols.length > 0) {
        if (shouldTrackExplicitNullFields(className)) {
          selectedCols.push(quoteColumnName(nullFieldTrackerColumn));
        }
        selectSql = selectedCols.join(', ');
      }
    }

    let sql;
    let textScoreSql = null;
    if (textSearch) {
      await this._ensureFTS5Index(
        className,
        textSearch.fieldName,
        Boolean(textSearch.diacriticSensitive),
        db
      );
      const ftsTableName = this._quotedFTSTableName(
        className,
        textSearch.fieldName,
        Boolean(textSearch.diacriticSensitive)
      );
      textScoreSql = `(-bm25(${ftsTableName}))`;
      if (includeTextScore) {
        if (selectSql === '*') {
          selectSql = `${tableName}.*, ${textScoreSql} as "score"`;
        } else {
          selectSql = `${selectSql}, ${textScoreSql} as "score"`;
        }
      }
      sql = `SELECT ${selectSql} FROM ${tableName} INNER JOIN ${ftsTableName} ON ${ftsTableName}.rowid = ${tableName}.rowid WHERE ${ftsTableName} MATCH ?`;
      queryParams.unshift(escapeFTS5Query(textSearch.searchTerm));
    } else {
      sql = `SELECT ${selectSql} FROM ${tableName}`;
    }

    if (where.sql) {
      sql += textSearch ? ` AND ${where.sql}` : ` WHERE ${where.sql}`;
    }

    {
      const sortParts = [...where.orderBys];
      let timestampSortDirection;
      let hasExplicitStableSortKey = false;
      if (sort) {
        for (const sortKey in sort) {
          if (!Object.prototype.hasOwnProperty.call(sort, sortKey)) {
            continue;
          }
          if (sortKey === 'score' && sort[sortKey] && sort[sortKey].$meta === 'textScore') {
            sortParts.push(`${textScoreSql} DESC`);
            continue;
          }
          const normalizedSortKey =
            normalizeStorageFieldName(sortKey);
          const dir = sort[sortKey] > 0 ? 'ASC' : 'DESC';
          if (normalizedSortKey === 'objectId') {
            hasExplicitStableSortKey = true;
          } else if (normalizedSortKey === 'createdAt' || normalizedSortKey === 'updatedAt') {
            timestampSortDirection = dir;
          }
          if (normalizedSortKey.indexOf('.') >= 0) {
            sortParts.push(`${transformDotField(normalizedSortKey)} ${dir}`);
          } else {
            validateFieldName(normalizedSortKey);
            sortParts.push(`${quoteColumnName(normalizedSortKey)} ${dir}`);
          }
        }
      }
      if (timestampSortDirection && !hasExplicitStableSortKey) {
        // Parse timestamps are millisecond-precision. Track write order in a
        // hidden column so latest updates sort correctly without JS-side resorting.
        const tableColumns = this._getTableColumns(className, db);
        if (tableColumns.includes(writeSequenceColumn)) {
          sortParts.push(
            `COALESCE(${quoteColumnName(writeSequenceColumn)}, ${tableName}.rowid) ${timestampSortDirection}`
          );
        }
        sortParts.push(`${tableName}.rowid ${timestampSortDirection}`);
      }
      if (sortParts.length > 0) {
        sql += ` ORDER BY ${sortParts.join(', ')}`;
      }
    }

    if (limit !== undefined) {
      sql += ` LIMIT ${parseInt(limit, 10)}`;
    }
    if (skip !== undefined) {
      if (limit === undefined) {
        sql += ` LIMIT -1`;
      }
      sql += ` OFFSET ${parseInt(skip, 10)}`;
    }

    const rows = this._prepare(sql, db).all(...queryParams, ...where.orderByParams);
    return rows.map(row => this._sqliteRowToParseObject(className, row, schema));
  }

  async count(
    className: string,
    schema: SchemaType,
    query: QueryType,
    transactionalSession?: any
  ): Promise<number> {
    if (shouldYieldBeforeTopLevelSQLiteOperation(transactionalSession)) {
      await waitForNextEventLoopTurn();
    }
    const db =
      transactionalSession && typeof transactionalSession.prepare === 'function'
        ? transactionalSession
        : this._db;
    if (!(await this.classExists(className, db))) {
      return 0;
    }
    const tableName = this._tableName(className);
    const where = this._buildWhereClause(className, schema, query);
    let sql = `SELECT COUNT(*) as count FROM ${tableName}`;
    if (where.sql) {
      sql += ` WHERE ${where.sql}`;
    }
    const row = this._prepare(sql, db).get(...where.params);
    return row ? row.count : 0;
  }

  async distinct(
    className: string,
    schema: SchemaType,
    query: QueryType,
    fieldName: string,
    transactionalSession?: any
  ): Promise<any> {
    if (shouldYieldBeforeTopLevelSQLiteOperation(transactionalSession)) {
      await waitForNextEventLoopTurn();
    }
    const db =
      transactionalSession && typeof transactionalSession.prepare === 'function'
        ? transactionalSession
        : this._db;
    if (!(await this.classExists(className, db))) {
      return [];
    }
    const rootFieldName = fieldName.indexOf('.') >= 0 ? fieldName.split('.')[0] : fieldName;
    validateFieldName(rootFieldName);
    schema = normalizeSQLiteSchema(className, schema);
    const columns = this._getTableColumns(className, db);
    if (
      !['objectId', 'createdAt', 'updatedAt'].includes(rootFieldName) &&
      !columns.includes(rootFieldName)
    ) {
      return [];
    }
    const tableName = this._tableName(className);
    const where = this._buildWhereClause(className, schema, query);
    const fieldSchema = (schema.fields || {})[rootFieldName];

    if (fieldSchema && fieldSchema.type === 'Array' && fieldName.indexOf('.') === -1) {
      let sql =
        `SELECT DISTINCT json_each.value as val ` +
        `FROM ${tableName} JOIN json_each(${quoteColumnName(fieldName)})`;
      if (where.sql) {
        sql += ` WHERE ${where.sql} AND json_each.value IS NOT NULL`;
      } else {
        sql += ` WHERE json_each.value IS NOT NULL`;
      }
      const rows = this._prepare(sql, db).all(...where.params);
      return rows.map(row => parseJSONValue(row.val));
    }

    const targetSql =
      fieldName.indexOf('.') >= 0 ? transformDotField(fieldName) : quoteColumnName(fieldName);

    let sql = `SELECT DISTINCT ${targetSql} as val FROM ${tableName}`;
    if (where.sql) {
      sql += ` WHERE ${where.sql} AND ${targetSql} IS NOT NULL`;
    } else {
      sql += ` WHERE ${targetSql} IS NOT NULL`;
    }

    const rows = this._prepare(sql, db).all(...where.params);
    if (fieldSchema && fieldSchema.type === 'Pointer') {
      return rows
        .filter(row => row.val !== null && row.val !== undefined)
        .map(row => ({
          __type: 'Pointer',
          className: fieldSchema.targetClass,
          objectId: row.val,
        }));
    }
    const valueType =
      rootFieldName === 'createdAt' || rootFieldName === 'updatedAt'
        ? { type: 'Date' }
        : fieldSchema;
    return rows.map(row => sqliteValueToParseValue(row.val, valueType));
  }

  _buildNativeAggregateSchema(className: string, schema: SchemaType): SchemaType {
    const nativeSchema = {
      className,
      fields: {
        _id: { type: 'String' },
        _created_at: { type: 'Date' },
        _updated_at: { type: 'Date' },
      },
    };

    const schemaFields = (schema && schema.fields) || {};
    for (const fieldName in schemaFields) {
      if (!Object.prototype.hasOwnProperty.call(schemaFields, fieldName)) {
        continue;
      }
      if (fieldName === 'objectId' || fieldName === 'createdAt' || fieldName === 'updatedAt') {
        continue;
      }
      const field = schemaFields[fieldName];
      if (field.type === 'Pointer') {
        nativeSchema.fields[`_p_${fieldName}`] = {
          ...field,
          nativePointer: true,
        };
      } else {
        nativeSchema.fields[fieldName] = { ...field };
      }
    }

    return nativeSchema;
  }

  _getNativeAggregateContext(className: string, schema: SchemaType): any {
    const columns = this._getTableColumns(className);
    const selectParts = [];
    const params = [];
    const nativeSchema = {
      className,
      fields: {},
    };

    for (const column of columns) {
      if (column === 'objectId') {
        selectParts.push(`${quoteColumnName(column)} AS "_id"`);
        nativeSchema.fields._id = { type: 'String' };
      } else if (column === 'createdAt') {
        selectParts.push(`${quoteColumnName(column)} AS "_created_at"`);
        nativeSchema.fields._created_at = { type: 'Date' };
      } else if (column === 'updatedAt') {
        selectParts.push(`${quoteColumnName(column)} AS "_updated_at"`);
        nativeSchema.fields._updated_at = { type: 'Date' };
      } else if (schema.fields[column] && schema.fields[column].type === 'Pointer') {
        selectParts.push(
          `CASE WHEN ${quoteColumnName(column)} IS NULL THEN NULL ELSE ? || ${quoteColumnName(column)} END AS ${quoteColumnName(`_p_${column}`)}`
        );
        params.push(`${schema.fields[column].targetClass}$`);
        nativeSchema.fields[`_p_${column}`] = {
          ...schema.fields[column],
          nativePointer: true,
        };
      } else {
        selectParts.push(quoteColumnName(column));
        if (schema.fields[column]) {
          nativeSchema.fields[column] = { ...schema.fields[column] };
        }
      }
    }

    return {
      className,
      schema: nativeSchema,
      sql: `SELECT ${selectParts.join(', ')} FROM ${this._tableName(className)}`,
      params,
    };
  }

  _convertAggregateValueToDate(value: any): any {
    if (Utils.isDate(value)) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(item => this._convertAggregateValueToDate(item));
    }
    if (typeof value === 'string') {
      return isNaN(Date.parse(value)) ? value : new Date(value);
    }
    if (value && typeof value === 'object') {
      const output = {};
      for (const key of Object.keys(value)) {
        output[key] = this._convertAggregateValueToDate(value[key]);
      }
      return output;
    }
    return value;
  }

  _transformAggregatePointerConstraint(value: any, targetClass: string): any {
    if (value === null || value === undefined) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(item => this._transformAggregatePointerConstraint(item, targetClass));
    }
    if (typeof value === 'string') {
      return value.includes('$') ? value : `${targetClass}$${value}`;
    }
    if (isPlainObject(value)) {
      const output = {};
      for (const key of Object.keys(value)) {
        if (['$in', '$nin', '$all'].includes(key) && Array.isArray(value[key])) {
          output[key] = value[key].map(item =>
            this._transformAggregatePointerConstraint(item, targetClass)
          );
        } else if (['$eq', '$ne'].includes(key)) {
          output[key] = this._transformAggregatePointerConstraint(value[key], targetClass);
        } else {
          output[key] = value[key];
        }
      }
      return output;
    }
    return value;
  }

  _transformAggregateArgs(
    schema: SchemaType,
    pipeline: any,
    rawValues?: boolean,
    rawFieldNames?: boolean
  ): any {
    if (pipeline === null || pipeline === undefined) {
      return pipeline;
    }
    if (Utils.isDate(pipeline)) {
      return pipeline;
    }
    if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._transformAggregateArgs(schema, value, rawValues, rawFieldNames));
    }
    if (typeof pipeline === 'object') {
      const output = {};
      for (const field of Object.keys(pipeline)) {
        const value = pipeline[field];

        if (field === '$expr') {
          output[field] = this._transformAggregateGroupArgs(schema, value, rawFieldNames);
          continue;
        }

        let outputField = field;
        let outputValue = value;
        const fieldSchema = (schema.fields || {})[field];

        if (!rawFieldNames) {
          if (field === 'objectId') {
            outputField = '_id';
          } else if (field === 'createdAt') {
            outputField = '_created_at';
            if (!rawValues) {
              outputValue = this._convertAggregateValueToDate(value);
            }
          } else if (field === 'updatedAt') {
            outputField = '_updated_at';
            if (!rawValues) {
              outputValue = this._convertAggregateValueToDate(value);
            }
          } else if (fieldSchema && fieldSchema.type === 'Pointer') {
            outputField = `_p_${field}`;
            outputValue = this._transformAggregatePointerConstraint(value, fieldSchema.targetClass);
          } else if (fieldSchema && fieldSchema.type === 'Date' && !rawValues) {
            outputValue = this._convertAggregateValueToDate(value);
          }
        } else if ((field === '_created_at' || field === '_updated_at' || (fieldSchema && fieldSchema.type === 'Date')) && !rawValues) {
          outputValue = this._convertAggregateValueToDate(value);
        }

        if (outputValue && typeof outputValue === 'object' && !Utils.isDate(outputValue)) {
          output[outputField] = this._transformAggregateArgs(
            schema,
            outputValue,
            rawValues,
            rawFieldNames
          );
        } else {
          output[outputField] = outputValue;
        }
      }
      return output;
    }
    return pipeline;
  }

  _transformAggregateProjectArgs(
    schema: SchemaType,
    pipeline: any,
    rawValues?: boolean,
    rawFieldNames?: boolean
  ): any {
    const output = {};

    for (const field of Object.keys(pipeline)) {
      const value = pipeline[field];
      let outputField = field;

      if (!rawFieldNames) {
        if (field === 'objectId') {
          outputField = '_id';
        } else if (field === 'createdAt') {
          outputField = '_created_at';
        } else if (field === 'updatedAt') {
          outputField = '_updated_at';
        } else if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
          outputField = `_p_${field}`;
        }
      }

      output[outputField] = this._transformAggregateArgs(schema, value, rawValues, rawFieldNames);
    }

    return output;
  }

  _transformAggregateGroupArgs(
    schema: SchemaType,
    pipeline: any,
    rawFieldNames?: boolean
  ): any {
    if (Array.isArray(pipeline)) {
      return pipeline.map(value => this._transformAggregateGroupArgs(schema, value, rawFieldNames));
    }
    if (pipeline && typeof pipeline === 'object') {
      const output = {};
      for (const field of Object.keys(pipeline)) {
        output[field] = this._transformAggregateGroupArgs(schema, pipeline[field], rawFieldNames);
      }
      return output;
    }
    if (typeof pipeline === 'string' && pipeline.startsWith('$') && !rawFieldNames) {
      const field = pipeline.slice(1);
      if (field === 'objectId') {
        return '$_id';
      }
      if (field === 'createdAt') {
        return '$_created_at';
      }
      if (field === 'updatedAt') {
        return '$_updated_at';
      }
      if (schema.fields[field] && schema.fields[field].type === 'Pointer') {
        return `$_p_${field}`;
      }
    }
    return pipeline;
  }

  _isAggregateDateField(fieldName: string, schema: SchemaType, rawFieldNames?: boolean): boolean {
    if (rawFieldNames) {
      return fieldName === '_created_at' || fieldName === '_updated_at' || (schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Date');
    }
    return fieldName === 'createdAt' || fieldName === 'updatedAt' || (schema.fields && schema.fields[fieldName] && schema.fields[fieldName].type === 'Date');
  }

  _hasIncompatibleAggregateDateMatchValue(value: any): boolean {
    if (value === null || value === undefined) {
      return false;
    }
    if (Utils.isDate(value)) {
      return false;
    }
    if (Array.isArray(value)) {
      return value.some(item => this._hasIncompatibleAggregateDateMatchValue(item));
    }
    if (typeof value === 'string') {
      return true;
    }
    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === '$relativeTime') {
        return false;
      }
      if (keys.every(key => aggregateDateMatchOperators.has(key))) {
        return keys.some(key => {
          if (key === '$exists') {
            return typeof value[key] !== 'boolean';
          }
          return this._hasIncompatibleAggregateDateMatchValue(value[key]);
        });
      }
      return true;
    }
    return true;
  }

  _aggregateMatchAlwaysFalse(
    query: any,
    schema: SchemaType,
    _rawValues?: boolean,
    rawFieldNames?: boolean
  ): boolean {
    if (!query) {
      return false;
    }
    for (const key of Object.keys(query)) {
      const value = query[key];
      if (key === '$or' || key === '$and' || key === '$nor') {
        if (
          Array.isArray(value) &&
          value.some(item => this._aggregateMatchAlwaysFalse(item, schema, _rawValues, rawFieldNames))
        ) {
          return true;
        }
        continue;
      }
      if (key === '$expr') {
        continue;
      }
      if (
        this._isAggregateDateField(key, schema, rawFieldNames) &&
        this._hasIncompatibleAggregateDateMatchValue(value)
      ) {
        return true;
      }
    }
    return false;
  }

  _aggregateQueryReferencesMissingField(query: any, schema: SchemaType): boolean {
    if (!query || typeof query !== 'object') {
      return false;
    }
    for (const key of Object.keys(query)) {
      const value = query[key];
      if (key === '$or' || key === '$and' || key === '$nor') {
        if (Array.isArray(value) && value.some(item => this._aggregateQueryReferencesMissingField(item, schema))) {
          return true;
        }
        continue;
      }
      if (key === '$expr') {
        continue;
      }
      const rootFieldName = key.indexOf('.') >= 0 ? key.split('.')[0] : key;
      if (!schema.fields[rootFieldName]) {
        return true;
      }
    }
    return false;
  }

  _compileAggregateExpression(context: any, expression: any): any {
    if (expression === null) {
      return { sql: 'NULL', params: [], fieldType: null };
    }
    if (Utils.isDate(expression)) {
      return {
        sql: '?',
        params: [expression.toISOString()],
        fieldType: { type: 'Date' },
      };
    }
    if (typeof expression === 'string') {
      if (expression === '$$NOW') {
        return {
          sql: '?',
          params: [new Date().toISOString()],
          fieldType: { type: 'Date' },
        };
      }
      if (expression.startsWith('$')) {
        const fieldName = expression.slice(1);
        const rootFieldName = fieldName.indexOf('.') >= 0 ? fieldName.split('.')[0] : fieldName;
        if (!context.schema.fields[rootFieldName]) {
          return { sql: 'NULL', params: [], fieldType: null };
        }
        return {
          sql: fieldName.indexOf('.') >= 0 ? transformDotField(fieldName) : quoteColumnName(fieldName),
          params: [],
          fieldType: context.schema.fields[rootFieldName],
        };
      }
      return {
        sql: '?',
        params: [expression],
        fieldType: { type: 'String' },
      };
    }
    if (typeof expression === 'number') {
      return {
        sql: '?',
        params: [expression],
        fieldType: { type: 'Number' },
      };
    }
    if (typeof expression === 'boolean') {
      return {
        sql: '?',
        params: [expression ? 1 : 0],
        fieldType: { type: 'Boolean' },
      };
    }
    if (Array.isArray(expression)) {
      return {
        sql: 'json(?)',
        params: [JSON.stringify(expression)],
        fieldType: { type: 'Array' },
      };
    }
    if (isPlainObject(expression)) {
      if (expression.$multiply) {
        const parts = expression.$multiply.map(item => this._compileAggregateExpression(context, item));
        return {
          sql: parts.map(item => `CAST(${item.sql} AS REAL)`).join(' * '),
          params: parts.flatMap(item => item.params),
          fieldType: { type: 'Number' },
        };
      }
      if (expression.$dayOfMonth) {
        const compiled = this._compileAggregateExpression(context, expression.$dayOfMonth);
        return {
          sql: `CAST(strftime('%d', ${compiled.sql}) AS INTEGER)`,
          params: compiled.params,
          fieldType: { type: 'Number' },
        };
      }
      if (expression.$month) {
        const compiled = this._compileAggregateExpression(context, expression.$month);
        return {
          sql: `CAST(strftime('%m', ${compiled.sql}) AS INTEGER)`,
          params: compiled.params,
          fieldType: { type: 'Number' },
        };
      }
      if (expression.$year) {
        const compiled = this._compileAggregateExpression(context, expression.$year);
        return {
          sql: `CAST(strftime('%Y', ${compiled.sql}) AS INTEGER)`,
          params: compiled.params,
          fieldType: { type: 'Number' },
        };
      }
      if (expression.$substr) {
        const [source, start, length] = expression.$substr;
        const compiled = this._compileAggregateExpression(context, source);
        const startIndex = Number(start) + 1;
        if (Number(length) === -1) {
          return {
            sql: `substr(${compiled.sql}, ${startIndex})`,
            params: compiled.params,
            fieldType: { type: 'String' },
          };
        }
        return {
          sql: `substr(${compiled.sql}, ${startIndex}, ${Number(length)})`,
          params: compiled.params,
          fieldType: { type: 'String' },
        };
      }
      if (expression.$dateSubtract) {
        const startDate = expression.$dateSubtract.startDate;
        const unit = expression.$dateSubtract.unit;
        const amount = Number(expression.$dateSubtract.amount);
        if (startDate === '$$NOW' && unit === 'day' && Number.isFinite(amount)) {
          return {
            sql: '?',
            params: [new Date(Date.now() - amount * 24 * 60 * 60 * 1000).toISOString()],
            fieldType: { type: 'Date' },
          };
        }
      }
      return {
        sql: 'json(?)',
        params: [JSON.stringify(expression)],
        fieldType: { type: 'Object' },
      };
    }
    return { sql: 'NULL', params: [], fieldType: null };
  }

  _compileAggregateExprWhereClause(context: any, expression: any): any {
    const op = Object.keys(expression || {})[0];
    const operands = expression[op];
    if (!Array.isArray(operands) || operands.length !== 2) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Invalid $expr format');
    }
    const left = this._compileAggregateExpression(context, operands[0]);
    const right = this._compileAggregateExpression(context, operands[1]);
    const operatorMap = {
      $eq: '=',
      $ne: '!=',
      $gt: '>',
      $gte: '>=',
      $lt: '<',
      $lte: '<=',
    };
    if (!operatorMap[op]) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, `Unsupported $expr operator: ${op}`);
    }
    return {
      sql: `(${left.sql}) ${operatorMap[op]} (${right.sql})`,
      params: [...left.params, ...right.params],
    };
  }

  _applyAggregateMatchStage(
    context: any,
    matchStage: any,
    schema: SchemaType,
    rawValues?: boolean,
    rawFieldNames?: boolean
  ): any {
    const transformed = this._transformAggregateArgs(schema, matchStage, rawValues, rawFieldNames);
    if (this._aggregateMatchAlwaysFalse(transformed, context.schema, rawValues, true)) {
      return {
        ...context,
        sql: `SELECT * FROM (${context.sql}) AS "__aggregate_match_false" WHERE 1 = 0`,
      };
    }

    if (this._aggregateQueryReferencesMissingField(transformed, context.schema)) {
      return {
        ...context,
        sql: `SELECT * FROM (${context.sql}) AS "__aggregate_match_missing" WHERE 1 = 0`,
      };
    }

    const expr = transformed.$expr;
    if (expr !== undefined) {
      delete transformed.$expr;
    }

    const where = this._buildWhereClause(
      context.className,
      context.schema,
      transformed,
      false,
      true
    );
    const conditions = [];
    const params = [...context.params];
    if (where.sql) {
      conditions.push(where.sql);
      params.push(...where.params);
    }
    if (expr) {
      const exprWhere = this._compileAggregateExprWhereClause(context, expr);
      conditions.push(exprWhere.sql);
      params.push(...exprWhere.params);
    }

    return {
      ...context,
      sql:
        `SELECT * FROM (${context.sql}) AS "__aggregate_match"` +
        (conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''),
      params,
    };
  }

  _applyAggregateProjectStage(
    context: any,
    projectStage: any,
    schema: SchemaType,
    rawValues?: boolean,
    rawFieldNames?: boolean
  ): any {
    const transformed = this._transformAggregateProjectArgs(schema, projectStage, rawValues, rawFieldNames);
    const selectParts = [];
    const params = [];
    const nextSchema = {
      className: context.className,
      fields: {},
    };

    let includeId = true;
    if (Object.prototype.hasOwnProperty.call(transformed, '_id') && !transformed._id) {
      includeId = false;
    }
    if (includeId && context.schema.fields._id) {
      selectParts.push(quoteColumnName('_id'));
      nextSchema.fields._id = context.schema.fields._id;
    }

    for (const key of Object.keys(transformed)) {
      const value = transformed[key];
      if (key === '_id') {
        if (value && value !== 1) {
          const compiled = this._compileAggregateExpression(context, value);
          selectParts.push(`${compiled.sql} AS "_id"`);
          params.push(...compiled.params);
          nextSchema.fields._id = compiled.fieldType || { type: 'String' };
        }
        continue;
      }
      if (value === 0 || value === false) {
        continue;
      }
      if (value === 1 || value === true) {
        if (context.schema.fields[key]) {
          selectParts.push(quoteColumnName(key));
          nextSchema.fields[key] = context.schema.fields[key];
        }
        continue;
      }
      const compiled = this._compileAggregateExpression(context, value);
      selectParts.push(`${compiled.sql} AS ${quoteColumnName(key)}`);
      params.push(...compiled.params);
      nextSchema.fields[key] = compiled.fieldType || { type: 'Object' };
    }
    params.push(...context.params);

    return {
      ...context,
      schema: nextSchema,
      sql: `SELECT ${selectParts.join(', ')} FROM (${context.sql}) AS "__aggregate_project"`,
      params,
    };
  }

  _applyAggregateAddFieldsStage(
    context: any,
    addFieldsStage: any,
    schema: SchemaType,
    rawValues?: boolean,
    rawFieldNames?: boolean
  ): any {
    const transformed = this._transformAggregateProjectArgs(schema, addFieldsStage, rawValues, rawFieldNames);
    const computedKeys = new Set(Object.keys(transformed));
    const selectParts = [];
    const params = [];
    const nextSchema = {
      className: context.className,
      fields: {
        ...context.schema.fields,
      },
    };

    for (const key of Object.keys(context.schema.fields)) {
      if (!computedKeys.has(key)) {
        selectParts.push(quoteColumnName(key));
      }
    }

    for (const key of Object.keys(transformed)) {
      const compiled = this._compileAggregateExpression(context, transformed[key]);
      selectParts.push(`${compiled.sql} AS ${quoteColumnName(key)}`);
      params.push(...compiled.params);
      nextSchema.fields[key] = compiled.fieldType || { type: 'Object' };
    }
    params.push(...context.params);

    return {
      ...context,
      schema: nextSchema,
      sql: `SELECT ${selectParts.join(', ')} FROM (${context.sql}) AS "__aggregate_add_fields"`,
      params,
    };
  }

  _buildAggregateGroupId(context: any, expression: any): any {
    if (
      expression === null ||
      expression === '' ||
      (Array.isArray(expression) && expression.length === 0) ||
      (isPlainObject(expression) && Object.keys(expression).length === 0)
    ) {
      return {
        sql: 'NULL',
        params: [],
        groupBy: [],
        fieldType: { type: 'String', aggregateNullGroupId: true },
      };
    }

    if (isPlainObject(expression) && !Object.keys(expression).some(key => key.startsWith('$'))) {
      const params = [];
      const groupBy = [];
      const jsonParts = [];
      for (const key of Object.keys(expression)) {
        const compiled = this._compileAggregateExpression(context, expression[key]);
        jsonParts.push(`'${key.replace(/'/g, "''")}', ${compiled.sql}`);
        groupBy.push(compiled.sql);
        params.push(...compiled.params);
      }
      return {
        sql: `json_object(${jsonParts.join(', ')})`,
        params,
        groupBy,
        fieldType: { type: 'Object' },
      };
    }

    const compiled = this._compileAggregateExpression(context, expression);
    let fieldType = compiled.fieldType;
    if (fieldType && fieldType.nativePointer) {
      fieldType = {
        ...fieldType,
        aggregateGroupPointer: true,
      };
    }
    return {
      sql: compiled.sql,
      params: compiled.params,
      groupBy: [compiled.sql],
      fieldType,
    };
  }

  _applyAggregateGroupStage(
    context: any,
    groupStage: any,
    schema: SchemaType,
    rawFieldNames?: boolean
  ): any {
    if (!Object.prototype.hasOwnProperty.call(groupStage, '_id')) {
      throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Invalid group: _id is required');
    }

    const transformed = this._transformAggregateGroupArgs(schema, groupStage, rawFieldNames);
    const groupId = this._buildAggregateGroupId(context, transformed._id);
    const selectParts = [`${groupId.sql} AS "_id"`];
    const params = [...groupId.params];
    const nextSchema = {
      className: context.className,
      fields: {
        _id: groupId.fieldType || { type: 'String' },
      },
    };

    for (const key of Object.keys(transformed)) {
      if (key === '_id') {
        continue;
      }
      const agg = transformed[key];
      if (agg.$sum !== undefined) {
        if (agg.$sum === 1) {
          selectParts.push(`COUNT(*) AS ${quoteColumnName(key)}`);
        } else {
          const compiled = this._compileAggregateExpression(context, agg.$sum);
          selectParts.push(`SUM(CAST(${compiled.sql} AS REAL)) AS ${quoteColumnName(key)}`);
          params.push(...compiled.params);
        }
        nextSchema.fields[key] = { type: 'Number' };
      } else if (agg.$avg !== undefined) {
        const compiled = this._compileAggregateExpression(context, agg.$avg);
        selectParts.push(`AVG(CAST(${compiled.sql} AS REAL)) AS ${quoteColumnName(key)}`);
        params.push(...compiled.params);
        nextSchema.fields[key] = { type: 'Number' };
      } else if (agg.$min !== undefined) {
        const compiled = this._compileAggregateExpression(context, agg.$min);
        selectParts.push(`MIN(${compiled.sql}) AS ${quoteColumnName(key)}`);
        params.push(...compiled.params);
        nextSchema.fields[key] = compiled.fieldType || { type: 'Object' };
      } else if (agg.$max !== undefined) {
        const compiled = this._compileAggregateExpression(context, agg.$max);
        selectParts.push(`MAX(${compiled.sql}) AS ${quoteColumnName(key)}`);
        params.push(...compiled.params);
        nextSchema.fields[key] = compiled.fieldType || { type: 'Object' };
      }
    }
    params.push(...context.params);

    return {
      ...context,
      schema: nextSchema,
      sql:
        `SELECT ${selectParts.join(', ')} FROM (${context.sql}) AS "__aggregate_group"` +
        (groupId.groupBy.length ? ` GROUP BY ${groupId.groupBy.join(', ')}` : ''),
      params,
    };
  }

  _transformAggregateSortField(context: any, fieldName: string, rawFieldNames?: boolean): string {
    if (context.schema.fields[fieldName]) {
      return fieldName;
    }
    if (!rawFieldNames) {
      if (fieldName === 'objectId' && context.schema.fields._id) {
        return '_id';
      }
      if (fieldName === 'createdAt' && context.schema.fields._created_at) {
        return '_created_at';
      }
      if (fieldName === 'updatedAt' && context.schema.fields._updated_at) {
        return '_updated_at';
      }
      if (context.schema.fields[`_p_${fieldName}`]) {
        return `_p_${fieldName}`;
      }
    }
    return fieldName;
  }

  _applyAggregateSortStage(context: any, sortStage: any, rawFieldNames?: boolean): any {
    const sortParts = [];
    for (const key in sortStage || {}) {
      if (!Object.prototype.hasOwnProperty.call(sortStage, key)) {
        continue;
      }
      const transformedKey = this._transformAggregateSortField(context, key, rawFieldNames);
      const dir = sortStage[key] > 0 ? 'ASC' : 'DESC';
      sortParts.push(
        transformedKey.indexOf('.') >= 0
          ? `${transformDotField(transformedKey)} ${dir}`
          : `${quoteColumnName(transformedKey)} ${dir}`
      );
    }
    return {
      ...context,
      sql:
        `SELECT * FROM (${context.sql}) AS "__aggregate_sort"` +
        (sortParts.length ? ` ORDER BY ${sortParts.join(', ')}` : ''),
    };
  }

  _applyAggregateLimitStage(context: any, limitValue: number): any {
    return {
      ...context,
      sql: `SELECT * FROM (${context.sql}) AS "__aggregate_limit" LIMIT ${parseInt(limitValue, 10)}`,
    };
  }

  _applyAggregateSkipStage(context: any, skipValue: number): any {
    return {
      ...context,
      sql: `SELECT * FROM (${context.sql}) AS "__aggregate_skip" LIMIT -1 OFFSET ${parseInt(skipValue, 10)}`,
    };
  }

  _applyAggregateCountStage(context: any, countFieldName: string): any {
    return {
      ...context,
      schema: {
        className: context.className,
        fields: {
          [countFieldName]: { type: 'Number' },
        },
      },
      sql:
        `SELECT COUNT(*) AS ${quoteColumnName(countFieldName)} ` +
        `FROM (${context.sql}) AS "__aggregate_count" HAVING COUNT(*) > 0`,
    };
  }

  async _buildNativeLookupObjectSql(className: string, schema: SchemaType, alias: string): Promise<any> {
    const columns = this._getTableColumns(className);
    const parts = [];
    const params = [];

    for (const column of columns) {
      const qualifiedColumn = `${alias}.${quoteColumnName(column)}`;
      if (column === 'objectId') {
        parts.push(`'_id', ${qualifiedColumn}`);
      } else if (column === 'createdAt') {
        parts.push(`'_created_at', ${qualifiedColumn}`);
      } else if (column === 'updatedAt') {
        parts.push(`'_updated_at', ${qualifiedColumn}`);
      } else if (schema.fields[column] && schema.fields[column].type === 'Pointer') {
        parts.push(
          `'${`_p_${column}`}', CASE WHEN ${qualifiedColumn} IS NULL THEN NULL ELSE ? || ${qualifiedColumn} END`
        );
        params.push(`${schema.fields[column].targetClass}$`);
      } else {
        parts.push(`'${column.replace(/'/g, "''")}', ${qualifiedColumn}`);
      }
    }

    return {
      sql: `json_object(${parts.join(', ')})`,
      params,
    };
  }

  _mapLookupFieldToStorage(fieldName: string): string {
    if (fieldName === '_id') {
      return 'objectId';
    }
    if (fieldName === '_created_at') {
      return 'createdAt';
    }
    if (fieldName === '_updated_at') {
      return 'updatedAt';
    }
    if (fieldName.startsWith('_p_')) {
      return fieldName.slice(3);
    }
    return fieldName;
  }

  async _applyAggregateLookupStage(context: any, lookupStage: any): Promise<any> {
    const targetClassName = lookupStage.from.startsWith(this._collectionPrefix)
      ? lookupStage.from.slice(this._collectionPrefix.length)
      : lookupStage.from;
    const targetSchema = normalizeSQLiteSchema(targetClassName, await this.getClass(targetClassName));
    const nativeTargetSchema = this._buildNativeAggregateSchema(targetClassName, targetSchema);
    const lookupObject = await this._buildNativeLookupObjectSql(targetClassName, targetSchema, '__aggregate_lookup_target');
    const localField = lookupStage.localField;
    const foreignField = this._mapLookupFieldToStorage(lookupStage.foreignField);
    const localSql =
      localField.indexOf('.') >= 0 ? transformDotField(localField) : quoteColumnName(localField);
    const foreignSql =
      foreignField.indexOf('.') >= 0 ? transformDotField(foreignField) : `__aggregate_lookup_target.${quoteColumnName(foreignField)}`;

    const nextSchema = {
      className: context.className,
      fields: {
        ...context.schema.fields,
        [lookupStage.as]: {
          type: 'Array',
          aggregateLookup: true,
          lookupSchema: nativeTargetSchema,
          targetClass: targetClassName,
        },
      },
    };

    const currentFields = Object.keys(context.schema.fields)
      .filter(field => field !== lookupStage.as)
      .map(field => quoteColumnName(field))
      .join(', ');

    return {
      ...context,
      schema: nextSchema,
      sql:
        `SELECT ${currentFields}${currentFields ? ', ' : ''}COALESCE((` +
        `SELECT json_group_array(${lookupObject.sql}) FROM ${this._tableName(targetClassName)} AS "__aggregate_lookup_target" ` +
        `WHERE ${foreignSql} = __aggregate_lookup_source.${localSql}` +
        `), '[]') AS ${quoteColumnName(lookupStage.as)} ` +
        `FROM (${context.sql}) AS "__aggregate_lookup_source"`,
      params: [...lookupObject.params, ...context.params],
    };
  }

  _applyAggregateUnwindStage(context: any, unwindStage: any): any {
    const path = typeof unwindStage === 'string' ? unwindStage : unwindStage.path;
    const fieldName = path.startsWith('$') ? path.slice(1) : path;
    const selectParts = [];
    for (const key of Object.keys(context.schema.fields)) {
      if (key === fieldName) {
        continue;
      }
      selectParts.push(`__aggregate_unwind_source.${quoteColumnName(key)}`);
    }
    selectParts.push(`json_each.value AS ${quoteColumnName(fieldName)}`);

    const currentField = context.schema.fields[fieldName];
    let nextFieldDefinition = { type: 'Object' };
    if (currentField && currentField.aggregateLookup) {
      nextFieldDefinition = {
        type: 'Object',
        aggregateLookup: true,
        lookupSchema: currentField.lookupSchema,
        targetClass: currentField.targetClass,
      };
    }

    const nextSchema = {
      className: context.className,
      fields: {
        ...context.schema.fields,
        [fieldName]: nextFieldDefinition,
      },
    };

    return {
      ...context,
      schema: nextSchema,
      sql:
        `SELECT ${selectParts.join(', ')} FROM (${context.sql}) AS "__aggregate_unwind_source", ` +
        `json_each(__aggregate_unwind_source.${quoteColumnName(fieldName)})`,
    };
  }

  _normalizeAggregateGroupIdValue(value: any, fieldSchema: any): any {
    const parsedValue = parseJSONValue(value);
    if (fieldSchema && fieldSchema.aggregateGroupPointer && typeof parsedValue === 'string') {
      return parsedValue.includes('$') ? parsedValue.split('$').slice(1).join('$') : parsedValue;
    }
    return parsedValue;
  }

  _convertAggregateFieldValue(
    key: string,
    value: any,
    fieldSchema: any,
    options: { rawValues?: boolean, rawFieldNames?: boolean }
  ): any {
    if (value === null || value === undefined) {
      return value;
    }
    if (fieldSchema && fieldSchema.aggregateLookup) {
      return this._convertAggregateNativeDocument(
        parseJSONValue(value),
        fieldSchema.lookupSchema,
        options
      );
    }
    if (fieldSchema && fieldSchema.type === 'Date' && typeof value === 'string') {
      return options.rawValues ? { $date: value } : { __type: 'Date', iso: value };
    }
    if (fieldSchema && fieldSchema.nativePointer && typeof value === 'string') {
      if (options.rawFieldNames) {
        return value;
      }
      return {
        __type: 'Pointer',
        className: fieldSchema.targetClass,
        objectId: value.includes('$') ? value.split('$').slice(1).join('$') : value,
      };
    }
    if (fieldSchema && (fieldSchema.type === 'Array' || fieldSchema.type === 'Object')) {
      return this._convertAggregateNativeDocument(parseJSONValue(value), null, options);
    }
    return parseJSONValue(value);
  }

  _convertAggregateNativeDocument(
    document: any,
    schema: ?SchemaType,
    options: { rawValues?: boolean, rawFieldNames?: boolean }
  ): any {
    if (document === null || document === undefined) {
      return document;
    }
    if (Array.isArray(document)) {
      return document.map(item => this._convertAggregateNativeDocument(parseJSONValue(item), schema, options));
    }
    if (!isPlainObject(document)) {
      return document;
    }

    const output = {};
    for (const key of Object.keys(document)) {
      if (!options.rawValues && !options.rawFieldNames && aggregateHiddenFieldNames.has(key)) {
        continue;
      }

      const value = document[key];
      const fieldSchema = schema && schema.fields ? schema.fields[key] : null;

      if (!options.rawFieldNames && key === '_id') {
        output.objectId = this._normalizeAggregateGroupIdValue(value, fieldSchema);
        continue;
      }
      if (!options.rawValues && !options.rawFieldNames && key === '_created_at') {
        output.createdAt = typeof value === 'string' ? value : new Date(value).toISOString();
        continue;
      }
      if (!options.rawValues && !options.rawFieldNames && key === '_updated_at') {
        output.updatedAt = typeof value === 'string' ? value : new Date(value).toISOString();
        continue;
      }

      const outputKey =
        !options.rawFieldNames && !options.rawValues && key.startsWith('_p_') ? key.slice(3) : key;
      output[outputKey] = this._convertAggregateFieldValue(key, value, fieldSchema, options);
    }
    return output;
  }

  async aggregate(
    className: string,
    schema: any,
    pipeline: any,
    _readPreference?: ?string,
    _hint?: ?mixed,
    _explain?: boolean,
    _comment?: ?string,
    rawValues?: boolean,
    rawFieldNames?: boolean
  ): Promise<any> {
    if (!(await this.classExists(className))) {
      return [];
    }
    schema = normalizeSQLiteSchema(className, schema);
    if (rawValues) {
      pipeline = EJSON.deserialize(pipeline);
    }

    let context = this._getNativeAggregateContext(className, schema);

    for (const stage of pipeline) {
      if (stage.$match) {
        context = this._applyAggregateMatchStage(
          context,
          stage.$match,
          schema,
          rawValues,
          rawFieldNames
        );
      } else if (stage.$project) {
        context = this._applyAggregateProjectStage(
          context,
          stage.$project,
          schema,
          rawValues,
          rawFieldNames
        );
      } else if (stage.$addFields) {
        context = this._applyAggregateAddFieldsStage(
          context,
          stage.$addFields,
          schema,
          rawValues,
          rawFieldNames
        );
      } else if (stage.$group) {
        context = this._applyAggregateGroupStage(context, stage.$group, schema, rawFieldNames);
      } else if (stage.$sort) {
        context = this._applyAggregateSortStage(context, stage.$sort, rawFieldNames);
      } else if (stage.$skip !== undefined) {
        context = this._applyAggregateSkipStage(context, stage.$skip);
      } else if (stage.$limit !== undefined) {
        context = this._applyAggregateLimitStage(context, stage.$limit);
      } else if (stage.$count) {
        context = this._applyAggregateCountStage(context, stage.$count);
      } else if (stage.$lookup) {
        context = await this._applyAggregateLookupStage(context, stage.$lookup);
      } else if (stage.$unwind) {
        context = this._applyAggregateUnwindStage(context, stage.$unwind);
      }
    }

    const rows = this._prepare(context.sql).all(...context.params);
    return rows.map(row =>
      this._convertAggregateNativeDocument(row, context.schema, {
        rawValues,
        rawFieldNames,
      })
    );
  }

  async deleteObjectsByQuery(
    className: string,
    schema: SchemaType,
    query: QueryType,
    transactionalSession: ?any
  ): Promise<void> {
    if (shouldYieldBeforeTopLevelSQLiteOperation(transactionalSession)) {
      await waitForNextEventLoopTurn();
    }
    const db = transactionalSession || this._db;
    if (shouldIgnoreSQLiteOperationAfterShutdown(db, this._isShutDown)) {
      return;
    }
    if (!(await this.classExists(className, db))) {
      return;
    }
    const tableName = this._tableName(className);
    const where = this._buildWhereClause(className, schema, query);
    let sql = `DELETE FROM ${tableName}`;
    if (where.sql) {
      sql += ` WHERE ${where.sql}`;
    }
    if (shouldYieldBeforeTopLevelSQLiteOperation(transactionalSession)) {
      await waitForNextEventLoopTurn();
    }
    const result = this._prepare(sql, transactionalSession).run(...where.params);
    if (!result || result.changes === 0) {
      throw new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.');
    }
  }

  async updateObjectsByQuery(
    className: string,
    schema: SchemaType,
    query: QueryType,
    update: any,
    transactionalSession: ?any
  ): Promise<any> {
    if (shouldYieldBeforeTopLevelSQLiteOperation(transactionalSession)) {
      await waitForNextEventLoopTurn();
    }
    const db = transactionalSession || this._db;
    if (shouldIgnoreSQLiteOperationAfterShutdown(db, this._isShutDown)) {
      return [];
    }
    if (!(await this.classExists(className, db))) {
      return [];
    }
    schema = normalizeSQLiteSchema(className, schema);

    const normalizeAuthDataUpdateObject = updateObject => {
      if (!updateObject || typeof updateObject !== 'object' || Array.isArray(updateObject)) {
        return;
      }
      let authDataUpdate =
        updateObject.authData &&
        typeof updateObject.authData === 'object' &&
        !Array.isArray(updateObject.authData) &&
        !updateObject.authData.__op
          ? { ...updateObject.authData }
          : null;
      let hasAuthDataUpdate = authDataUpdate !== null;

      for (const fieldName in updateObject) {
        if (!Object.prototype.hasOwnProperty.call(updateObject, fieldName)) {
          continue;
        }
        const provider = getAuthDataProviderFieldName(fieldName);
        if (!provider) {
          continue;
        }
        if (!hasAuthDataUpdate) {
          authDataUpdate = {};
          hasAuthDataUpdate = true;
        }
        authDataUpdate[provider] = updateObject[fieldName];
        delete updateObject[fieldName];
      }

      if (hasAuthDataUpdate && authDataUpdate) {
        updateObject.authData = authDataUpdate;
      }
    };

    normalizeAuthDataUpdateObject(update);
    normalizeAuthDataUpdateObject(update.$set);
    normalizeAuthDataUpdateObject(update.$unset);
    normalizeAuthDataUpdateObject(update.$inc);
    normalizeAuthDataUpdateObject(update.$add);
    normalizeAuthDataUpdateObject(update.$addUnique);
    normalizeAuthDataUpdateObject(update.$remove);

    const tableName = this._tableName(className);

    // Keep the initial read only for Mongo-compatible update return semantics.
    const existing = await this.find(className, schema, query, {}, db);
    if (!existing || existing.length === 0) {
      return [];
    }

    const where = this._buildWhereClause(className, schema, query);

    const setClauses = [];
    const params = [];
    const nestedFieldUpdates = new Map();
    let nullFieldTrackerUpdate = null;
    const cachedSchema = this._schemaCache.get(className);
    const mergedSchemaFields = {
      ...((cachedSchema && cachedSchema.fields) || {}),
      ...((schema && schema.fields) || {}),
    };
    const existingTableColumns = new Set(this._getTableColumns(className, db));

    const appendNullFieldTrackerUpdate = (fieldName, trackExplicitNull) => {
      if (!fieldName || fieldName === nullFieldTrackerColumn) {
        return;
      }
      const effectiveTrackExplicitNull =
        shouldPersistExplicitNullField(className, fieldName) && trackExplicitNull;
      const current = nullFieldTrackerUpdate || {
        expression: `COALESCE(${quoteColumnName(nullFieldTrackerColumn)}, '[]')`,
        params: [],
      };
      nullFieldTrackerUpdate = {
        expression: effectiveTrackExplicitNull
          ? `parse_array_add_unique(${current.expression}, ?)`
          : `parse_array_remove(${current.expression}, ?)`,
        params: [...current.params, JSON.stringify([fieldName])],
      };
    };

    const appendNestedFieldUpdate = (dotFieldPath, fieldValue) => {
      const { rootFieldName } = dotFieldPath;
      const fallbackContainerType =
        mergedSchemaFields[rootFieldName] && mergedSchemaFields[rootFieldName].type === 'Array'
          ? 'array'
          : 'object';
      const existingUpdate = nestedFieldUpdates.get(rootFieldName) || {
        expression: getJsonContainerValueExpression(
          quoteColumnName(rootFieldName),
          fallbackContainerType
        ),
        params: [],
      };
      const nextUpdate = buildJsonPathUpdateExpression(
        existingUpdate.expression,
        dotFieldPath,
        fieldValue
      );
      nestedFieldUpdates.set(rootFieldName, {
        expression: nextUpdate.expression,
        params: [...existingUpdate.params, ...nextUpdate.params],
      });
      appendNullFieldTrackerUpdate(rootFieldName, false);
    };

    const handleOp = async (fieldName: string, fieldValue: any) => {
      if (typeof fieldValue === 'undefined') {
        return;
      }
      const authDataProvider = getAuthDataProviderFieldName(fieldName);
      if (authDataProvider) {
        fieldName = 'authData';
        fieldValue = { [authDataProvider]: fieldValue };
      }
      const isDotNotationField = fieldName.indexOf('.') >= 0;
      const dotFieldPath = isDotNotationField ? buildDotFieldPath(fieldName) : null;
      const columnName = quoteColumnName(
        dotFieldPath ? dotFieldPath.rootFieldName : fieldName
      );
      const storageFieldName = dotFieldPath ? dotFieldPath.rootFieldName : fieldName;
      const schemaInferenceValue = getUpdateValueForSchemaInference(fieldName, fieldValue);

      if (typeof schemaInferenceValue !== 'undefined') {
        await this._ensureColumnsExist(className, { [fieldName]: schemaInferenceValue }, schema, db);
        existingTableColumns.add(storageFieldName);
      }

      if (fieldValue === null) {
        if (dotFieldPath) {
          if (!existingTableColumns.has(storageFieldName)) {
            return;
          }
          appendNestedFieldUpdate(dotFieldPath, null);
        } else {
          validateFieldName(fieldName);
          if (existingTableColumns.has(storageFieldName)) {
            setClauses.push(`${columnName} = NULL`);
          }
          appendNullFieldTrackerUpdate(fieldName, true);
        }
        return;
      }

      if (typeof fieldValue === 'object') {
        if (fieldValue.__op === 'Increment') {
          if (dotFieldPath) {
            appendNestedFieldUpdate(dotFieldPath, fieldValue);
          } else {
            if (typeof fieldValue.amount !== 'number' || Number.isNaN(fieldValue.amount)) {
              throw new Parse.Error(
                Parse.Error.INVALID_JSON,
                'Cannot increment by a non-numeric value.'
              );
            }
            validateFieldName(fieldName);
            setClauses.push(`${columnName} = COALESCE(${columnName}, 0) + ?`);
            params.push(fieldValue.amount);
            appendNullFieldTrackerUpdate(fieldName, false);
          }
          return;
        }
        if (fieldValue.__op === 'Add') {
          if (dotFieldPath) {
            appendNestedFieldUpdate(dotFieldPath, fieldValue);
          } else {
            validateFieldName(fieldName);
            setClauses.push(`${columnName} = ${buildJSONArrayAppendExpression(columnName)}`);
            params.push(JSON.stringify(fieldValue.objects));
            appendNullFieldTrackerUpdate(fieldName, false);
          }
          return;
        }
        if (fieldValue.__op === 'AddUnique') {
          if (dotFieldPath) {
            appendNestedFieldUpdate(dotFieldPath, fieldValue);
          } else {
            validateFieldName(fieldName);
            setClauses.push(`${columnName} = parse_array_add_unique(${columnName}, ?)`);
            params.push(JSON.stringify(fieldValue.objects));
            appendNullFieldTrackerUpdate(fieldName, false);
          }
          return;
        }
        if (fieldValue.__op === 'Remove') {
          if (dotFieldPath) {
            appendNestedFieldUpdate(dotFieldPath, fieldValue);
          } else {
            validateFieldName(fieldName);
            setClauses.push(`${columnName} = parse_array_remove(${columnName}, ?)`);
            params.push(JSON.stringify(fieldValue.objects));
            appendNullFieldTrackerUpdate(fieldName, false);
          }
          return;
        }
        if (fieldValue.__op === 'Delete') {
          if (!existingTableColumns.has(storageFieldName)) {
            return;
          }
          if (dotFieldPath) {
            appendNestedFieldUpdate(dotFieldPath, fieldValue);
          } else {
            validateFieldName(fieldName);
            setClauses.push(`${columnName} = NULL`);
            appendNullFieldTrackerUpdate(fieldName, false);
          }
          return;
        }
        if (fieldName === 'authData') {
          validateFieldName('authData');
          const existingAuthDataUpdate = nestedFieldUpdates.get('authData') || {
            expression: quoteColumnName('authData'),
            params: [],
          };
          let authDataExpression = existingAuthDataUpdate.expression;
          const authDataParams = [...existingAuthDataUpdate.params];
          for (const provider in fieldValue) {
            if (!Object.prototype.hasOwnProperty.call(fieldValue, provider)) {
              continue;
            }
            let val = fieldValue[provider];
            if (val && val.__op === 'Delete') {
              val = null;
            }
            if (val === null) {
              authDataExpression = `json_remove(COALESCE(${authDataExpression}, '{}'), '$."${provider}"')`;
            } else {
              authDataExpression =
                `json_set(COALESCE(${authDataExpression}, '{}'), '$."${provider}"', ` +
                `${getParameterizedValueExpression(val)})`;
              authDataParams.push(toSQLiteValue(val));
            }
          }
          nestedFieldUpdates.set('authData', {
            expression: authDataExpression,
            params: authDataParams,
          });
          appendNullFieldTrackerUpdate('authData', false);
          return;
        }
        if (fieldValue.__type === 'Relation') {
          return;
        }
      }

      if (dotFieldPath) {
        appendNestedFieldUpdate(dotFieldPath, fieldValue);
        return;
      }

      validateNestedKeys(fieldValue);
      validateFieldName(fieldName);
      const sqliteValue = toSQLiteValue(fieldValue);
      setClauses.push(`${columnName} = ?`);
      params.push(sqliteValue);
      appendNullFieldTrackerUpdate(fieldName, sqliteValue === null);
    };

    if (update.$set) {
      for (const k in update.$set) {
        if (!Object.prototype.hasOwnProperty.call(update.$set, k)) {
          continue;
        }
        await handleOp(k, update.$set[k]);
      }
    }
    if (update.$inc) {
      for (const k in update.$inc) {
        if (!Object.prototype.hasOwnProperty.call(update.$inc, k)) {
          continue;
        }
        await handleOp(k, { __op: 'Increment', amount: update.$inc[k] });
      }
    }
    if (update.$unset) {
      for (const k in update.$unset) {
        if (!Object.prototype.hasOwnProperty.call(update.$unset, k)) {
          continue;
        }
        if (k.indexOf('.') >= 0) {
          const dotFieldPath = buildDotFieldPath(k);
          if (!existingTableColumns.has(dotFieldPath.rootFieldName)) {
            continue;
          }
          appendNestedFieldUpdate(dotFieldPath, { __op: 'Delete' });
        } else {
          if (!existingTableColumns.has(k)) {
            continue;
          }
          validateFieldName(k);
          setClauses.push(`${quoteColumnName(k)} = NULL`);
          appendNullFieldTrackerUpdate(k, false);
        }
      }
    }
    if (update.$add) {
      for (const k in update.$add) {
        if (!Object.prototype.hasOwnProperty.call(update.$add, k)) {
          continue;
        }
        await handleOp(k, { __op: 'Add', objects: update.$add[k] });
      }
    }
    if (update.$addUnique) {
      for (const k in update.$addUnique) {
        if (!Object.prototype.hasOwnProperty.call(update.$addUnique, k)) {
          continue;
        }
        await handleOp(k, { __op: 'AddUnique', objects: update.$addUnique[k] });
      }
    }
    if (update.$remove) {
      for (const k in update.$remove) {
        if (!Object.prototype.hasOwnProperty.call(update.$remove, k)) {
          continue;
        }
        await handleOp(k, { __op: 'Remove', objects: update.$remove[k] });
      }
    }

    for (const k in update) {
      if (!Object.prototype.hasOwnProperty.call(update, k)) {
        continue;
      }
      if (!k.startsWith('$')) {
        await handleOp(k, update[k]);
      }
    }

    for (const [rootFieldName, nestedFieldUpdate] of nestedFieldUpdates.entries()) {
      setClauses.push(`${quoteColumnName(rootFieldName)} = ${nestedFieldUpdate.expression}`);
      params.push(...nestedFieldUpdate.params);
    }
    if (nullFieldTrackerUpdate) {
      setClauses.push(
        `${quoteColumnName(nullFieldTrackerColumn)} = ${nullFieldTrackerUpdate.expression}`
      );
      params.push(...nullFieldTrackerUpdate.params);
    }

    let updateChanges;
    if (setClauses.length > 0) {
      setClauses.push(`${quoteColumnName(writeSequenceColumn)} = ?`);
      params.push(this._nextWriteSequence());
      let sql = `UPDATE ${tableName} SET ${setClauses.join(', ')}`;
      if (where.sql) {
        sql += ` WHERE ${where.sql}`;
      }
      params.push(...where.params);
      try {
        if (shouldYieldBeforeTopLevelSQLiteOperation(transactionalSession)) {
          await waitForNextEventLoopTurn();
        }
        const result = this._prepare(sql, transactionalSession).run(...params);
        updateChanges = typeof result.changes === 'number' ? result.changes : undefined;
      } catch (err) {
        throw this._transformDuplicateKeyError(err, className);
      }
    }

    if (updateChanges === 0) {
      const stillMatching = await this.find(
        className,
        schema,
        query,
        { limit: existing.length },
        {},
        db
      );
      if (!stillMatching || stillMatching.length === 0) {
        return [];
      }
      return stillMatching;
    }

    const ids = existing.map(o => o.objectId);
    const updated = await this.find(className, schema, { objectId: { $in: ids } }, {}, db);
    return updated;
  }

  async findOneAndUpdate(
    className: string,
    schema: SchemaType,
    query: QueryType,
    update: any,
    transactionalSession: ?any
  ): Promise<any> {
    const results = await this.updateObjectsByQuery(className, schema, query, update, transactionalSession);
    return results ? results[0] : undefined;
  }

  async upsertOneObject(
    className: string,
    schema: SchemaType,
    query: QueryType,
    update: any,
    transactionalSession: ?any
  ): Promise<any> {
    const db = transactionalSession || this._db;
    const existing = await this.find(className, schema, query, { limit: 1 });
    if (existing && existing.length > 0) {
      await this.updateObjectsByQuery(className, schema, query, update, db);
      return this.find(className, schema, { objectId: existing[0].objectId }, { limit: 1 }).then(r => r[0]);
    } else {
      const createObj = { ...query };
      if (update.$set) {
        Object.assign(createObj, update.$set);
      }
      if (update.$inc) {
        for (const key in update.$inc) {
          if (!Object.prototype.hasOwnProperty.call(update.$inc, key)) {
            continue;
          }
          createObj[key] = update.$inc[key];
        }
      }
      if (update.$add) {
        for (const key in update.$add) {
          if (!Object.prototype.hasOwnProperty.call(update.$add, key)) {
            continue;
          }
          createObj[key] = update.$add[key];
        }
      }
      if (update.$addUnique) {
        for (const key in update.$addUnique) {
          if (!Object.prototype.hasOwnProperty.call(update.$addUnique, key)) {
            continue;
          }
          createObj[key] = update.$addUnique[key];
        }
      }
      if (update.$unset) {
        for (const key in update.$unset) {
          if (!Object.prototype.hasOwnProperty.call(update.$unset, key)) {
            continue;
          }
          delete createObj[key];
        }
      }
      for (const key in update) {
        if (!Object.prototype.hasOwnProperty.call(update, key)) {
          continue;
        }
        if (!key.startsWith('$')) {
          createObj[key] = update[key];
        }
      }
      await this.createObject(className, schema, createObj, db);
      return createObj;
    }
  }

  async ensureIndex(
    className: string,
    schema: SchemaType,
    fieldNames: string[],
    indexName?: string,
    caseInsensitive?: boolean = false,
    options?: Object = {}
  ): Promise<any> {
    if (!(await this.classExists(className))) {
      const fields = {};
      fieldNames.forEach(f => {
        fields[f] = { type: 'String' };
      });
      await this.createClass(className, schema || { fields });
    }
    const tableName = this._tableName(className);
    const idxName = indexName || `parse_default_${fieldNames.sort().join('_')}`;
    const safeIdxName = `"${idxName.replace(/"/g, '""')}"`;
    const colExprs = fieldNames.map(fieldName => {
      const fieldExpression = this._buildIndexFieldExpression(fieldName).expression;

      // Parse asks for these username/email helper indexes so lowered `LIKE 'foo%'`
      // can seek with SQLite's NOCASE collation instead of walking the whole table.
      if (caseInsensitive) {
        return `${fieldExpression} COLLATE NOCASE`;
      } else {
        return fieldExpression;
      }
    });

    let sql = `CREATE INDEX IF NOT EXISTS ${safeIdxName} ON ${tableName} (${colExprs.join(', ')})`;
    if (options.ttl) {
      sql = `CREATE INDEX IF NOT EXISTS ${safeIdxName} ON ${tableName} ("_expiresAt")`;
    }
    try {
      this._prepare(sql, options.conn).run();
    } catch {
      /* */
    }
  }

  async ensureUniqueness(className: string, schema: SchemaType, fieldNames: Array<string>): Promise<void> {
    if (!(await this.classExists(className))) {
      const fields = {};
      fieldNames.forEach(f => {
        fields[f] = { type: 'String' };
      });
      await this.createClass(className, schema || { fields });
    }
    const tableName = this._tableName(className);
    const idxName = `unique_${fieldNames.join('_')}`;
    const safeIdxName = `"${idxName.replace(/"/g, '""')}"`;
    const colExprs = fieldNames.map(fieldName => this._buildIndexFieldExpression(fieldName).expression);

    const sql = `CREATE UNIQUE INDEX IF NOT EXISTS ${safeIdxName} ON ${tableName} (${colExprs.join(', ')})`;
    try {
      this._prepare(sql).run();
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw new Parse.Error(
          Parse.Error.DUPLICATE_VALUE,
          'Tried to ensure field uniqueness for a class that already has duplicates.'
        );
      }
      throw err;
    }
  }

  async ensureAuthDataUniqueness(provider: string): Promise<void> {
    if (!(await this.classExists('_User'))) {
      await this.createClass('_User', { fields: { authData: { type: 'Object' } } });
    }
    const indexName = `_User_unique_authData_${provider}_id`;
    const safeIdxName = `"${indexName.replace(/"/g, '""')}"`;
    const tableName = this._tableName('_User');
    const sql = `CREATE UNIQUE INDEX IF NOT EXISTS ${safeIdxName} ON ${tableName} (json_extract("authData", '$."${provider}".id')) WHERE json_extract("authData", '$."${provider}".id') IS NOT NULL`;
    try {
      this._prepare(sql).run();
    } catch (err) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw new Parse.Error(
          Parse.Error.DUPLICATE_VALUE,
          'Tried to ensure field uniqueness for a class that already has duplicates.'
        );
      }
      throw err;
    }
  }

  async createIndex(className: string, index: any, options?: any, conn?: any): Promise<void> {
    const storedSchema = this._getStoredSchemaObject(className) || {
      isParseClass: isSQLiteInternalClass(className) ? 0 : 1,
      schema: { className, fields: {} },
    };
    const indexName = (options && options.name) || buildAutomaticIndexName(index);
    const fields = storedSchema.schema.fields || {};

    for (const fieldName of Object.keys(index || {})) {
      if (!this.disableIndexFieldValidation && !this._fieldExistsForIndex(fields, fieldName)) {
        throw new Parse.Error(
          Parse.Error.INVALID_QUERY,
          `Field ${fieldName} does not exist, cannot add index.`
        );
      }
    }

    await this.createIndexes(
      className,
      [
        {
          name: indexName,
          key: index,
          unique: Boolean(options && options.unique),
          sparse: Boolean(options && options.sparse),
          skipDatabaseCreation:
            this.disableIndexFieldValidation &&
            Object.keys(index || {}).some(fieldName => !this._fieldExistsForIndex(fields, fieldName)),
        },
      ],
      conn
    );

    storedSchema.schema.indexes = storedSchema.schema.indexes || buildDefaultSchemaIndexes();
    storedSchema.schema.indexes[indexName] = cloneIndexDefinition(index);
    this._saveStoredSchemaObject(className, storedSchema.schema, storedSchema.isParseClass);
    this._notifySchemaChange();
  }

  async createIndexes(className: string, indexes: any, conn?: any): Promise<void> {
    if (!indexes) {
      return;
    }
    await this._ensureClassExists(className, { fields: {} }, conn);
    const storedSchema = this._getStoredSchemaObject(className, conn) || {
      schema: { fields: {} },
    };
    const schemaFields = (storedSchema.schema && storedSchema.schema.fields) || {};
    let normalizedIndexes;
    if (Array.isArray(indexes)) {
      normalizedIndexes = indexes.map(index => ({
        name: index.name,
        key: index.key,
        unique: Boolean(index.unique),
        sparse: Boolean(index.sparse),
        skipDatabaseCreation: Boolean(index.skipDatabaseCreation),
      }));
    } else {
      normalizedIndexes = Object.keys(indexes).map(name => ({
        name,
        key: indexes[name],
        unique: false,
        sparse: false,
        skipDatabaseCreation: false,
      }));
    }

    const tableName = this._tableName(className);
    const columns = new Set(this._getTableColumns(className, conn));

    for (const index of normalizedIndexes) {
      const key = index.key || {};
      if (
        index.skipDatabaseCreation ||
        Object.keys(key).length === 0 ||
        isTextIndexDefinition(key)
      ) {
        continue;
      }

      const indexFieldExpressions = Object.keys(key).map(fieldName =>
        this._buildIndexFieldExpression(fieldName)
      );
      if (
        indexFieldExpressions.some(({ requiredColumns }) =>
          requiredColumns.some(columnName => !columns.has(columnName))
        )
      ) {
        continue;
      }

      const idxName = `"${index.name.replace(/"/g, '""')}"`;
      const cols = indexFieldExpressions.map(({ expression }) => expression);
      let sql = `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${idxName} ON ${tableName} (${cols.join(', ')})`;
      if (index.sparse) {
        sql += ` WHERE ${cols.map(expression => `${expression} IS NOT NULL`).join(' AND ')}`;
      }

      try {
        this._prepare(sql, conn).run();
      } catch (err) {
        throw this._transformDuplicateKeyError(err, className);
      }

      for (const fieldName of Object.keys(key)) {
        await this._ensureArrayElementIndex(className, schemaFields, fieldName, conn);
      }
    }
  }

  async getIndexes(className: string, connection?: any): Promise<Array<any>> {
    if (!(await this.classExists(className, connection))) {
      return [];
    }
    const rawName = this._rawTableName(className);
    const indexes = [{ name: '_id_', key: { _id: 1 }, unique: true }];
    const rows = this._prepare(`PRAGMA index_list("${rawName.replace(/"/g, '""')}")`, connection).all();
    for (const row of rows) {
      if (!row.name || String(row.name).startsWith('sqlite_autoindex_')) {
        continue;
      }
      const indexRows = this._prepare(
        `PRAGMA index_info("${String(row.name).replace(/"/g, '""')}")`,
        connection
      ).all();
      const key = {};
      for (const indexRow of indexRows) {
        if (!indexRow.name) {
          continue;
        }
        const fieldName = indexRow.name === 'objectId' ? '_id' : indexRow.name;
        key[fieldName] = 1;
      }
      if (Object.keys(key).length === 0) {
        continue;
      }
      indexes.push({
        name: row.name,
        key,
        unique: Boolean(row.unique),
      });
    }

    const storedSchema = this._getStoredSchemaObject(className);
    const storedIndexes = (storedSchema && storedSchema.schema && storedSchema.schema.indexes) || {};
    for (const name of Object.keys(storedIndexes)) {
      if (indexes.some(index => index.name === name)) {
        continue;
      }
      indexes.push({
        name,
        key: cloneIndexDefinition(storedIndexes[name]),
        unique: false,
      });
    }

    return indexes;
  }

  async dropIndexes(className: string, indexes: Array<string>, conn?: any): Promise<void> {
    const storedSchema = this._getStoredSchemaObject(className, conn) || {
      schema: { fields: {}, indexes: {} },
    };
    const schemaFields = (storedSchema.schema && storedSchema.schema.fields) || {};
    const storedIndexes = (storedSchema.schema && storedSchema.schema.indexes) || {};
    const droppedArrayIndexFieldNames = new Set();
    const retainedArrayIndexFieldNames = new Set();

    for (const indexName in storedIndexes) {
      if (!Object.prototype.hasOwnProperty.call(storedIndexes, indexName)) {
        continue;
      }
      const indexDefinition = storedIndexes[indexName] || {};
      for (const fieldName in indexDefinition) {
        if (!Object.prototype.hasOwnProperty.call(indexDefinition, fieldName)) {
          continue;
        }
        const arrayIndexField = this._getArrayElementIndexFieldInfo(schemaFields, fieldName);
        if (!arrayIndexField) {
          continue;
        }
        if (indexes.includes(indexName)) {
          droppedArrayIndexFieldNames.add(arrayIndexField.normalizedFieldName);
        } else {
          retainedArrayIndexFieldNames.add(arrayIndexField.normalizedFieldName);
        }
      }
    }

    for (const indexName of indexes) {
      if (indexName === '_id_') {
        continue;
      }
      this._prepare(
        `DROP INDEX IF EXISTS "${String(indexName).replace(/"/g, '""')}"`,
        conn
      ).run();
    }

    for (const fieldName of droppedArrayIndexFieldNames) {
      if (!retainedArrayIndexFieldNames.has(fieldName)) {
        this._dropArrayElementIndexArtifactsForField(className, fieldName, schemaFields, conn);
      }
    }
  }

  async updateSchemaWithIndexes(): Promise<void> {
    const rows = this._prepare('SELECT "className", "schema", "isParseClass" FROM "_SCHEMA"').all();
    for (const row of rows) {
      let schemaObj = {};
      try {
        schemaObj = JSON.parse(row.schema);
      } catch {
        schemaObj = {};
      }
      const indexes = await this.getIndexes(row.className);
      schemaObj.indexes = this._buildSchemaIndexesObject(indexes);
      this._saveStoredSchemaObject(row.className, schemaObj, row.isParseClass);
    }
  }

  async setIndexesWithSchemaFormat(
    className: string,
    submittedIndexes: any,
    existingIndexes: any,
    fields: any,
    conn?: any
  ): Promise<void> {
    if (submittedIndexes === undefined) {
      return;
    }
    const nextIndexes =
      Object.keys(existingIndexes || {}).length > 0
        ? { ...existingIndexes }
        : buildDefaultSchemaIndexes();
    const deletedIndexes = [];
    const deletedTextIndexFields = new Set();
    const insertedIndexes = [];

    for (const name of Object.keys(submittedIndexes)) {
      const indexDefinition = submittedIndexes[name];
      if (nextIndexes[name] && indexDefinition.__op !== 'Delete') {
        throw new Parse.Error(Parse.Error.INVALID_QUERY, `Index ${name} exists, cannot update.`);
      }
      if (!nextIndexes[name] && indexDefinition.__op === 'Delete') {
        throw new Parse.Error(
          Parse.Error.INVALID_QUERY,
          `Index ${name} does not exist, cannot delete.`
        );
      }
      if (indexDefinition.__op === 'Delete') {
        const deletedIndexDefinition = nextIndexes[name] || existingIndexes[name];
        if (isTextIndexDefinition(deletedIndexDefinition)) {
          Object.keys(deletedIndexDefinition).forEach(fieldName => {
            deletedTextIndexFields.add(fieldName);
          });
        }
        deletedIndexes.push(name);
        delete nextIndexes[name];
        continue;
      }

      const missingField = Object.keys(indexDefinition).find(
        fieldName => !this._fieldExistsForIndex(fields || {}, fieldName)
      );
      if (missingField && !this.disableIndexFieldValidation) {
        throw new Parse.Error(
          Parse.Error.INVALID_QUERY,
          `Field ${missingField} does not exist, cannot add index.`
        );
      }

      nextIndexes[name] = cloneIndexDefinition(indexDefinition);
      insertedIndexes.push({
        name,
        key: indexDefinition,
        unique: false,
        sparse: false,
        skipDatabaseCreation: Boolean(missingField),
      });
    }

    if (insertedIndexes.length > 0) {
      await this.createIndexes(className, insertedIndexes, conn);
    }
    if (deletedIndexes.length > 0) {
      await this.dropIndexes(className, deletedIndexes, conn);
    }
    for (const fieldName of deletedTextIndexFields) {
      this._dropFTS5ArtifactsForField(className, fieldName, conn);
    }

    const storedSchema = this._getStoredSchemaObject(className, conn) || {
      isParseClass: isSQLiteInternalClass(className) ? 0 : 1,
      schema: { className, fields: fields || {} },
    };
    storedSchema.schema.indexes = nextIndexes;
    this._saveStoredSchemaObject(className, storedSchema.schema, storedSchema.isParseClass, conn);
    if (!conn || conn === this._db) {
      this._notifySchemaChange();
    }
  }

  _collectionNameToClassName(collectionName: string): string {
    if (collectionName.startsWith(this._collectionPrefix)) {
      const rawTableName = collectionName.slice(this._collectionPrefix.length);
      if (rawTableName.startsWith(sqliteEncodedTableNamePrefix)) {
        const decodedClassName = decodeSQLiteTableNameToken(
          rawTableName.slice(sqliteEncodedTableNamePrefix.length)
        );
        if (decodedClassName) {
          return decodedClassName;
        }
      }
      return rawTableName;
    }
    return collectionName;
  }

  _normalizeLegacyDatabaseFieldName(className: string, fieldName: string): string {
    if (className === '_Audience') {
      if (fieldName === '_id') {
        return 'objectId';
      }
      if (fieldName === '_last_used') {
        return 'lastUsed';
      }
      if (fieldName === 'times_used') {
        return 'timesUsed';
      }
    }
    return fieldName;
  }

  _normalizeLegacyDatabaseQuery(className: string, query: any = {}): any {
    return Object.keys(query || {}).reduce((output, fieldName) => {
      const normalizedFieldName = this._normalizeLegacyDatabaseFieldName(className, fieldName);
      let value = query[fieldName];
      if (normalizedFieldName === 'lastUsed' && Utils.isDate(value)) {
        value = Parse._encode(value);
      }
      output[normalizedFieldName] = value;
      return output;
    }, {});
  }

  _normalizeLegacyDatabaseUpdate(className: string, update: any = {}): any {
    const normalizedUpdate = {};
    for (const operator of Object.keys(update || {})) {
      if (operator !== '$set') {
        normalizedUpdate[operator] = update[operator];
        continue;
      }
      normalizedUpdate.$set = Object.keys(update.$set || {}).reduce((output, fieldName) => {
        const normalizedFieldName = this._normalizeLegacyDatabaseFieldName(className, fieldName);
        let value = update.$set[fieldName];
        if (normalizedFieldName === 'lastUsed' && Utils.isDate(value)) {
          value = Parse._encode(value);
        }
        output[normalizedFieldName] = value;
        return output;
      }, {});
    }
    return normalizedUpdate;
  }

  _toLegacyDatabaseRow(className: string, object: any): any {
    return Object.keys(object || {}).reduce((output, fieldName) => {
      const value = object[fieldName];
      if (className === '_Audience') {
        if (fieldName === 'objectId') {
          output._id = value;
          return output;
        }
        if (fieldName === 'lastUsed') {
          output._last_used =
            value && value.__type === 'Date'
              ? new Date(value.iso)
              : typeof value === 'string'
                ? new Date(value)
                : value;
          return output;
        }
        if (fieldName === 'timesUsed') {
          output.times_used = value;
          return output;
        }
      }
      output[fieldName] = value;
      return output;
    }, {});
  }

  _buildLegacyDatabaseCompat(): any {
    return {
      collection: (collectionName: string) => {
        const className = this._collectionNameToClassName(collectionName);
        const getSchema = () =>
          (this._getStoredSchemaObject(className) || { schema: { className, fields: {} } }).schema;

        return {
          updateOne: async (query: any = {}, update: any = {}) => {
            const normalizedQuery = this._normalizeLegacyDatabaseQuery(className, query);
            const normalizedUpdate = this._normalizeLegacyDatabaseUpdate(className, update);
            const result = await this.updateObjectsByQuery(
              className,
              getSchema(),
              normalizedQuery,
              normalizedUpdate
            );
            return {
              acknowledged: true,
              matchedCount: result.length,
              modifiedCount: result.length,
            };
          },
          find: (query: any = {}) => ({
            toArray: async () => {
              const normalizedQuery = this._normalizeLegacyDatabaseQuery(className, query);
              const results = await this.find(className, getSchema(), normalizedQuery);
              return results.map(row => this._toLegacyDatabaseRow(className, row));
            },
          }),
        };
      },
    };
  }

  async _adaptiveCollection(className: string): Promise<any> {
    return {
      find: async (query: any = {}) => {
        const tableName = this._tableName(className);
        const schema = normalizeSQLiteSchema(
          className,
          (this._getStoredSchemaObject(className) || { schema: { fields: {} } }).schema
        );
        const where = this._buildWhereClause(className, schema, query);
        let sql = `SELECT * FROM ${tableName}`;
        if (where.sql) {
          sql += ` WHERE ${where.sql}`;
        }
        const rows = this._prepare(sql).all(...where.params);
        return rows.map(row => this._buildRawStorageObject(row));
      },
      _ensureSparseUniqueIndexInBackground: async (index: any) => {
        for (const fieldName of Object.keys(index || {})) {
          await this.addFieldIfNotExists(className, fieldName, { type: 'Number' });
        }
        await this.createIndex(className, index, {
          name: buildAutomaticIndexName(index),
          unique: true,
          sparse: true,
        });
      },
    };
  }

  async performInitialization(options: any = {}): Promise<void> {
    this._initSchemaTable();
    const VolatileClassesSchemas = options.VolatileClassesSchemas || [];
    for (const schema of VolatileClassesSchemas) {
      if (!(await this.classExists(schema.className))) {
        try {
          await this.createClass(schema.className, schema);
        } catch (err) {
          if (err.code !== Parse.Error.DUPLICATE_VALUE) {
            throw err;
          }
        }
      }
    }
  }

  async createTransactionalSession(): Promise<any> {
    const txDb = createClient(this._dbOptions);
    txDb.exec('BEGIN IMMEDIATE');
    return txDb;
  }

  async commitTransactionalSession(transactionalSession: any): Promise<void> {
    try {
      transactionalSession.exec('COMMIT');
    } finally {
      transactionalSession.close();
      this._reloadSchemaStateFromDatabase();
    }
  }

  async abortTransactionalSession(transactionalSession: any): Promise<void> {
    try {
      transactionalSession.exec('ROLLBACK');
    } finally {
      transactionalSession.close();
      this._reloadSchemaStateFromDatabase();
    }
  }
}

Object.setPrototypeOf(SQLiteStorageAdapter.prototype, PostgresStorageAdapter.prototype);

export default SQLiteStorageAdapter;
