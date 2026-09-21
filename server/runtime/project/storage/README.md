# Project storage

A FUXA project is a key/value store: eleven tables, each a set of
`(name, value)` rows where `value` is JSON. Two backends implement it.

| Backend | Where | Chosen with |
|---|---|---|
| `sqlite` | one binary `project.fuxap.db` | default |
| `fs` | a folder of JSON, SVG and JS files | `project.storage: 'fs'` |

`prjstorage.js` dispatches to whichever is configured. Both expose the same
seven operations, so `runtime/project/index.js` is written against that
interface alone and does not know which one is running.

## Why the file backend exists

The database is a single binary blob, so a project cannot be reviewed, diffed
or merged. Two engineers cannot work on different views at the same time, a
pull request shows nothing, and `git log` cannot say who changed an alarm
limit.

The shape of the data makes this worse than it sounds. In the shipped demo
project, `hmi` is 268,197 of 271,704 bytes: **98.7% of a project is SVG
markup** packed into `View.svgcontent`, one view to a line, the largest being
170 KB. Splitting those into real `.svg` files is most of the benefit on its
own.

## Turning it on

```js
// _appdata/settings.js
project: {
    storage: 'fs',
    workspaceDir: '_project',   // relative paths resolve against workDir
}
```

On the next start, an existing `project.fuxap.db` is converted into the
workspace automatically. The database is only read, never modified, so
switching back is just changing the setting back.

To convert by hand, in either direction:

```bash
node tools/project-convert.js --to fs
node tools/project-convert.js --to sqlite
node tools/project-convert.js --verify    # round trip and report differences
```

The workspace is meant to be its own git repository — `git init` it and commit.
It is not part of the FUXA checkout, and the repository's `.gitignore` already
excludes `_appdata/`, so the default location cannot be committed into a FUXA
fork by accident.

## Layout

```
<workspace>/
  general/<row>.json             version, layout, charts, graphs, languages, ...
  devices/<name>/device.json     the device minus its tags
  devices/<name>/tags.json       the tags
  views/<name>/view.json         the view minus its drawing and bindings
  views/<name>/items.json        gauge bindings, keyed by SVG element id
  views/<name>/view.svg          the drawing, as real SVG
  views/<name>/cards.json        for 'cards' views, whose svgcontent is JSON
  views/<name>/maps.json         for 'maps' views, likewise
  scripts/<name>/script.json     the script metadata
  scripts/<name>/script.js       the source, as a real .js file
  alarms/<name>.json  texts/<name>.json  notifications/<name>.json
  reports/<name>.json  mapsLocations/<name>.json  arMarkers/<name>.json
  .fuxa-index.json               the manifest, see below
```

`items.json` and `view.svg` are the two halves of one drawing: every key in
`items` is an `id="…"` inside the SVG.

## The manifest

`.fuxa-index.json` maps each stored row to its files and records a hash. It is
the only machine-oriented file in the workspace, and it earns its place four
times over:

1. **Reverse lookup** — resolves a row id to a path without scanning.
2. **Renames** — an entity renamed in the app moves its folder, so git reports
   a rename instead of a delete plus an add.
3. **Drift** — comparing on-disk hashes against it shows what changed outside
   the application.
4. **Safe `clearAll()`** — only files the manifest lists are deleted.
   `clearAll` runs on every whole-project upload; without this scoping it would
   take the workspace's `.git`, `README.md` and `.gitignore` with it.

Because row order in the manifest is the order views are listed in, `rows` is a
JSON array rather than an object, and is the one thing not written with sorted
keys.

## Serialization rules

- JSON is written with sorted keys, 2-space indent and one trailing newline, so
  saving an unchanged project produces an empty diff. Arrays keep their order,
  which matters for `charts`, chart lines and script parameters.
- `.svg` and `.js` files are written verbatim plus one `\n`; reading strips
  exactly one. That rule is lossless both ways and keeps the files POSIX clean.
- `cards.json` / `maps.json` are pretty-printed but **not** key-sorted. The
  editor compares `svgcontent` as a raw string when deciding whether a project
  is dirty, so re-stringifying has to reproduce the original byte for byte.
- Writes go through a temporary file and a rename. The manifest is written
  last, so an interrupted save leaves it pointing at the previous good state.
- Filenames are derived from entity names: illegal characters stripped, capped
  at 64 characters, Windows reserved names avoided, collisions compared
  case-insensitively so a workspace authored on Linux still opens on Windows.
  Ids stay authoritative — the filename is only a label, recorded in the
  manifest.

## Credentials

`devicesSecurity` rows hold device credentials. They are **never** written into
the workspace; they go to `<workDir>/project.secrets.json` with `0600`
permissions, alongside the database rather than inside the folder you commit.

Note that `device.property` can itself contain secrets — an MQTT password, an
API token — and those *are* part of `devices/<name>/device.json`. This is
already true of the sqlite file, but putting the workspace in git makes it
consequential. Review a device's JSON before committing it. Substituting
`${ENV_VAR}` placeholders in device properties would be the natural fix and is
not implemented yet.

## Known quirks inherited from the application

These are pre-existing behaviours of `runtime/project/index.js`. The backend
reproduces them faithfully rather than silently correcting them, because a
storage layer that rewrites data is worse than one that preserves a wart.

- Saving a whole project writes the client access settings as a `clientAccess`
  row, while editing them writes `client-access`. Only `clientAccess` is ever
  read back. Both appear in `general/` as separate files.
- Texts are keyed by `name` on a whole-project save and by `id` on an
  incremental one, so the same text can occupy two rows.
- `clearAll()` does not clear `devicesSecurity`, in either backend.
