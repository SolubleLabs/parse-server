const SQLiteStorageAdapter = require('../lib/Adapters/Storage/SQLite/SQLiteStorageAdapter').default;
const { createClient } = require('../lib/Adapters/Storage/SQLite/SQLiteClient');
const {
  getDatabaseOptionsFromURI,
} = require('../lib/Adapters/Storage/SQLite/SQLiteConfigParser');
const Parse = require('parse/node');

describe_only_db('sqlite')('SQLiteStorageAdapter Unit & Security Tests', () => {
  let adapter;
  let collectionPrefixIndex = 0;
  const getFTSArtifactsForField = (currentAdapter, className, fieldName) => {
    const rawTableNames = [
      currentAdapter._rawFTSTableName(className, fieldName, false),
      currentAdapter._rawFTSTableName(className, fieldName, true),
    ];
    const triggerNames = rawTableNames.flatMap(rawTableName =>
      Object.values(currentAdapter._getFTS5TriggerNames(rawTableName)).map(triggerName =>
        triggerName.slice(1, -1)
      )
    );
    const allRows = currentAdapter._db
      .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all();

    return allRows.filter(
      row =>
        rawTableNames.some(rawTableName => row.name === rawTableName || row.name.startsWith(`${rawTableName}_`)) ||
        triggerNames.includes(row.name)
    );
  };

  beforeEach(async () => {
    adapter = new SQLiteStorageAdapter({
      uri: 'sqlite://:memory:',
      collectionPrefix: `test_${collectionPrefixIndex++}_`,
      databaseOptions: { enableSchemaHooks: true },
    });
  });

  afterEach(() => {
    adapter.handleShutdown();
  });

  it('supports configurable sqlite cache size', async () => {
    const configuredAdapter = new SQLiteStorageAdapter({
      uri: 'sqlite://:memory:?cacheSizeKb=16384',
      collectionPrefix: `cache_${collectionPrefixIndex++}_`,
    });

    try {
      expect(configuredAdapter._db.pragma('cache_size', { simple: true })).toBe(-16384);
    } finally {
      configuredAdapter.handleShutdown();
    }
  });

  it('preserves an explicit sqlite timeout of 0', () => {
    const db = createClient({ filename: ':memory:', timeout: 0 });

    try {
      expect(db.pragma('busy_timeout', { simple: true })).toBe(0);
    } finally {
      db.close();
    }
  });

  it('does not throw on malformed percent-encoding in sqlite URIs', () => {
    expect(() => getDatabaseOptionsFromURI('sqlite://bad%2path.sqlite')).not.toThrow();
    expect(getDatabaseOptionsFromURI('sqlite://bad%2path.sqlite').filename).toBe(
      'bad%2path.sqlite'
    );
  });

  it('normalizes file sqlite URIs and ignores invalid numeric query options', () => {
    expect(
      getDatabaseOptionsFromURI('file:relative/test.sqlite?timeout=bad&cacheSizeKb=4096')
    ).toEqual({
      filename: 'relative/test.sqlite',
      cacheSizeKb: 4096,
    });

    expect(getDatabaseOptionsFromURI('file::memory:?cache=shared').filename).toBe(':memory:');
  });

  it('creates class and inserts objects', async () => {
    const schema = {
      className: 'TestClass',
      fields: {
        objectId: { type: 'String' },
        name: { type: 'String' },
        age: { type: 'Number' },
      },
    };
    await adapter.createClass('TestClass', schema);
    const exists = await adapter.classExists('TestClass');
    expect(exists).toBe(true);

    await adapter.createObject('TestClass', schema, {
      objectId: 'obj1',
      name: 'Alice',
      age: 30,
    });

    const results = await adapter.find('TestClass', schema, { objectId: 'obj1' });
    expect(results.length).toBe(1);
    expect(results[0].name).toBe('Alice');
    expect(results[0].age).toBe(30);
  });

  it('handles large primitive $in queries without hitting sqlite expression limits', async () => {
    const schema = {
      className: 'LargeInClass',
      fields: {
        objectId: { type: 'String' },
      },
    };
    await adapter.createClass('LargeInClass', schema);
    await adapter.createObject('LargeInClass', schema, {
      objectId: 'match-me',
    });

    const longListOfObjectIds = [];
    for (let i = 0; i < 1500; i += 1) {
      longListOfObjectIds.push(`missing-${i}`);
    }
    longListOfObjectIds.push('match-me');

    const results = await adapter.find('LargeInClass', schema, {
      objectId: { $in: longListOfObjectIds },
    });

    expect(results.map(result => result.objectId)).toEqual(['match-me']);
  });

  it('handles large pointer $in queries on scalar pointer fields', async () => {
    const childSchema = {
      className: 'LargePointerChild',
      fields: {
        objectId: { type: 'String' },
      },
    };
    const schema = {
      className: 'LargePointerScalarClass',
      fields: {
        objectId: { type: 'String' },
        child: { type: 'Pointer', targetClass: 'LargePointerChild' },
      },
    };
    await adapter.createClass('LargePointerChild', childSchema);
    await adapter.createClass('LargePointerScalarClass', schema);
    await adapter.createObject('LargePointerChild', childSchema, {
      objectId: 'child-match',
    });
    await adapter.createObject('LargePointerScalarClass', schema, {
      objectId: 'parent-match',
      child: {
        __type: 'Pointer',
        className: 'LargePointerChild',
        objectId: 'child-match',
      },
    });

    const longPointerList = [];
    for (let i = 0; i < 1500; i += 1) {
      longPointerList.push({
        __type: 'Pointer',
        className: 'LargePointerChild',
        objectId: `missing-child-${i}`,
      });
    }
    longPointerList.push({
      __type: 'Pointer',
      className: 'LargePointerChild',
      objectId: 'child-match',
    });

    const results = await adapter.find('LargePointerScalarClass', schema, {
      child: { $in: longPointerList },
    });

    expect(results.map(result => result.objectId)).toEqual(['parent-match']);
  });

  it('handles large pointer $in queries on array fields', async () => {
    const schema = {
      className: 'LargePointerArrayClass',
      fields: {
        objectId: { type: 'String' },
        children: { type: 'Array' },
      },
    };
    await adapter.createClass('LargePointerArrayClass', schema);
    await adapter.createObject('LargePointerArrayClass', schema, {
      objectId: 'parent-array-match',
      children: [
        {
          __type: 'Pointer',
          className: 'LargePointerArrayChild',
          objectId: 'child-array-match',
        },
      ],
    });

    const longPointerList = [];
    for (let i = 0; i < 1500; i += 1) {
      longPointerList.push({
        __type: 'Pointer',
        className: 'LargePointerArrayChild',
        objectId: `missing-array-child-${i}`,
      });
    }
    longPointerList.push({
      __type: 'Pointer',
      className: 'LargePointerArrayChild',
      objectId: 'child-array-match',
    });

    const results = await adapter.find('LargePointerArrayClass', schema, {
      children: { $in: longPointerList },
    });

    expect(results.map(result => result.objectId)).toEqual(['parent-array-match']);
  });

  it('handles large date $in queries on scalar date fields', async () => {
    const schema = {
      className: 'LargeDateScalarClass',
      fields: {
        objectId: { type: 'String' },
        happenedAt: { type: 'Date' },
      },
    };
    await adapter.createClass('LargeDateScalarClass', schema);
    await adapter.createObject('LargeDateScalarClass', schema, {
      objectId: 'date-scalar-match',
      happenedAt: { __type: 'Date', iso: '2026-07-08T00:00:00.000Z' },
    });

    const longDateList = [];
    for (let i = 0; i < 1500; i += 1) {
      longDateList.push({
        __type: 'Date',
        iso: `2026-07-09T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      });
    }
    longDateList.push({
      __type: 'Date',
      iso: '2026-07-08T00:00:00.000Z',
    });

    const results = await adapter.find('LargeDateScalarClass', schema, {
      happenedAt: { $in: longDateList },
    });

    expect(results.map(result => result.objectId)).toEqual(['date-scalar-match']);
  });

  it('handles large date $in queries on array fields', async () => {
    const schema = {
      className: 'LargeDateArrayClass',
      fields: {
        objectId: { type: 'String' },
        importantDates: { type: 'Array' },
      },
    };
    await adapter.createClass('LargeDateArrayClass', schema);
    await adapter.createObject('LargeDateArrayClass', schema, {
      objectId: 'date-array-match',
      importantDates: [{ __type: 'Date', iso: '2026-07-08T00:00:00.000Z' }],
    });

    const longDateList = [];
    for (let i = 0; i < 1500; i += 1) {
      longDateList.push({
        __type: 'Date',
        iso: `2026-07-10T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      });
    }
    longDateList.push({
      __type: 'Date',
      iso: '2026-07-08T00:00:00.000Z',
    });

    const results = await adapter.find('LargeDateArrayClass', schema, {
      importantDates: { $in: longDateList },
    });

    expect(results.map(result => result.objectId)).toEqual(['date-array-match']);
  });

  it('treats late storage probes after shutdown as empty results', async () => {
    const schema = {
      className: 'LateShutdownClass',
      fields: {
        objectId: { type: 'String' },
      },
    };
    await adapter.createClass('LateShutdownClass', schema);
    await adapter.handleShutdown();

    await expectAsync(adapter.classExists('LateShutdownClass')).toBeResolvedTo(false);
    await expectAsync(adapter.find('LateShutdownClass', schema, {})).toBeResolvedTo([]);
  });

  it('handles transactions commit and abort', async () => {
    const schema = {
      className: 'TxClass',
      fields: {
        objectId: { type: 'String' },
        val: { type: 'String' },
      },
    };
    await adapter.createClass('TxClass', schema);

    const tx = await adapter.createTransactionalSession();
    await adapter.createObject('TxClass', schema, { objectId: 'tx1', val: 'committed' }, tx);
    await adapter.commitTransactionalSession(tx);

    const check1 = await adapter.find('TxClass', schema, { objectId: 'tx1' });
    expect(check1.length).toBe(1);

    const tx2 = await adapter.createTransactionalSession();
    await adapter.createObject('TxClass', schema, { objectId: 'tx2', val: 'rolledback' }, tx2);
    await adapter.abortTransactionalSession(tx2);

    const check2 = await adapter.find('TxClass', schema, { objectId: 'tx2' });
    expect(check2.length).toBe(0);
  });

  it('notifies schema hooks on watch()', done => {
    let finished = false;
    adapter.watch(() => {
      if (finished) {
        return;
      }
      finished = true;
      done();
    });
    adapter.createClass('HookClass', { fields: { objectId: { type: 'String' } } });
  });

  it('does not treat mid-pattern anchors as literal LIKE-compatible regex text', async () => {
    const schema = {
      className: 'RegexAnchorClass',
      fields: {
        objectId: { type: 'String' },
        text: { type: 'String' },
      },
    };
    await adapter.createClass('RegexAnchorClass', schema);
    await adapter.createObject('RegexAnchorClass', schema, {
      objectId: 'anchor1',
      text: 'foo^bar',
    });

    const results = await adapter.find('RegexAnchorClass', schema, {
      text: { $regex: 'foo^bar' },
    });

    expect(results).toEqual([]);
  });

  it('supports geospatial queries ($nearSphere, $within)', async () => {
    const schema = {
      className: 'LocationClass',
      fields: {
        objectId: { type: 'String' },
        location: { type: 'GeoPoint' },
      },
    };
    await adapter.createClass('LocationClass', schema);

    await adapter.createObject('LocationClass', schema, {
      objectId: 'p1',
      location: { __type: 'GeoPoint', latitude: 37.7749, longitude: -122.4194 },
    });
    await adapter.createObject('LocationClass', schema, {
      objectId: 'p2',
      location: { __type: 'GeoPoint', latitude: 40.7128, longitude: -74.006 },
    });

    const res = await adapter.find('LocationClass', schema, {
      location: {
        $nearSphere: { __type: 'GeoPoint', latitude: 37.77, longitude: -122.41 },
        $maxDistance: 0.1,
      },
    });

    expect(res.length).toBe(1);
    expect(res[0].objectId).toBe('p1');
  });

  it('normalizes polygon values for storage and equality queries', async () => {
    const schema = {
      className: 'PolygonClass',
      fields: {
        objectId: { type: 'String' },
        boundary: { type: 'Polygon' },
      },
    };
    const openPolygon = {
      __type: 'Polygon',
      coordinates: [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
      ],
    };
    await adapter.createClass('PolygonClass', schema);
    await adapter.createObject('PolygonClass', schema, {
      objectId: 'poly1',
      boundary: openPolygon,
    });

    const findResults = await adapter.find('PolygonClass', schema, { objectId: 'poly1' });
    expect(findResults.length).toBe(1);
    expect(findResults[0].boundary.coordinates).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 0],
    ]);

    const equalityResults = await adapter.find('PolygonClass', schema, {
      boundary: openPolygon,
    });
    expect(equalityResults.length).toBe(1);
    expect(equalityResults[0].objectId).toBe('poly1');
  });

  it('supports polygon fields with $geoIntersects point queries', async () => {
    const schema = {
      className: 'PolygonIntersectClass',
      fields: {
        objectId: { type: 'String' },
        boundary: { type: 'Polygon' },
      },
    };
    await adapter.createClass('PolygonIntersectClass', schema);
    await adapter.createObject('PolygonIntersectClass', schema, {
      objectId: 'poly1',
      boundary: {
        __type: 'Polygon',
        coordinates: [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ],
      },
    });
    await adapter.createObject('PolygonIntersectClass', schema, {
      objectId: 'poly2',
      boundary: {
        __type: 'Polygon',
        coordinates: [
          [0, 0],
          [0, 2],
          [2, 2],
          [2, 0],
        ],
      },
    });
    await adapter.createObject('PolygonIntersectClass', schema, {
      objectId: 'poly3',
      boundary: {
        __type: 'Polygon',
        coordinates: [
          [10, 10],
          [10, 15],
          [15, 15],
          [15, 10],
        ],
      },
    });

    const results = await adapter.find('PolygonIntersectClass', schema, {
      boundary: {
        $geoIntersects: {
          $point: {
            __type: 'GeoPoint',
            latitude: 0.5,
            longitude: 0.5,
          },
        },
      },
    });

    expect(results.map(result => result.objectId).sort()).toEqual(['poly1', 'poly2']);
  });

  it('supports idempotency index and uniqueness', async () => {
    const schema = {
      className: 'UniqueClass',
      fields: {
        objectId: { type: 'String' },
        code: { type: 'String' },
      },
    };
    await adapter.createClass('UniqueClass', schema);
    await adapter.ensureUniqueness('UniqueClass', schema, ['code']);

    await adapter.createObject('UniqueClass', schema, { objectId: 'u1', code: 'A1' });

    await expectAsync(
      adapter.createObject('UniqueClass', schema, { objectId: 'u2', code: 'A1' })
    ).toBeRejected();
  });

  it('creates expression indexes for dotted array/object paths using the query expression', async () => {
    const schema = {
      className: 'IndexedNumericDotPathClass',
      fields: {
        objectId: { type: 'String' },
        payload: { type: 'Object' },
      },
    };
    await adapter.createClass('IndexedNumericDotPathClass', schema);
    await adapter.createObject('IndexedNumericDotPathClass', schema, {
      objectId: 'idx1',
      payload: {
        rows: [{ '1': 'match-me' }],
      },
    });
    await adapter.createObject('IndexedNumericDotPathClass', schema, {
      objectId: 'idx2',
      payload: {
        rows: [{ '1': 'other' }],
      },
    });

    await adapter.createIndex(
      'IndexedNumericDotPathClass',
      { 'payload.rows.0.1': 1 },
      { name: 'payload_rows_0_1' }
    );

    const where = adapter._buildWhereClause(
      'IndexedNumericDotPathClass',
      schema,
      { 'payload.rows.0.1': 'match-me' }
    );
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedNumericDotPathClass')} WHERE ${where.sql}`
      )
      .all(...where.params);

    expect(
      queryPlan.some(row => typeof row.detail === 'string' && row.detail.includes('payload_rows_0_1'))
    ).toBeTrue();

    const results = await adapter.find('IndexedNumericDotPathClass', schema, {
      'payload.rows.0.1': 'match-me',
    });
    expect(results.map(result => result.objectId)).toEqual(['idx1']);
  });

  it('uses hidden array-element indexes for equalTo membership on Array fields', async () => {
    const schema = {
      className: 'IndexedArrayFieldClass',
      fields: {
        objectId: { type: 'String' },
        tags: { type: 'Array', contents: { type: 'String' } },
      },
    };
    await adapter.createClass('IndexedArrayFieldClass', schema);
    await adapter.createIndex('IndexedArrayFieldClass', { tags: 1 }, { name: 'indexed_tags' });
    await adapter.createObject('IndexedArrayFieldClass', schema, {
      objectId: 'arrayEq1',
      tags: ['anna', 'beth'],
    });
    await adapter.createObject('IndexedArrayFieldClass', schema, {
      objectId: 'arrayEq2',
      tags: ['cara'],
    });

    const where = adapter._buildWhereClause('IndexedArrayFieldClass', schema, {
      tags: 'anna',
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedArrayFieldClass')} WHERE ${where.sql}`
      )
      .all(...where.params);
    const results = await adapter.find('IndexedArrayFieldClass', schema, {
      tags: 'anna',
    });

    expect(where.sql.includes('json_each')).toBeFalse();
    expect(where.sql.includes('IN (SELECT "objectId"')).toBeTrue();
    expect(
      queryPlan.some(
        row => typeof row.detail === 'string' && row.detail.toLowerCase().includes('arridx')
      )
    ).toBeTrue();
    expect(results.map(result => result.objectId)).toEqual(['arrayEq1']);
  });

  it('uses hidden array-element indexes for dotted paths under Array roots', async () => {
    const schema = {
      className: 'IndexedArrayRootDotPathClass',
      fields: {
        objectId: { type: 'String' },
        contacts: { type: 'Array' },
      },
    };
    await adapter.createClass('IndexedArrayRootDotPathClass', schema);
    await adapter.createIndex(
      'IndexedArrayRootDotPathClass',
      { 'contacts.name': 1 },
      { name: 'indexed_contacts_name' }
    );
    await adapter.createObject('IndexedArrayRootDotPathClass', schema, {
      objectId: 'arrayDot1',
      contacts: [{ name: 'anna' }, { name: 'beth' }],
    });
    await adapter.createObject('IndexedArrayRootDotPathClass', schema, {
      objectId: 'arrayDot2',
      contacts: [{ name: 'cara' }],
    });

    const where = adapter._buildWhereClause('IndexedArrayRootDotPathClass', schema, {
      'contacts.name': 'anna',
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedArrayRootDotPathClass')} WHERE ${where.sql}`
      )
      .all(...where.params);
    const results = await adapter.find('IndexedArrayRootDotPathClass', schema, {
      'contacts.name': 'anna',
    });

    expect(where.sql.includes('json_each')).toBeFalse();
    expect(where.sql.includes('IN (SELECT "objectId"')).toBeTrue();
    expect(
      queryPlan.some(
        row => typeof row.detail === 'string' && row.detail.toLowerCase().includes('arridx')
      )
    ).toBeTrue();
    expect(results.map(result => result.objectId)).toEqual(['arrayDot1']);
  });

  it('uses hidden array-element indexes as regex prefilters on string arrays', async () => {
    const schema = {
      className: 'IndexedArrayRegexClass',
      fields: {
        objectId: { type: 'String' },
        tags: { type: 'Array', contents: { type: 'String' } },
      },
    };
    await adapter.createClass('IndexedArrayRegexClass', schema);
    await adapter.createIndex('IndexedArrayRegexClass', { tags: 1 }, { name: 'indexed_tags' });
    await adapter.createObject('IndexedArrayRegexClass', schema, {
      objectId: 'arrayRegex1',
      tags: ['annason', 'beth'],
    });
    await adapter.createObject('IndexedArrayRegexClass', schema, {
      objectId: 'arrayRegex2',
      tags: ['ANNa_big_son'],
    });
    await adapter.createObject('IndexedArrayRegexClass', schema, {
      objectId: 'arrayRegex3',
      tags: ['bobson'],
    });

    const where = adapter._buildWhereClause('IndexedArrayRegexClass', schema, {
      tags: { $regex: '^ann.*son', $options: 'i' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedArrayRegexClass')} WHERE ${where.sql}`
      )
      .all(...where.params);
    const results = await adapter.find('IndexedArrayRegexClass', schema, {
      tags: { $regex: '^ann.*son', $options: 'i' },
    });

    expect(where.sql.includes('"value" LIKE ?')).toBeTrue();
    expect(where.sql.includes('regexp_flags')).toBeTrue();
    expect(
      queryPlan.some(
        row => typeof row.detail === 'string' && row.detail.toLowerCase().includes('arridx')
      )
    ).toBeTrue();
    expect(results.map(result => result.objectId).sort()).toEqual([
      'arrayRegex1',
      'arrayRegex2',
    ]);
  });

  it('keeps anchored regex prefix queries on plain String columns index-friendly', async () => {
    const schema = {
      className: 'IndexedRegexClass',
      fields: {
        objectId: { type: 'String' },
        name: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexClass', schema);
    await adapter.createIndex('IndexedRegexClass', { name: 1 }, { name: 'indexed_regex_name' });

    const where = adapter._buildWhereClause('IndexedRegexClass', schema, {
      name: { $regex: '^ann' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexClass')} WHERE ${where.sql}`
      )
      .all(...where.params);

    expect(where.sql.includes('CAST(')).toBeFalse();
    expect(where.sql.includes('"name" GLOB ?')).toBeTrue();
    expect(
      queryPlan.some(
        row => typeof row.detail === 'string' && row.detail.includes('indexed_regex_name')
      )
    ).toBeTrue();
  });

  it('uses the Parse case-insensitive helper index for lowered regex prefix lookups', async () => {
    const schema = {
      className: 'IndexedRegexInsensitiveClass',
      fields: {
        objectId: { type: 'String' },
        username: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexInsensitiveClass', schema);
    await adapter.ensureIndex(
      'IndexedRegexInsensitiveClass',
      schema,
      ['username'],
      'case_insensitive_username',
      true
    );

    const where = adapter._buildWhereClause('IndexedRegexInsensitiveClass', schema, {
      username: { $regex: '^ann', $options: 'i' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexInsensitiveClass')} WHERE ${where.sql}`
      )
      .all(...where.params);

    expect(where.sql.includes('CAST(')).toBeFalse();
    expect(where.sql.includes('"username" LIKE ?')).toBeTrue();
    expect(
      queryPlan.some(
        row => typeof row.detail === 'string' && row.detail.includes('case_insensitive_username')
      )
    ).toBeTrue();
  });

  it('uses the Parse case-insensitive helper index as a prefix prefilter for more complex anchored regex', async () => {
    const schema = {
      className: 'IndexedRegexResidualClass',
      fields: {
        objectId: { type: 'String' },
        username: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexResidualClass', schema);
    await adapter.createObject('IndexedRegexResidualClass', schema, {
      objectId: 'regexResidual1',
      username: 'annason',
    });
    await adapter.createObject('IndexedRegexResidualClass', schema, {
      objectId: 'regexResidual2',
      username: 'ANN_big_son',
    });
    await adapter.createObject('IndexedRegexResidualClass', schema, {
      objectId: 'regexResidual3',
      username: 'bobson',
    });
    await adapter.ensureIndex(
      'IndexedRegexResidualClass',
      schema,
      ['username'],
      'case_insensitive_username',
      true
    );

    const where = adapter._buildWhereClause('IndexedRegexResidualClass', schema, {
      username: { $regex: '^ann.*son', $options: 'i' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexResidualClass')} WHERE ${where.sql}`
      )
      .all(...where.params);
    const results = await adapter.find('IndexedRegexResidualClass', schema, {
      username: { $regex: '^ann.*son', $options: 'i' },
    });

    expect(where.sql.includes('"username" LIKE ?')).toBeTrue();
    expect(where.sql.includes('regexp_flags')).toBeTrue();
    expect(
      queryPlan.some(
        row => typeof row.detail === 'string' && row.detail.includes('case_insensitive_username')
      )
    ).toBeTrue();
    expect(results.map(result => result.objectId).sort()).toEqual([
      'regexResidual1',
      'regexResidual2',
    ]);
  });

  it('uses uncased Thai prefixes as regex prefilters without losing unicode matches', async () => {
    const schema = {
      className: 'IndexedRegexThaiClass',
      fields: {
        objectId: { type: 'String' },
        name: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexThaiClass', schema);
    await adapter.createObject('IndexedRegexThaiClass', schema, {
      objectId: 'thaiRegex1',
      name: 'สมชายใจดี',
    });
    await adapter.createObject('IndexedRegexThaiClass', schema, {
      objectId: 'thaiRegex2',
      name: 'สมหญิงใจกว้าง',
    });
    await adapter.createObject('IndexedRegexThaiClass', schema, {
      objectId: 'thaiRegex3',
      name: 'จอยใจดี',
    });
    await adapter.createIndex('IndexedRegexThaiClass', { name: 1 }, { name: 'indexed_regex_thai_name' });

    const where = adapter._buildWhereClause('IndexedRegexThaiClass', schema, {
      name: { $regex: '^สม.*ใจ', $options: 'i' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexThaiClass')} WHERE ${where.sql}`
      )
      .all(...where.params);
    const results = await adapter.find('IndexedRegexThaiClass', schema, {
      name: { $regex: '^สม.*ใจ', $options: 'i' },
    });

    expect(where.sql.includes('"name" GLOB ?')).toBeTrue();
    expect(where.sql.includes('regexp_flags')).toBeTrue();
    expect(
      queryPlan.some(
        row => typeof row.detail === 'string' && row.detail.includes('indexed_regex_thai_name')
      )
    ).toBeTrue();
    expect(results.map(result => result.objectId).sort()).toEqual([
      'thaiRegex1',
      'thaiRegex2',
    ]);
  });

  it('lowers anchored exact regex alternations to IN while keeping end-anchor semantics correct', async () => {
    const schema = {
      className: 'IndexedRegexExactAlternationClass',
      fields: {
        objectId: { type: 'String' },
        name: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexExactAlternationClass', schema);
    await adapter.createObject('IndexedRegexExactAlternationClass', schema, {
      objectId: 'regexExactAlt1',
      name: 'ann',
    });
    await adapter.createObject('IndexedRegexExactAlternationClass', schema, {
      objectId: 'regexExactAlt2',
      name: 'bob',
    });
    await adapter.createObject('IndexedRegexExactAlternationClass', schema, {
      objectId: 'regexExactAlt3',
      name: 'cat',
    });
    await adapter.createObject('IndexedRegexExactAlternationClass', schema, {
      objectId: 'regexExactAlt4',
      name: 'anna',
    });
    await adapter.createIndex(
      'IndexedRegexExactAlternationClass',
      { name: 1 },
      { name: 'indexed_regex_exact_alt_name' }
    );

    const where = adapter._buildWhereClause('IndexedRegexExactAlternationClass', schema, {
      name: { $regex: '^(ann|bob|cat)$' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexExactAlternationClass')} WHERE ${where.sql}`
      )
      .all(...where.params);
    const results = await adapter.find('IndexedRegexExactAlternationClass', schema, {
      name: { $regex: '^(ann|bob|cat)$' },
    });

    expect(where.sql.includes(' IN (')).toBeTrue();
    expect(where.sql.includes('REGEXP')).toBeTrue();
    expect(
      queryPlan.some(
        row =>
          typeof row.detail === 'string' &&
          row.detail.includes('indexed_regex_exact_alt_name')
      )
    ).toBeTrue();
    expect(results.map(result => result.objectId).sort()).toEqual([
      'regexExactAlt1',
      'regexExactAlt2',
      'regexExactAlt3',
    ]);
  });

  it('uses the Parse case-insensitive helper index for exact regex alternations too', async () => {
    const schema = {
      className: 'IndexedRegexExactInsensitiveAlternationClass',
      fields: {
        objectId: { type: 'String' },
        username: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexExactInsensitiveAlternationClass', schema);
    await adapter.createObject('IndexedRegexExactInsensitiveAlternationClass', schema, {
      objectId: 'regexExactInsensitive1',
      username: 'Ann',
    });
    await adapter.createObject('IndexedRegexExactInsensitiveAlternationClass', schema, {
      objectId: 'regexExactInsensitive2',
      username: 'BOB',
    });
    await adapter.createObject('IndexedRegexExactInsensitiveAlternationClass', schema, {
      objectId: 'regexExactInsensitive3',
      username: 'cat',
    });
    await adapter.ensureIndex(
      'IndexedRegexExactInsensitiveAlternationClass',
      schema,
      ['username'],
      'case_insensitive_username',
      true
    );

    const where = adapter._buildWhereClause(
      'IndexedRegexExactInsensitiveAlternationClass',
      schema,
      {
        username: { $regex: '^(ann|bob)$', $options: 'i' },
      }
    );
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexExactInsensitiveAlternationClass')} WHERE ${where.sql}`
      )
      .all(...where.params);
    const results = await adapter.find(
      'IndexedRegexExactInsensitiveAlternationClass',
      schema,
      {
        username: { $regex: '^(ann|bob)$', $options: 'i' },
      }
    );

    expect(where.sql.includes('COLLATE NOCASE')).toBeTrue();
    expect(where.sql.includes(' IN (')).toBeTrue();
    expect(where.sql.includes('regexp_flags')).toBeTrue();
    expect(
      queryPlan.some(
        row => typeof row.detail === 'string' && row.detail.includes('case_insensitive_username')
      )
    ).toBeTrue();
    expect(results.map(result => result.objectId).sort()).toEqual([
      'regexExactInsensitive1',
      'regexExactInsensitive2',
    ]);
  });

  it('lowers finite char-class exact regex to IN while keeping end-anchor semantics correct', async () => {
    const schema = {
      className: 'IndexedRegexFiniteCharClassClass',
      fields: {
        objectId: { type: 'String' },
        name: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexFiniteCharClassClass', schema);
    await adapter.createObject('IndexedRegexFiniteCharClassClass', schema, {
      objectId: 'regexFiniteCharClass1',
      name: 'anna',
    });
    await adapter.createObject('IndexedRegexFiniteCharClassClass', schema, {
      objectId: 'regexFiniteCharClass2',
      name: 'anne',
    });
    await adapter.createObject('IndexedRegexFiniteCharClassClass', schema, {
      objectId: 'regexFiniteCharClass3',
      name: 'annb',
    });
    await adapter.createIndex(
      'IndexedRegexFiniteCharClassClass',
      { name: 1 },
      { name: 'indexed_regex_finite_char_class_name' }
    );

    const where = adapter._buildWhereClause('IndexedRegexFiniteCharClassClass', schema, {
      name: { $regex: '^ann[ae]$' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexFiniteCharClassClass')} WHERE ${where.sql}`
      )
      .all(...where.params);
    const results = await adapter.find('IndexedRegexFiniteCharClassClass', schema, {
      name: { $regex: '^ann[ae]$' },
    });

    expect(where.sql.includes(' IN (')).toBeTrue();
    expect(where.sql.includes('REGEXP')).toBeTrue();
    expect(where.params.slice(0, 2).sort()).toEqual(['anna', 'anne']);
    expect(where.params[2]).toBe('^ann[ae]$');
    expect(
      queryPlan.some(
        row =>
          typeof row.detail === 'string' &&
          row.detail.includes('indexed_regex_finite_char_class_name')
      )
    ).toBeTrue();
    expect(results.map(result => result.objectId).sort()).toEqual([
      'regexFiniteCharClass1',
      'regexFiniteCharClass2',
    ]);
  });

  it('lowers finite grouped regex products to IN when the full language stays small', async () => {
    const schema = {
      className: 'IndexedRegexFiniteGroupProductClass',
      fields: {
        objectId: { type: 'String' },
        title: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexFiniteGroupProductClass', schema);
    await adapter.createObject('IndexedRegexFiniteGroupProductClass', schema, {
      objectId: 'regexFiniteGroup1',
      title: 'Dr. Ann',
    });
    await adapter.createObject('IndexedRegexFiniteGroupProductClass', schema, {
      objectId: 'regexFiniteGroup2',
      title: 'Dr. Bob',
    });
    await adapter.createObject('IndexedRegexFiniteGroupProductClass', schema, {
      objectId: 'regexFiniteGroup3',
      title: 'Mr. Ann',
    });
    await adapter.createObject('IndexedRegexFiniteGroupProductClass', schema, {
      objectId: 'regexFiniteGroup4',
      title: 'Ms. Ann',
    });
    await adapter.createIndex(
      'IndexedRegexFiniteGroupProductClass',
      { title: 1 },
      { name: 'indexed_regex_finite_group_product_title' }
    );

    const where = adapter._buildWhereClause('IndexedRegexFiniteGroupProductClass', schema, {
      title: { $regex: '^(Dr|Mr)\\. (Ann|Bob)$' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexFiniteGroupProductClass')} WHERE ${where.sql}`
      )
      .all(...where.params);
    const results = await adapter.find('IndexedRegexFiniteGroupProductClass', schema, {
      title: { $regex: '^(Dr|Mr)\\. (Ann|Bob)$' },
    });

    expect(where.sql.includes(' IN (')).toBeTrue();
    expect(where.sql.includes('REGEXP')).toBeTrue();
    expect(where.params.slice(0, 4).sort()).toEqual([
      'Dr. Ann',
      'Dr. Bob',
      'Mr. Ann',
      'Mr. Bob',
    ]);
    expect(where.params[4]).toBe('^(Dr|Mr)\\. (Ann|Bob)$');
    expect(
      queryPlan.some(
        row =>
          typeof row.detail === 'string' &&
          row.detail.includes('indexed_regex_finite_group_product_title')
      )
    ).toBeTrue();
    expect(results.map(result => result.objectId).sort()).toEqual([
      'regexFiniteGroup1',
      'regexFiniteGroup2',
      'regexFiniteGroup3',
    ]);
  });

  it('uses finite leading expansions as more selective regex prefilters before residual matching', async () => {
    const schema = {
      className: 'IndexedRegexFiniteResidualClass',
      fields: {
        objectId: { type: 'String' },
        name: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexFiniteResidualClass', schema);
    await adapter.createObject('IndexedRegexFiniteResidualClass', schema, {
      objectId: 'regexFiniteResidual1',
      name: 'annason',
    });
    await adapter.createObject('IndexedRegexFiniteResidualClass', schema, {
      objectId: 'regexFiniteResidual2',
      name: 'anneson',
    });
    await adapter.createObject('IndexedRegexFiniteResidualClass', schema, {
      objectId: 'regexFiniteResidual3',
      name: 'annxson',
    });
    await adapter.createIndex(
      'IndexedRegexFiniteResidualClass',
      { name: 1 },
      { name: 'indexed_regex_finite_residual_name' }
    );

    const where = adapter._buildWhereClause('IndexedRegexFiniteResidualClass', schema, {
      name: { $regex: '^ann[ae].*son' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexFiniteResidualClass')} WHERE ${where.sql}`
      )
      .all(...where.params);
    const results = await adapter.find('IndexedRegexFiniteResidualClass', schema, {
      name: { $regex: '^ann[ae].*son' },
    });

    expect(where.sql.includes(' OR ')).toBeTrue();
    expect(where.sql.includes('"name" GLOB ?')).toBeTrue();
    expect(where.sql.includes('REGEXP')).toBeTrue();
    expect(where.params.slice(0, 2).sort()).toEqual(['anna*', 'anne*']);
    expect(
      queryPlan.some(
        row =>
          typeof row.detail === 'string' &&
          row.detail.includes('indexed_regex_finite_residual_name')
      )
    ).toBeTrue();
    expect(results.map(result => result.objectId).sort()).toEqual([
      'regexFiniteResidual1',
      'regexFiniteResidual2',
    ]);
  });

  it('keeps finite optional regex prefixes fully native when the remaining language is still pure prefix', async () => {
    const schema = {
      className: 'IndexedRegexFiniteOptionalPrefixClass',
      fields: {
        objectId: { type: 'String' },
        word: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexFiniteOptionalPrefixClass', schema);
    await adapter.createIndex(
      'IndexedRegexFiniteOptionalPrefixClass',
      { word: 1 },
      { name: 'indexed_regex_finite_optional_prefix_word' }
    );

    const where = adapter._buildWhereClause('IndexedRegexFiniteOptionalPrefixClass', schema, {
      word: { $regex: '^colou?r' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexFiniteOptionalPrefixClass')} WHERE ${where.sql}`
      )
      .all(...where.params);

    expect(where.sql.includes(' OR ')).toBeTrue();
    expect(where.sql.includes('"word" GLOB ?')).toBeTrue();
    expect(where.sql.includes('REGEXP')).toBeFalse();
    expect(where.params.slice().sort()).toEqual(['color*', 'colour*']);
    expect(
      queryPlan.some(
        row =>
          typeof row.detail === 'string' &&
          row.detail.includes('indexed_regex_finite_optional_prefix_word')
      )
    ).toBeTrue();
  });

  it('does not underfilter ungrouped top-level alternation regex with a misleading prefix prefilter', async () => {
    const schema = {
      className: 'IndexedRegexTopLevelAlternationClass',
      fields: {
        objectId: { type: 'String' },
        name: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexTopLevelAlternationClass', schema);
    await adapter.createObject('IndexedRegexTopLevelAlternationClass', schema, {
      objectId: 'regexTopAlt1',
      name: 'annx',
    });
    await adapter.createObject('IndexedRegexTopLevelAlternationClass', schema, {
      objectId: 'regexTopAlt2',
      name: 'xxbob',
    });
    await adapter.createIndex(
      'IndexedRegexTopLevelAlternationClass',
      { name: 1 },
      { name: 'indexed_regex_top_level_alt_name' }
    );

    const where = adapter._buildWhereClause('IndexedRegexTopLevelAlternationClass', schema, {
      name: { $regex: '^ann|bob$' },
    });
    const results = await adapter.find('IndexedRegexTopLevelAlternationClass', schema, {
      name: { $regex: '^ann|bob$' },
    });

    expect(where.sql.includes('GLOB')).toBeFalse();
    expect(where.sql.includes('LIKE')).toBeFalse();
    expect(where.sql.includes('REGEXP')).toBeTrue();
    expect(results.map(result => result.objectId).sort()).toEqual([
      'regexTopAlt1',
      'regexTopAlt2',
    ]);
  });

  it('keeps residual regex checks on non-indexed array fields when prefix lowering is only a prefilter', async () => {
    const schema = {
      className: 'ArrayRegexResidualClass',
      fields: {
        objectId: { type: 'String' },
        tags: { type: 'Array' },
      },
    };
    await adapter.createClass('ArrayRegexResidualClass', schema);
    await adapter.createObject('ArrayRegexResidualClass', schema, {
      objectId: 'arrayRegexResidual1',
      tags: ['annx'],
    });
    await adapter.createObject('ArrayRegexResidualClass', schema, {
      objectId: 'arrayRegexResidual2',
      tags: ['annason'],
    });

    const where = adapter._buildWhereClause('ArrayRegexResidualClass', schema, {
      tags: { $regex: '^ann.*son' },
    });
    const results = await adapter.find('ArrayRegexResidualClass', schema, {
      tags: { $regex: '^ann.*son' },
    });

    expect(where.sql.includes('EXISTS')).toBeTrue();
    expect(where.sql.includes('REGEXP')).toBeTrue();
    expect(results.map(result => result.objectId)).toEqual(['arrayRegexResidual2']);
  });

  it('keeps residual regex checks on non-indexed dotted array paths too', async () => {
    const schema = {
      className: 'DotArrayRegexResidualClass',
      fields: {
        objectId: { type: 'String' },
        members: { type: 'Array' },
      },
    };
    await adapter.createClass('DotArrayRegexResidualClass', schema);
    await adapter.createObject('DotArrayRegexResidualClass', schema, {
      objectId: 'dotArrayRegexResidual1',
      members: [{ name: 'annx' }],
    });
    await adapter.createObject('DotArrayRegexResidualClass', schema, {
      objectId: 'dotArrayRegexResidual2',
      members: [{ name: 'annason' }],
    });

    const where = adapter._buildWhereClause('DotArrayRegexResidualClass', schema, {
      'members.name': { $regex: '^ann.*son' },
    });
    const results = await adapter.find('DotArrayRegexResidualClass', schema, {
      'members.name': { $regex: '^ann.*son' },
    });

    expect(where.sql.includes('EXISTS')).toBeTrue();
    expect(where.sql.includes('REGEXP')).toBeTrue();
    expect(results.map(result => result.objectId)).toEqual(['dotArrayRegexResidual2']);
  });

  it('rejects stateful regex flags that would make cached RegExp.test nondeterministic', async () => {
    const schema = {
      className: 'RegexInvalidFlagClass',
      fields: {
        objectId: { type: 'String' },
        name: { type: 'String' },
      },
    };
    await adapter.createClass('RegexInvalidFlagClass', schema);

    expect(() =>
      adapter._buildWhereClause('RegexInvalidFlagClass', schema, {
        name: { $regex: '^ann', $options: 'g' },
      })
    ).toThrowError(/An internal server error occurred/);
    expect(() =>
      adapter._buildWhereClause('RegexInvalidFlagClass', schema, {
        name: { $regex: '^ann', $options: 'y' },
      })
    ).toThrowError(/An internal server error occurred/);
  });

  it('keeps end-anchor regex lowering aligned with JavaScript newline semantics', async () => {
    const schema = {
      className: 'RegexEndAnchorSemanticsClass',
      fields: {
        objectId: { type: 'String' },
        name: { type: 'String' },
      },
    };
    const fixtures = [
      { objectId: 'regexEndAnchor1', name: 'ann' },
      { objectId: 'regexEndAnchor2', name: 'ann\n' },
      { objectId: 'regexEndAnchor3', name: 'ann\r' },
      { objectId: 'regexEndAnchor4', name: 'ann\r\n' },
      { objectId: 'regexEndAnchor5', name: `ann${String.fromCharCode(0x2028)}` },
      { objectId: 'regexEndAnchor6', name: `ann${String.fromCharCode(0x2029)}` },
      { objectId: 'regexEndAnchor7', name: 'ann\nx' },
    ];
    await adapter.createClass('RegexEndAnchorSemanticsClass', schema);
    for (const fixture of fixtures) {
      await adapter.createObject('RegexEndAnchorSemanticsClass', schema, fixture);
    }
    await adapter.createIndex(
      'RegexEndAnchorSemanticsClass',
      { name: 1 },
      { name: 'indexed_regex_end_anchor_name' }
    );

    const exactWhere = adapter._buildWhereClause('RegexEndAnchorSemanticsClass', schema, {
      name: { $regex: '^ann$' },
    });
    const prefixWhere = adapter._buildWhereClause('RegexEndAnchorSemanticsClass', schema, {
      name: { $regex: '^ann.*$' },
    });
    const exactResults = await adapter.find('RegexEndAnchorSemanticsClass', schema, {
      name: { $regex: '^ann$' },
    });
    const prefixResults = await adapter.find('RegexEndAnchorSemanticsClass', schema, {
      name: { $regex: '^ann.*$' },
    });
    const exactRegex = new RegExp('^ann$');
    const prefixRegex = new RegExp('^ann.*$');

    expect(exactWhere.sql.includes('REGEXP')).toBeTrue();
    expect(prefixWhere.sql.includes('REGEXP')).toBeTrue();
    expect(exactResults.map(result => result.objectId).sort()).toEqual(
      fixtures
        .filter(fixture => exactRegex.test(fixture.name))
        .map(fixture => fixture.objectId)
        .sort()
    );
    expect(prefixResults.map(result => result.objectId).sort()).toEqual(
      fixtures
        .filter(fixture => prefixRegex.test(fixture.name))
        .map(fixture => fixture.objectId)
        .sort()
    );
  });

  it('keeps open-ended exact-ish prefixes as prefix filters plus residual instead of collapsing them to equality', async () => {
    const schema = {
      className: 'RegexOpenEndedExactClass',
      fields: {
        objectId: { type: 'String' },
        name: { type: 'String' },
      },
    };
    await adapter.createClass('RegexOpenEndedExactClass', schema);
    await adapter.createObject('RegexOpenEndedExactClass', schema, {
      objectId: 'regexOpenEnded1',
      name: 'an',
    });
    await adapter.createObject('RegexOpenEndedExactClass', schema, {
      objectId: 'regexOpenEnded2',
      name: 'ann',
    });
    await adapter.createObject('RegexOpenEndedExactClass', schema, {
      objectId: 'regexOpenEnded3',
      name: 'anx',
    });
    await adapter.createIndex(
      'RegexOpenEndedExactClass',
      { name: 1 },
      { name: 'indexed_regex_open_ended_exact_name' }
    );

    const where = adapter._buildWhereClause('RegexOpenEndedExactClass', schema, {
      name: { $regex: '^an+$' },
    });
    const results = await adapter.find('RegexOpenEndedExactClass', schema, {
      name: { $regex: '^an+$' },
    });

    expect(where.sql.includes('GLOB')).toBeTrue();
    expect(where.sql.includes('REGEXP')).toBeTrue();
    expect(where.sql.includes(' IN (')).toBeFalse();
    expect(results.map(result => result.objectId).sort()).toEqual([
      'regexOpenEnded1',
      'regexOpenEnded2',
    ]);
  });

  it('keeps pure ^prefix.* regex fully native instead of adding a redundant residual regex', async () => {
    const schema = {
      className: 'IndexedRegexPurePrefixClass',
      fields: {
        objectId: { type: 'String' },
        name: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexPurePrefixClass', schema);
    await adapter.createIndex(
      'IndexedRegexPurePrefixClass',
      { name: 1 },
      { name: 'indexed_regex_pure_prefix_name' }
    );

    const where = adapter._buildWhereClause('IndexedRegexPurePrefixClass', schema, {
      name: { $regex: '^ann.*' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexPurePrefixClass')} WHERE ${where.sql}`
      )
      .all(...where.params);

    expect(where.sql.includes('"name" GLOB ?')).toBeTrue();
    expect(where.sql.includes('REGEXP')).toBeFalse();
    expect(
      queryPlan.some(
        row =>
          typeof row.detail === 'string' &&
          row.detail.includes('indexed_regex_pure_prefix_name')
      )
    ).toBeTrue();
  });

  it('uses native OR prefix prefilters for grouped anchored regex before falling back to residual matching', async () => {
    const schema = {
      className: 'IndexedRegexAlternationResidualClass',
      fields: {
        objectId: { type: 'String' },
        username: { type: 'String' },
      },
    };
    await adapter.createClass('IndexedRegexAlternationResidualClass', schema);
    await adapter.createObject('IndexedRegexAlternationResidualClass', schema, {
      objectId: 'regexAlternationResidual1',
      username: 'annason',
    });
    await adapter.createObject('IndexedRegexAlternationResidualClass', schema, {
      objectId: 'regexAlternationResidual2',
      username: 'bob___son',
    });
    await adapter.createObject('IndexedRegexAlternationResidualClass', schema, {
      objectId: 'regexAlternationResidual3',
      username: 'catson',
    });
    await adapter.ensureIndex(
      'IndexedRegexAlternationResidualClass',
      schema,
      ['username'],
      'case_insensitive_username',
      true
    );

    const where = adapter._buildWhereClause('IndexedRegexAlternationResidualClass', schema, {
      username: { $regex: '^(ann|bob).*son', $options: 'i' },
    });
    const queryPlan = adapter
      ._prepare(
        `EXPLAIN QUERY PLAN SELECT "objectId" FROM ${adapter._tableName('IndexedRegexAlternationResidualClass')} WHERE ${where.sql}`
      )
      .all(...where.params);
    const results = await adapter.find('IndexedRegexAlternationResidualClass', schema, {
      username: { $regex: '^(ann|bob).*son', $options: 'i' },
    });

    expect(where.sql.includes(' OR ')).toBeTrue();
    expect(where.sql.includes('"username" LIKE ?')).toBeTrue();
    expect(where.sql.includes('regexp_flags')).toBeTrue();
    expect(
      queryPlan.some(
        row => typeof row.detail === 'string' && row.detail.includes('case_insensitive_username')
      )
    ).toBeTrue();
    expect(results.map(result => result.objectId).sort()).toEqual([
      'regexAlternationResidual1',
      'regexAlternationResidual2',
    ]);
  });

  it('cleans up FTS artifacts when deleting text indexes', async () => {
    const schema = {
      className: 'FTSIndexClass',
      fields: {
        objectId: { type: 'String' },
        subject: { type: 'String' },
      },
    };
    await adapter.createClass('FTSIndexClass', schema);
    await adapter.createIndex('FTSIndexClass', { subject: 'text' }, { name: 'subject_text' });
    await adapter._ensureFTS5Index('FTSIndexClass', 'subject', false);
    await adapter._ensureFTS5Index('FTSIndexClass', 'subject', true);

    expect(getFTSArtifactsForField(adapter, 'FTSIndexClass', 'subject').length).toBeGreaterThan(0);

    const storedSchema = await adapter.getClass('FTSIndexClass');
    await adapter.setIndexesWithSchemaFormat(
      'FTSIndexClass',
      { subject_text: { __op: 'Delete' } },
      storedSchema.indexes,
      storedSchema.fields
    );

    expect(getFTSArtifactsForField(adapter, 'FTSIndexClass', 'subject')).toEqual([]);
  });

  it('cleans up FTS artifacts when deleting fields', async () => {
    const schema = {
      className: 'FTSFieldClass',
      fields: {
        objectId: { type: 'String' },
        subject: { type: 'String' },
      },
    };
    await adapter.createClass('FTSFieldClass', schema);
    await adapter._ensureFTS5Index('FTSFieldClass', 'subject', false);
    await adapter._ensureFTS5Index('FTSFieldClass', 'subject', true);

    expect(getFTSArtifactsForField(adapter, 'FTSFieldClass', 'subject').length).toBeGreaterThan(0);

    await adapter.deleteFields('FTSFieldClass', schema, ['subject']);

    expect(getFTSArtifactsForField(adapter, 'FTSFieldClass', 'subject')).toEqual([]);
  });

  it('cleans up FTS artifacts when deleting classes', async () => {
    const schema = {
      className: 'FTSDeleteClass',
      fields: {
        objectId: { type: 'String' },
        subject: { type: 'String' },
      },
    };
    await adapter.createClass('FTSDeleteClass', schema);
    await adapter._ensureFTS5Index('FTSDeleteClass', 'subject', false);
    await adapter._ensureFTS5Index('FTSDeleteClass', 'subject', true);

    expect(getFTSArtifactsForField(adapter, 'FTSDeleteClass', 'subject').length).toBeGreaterThan(0);

    await adapter.deleteClass('FTSDeleteClass');

    expect(getFTSArtifactsForField(adapter, 'FTSDeleteClass', 'subject')).toEqual([]);
  });

  it('throws object not found when delete query matches no rows', async () => {
    const schema = {
      className: 'DeleteClass',
      fields: {
        objectId: { type: 'String' },
      },
    };
    await adapter.createClass('DeleteClass', schema);

    await expectAsync(
      adapter.deleteObjectsByQuery('DeleteClass', schema, { objectId: 'missing' })
    ).toBeRejectedWith(new Parse.Error(Parse.Error.OBJECT_NOT_FOUND, 'Object not found.'));
  });

  it('rejects degenerate polygon loops', async () => {
    const schema = {
      className: 'DegeneratePolygonClass',
      fields: {
        objectId: { type: 'String' },
        boundary: { type: 'Polygon' },
      },
    };
    await adapter.createClass('DegeneratePolygonClass', schema);

    await expectAsync(
      adapter.createObject('DegeneratePolygonClass', schema, {
        objectId: 'degenerate1',
        boundary: {
          __type: 'Polygon',
          coordinates: [
            [0, 0],
            [0, 1],
            [0, 0],
          ],
        },
      })
    ).toBeRejected();
  });

  it('supports nested array updates on dot notation fields', async () => {
    const schema = {
      className: 'NestedArrayClass',
      fields: {
        objectId: { type: 'String' },
        a: { type: 'Object' },
      },
    };
    await adapter.createClass('NestedArrayClass', schema);
    await adapter.createObject('NestedArrayClass', schema, {
      objectId: 'nested1',
      a: { foo: ['a'] },
    });

    await adapter.updateObjectsByQuery(
      'NestedArrayClass',
      schema,
      { objectId: 'nested1' },
      {
        $addUnique: { 'a.foo': ['a', 'b'] },
      }
    );
    await adapter.updateObjectsByQuery(
      'NestedArrayClass',
      schema,
      { objectId: 'nested1' },
      {
        $add: { 'a.foo': ['c'] },
      }
    );
    await adapter.updateObjectsByQuery(
      'NestedArrayClass',
      schema,
      { objectId: 'nested1' },
      {
        $remove: { 'a.foo': ['a'] },
      }
    );

    const results = await adapter.find('NestedArrayClass', schema, { objectId: 'nested1' });
    expect(results.length).toBe(1);
    expect(results[0].a).toEqual({ foo: ['b', 'c'] });
  });

  it('infers semantic field types for root update ops', async () => {
    const schema = {
      className: 'RootUpdateOpInferenceClass',
      fields: {
        objectId: { type: 'String' },
      },
    };
    await adapter.createClass('RootUpdateOpInferenceClass', schema);
    await adapter.createObject('RootUpdateOpInferenceClass', schema, {
      objectId: 'root-op-1',
    });

    await adapter.updateObjectsByQuery(
      'RootUpdateOpInferenceClass',
      schema,
      { objectId: 'root-op-1' },
      {
        lastRefundAt: { __op: 'Delete' },
        refundCount: { __op: 'Increment', amount: 1 },
        tags: { __op: 'AddUnique', objects: ['a'] },
        removedTags: { __op: 'Remove', objects: ['x'] },
      }
    );

    const storedSchema = await adapter.getClass('RootUpdateOpInferenceClass');
    expect(storedSchema.fields.lastRefundAt).toBeUndefined();
    expect(storedSchema.fields.refundCount.type).toBe('Number');
    expect(storedSchema.fields.tags.type).toBe('Array');
    expect(storedSchema.fields.removedTags.type).toBe('Array');

    await adapter.updateObjectsByQuery(
      'RootUpdateOpInferenceClass',
      storedSchema,
      { objectId: 'root-op-1' },
      {
        lastRefundAt: 123,
        refundCount: { __op: 'Increment', amount: 2 },
        tags: { __op: 'AddUnique', objects: ['b'] },
        removedTags: { __op: 'AddUnique', objects: ['c'] },
      }
    );

    const results = await adapter.find('RootUpdateOpInferenceClass', storedSchema, {
      objectId: 'root-op-1',
    });
    expect(results.length).toBe(1);
    expect(results[0].lastRefundAt).toBe(123);
    expect(results[0].refundCount).toBe(3);
    expect(results[0].tags).toEqual(['a', 'b']);
    expect(results[0].removedTags).toEqual(['c']);
  });

  it('does not infer string schema from null-only writes on new fields', async () => {
    const schema = {
      className: 'NullFieldInferenceClass',
      fields: {
        objectId: { type: 'String' },
      },
    };
    await adapter.createClass('NullFieldInferenceClass', schema);
    await adapter.createObject('NullFieldInferenceClass', schema, {
      objectId: 'null-field-1',
      nullableMetric: null,
    });

    let storedSchema = await adapter.getClass('NullFieldInferenceClass');
    expect(storedSchema.fields.nullableMetric).toBeUndefined();

    let results = await adapter.find('NullFieldInferenceClass', storedSchema, {
      objectId: 'null-field-1',
    });
    expect(results.length).toBe(1);
    expect(results[0].nullableMetric).toBeNull();

    await adapter.updateObjectsByQuery(
      'NullFieldInferenceClass',
      storedSchema,
      { objectId: 'null-field-1' },
      {
        nullableMetric: 7,
      }
    );

    storedSchema = await adapter.getClass('NullFieldInferenceClass');
    expect(storedSchema.fields.nullableMetric.type).toBe('Number');

    results = await adapter.find('NullFieldInferenceClass', storedSchema, {
      objectId: 'null-field-1',
    });
    expect(results.length).toBe(1);
    expect(results[0].nullableMetric).toBe(7);
  });

  it('tracks null-only update writes without requiring a backing column first', async () => {
    const schema = {
      className: 'NullFieldUpdateInferenceClass',
      fields: {
        objectId: { type: 'String' },
      },
    };
    await adapter.createClass('NullFieldUpdateInferenceClass', schema);
    await adapter.createObject('NullFieldUpdateInferenceClass', schema, {
      objectId: 'null-field-update-1',
    });

    await adapter.updateObjectsByQuery(
      'NullFieldUpdateInferenceClass',
      schema,
      { objectId: 'null-field-update-1' },
      {
        nullableArray: null,
      }
    );

    let storedSchema = await adapter.getClass('NullFieldUpdateInferenceClass');
    expect(storedSchema.fields.nullableArray).toBeUndefined();

    let results = await adapter.find('NullFieldUpdateInferenceClass', storedSchema, {
      objectId: 'null-field-update-1',
    });
    expect(results.length).toBe(1);
    expect(results[0].nullableArray).toBeNull();

    await adapter.updateObjectsByQuery(
      'NullFieldUpdateInferenceClass',
      storedSchema,
      { objectId: 'null-field-update-1' },
      {
        nullableArray: [],
      }
    );

    storedSchema = await adapter.getClass('NullFieldUpdateInferenceClass');
    expect(storedSchema.fields.nullableArray.type).toBe('Array');

    results = await adapter.find('NullFieldUpdateInferenceClass', storedSchema, {
      objectId: 'null-field-update-1',
    });
    expect(results.length).toBe(1);
    expect(results[0].nullableArray).toEqual([]);
  });

  it('preserves array indexes when deleting dotted numeric paths', async () => {
    const schema = {
      className: 'NestedArrayDeleteClass',
      fields: {
        objectId: { type: 'String' },
        payload: { type: 'Object' },
      },
    };
    await adapter.createClass('NestedArrayDeleteClass', schema);
    await adapter.createObject('NestedArrayDeleteClass', schema, {
      objectId: 'nested-delete-1',
      payload: {
        items: ['a', 'b', 'c'],
      },
    });

    await adapter.updateObjectsByQuery(
      'NestedArrayDeleteClass',
      schema,
      { objectId: 'nested-delete-1' },
      {
        'payload.items.1': { __op: 'Delete' },
      }
    );

    const results = await adapter.find('NestedArrayDeleteClass', schema, {
      'payload.items.2': 'c',
    });
    expect(results.length).toBe(1);
    expect(results[0].payload.items).toEqual(['a', null, 'c']);
  });

  it('treats dotted queries on missing root columns as no-match instead of SQL errors', async () => {
    const schema = {
      className: 'MissingDotRootQueryClass',
      fields: {
        objectId: { type: 'String' },
      },
    };
    await adapter.createClass('MissingDotRootQueryClass', schema);
    await adapter.createObject('MissingDotRootQueryClass', schema, {
      objectId: 'missing-dot-root-1',
    });

    const results = await adapter.find('MissingDotRootQueryClass', schema, {
      'externalRecordURL.value': 'integration://provider/account/user',
    });

    expect(results).toEqual([]);
  });

  it('matches dotted queries through arrays of objects', async () => {
    const schema = {
      className: 'ArrayObjectDotQueryClass',
      fields: {
        objectId: { type: 'String' },
        externalRecordURL: { type: 'Array' },
      },
    };
    await adapter.createClass('ArrayObjectDotQueryClass', schema);
    await adapter.createObject('ArrayObjectDotQueryClass', schema, {
      objectId: 'array-dot-match-1',
      externalRecordURL: [
        {
          label: 'Integration:provider',
          value: 'integration://provider/account/user',
        },
      ],
    });

    const results = await adapter.find('ArrayObjectDotQueryClass', schema, {
      'externalRecordURL.value': 'integration://provider/account/user',
    });

    expect(results.map(result => result.objectId)).toEqual(['array-dot-match-1']);
  });

  it('preserves nested undefined keys in JSON payloads as null', async () => {
    const schema = {
      className: 'UndefinedJSONPayloadClass',
      fields: {
        objectId: { type: 'String' },
        changes: { type: 'Array' },
      },
    };
    await adapter.createClass('UndefinedJSONPayloadClass', schema);
    await adapter.createObject('UndefinedJSONPayloadClass', schema, {
      objectId: 'undefined-json-1',
      changes: [
        {
          changes: {
            status: 'active',
            taskStatus: undefined,
          },
        },
      ],
    });

    const [result] = await adapter.find('UndefinedJSONPayloadClass', schema, {
      objectId: 'undefined-json-1',
    });

    expect(result.changes[0].changes).toEqual({
      status: 'active',
      taskStatus: null,
    });
  });

  it('avoids repeating metadata lookups for cached classExists checks', async () => {
    const schema = {
      className: 'CachedClassExists',
      fields: {
        objectId: { type: 'String' },
      },
    };
    await adapter.createClass('CachedClassExists', schema);
    expect(await adapter.classExists('CachedClassExists')).toBeTrue();

    spyOn(adapter._db, 'prepare').and.callThrough();

    expect(await adapter.classExists('CachedClassExists')).toBeTrue();

    const preparedSql = adapter._db.prepare.calls.allArgs().map(args => args[0]);
    expect(
      preparedSql.some(
        sql => typeof sql === 'string' && (sql.includes('sqlite_master') || sql.includes('PRAGMA table_info'))
      )
    ).toBeFalse();
  });

  it('treats positive UTC offset keys as object members instead of array indexes', async () => {
    const schema = {
      className: 'PushStatusLikeClass',
      fields: {
        objectId: { type: 'String' },
        sentPerUTCOffset: { type: 'Object' },
        failedPerUTCOffset: { type: 'Object' },
      },
    };
    await adapter.createClass('PushStatusLikeClass', schema);
    await adapter.createObject('PushStatusLikeClass', schema, {
      objectId: 'push1',
    });

    await adapter.updateObjectsByQuery(
      'PushStatusLikeClass',
      schema,
      { objectId: 'push1' },
      {
        'sentPerUTCOffset.1': { __op: 'Increment', amount: 1 },
        'failedPerUTCOffset.1': { __op: 'Increment', amount: 2 },
      }
    );

    const results = await adapter.find('PushStatusLikeClass', schema, {
      'sentPerUTCOffset.1': 1,
      'failedPerUTCOffset.1': 2,
    });
    expect(results.length).toBe(1);
    expect(results[0].sentPerUTCOffset).toEqual({ '1': 1 });
    expect(results[0].failedPerUTCOffset).toEqual({ '1': 2 });
  });

  it('resolves numeric dot segments from the runtime parent container type', async () => {
    const schema = {
      className: 'NumericDotPathClass',
      fields: {
        objectId: { type: 'String' },
        payload: { type: 'Object' },
      },
    };
    await adapter.createClass('NumericDotPathClass', schema);
    await adapter.createObject('NumericDotPathClass', schema, {
      objectId: 'numeric1',
      payload: {
        counters: { '1': 11 },
        rows: [{ '1': 'nested-object-key' }],
        matrix: [[0, 7]],
      },
    });

    let results = await adapter.find('NumericDotPathClass', schema, {
      'payload.counters.1': 11,
    });
    expect(results.length).toBe(1);

    results = await adapter.find('NumericDotPathClass', schema, {
      'payload.rows.0.1': 'nested-object-key',
    });
    expect(results.length).toBe(1);

    results = await adapter.find('NumericDotPathClass', schema, {
      'payload.matrix.0.1': 7,
    });
    expect(results.length).toBe(1);

    await adapter.updateObjectsByQuery(
      'NumericDotPathClass',
      schema,
      { objectId: 'numeric1' },
      {
        'payload.rows.0.1': 'updated-object-key',
      }
    );

    results = await adapter.find('NumericDotPathClass', schema, { objectId: 'numeric1' });
    expect(results.length).toBe(1);
    expect(results[0].payload.rows[0]).toEqual({ '1': 'updated-object-key' });
    expect(results[0].payload.matrix[0][1]).toBe(7);
  });

  it('treats array object equality consistently across key order for addUnique/remove', async () => {
    const schema = {
      className: 'CanonicalArrayClass',
      fields: {
        objectId: { type: 'String' },
        values: { type: 'Array' },
      },
    };
    const originalValue = { alpha: 1, beta: 2 };
    const reorderedValue = { beta: 2, alpha: 1 };
    await adapter.createClass('CanonicalArrayClass', schema);
    await adapter.createObject('CanonicalArrayClass', schema, {
      objectId: 'canonical1',
      values: [originalValue],
    });

    await adapter.updateObjectsByQuery(
      'CanonicalArrayClass',
      schema,
      { objectId: 'canonical1' },
      {
        $addUnique: { values: [reorderedValue] },
      }
    );

    let results = await adapter.find('CanonicalArrayClass', schema, { objectId: 'canonical1' });
    expect(results.length).toBe(1);
    expect(results[0].values).toEqual([originalValue]);

    await adapter.updateObjectsByQuery(
      'CanonicalArrayClass',
      schema,
      { objectId: 'canonical1' },
      {
        $remove: { values: [reorderedValue] },
      }
    );

    results = await adapter.find('CanonicalArrayClass', schema, { objectId: 'canonical1' });
    expect(results.length).toBe(1);
    expect(results[0].values).toEqual([]);
  });

  it('matches pointer values inside array fields and ignores invalid elements', async () => {
    const schema = {
      className: 'PointerArrayClass',
      fields: {
        objectId: { type: 'String' },
        collaborators: { type: 'Array' },
      },
    };
    const userA = {
      __type: 'Pointer',
      className: '_User',
      objectId: 'userA',
    };
    const userB = {
      __type: 'Pointer',
      className: '_User',
      objectId: 'userB',
    };
    await adapter.createClass('PointerArrayClass', schema);
    await adapter.createObject('PointerArrayClass', schema, {
      objectId: 'doc1',
      collaborators: [userA, '', -1, true, [], { invalid: -1 }],
    });

    const matchingResults = await adapter.find('PointerArrayClass', schema, {
      collaborators: { $all: [userA] },
    });
    expect(matchingResults.length).toBe(1);
    expect(matchingResults[0].objectId).toBe('doc1');

    const nonMatchingResults = await adapter.find('PointerArrayClass', schema, {
      collaborators: { $all: [userB] },
    });
    expect(nonMatchingResults.length).toBe(0);
  });

  it('matches pointer values on scalar pointer fields', async () => {
    const schema = {
      className: 'PointerFieldClass',
      fields: {
        objectId: { type: 'String' },
        user: { type: 'Pointer', targetClass: '_User' },
      },
    };
    const userPointer = {
      __type: 'Pointer',
      className: '_User',
      objectId: 'userScalar',
    };
    await adapter.createClass('PointerFieldClass', schema);
    await adapter.createObject('PointerFieldClass', schema, {
      objectId: 'row1',
      user: userPointer,
    });

    const results = await adapter.find('PointerFieldClass', schema, {
      user: userPointer,
    });
    expect(results.length).toBe(1);
    expect(results[0].objectId).toBe('row1');
  });

  it('matches nullish pointer coercions on scalar pointer fields', async () => {
    const schema = {
      className: 'NullPointerFieldClass',
      fields: {
        objectId: { type: 'String' },
        user: { type: 'Pointer', targetClass: '_User' },
      },
    };
    const nullishPointer = {
      __type: 'Pointer',
      className: '_User',
    };
    await adapter.createClass('NullPointerFieldClass', schema);
    await adapter.createObject('NullPointerFieldClass', schema, {
      objectId: 'row1',
      user: nullishPointer,
    });

    const results = await adapter.find('NullPointerFieldClass', schema, {
      user: nullishPointer,
    });
    expect(results.length).toBe(1);
    expect(results[0].objectId).toBe('row1');
    expect(results[0].user).toBeNull();
  });

  it('reuses the sqlite memory database across adapter instances', async () => {
    const sharedPrefix = `shared_${collectionPrefixIndex++}_`;
    const firstAdapter = new SQLiteStorageAdapter({
      uri: 'sqlite://:memory:',
      collectionPrefix: sharedPrefix,
    });
    const secondAdapter = new SQLiteStorageAdapter({
      uri: 'sqlite://:memory:',
      collectionPrefix: sharedPrefix,
    });
    const schema = {
      className: 'SharedMemoryClass',
      fields: {
        objectId: { type: 'String' },
        value: { type: 'String' },
      },
    };

    try {
      await firstAdapter.createClass('SharedMemoryClass', schema);
      await firstAdapter.createObject('SharedMemoryClass', schema, {
        objectId: 'shared1',
        value: 'persisted',
      });
      const results = await secondAdapter.find('SharedMemoryClass', schema, {
        objectId: 'shared1',
      });
      expect(results.length).toBe(1);
      expect(results[0].value).toBe('persisted');
    } finally {
      firstAdapter.handleShutdown();
      secondAdapter.handleShutdown();
    }
  });

  it('prevents SQL injection in dot paths and order params', async () => {
    const schema = {
      className: 'InjectionClass',
      fields: {
        objectId: { type: 'String' },
        data: { type: 'Object' },
        name: { type: 'String' },
      },
    };
    await adapter.createClass('InjectionClass', schema);
    await adapter.createObject('InjectionClass', schema, {
      objectId: 'inj1',
      data: { sub: 'val' },
      name: 'safe',
    });

    const maliciousOrder = "data.sub' ASC; DROP TABLE \"test_InjectionClass\";--";
    try {
      await adapter.find('InjectionClass', schema, {}, { sort: { [maliciousOrder]: 1 } });
    } catch {
      /* */
    }

    const exists = await adapter.classExists('InjectionClass');
    expect(exists).toBe(true);
  });

  it('rejects regular expressions with unsafe repeated groups to prevent ReDoS', async () => {
    const schema = {
      className: 'ReDoSTest',
      fields: {
        objectId: { type: 'String' },
        field: { type: 'String' },
      },
    };
    await adapter.createClass('ReDoSTest', schema);
    await adapter.createObject('ReDoSTest', schema, {
      objectId: 'redo1',
      field: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaac',
    });

    for (const pattern of ['(a+)+b', '(a|aa)+b']) {
      try {
        await adapter.find('ReDoSTest', schema, {
          field: { $regex: pattern },
        });
        fail(`should have thrown an error for ${pattern}`);
      } catch (error) {
        expect(error.code).toBe(Parse.Error.INTERNAL_SERVER_ERROR);
        expect(error.message).toBe('An internal server error occurred');
      }
    }
  });

  it('allows safe regular expressions to execute natively', async () => {
    const schema = {
      className: 'SafeRegexTest',
      fields: {
        objectId: { type: 'String' },
        field: { type: 'String' },
      },
    };
    await adapter.createClass('SafeRegexTest', schema);
    await adapter.createObject('SafeRegexTest', schema, {
      objectId: 'redo2',
      field: 'foo_123',
    });

    const results = await adapter.find('SafeRegexTest', schema, {
      field: { $regex: '^[a-z]+_[0-9]+$' },
    });
    expect(results.length).toBe(1);
    expect(results[0].objectId).toBe('redo2');
  });
});
