// @flow
const { Worker } = require('worker_threads');
const ParseModule = require('parse/node');
const Parse = ParseModule.default || ParseModule;

const workerTransactionIdProperty = '__sqliteWorkerTransactionId';

const deserializeWorkerError = (
  serializedError: any,
  logDuplicateKey: (message: string) => void,
  logSanitizedError: (message: string) => void
): any => {
  if (serializedError?.isThrownValue) {
    return serializedError.value;
  }
  const message = serializedError?.message || 'SQLite worker operation failed';
  const properties = { ...(serializedError?.properties || {}) };
  if (properties._sqliteDuplicateKeyLogMessage) {
    logDuplicateKey(properties._sqliteDuplicateKeyLogMessage);
    delete properties._sqliteDuplicateKeyLogMessage;
  }
  if (properties._sqliteSanitizedLogMessage) {
    logSanitizedError(properties._sqliteSanitizedLogMessage);
    delete properties._sqliteSanitizedLogMessage;
  }
  const error = serializedError?.isParseError
    ? new Parse.Error(properties.code, message)
    : new Error(message);
  error.name = serializedError?.name || 'Error';
  if (serializedError?.stack) {
    error.stack = serializedError.stack;
  }
  for (const key of Object.keys(properties)) {
    error[key] = properties[key];
  }
  return error;
};

class SQLiteWorkerClient {
  _worker: any;
  _pendingRequests: Map<number, any>;
  _nextRequestId: number;
  _schemaChangeCallback: () => void;
  _closed: boolean;
  _fatalError: ?Error;
  _logDuplicateKey: (message: string) => void;
  _logSanitizedError: (message: string) => void;

  constructor(
    options: any,
    logDuplicateKey: (message: string) => void,
    logSanitizedError: (message: string) => void
  ) {
    this._pendingRequests = new Map();
    this._nextRequestId = 1;
    this._schemaChangeCallback = () => {};
    this._closed = false;
    this._fatalError = null;
    this._logDuplicateKey = logDuplicateKey;
    this._logSanitizedError = logSanitizedError;
    this._worker = new Worker(require.resolve('./SQLiteStorageAdapterWorker'), {
      workerData: { options },
    });
    this._worker.on('message', message => this._handleMessage(message));
    this._worker.on('error', error => {
      this._fatalError = error;
      this._failPendingRequests(error);
    });
    this._worker.on('exit', code => {
      if (!this._closed) {
        this._fatalError ||= new Error(`SQLite worker exited unexpectedly with code ${code}`);
        this._failPendingRequests(this._fatalError);
      }
    });
    // Event listener registration re-references Worker handles. Unref only
    // after all listeners exist; pending RPCs temporarily ref it again below.
    this._worker.unref();
  }

  _handleMessage(message: any) {
    if (message?.type === 'schemaChange') {
      this._schemaChangeCallback();
      return;
    }
    if (message?.type !== 'response') {
      return;
    }
    const pendingRequest = this._pendingRequests.get(message.id);
    if (!pendingRequest) {
      return;
    }
    this._pendingRequests.delete(message.id);
    if (this._pendingRequests.size === 0) {
      this._worker.unref();
    }
    if (message.error) {
      pendingRequest.reject(
        deserializeWorkerError(
          message.error,
          this._logDuplicateKey,
          this._logSanitizedError
        )
      );
    } else {
      pendingRequest.resolve(message.result);
    }
  }

  _failPendingRequests(error: Error) {
    for (const pendingRequest of this._pendingRequests.values()) {
      pendingRequest.reject(error);
    }
    this._pendingRequests.clear();
    this._worker.unref();
  }

  invoke(method: string, args: Array<any> = []): Promise<any> {
    if (this._fatalError) {
      return Promise.reject(this._fatalError);
    }
    if (this._closed) {
      return Promise.reject(new Error('SQLite worker is already shut down'));
    }
    const id = this._nextRequestId;
    this._nextRequestId += 1;
    return new Promise((resolve, reject) => {
      if (this._pendingRequests.size === 0) {
        this._worker.ref();
      }
      this._pendingRequests.set(id, { resolve, reject });
      try {
        this._worker.postMessage({ type: 'invoke', id, method, args });
      } catch (error) {
        this._pendingRequests.delete(id);
        if (this._pendingRequests.size === 0) {
          this._worker.unref();
        }
        reject(error);
      }
    });
  }

  watch(callback: () => void) {
    this._schemaChangeCallback = callback;
  }

  setAdapterProperty(property: string, value: any) {
    if (this._fatalError) {
      throw this._fatalError;
    }
    if (this._closed) {
      throw new Error('SQLite worker is already shut down');
    }
    // The worker queues this control message by port submission order. The
    // assignment is asynchronous, but a later eligible invocation cannot pass it.
    this._worker.postMessage({ type: 'setAdapterProperty', property, value });
  }

  async close(): Promise<void> {
    if (this._closed) {
      return;
    }
    try {
      await this.invoke('handleShutdown');
    } finally {
      this._closed = true;
      await this._worker.terminate();
      this._failPendingRequests(new Error('SQLite worker was shut down'));
    }
  }
}

const createLegacyDatabaseFacade = (workerClient: SQLiteWorkerClient) => ({
  collection: (collectionName: string) => ({
    updateOne: (query: any = {}, update: any = {}) =>
      workerClient.invoke('__legacyDatabaseUpdateOne', [collectionName, query, update]),
    find: (query: any = {}) => ({
      toArray: () => workerClient.invoke('__legacyDatabaseFind', [collectionName, query]),
    }),
  }),
});

const createAdaptiveCollectionFacade = (workerClient: SQLiteWorkerClient, className: string) => ({
  find: (query: any = {}) => workerClient.invoke('__adaptiveCollectionFind', [className, query]),
  _ensureSparseUniqueIndexInBackground: (index: any) =>
    workerClient.invoke('__adaptiveCollectionEnsureSparseUniqueIndex', [className, index]),
});

function createWorkerStorageAdapter(
  workerOptions: any,
  publicURI: string,
  adapterPrototype: any,
  releaseMainThreadResources: () => void,
  logDuplicateKey: (message: string) => void,
  logSanitizedError: (message: string) => void
): any {
  // Functions and native handles cannot cross workerData. Custom worker drivers
  // therefore use a module name/path, while direct mode may also accept objects.
  let clonedOptions;
  try {
    clonedOptions = structuredClone(workerOptions);
  } catch {
    throw new TypeError(
      'SQLite worker options must be structured-cloneable; pass custom providers as a module name/path'
    );
  }
  const workerClient = new SQLiteWorkerClient(
    clonedOptions,
    logDuplicateKey,
    logSanitizedError
  );
  let shutdownPromise;
  const target = {
    _uri: publicURI,
    _executionMode: 'worker',
    canSortOnJoinTables: true,
    schemaCacheTtl: workerOptions.databaseOptions?.schemaCacheTtl ?? null,
    enableSchemaHooks: !!workerOptions.databaseOptions?.enableSchemaHooks,
    disableIndexFieldValidation: !!workerOptions.databaseOptions?.disableIndexFieldValidation,
    database: createLegacyDatabaseFacade(workerClient),
    watch: callback => workerClient.watch(callback),
    getIdempotencyIndexOptions: () => null,
    _adaptiveCollection: async className => createAdaptiveCollectionFacade(workerClient, className),
    handleShutdown: () => {
      if (!shutdownPromise) {
        shutdownPromise = workerClient.close().finally(releaseMainThreadResources);
      }
      return shutdownPromise;
    },
  };
  Object.setPrototypeOf(target, adapterPrototype);

  return new Proxy(target, {
    get(proxyTarget, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(proxyTarget, property)) {
        return Reflect.get(proxyTarget, property, receiver);
      }
      if (property === 'constructor') {
        // Parse's reset plumbing recreates the configured adapter through its
        // constructor. Keep reflection local instead of turning it into RPC.
        return adapterPrototype.constructor;
      }
      if (typeof property === 'string' && typeof adapterPrototype[property] === 'function') {
        return (...args) => workerClient.invoke(property, args);
      }
      return Reflect.get(proxyTarget, property, receiver);
    },
    set(proxyTarget, property, value, receiver) {
      if (property === 'disableIndexFieldValidation') {
        const normalizedValue = !!value;
        workerClient.setAdapterProperty(property, normalizedValue);
        return Reflect.set(proxyTarget, property, normalizedValue, receiver);
      }
      return Reflect.set(proxyTarget, property, value, receiver);
    },
  });
}

module.exports = {
  createWorkerStorageAdapter,
  workerTransactionIdProperty,
};
