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
