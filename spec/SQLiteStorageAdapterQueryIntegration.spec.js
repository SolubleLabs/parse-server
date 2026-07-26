'use strict';

const Parse = require('parse/node');

describe_only_db('sqlite')('SQLiteStorageAdapter live Parse query integration', () => {
  it('supports Parse.Query.exists on dotted object subfields', async () => {
    const matching = new Parse.Object('VitalSignsObservation');
    matching.set('value', { weight: 72.5 });
    await matching.save();

    const nonMatching = new Parse.Object('VitalSignsObservation');
    nonMatching.set('value', { temperature: 37.1 });
    await nonMatching.save();

    const query = new Parse.Query('VitalSignsObservation');
    query.exists('value.weight');
    query.ascending('objectId');

    const results = await query.find({ useMasterKey: true });

    expect(results.map(result => result.id)).toEqual([matching.id]);
  });

  it('supports VitalSignsObservation-style exists queries with subject scoping and time ordering', async () => {
    const allowedPatient = new Parse.Object('ClientInfo');
    await allowedPatient.save(null, { useMasterKey: true });

    const deniedPatient = new Parse.Object('ClientInfo');
    await deniedPatient.save(null, { useMasterKey: true });

    const matching = new Parse.Object('VitalSignsObservation');
    matching.set('subject', allowedPatient);
    matching.set('time', 10);
    matching.set('value', { weight: 72.5, heartRate: 84 });
    await matching.save(null, { useMasterKey: true });

    const wrongPatient = new Parse.Object('VitalSignsObservation');
    wrongPatient.set('subject', deniedPatient);
    wrongPatient.set('time', 20);
    wrongPatient.set('value', { weight: 91.2 });
    await wrongPatient.save(null, { useMasterKey: true });

    const missingWeight = new Parse.Object('VitalSignsObservation');
    missingWeight.set('subject', allowedPatient);
    missingWeight.set('time', 30);
    missingWeight.set('value', { temperature: 37.1 });
    await missingWeight.save(null, { useMasterKey: true });

    const query = new Parse.Query('VitalSignsObservation');
    query.exists('subject');
    query.exists('value.weight');
    query.equalTo('subject', allowedPatient);
    query.ascending('time');
    query.addAscending('objectId');

    const results = await query.find({ useMasterKey: true });

    expect(results.map(result => result.id)).toEqual([matching.id]);
  });

  it('supports Parse.Query.equalTo through arrays nested below object roots', async () => {
    const matching = new Parse.Object('Observation');
    matching.set('code', {
      coding: [{ code: '29463-7' }],
    });
    await matching.save();

    const nonMatching = new Parse.Object('Observation');
    nonMatching.set('code', {
      coding: [{ code: '8302-2' }],
    });
    await nonMatching.save();

    const query = new Parse.Query('Observation');
    query.equalTo('code.coding.code', '29463-7');
    query.ascending('objectId');

    const results = await query.find({ useMasterKey: true });

    expect(results.map(result => result.id)).toEqual([matching.id]);
  });

  it('supports Observation-style deep code queries with subject scoping and time ordering', async () => {
    const allowedPatient = new Parse.Object('ClientInfo');
    await allowedPatient.save(null, { useMasterKey: true });

    const deniedPatient = new Parse.Object('ClientInfo');
    await deniedPatient.save(null, { useMasterKey: true });

    const matching = new Parse.Object('Observation');
    matching.set('subject', allowedPatient);
    matching.set('time', 10);
    matching.set('code', {
      coding: [{ code: '29463-7' }],
    });
    await matching.save(null, { useMasterKey: true });

    const wrongPatient = new Parse.Object('Observation');
    wrongPatient.set('subject', deniedPatient);
    wrongPatient.set('time', 20);
    wrongPatient.set('code', {
      coding: [{ code: '29463-7' }],
    });
    await wrongPatient.save(null, { useMasterKey: true });

    const wrongCode = new Parse.Object('Observation');
    wrongCode.set('subject', allowedPatient);
    wrongCode.set('time', 30);
    wrongCode.set('code', {
      coding: [{ code: '8302-2' }],
    });
    await wrongCode.save(null, { useMasterKey: true });

    const query = new Parse.Query('Observation');
    query.exists('subject');
    query.equalTo('code.coding.code', '29463-7');
    query.equalTo('subject', allowedPatient);
    query.ascending('time');
    query.addAscending('objectId');

    const results = await query.find({ useMasterKey: true });

    expect(results.map(result => result.id)).toEqual([matching.id]);
  });

  it('supports Parse.Query.notEqualTo through arrays nested below object roots', async () => {
    const matching = new Parse.Object('Observation');
    matching.set('code', {
      coding: [{ code: '8302-2' }],
    });
    await matching.save(null, { useMasterKey: true });

    const excluded = new Parse.Object('Observation');
    excluded.set('code', {
      coding: [{ code: '29463-7' }],
    });
    await excluded.save(null, { useMasterKey: true });

    const query = new Parse.Query('Observation');
    query.notEqualTo('code.coding.code', '29463-7');
    query.ascending('objectId');

    const results = await query.find({ useMasterKey: true });

    expect(results.map(result => result.id)).toEqual([matching.id]);
  });

  it('supports Parse.Query.exists through arrays nested below object roots', async () => {
    const matching = new Parse.Object('Observation');
    matching.set('code', {
      coding: [{ code: '29463-7' }],
    });
    await matching.save(null, { useMasterKey: true });

    const excluded = new Parse.Object('Observation');
    excluded.set('code', {
      coding: [{ display: 'Weight' }],
    });
    await excluded.save(null, { useMasterKey: true });

    const query = new Parse.Query('Observation');
    query.exists('code.coding.code');
    query.ascending('objectId');

    const results = await query.find({ useMasterKey: true });

    expect(results.map(result => result.id)).toEqual([matching.id]);
  });

  it('supports Parse.Query range operators through arrays nested below object roots', async () => {
    const low = new Parse.Object('Observation');
    low.set('code', {
      coding: [{ rank: 10 }],
    });
    await low.save(null, { useMasterKey: true });

    const mid = new Parse.Object('Observation');
    mid.set('code', {
      coding: [{ rank: 20 }],
    });
    await mid.save(null, { useMasterKey: true });

    const high = new Parse.Object('Observation');
    high.set('code', {
      coding: [{ rank: 30 }],
    });
    await high.save(null, { useMasterKey: true });

    const lessThanQuery = new Parse.Query('Observation');
    lessThanQuery.lessThan('code.coding.rank', 15);
    lessThanQuery.ascending('objectId');

    const lessThanOrEqualQuery = new Parse.Query('Observation');
    lessThanOrEqualQuery.lessThanOrEqualTo('code.coding.rank', 20);
    lessThanOrEqualQuery.ascending('objectId');

    const greaterThanQuery = new Parse.Query('Observation');
    greaterThanQuery.greaterThan('code.coding.rank', 20);
    greaterThanQuery.ascending('objectId');

    const greaterThanOrEqualQuery = new Parse.Query('Observation');
    greaterThanOrEqualQuery.greaterThanOrEqualTo('code.coding.rank', 20);
    greaterThanOrEqualQuery.ascending('objectId');

    const lessThanResults = await lessThanQuery.find({ useMasterKey: true });
    const lessThanOrEqualResults = await lessThanOrEqualQuery.find({ useMasterKey: true });
    const greaterThanResults = await greaterThanQuery.find({ useMasterKey: true });
    const greaterThanOrEqualResults = await greaterThanOrEqualQuery.find({
      useMasterKey: true,
    });

    expect(lessThanResults.map(result => result.id)).toEqual([low.id]);
    expect(lessThanOrEqualResults.map(result => result.id).sort()).toEqual(
      [low.id, mid.id].sort()
    );
    expect(greaterThanResults.map(result => result.id)).toEqual([high.id]);
    expect(greaterThanOrEqualResults.map(result => result.id).sort()).toEqual(
      [high.id, mid.id].sort()
    );
  });

  it('supports Parse.Query set operators through arrays nested below object roots', async () => {
    const first = new Parse.Object('Observation');
    first.set('code', {
      coding: [{ code: '29463-7' }],
    });
    await first.save(null, { useMasterKey: true });

    const second = new Parse.Object('Observation');
    second.set('code', {
      coding: [{ code: '8302-2' }],
    });
    await second.save(null, { useMasterKey: true });

    const third = new Parse.Object('Observation');
    third.set('code', {
      coding: [{ code: '8867-4' }],
    });
    await third.save(null, { useMasterKey: true });

    const containedInQuery = new Parse.Query('Observation');
    containedInQuery.containedIn('code.coding.code', ['29463-7', '8302-2']);
    containedInQuery.ascending('objectId');

    const notContainedInQuery = new Parse.Query('Observation');
    notContainedInQuery.notContainedIn('code.coding.code', ['29463-7', '8867-4']);
    notContainedInQuery.ascending('objectId');

    const containedInResults = await containedInQuery.find({ useMasterKey: true });
    const notContainedInResults = await notContainedInQuery.find({ useMasterKey: true });

    expect(containedInResults.map(result => result.id).sort()).toEqual(
      [first.id, second.id].sort()
    );
    expect(notContainedInResults.map(result => result.id)).toEqual([second.id]);
  });

  it('supports Parse.Query set operators through arrays nested below object roots with array-valued terminals', async () => {
    const first = new Parse.Object('Observation');
    first.set('code', {
      coding: [{ aliases: ['weight', 'wt'] }],
    });
    await first.save(null, { useMasterKey: true });

    const second = new Parse.Object('Observation');
    second.set('code', {
      coding: [{ aliases: ['height', 'ht'] }],
    });
    await second.save(null, { useMasterKey: true });

    const containedInQuery = new Parse.Query('Observation');
    containedInQuery.containedIn('code.coding.aliases', ['wt']);
    containedInQuery.ascending('objectId');

    const notContainedInQuery = new Parse.Query('Observation');
    notContainedInQuery.notContainedIn('code.coding.aliases', ['wt']);
    notContainedInQuery.ascending('objectId');

    const containedInResults = await containedInQuery.find({ useMasterKey: true });
    const notContainedInResults = await notContainedInQuery.find({ useMasterKey: true });

    expect(containedInResults.map(result => result.id)).toEqual([first.id]);
    expect(notContainedInResults.map(result => result.id)).toEqual([second.id]);
  });

  it('supports Parse.Query.matches through arrays nested below object roots', async () => {
    const matching = new Parse.Object('Observation');
    matching.set('code', {
      coding: [{ code: '29463-7' }],
    });
    await matching.save(null, { useMasterKey: true });

    const excluded = new Parse.Object('Observation');
    excluded.set('code', {
      coding: [{ code: '8302-2' }],
    });
    await excluded.save(null, { useMasterKey: true });

    const query = new Parse.Query('Observation');
    query.matches('code.coding.code', /^29463/i);
    query.ascending('objectId');

    const results = await query.find({ useMasterKey: true });

    expect(results.map(result => result.id)).toEqual([matching.id]);
  });

  it('supports VitalSignsObservation-style exists queries with subject matchesQuery scoping', async () => {
    const allowedPatient = new Parse.Object('ClientInfo');
    allowedPatient.set('uid', 'patient-1');
    await allowedPatient.save(null, { useMasterKey: true });

    const deniedPatient = new Parse.Object('ClientInfo');
    await deniedPatient.save(null, { useMasterKey: true });

    const matching = new Parse.Object('VitalSignsObservation');
    matching.set('subject', allowedPatient);
    matching.set('time', 10);
    matching.set('value', { weight: 72.5 });
    await matching.save(null, { useMasterKey: true });

    const deniedBySubject = new Parse.Object('VitalSignsObservation');
    deniedBySubject.set('subject', deniedPatient);
    deniedBySubject.set('time', 20);
    deniedBySubject.set('value', { weight: 91.2 });
    await deniedBySubject.save(null, { useMasterKey: true });

    const deniedByValue = new Parse.Object('VitalSignsObservation');
    deniedByValue.set('subject', allowedPatient);
    deniedByValue.set('time', 30);
    deniedByValue.set('value', { temperature: 37.1 });
    await deniedByValue.save(null, { useMasterKey: true });

    const subjectQuery = new Parse.Query('ClientInfo');
    subjectQuery.exists('uid');

    const query = new Parse.Query('VitalSignsObservation');
    query.exists('subject');
    query.matchesQuery('subject', subjectQuery);
    query.exists('value.weight');
    query.ascending('time');
    query.addAscending('objectId');

    const results = await query.find({ useMasterKey: true });

    expect(results.map(result => result.id)).toEqual([matching.id]);
  });
});
