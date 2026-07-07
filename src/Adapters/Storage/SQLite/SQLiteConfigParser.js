// @flow

const decodeSQLitePath = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

const parseOptionalInteger = (value: ?string): ?number => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsedValue = parseInt(value, 10);
  return Number.isFinite(parsedValue) ? parsedValue : null;
};

const applySQLiteQueryOptions = (options: Object, searchParams: URLSearchParams) => {
  if (searchParams.has('fileMustExist')) {
    options.fileMustExist = searchParams.get('fileMustExist') === 'true';
  }

  const timeout = parseOptionalInteger(searchParams.get('timeout'));
  if (timeout !== null) {
    options.timeout = timeout;
  }

  const cacheSizeKb = parseOptionalInteger(searchParams.get('cacheSizeKb'));
  if (cacheSizeKb !== null) {
    options.cacheSizeKb = cacheSizeKb;
  }
};

const normalizeFileSQLiteURI = (uri: string): string => {
  if (uri === 'file::memory:' || uri.startsWith('file::memory:?')) {
    return ':memory:';
  }

  if (!uri.startsWith('file:/') && !uri.startsWith('file://')) {
    return decodeSQLitePath(uri.slice(5).split('?')[0]);
  }

  try {
    const parsedURI = new URL(uri);
    if (parsedURI.protocol !== 'file:') {
      return uri;
    }

    const decodedPath = decodeSQLitePath(parsedURI.pathname || '');
    if (parsedURI.hostname && parsedURI.hostname !== 'localhost') {
      return `//${parsedURI.hostname}${decodedPath}`;
    }
    if (/^\/[A-Za-z]:\//.test(decodedPath)) {
      return decodedPath.slice(1);
    }
    return decodedPath || ':memory:';
  } catch {
    return decodeSQLitePath(uri.slice(5).split('?')[0]);
  }
};

function getDatabaseOptionsFromURI(uri: string) {
  const options: Object = {};
  if (!uri) {
    options.filename = ':memory:';
    return options;
  }

  if (uri.startsWith('sqlite://')) {
    const rawPath = uri.substring(9);
    const [pathPart, queryPart] = rawPath.split('?');
    if (pathPart === ':memory:' || pathPart === '') {
      options.filename = ':memory:';
    } else {
      options.filename = decodeSQLitePath(pathPart);
    }
    if (queryPart) {
      applySQLiteQueryOptions(options, new URLSearchParams(queryPart));
    }
  } else if (uri.startsWith('file:')) {
    options.filename = normalizeFileSQLiteURI(uri);
    const queryStart = uri.indexOf('?');
    if (queryStart >= 0) {
      applySQLiteQueryOptions(options, new URLSearchParams(uri.slice(queryStart + 1)));
    }
  } else {
    options.filename = uri;
  }

  return options;
}

module.exports = {
  getDatabaseOptionsFromURI,
};
