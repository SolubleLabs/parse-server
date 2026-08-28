# parse-server-sqlite-storage-adapter

This folder is a drop-in packaging of the SQLite storage adapter so it can live outside the Parse Server repo.

## Install in another Parse Server app

1. Copy this folder into your app, for example `vendor/parse-server-sqlite-storage-adapter`.
2. From the app root, install it so peer dependencies resolve from the host app:

```bash
npm install ./vendor/parse-server-sqlite-storage-adapter
```

3. Wire it into Parse Server:

```js
const { ParseServer } = require("parse-server");
const SQLiteStorageAdapter = require("./vendor/parse-server-sqlite-storage-adapter");

const api = new ParseServer({
  appId: "app",
  masterKey: "master",
  serverURL: "http://localhost:1337/parse",
  databaseAdapter: new SQLiteStorageAdapter({
    uri: "sqlite:///absolute/path/to/app.sqlite",
  }),
});
```

Use a dedicated worker when SQLite work must not block Parse Server's main event loop:

```js
const databaseAdapter = new SQLiteStorageAdapter({
  uri: "sqlite:///absolute/path/to/app.sqlite",
  executionMode: "worker",
});
```

The default execution provider is `better-sqlite3`. Node's built-in synchronous
driver is also available on supported Node versions:

```js
const databaseAdapter = new SQLiteStorageAdapter({
  uri: "sqlite:///absolute/path/to/app.sqlite",
  executionMode: "worker",
  executionProvider: "node:sqlite",
});
```

Parse Server passes the adapter's `options` object through unchanged, so these
adapter-specific settings do not need to be encoded in the database URI. URI
parameters remain supported for deployments that can configure only one
`DATABASE_URI` string, for example
`?executionMode=worker&executionProvider=node%3Asqlite`.

`better-sqlite3` is an optional peer only when another provider is selected. It
must be installed for the default provider and for worker mode unless
`executionProvider` selects `node:sqlite`.

Custom synchronous providers can be passed as `executionProvider`, either as a
package name, an absolute module path, or an object exporting
`createClient(options)`. Worker mode requires a package name or absolute module
path because functions and native handles cannot be transferred through
`workerData`.

The returned client must provide `prepare(sql)` statements with `run()`,
`get()`, and `all()`, plus client-level `exec()`, `function()`, and `close()`.
An optional `pragma()` method avoids routing PRAGMAs through `exec()`. This
validation runs only when a connection is opened, not for each query.

If you prefer Parse Server's adapter loader, this works too:

```js
const path = require("path");

const api = new ParseServer({
  appId: "app",
  masterKey: "master",
  serverURL: "http://localhost:1337/parse",
  databaseAdapter: {
    module: path.resolve(
      __dirname,
      "./vendor/parse-server-sqlite-storage-adapter"
    ),
    options: {
      uri: "sqlite:///absolute/path/to/app.sqlite",
      executionMode: "worker",
      executionProvider: "node:sqlite",
    },
  },
});
```

If your own bootstrap code exposes a `setStorageAdapter()` helper, pass an instance of this class there. Parse Server itself uses the `databaseAdapter` option.

## Caveats

- This package depends on Parse Server internals under `parse-server/lib/...`, so keep it version-matched with the Parse Server build it came from.
- No Parse Server core patches are required. Class creation, schema changes, dashboard CRUD, and normal adapter calls still go through the adapter boundary.
