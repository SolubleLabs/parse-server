"use strict";

// Standalone package copy of the built SQLite worker runtime.

const {
  parentPort,
  workerData
} = require('worker_threads');
const {
  isNativeError
} = require('util').types;
const SQLiteStorageAdapterModule = require('./SQLiteStorageAdapter');
const {
  workerTransactionIdProperty
} = require('./SQLiteWorkerStorageAdapter');
const SQLiteStorageAdapter = SQLiteStorageAdapterModule.default || SQLiteStorageAdapterModule.SQLiteStorageAdapter || SQLiteStorageAdapterModule;
const options = workerData?.options || {};
options.executionMode = 'direct';
options._runsInDedicatedWorker = true;
if (options.databaseOptions) {
  options.databaseOptions.executionMode = 'direct';
}
const adapter = new SQLiteStorageAdapter(options);
const transactionalSessions = new Map();
class InvocationQueue {
  constructor() {
    this._items = [];
    this._head = 0;
  }
  push(invocation) {
    this._items.push(invocation);
  }
  shift() {
    const invocation = this._items[this._head];
    if (!invocation) {
      return null;
    }
    this._items[this._head] = undefined;
    this._head += 1;
    if (this._head === this._items.length) {
      this._items = [];
      this._head = 0;
    } else if (this._head > 1024 && this._head * 2 >= this._items.length) {
      this._items = this._items.slice(this._head);
      this._head = 0;
    }
    return invocation;
  }
  get length() {
    return this._items.length - this._head;
  }
}
const regularInvocations = new InvocationQueue();
const transactionInvocations = new InvocationQueue();
let activeTransactionId = null;
let nextTransactionId = 1;
let isDraining = false;
adapter.watch(() => parentPort.postMessage({
  type: 'schemaChange'
}));
const serializeError = error => {
  if (!isNativeError(error)) {
    try {
      return {
        isThrownValue: true,
        value: structuredClone(error)
      };
    } catch {
      return {
        isThrownValue: true,
        value: String(error)
      };
    }
  }
  const properties = {};
  for (const key of Object.getOwnPropertyNames(error || {})) {
    if (key === 'name' || key === 'message' || key === 'stack') {
      continue;
    }
    const value = error[key];
    try {
      structuredClone(value);
      properties[key] = value;
    } catch {
      properties[key] = String(value);
    }
  }
  return {
    isParseError: error?.constructor?.name === 'ParseError' && typeof error?.code === 'number',
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack,
    properties
  };
};
const getInvocationTransactionId = invocation => {
  for (const arg of invocation.args) {
    if (arg && typeof arg === 'object' && arg[workerTransactionIdProperty] != null) {
      return arg[workerTransactionIdProperty];
    }
  }
  return null;
};
const replaceTransactionTokens = args => args.map(arg => {
  const transactionId = arg && typeof arg === 'object' ? arg[workerTransactionIdProperty] : null;
  if (transactionId == null) {
    return arg;
  }
  const transactionalSession = transactionalSessions.get(transactionId);
  if (!transactionalSession) {
    throw new Error(`Unknown SQLite worker transaction ${transactionId}`);
  }
  return transactionalSession;
});
const invokeLegacyDatabaseMethod = async invocation => {
  const [collectionName, ...methodArgs] = invocation.args;
  const collection = adapter.database.collection(collectionName);
  switch (invocation.method) {
    case '__legacyDatabaseUpdateOne':
      return collection.updateOne(...methodArgs);
    case '__legacyDatabaseFind':
      return collection.find(...methodArgs).toArray();
    default:
      throw new Error(`Unknown legacy SQLite worker method ${invocation.method}`);
  }
};
const invokeAdaptiveCollectionMethod = async invocation => {
  const [className, ...methodArgs] = invocation.args;
  const collection = await adapter._adaptiveCollection(className);
  switch (invocation.method) {
    case '__adaptiveCollectionFind':
      return collection.find(...methodArgs);
    case '__adaptiveCollectionEnsureSparseUniqueIndex':
      return collection._ensureSparseUniqueIndexInBackground(...methodArgs);
    default:
      throw new Error(`Unknown adaptive SQLite worker method ${invocation.method}`);
  }
};
const runInvocation = async invocation => {
  if (invocation.method.startsWith('__legacyDatabase')) {
    return invokeLegacyDatabaseMethod(invocation);
  }
  if (invocation.method.startsWith('__adaptiveCollection')) {
    return invokeAdaptiveCollectionMethod(invocation);
  }
  if (invocation.method === 'createTransactionalSession') {
    const transactionalSession = await adapter.createTransactionalSession();
    const transactionId = nextTransactionId;
    nextTransactionId += 1;
    transactionalSessions.set(transactionId, transactionalSession);
    activeTransactionId = transactionId;
    return {
      [workerTransactionIdProperty]: transactionId
    };
  }
  if (invocation.method === 'handleShutdown') {
    for (const [transactionId, transactionalSession] of transactionalSessions) {
      try {
        await adapter.abortTransactionalSession(transactionalSession);
      } catch {
        /* The adapter shutdown below still closes the main connection. */
      }
      transactionalSessions.delete(transactionId);
    }
    activeTransactionId = null;
    return adapter.handleShutdown();
  }
  const transactionId = getInvocationTransactionId(invocation);
  const endsTransaction = transactionId != null && (invocation.method === 'commitTransactionalSession' || invocation.method === 'abortTransactionalSession');
  try {
    return await adapter[invocation.method](...replaceTransactionTokens(invocation.args));
  } finally {
    // Both direct transaction finalizers close their connection in a finally
    // block, so the worker token must be retired even if COMMIT/ROLLBACK fails.
    if (endsTransaction) {
      transactionalSessions.delete(transactionId);
      activeTransactionId = null;
    }
  }
};
const drainInvocations = async () => {
  if (isDraining) {
    return;
  }
  isDraining = true;
  try {
    let invocation = activeTransactionId == null ? regularInvocations.shift() : transactionInvocations.shift();
    while (invocation) {
      try {
        const result = await runInvocation(invocation);
        parentPort.postMessage({
          type: 'response',
          id: invocation.id,
          result
        });
      } catch (error) {
        parentPort.postMessage({
          type: 'response',
          id: invocation.id,
          error: serializeError(error)
        });
      }
      invocation = activeTransactionId == null ? regularInvocations.shift() : transactionInvocations.shift();
    }
  } finally {
    isDraining = false;
  }
};
parentPort.on('message', message => {
  if (message?.type === 'setAdapterProperty') {
    if (message.property !== 'disableIndexFieldValidation') {
      throw new Error(`Unsupported mutable SQLite adapter property ${message.property}`);
    }
    adapter.disableIndexFieldValidation = !!message.value;
    return;
  }
  if (message?.type !== 'invoke') {
    return;
  }
  const transactionId = getInvocationTransactionId(message);
  if (activeTransactionId != null && (message.method === 'handleShutdown' || transactionId === activeTransactionId)) {
    transactionInvocations.push(message);
  } else {
    regularInvocations.push(message);
  }
  void drainInvocations();
});
