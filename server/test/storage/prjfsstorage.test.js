'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const prjstorage = require('../../runtime/project/prjstorage');
const fsstorage = require('../../runtime/project/storage/filesystem');
const migrate = require('../../runtime/project/storage/migrate');
const J = require('../../runtime/project/storage/canonical');

const TableType = prjstorage.TableType;

function makeLogger() {
    return { info: () => {}, warn: () => {}, error: () => {} };
}

// A view carrying real SVG markup, which is what makes up ~99% of a project.
const SVG = '<svg id="v1"><rect id="r1" x="10" y="20"/><text id="t1">Pump</text></svg>';

function aView(id, name, extra) {
    return Object.assign({
        id,
        name,
        type: 'svg',
        profile: { width: 800, height: 600, bkcolor: '#ffffff' },
        svgcontent: SVG,
        items: { r1: { id: 'r1', type: 'shapes', property: { variableId: 'tag1' } } },
        variables: [],
    }, extra || {});
}

describe('Project filesystem storage', () => {
    let expect;
    const tmpDirs = [];

    before(async () => {
        const chai = await import('chai');
        expect = chai.expect;
    });

    after(() => {
        tmpDirs.forEach(dir => {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        });
    });

    let workDir;
    let workspace;

    beforeEach(async () => {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuxa-prjfs-'));
        tmpDirs.push(workDir);
        workspace = path.join(workDir, '_project');
        await fsstorage.init({ workDir, project: { storage: 'fs', workspaceDir: '_project' } }, makeLogger());
    });

    afterEach(() => {
        fsstorage.close();
    });

    const read = (rel) => fs.readFileSync(path.join(workspace, rel), 'utf8');
    const exists = (rel) => fs.existsSync(path.join(workspace, rel));

    async function value(table, name) {
        const rows = await fsstorage.getSection(table, name);
        return rows.length ? JSON.parse(rows[0].value) : undefined;
    }

    describe('key/value contract', () => {
        it('init reports whether a project is already stored', async () => {
            const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'fuxa-prjfs-'));
            tmpDirs.push(fresh);
            const first = await fsstorage.init({ workDir: fresh, project: { storage: 'fs' } }, makeLogger());
            expect(first).to.equal(false);

            await fsstorage.setDefault();
            const second = await fsstorage.init({ workDir: fresh, project: { storage: 'fs' } }, makeLogger());
            expect(second).to.equal(true);
        });

        it('insert/select on a single section works', async () => {
            await fsstorage.setSection({ table: TableType.GENERAL, name: 'app-name', value: { title: 'FUXA' } });

            const rows = await fsstorage.getSection(TableType.GENERAL, 'app-name');
            expect(rows).to.have.length(1);
            expect(rows[0].name).to.equal('app-name');
            expect(JSON.parse(rows[0].value)).to.deep.equal({ title: 'FUXA' });
        });

        it('batch insert/select with setSections works', async () => {
            await fsstorage.setSections([
                { table: TableType.VIEWS, name: 'view-1', value: aView('view-1', 'One') },
                { table: TableType.VIEWS, name: 'view-2', value: aView('view-2', 'Two') },
            ]);

            const rows = await fsstorage.getSection(TableType.VIEWS);
            expect(rows).to.have.length(2);
            expect(rows.map(r => r.name)).to.deep.equal(['view-1', 'view-2']);
        });

        it('returns an empty array for an unknown row and an empty table', async () => {
            expect(await fsstorage.getSection(TableType.ALARMS)).to.deep.equal([]);
            expect(await fsstorage.getSection(TableType.VIEWS, 'nope')).to.deep.equal([]);
        });

        it('rejects an unknown table, like the sqlite backend', async () => {
            let failed = false;
            try {
                await fsstorage.getSection('bobby; DROP TABLE views');
            } catch (err) {
                failed = true;
                expect(err.message).to.contain('invalid table');
            }
            expect(failed).to.equal(true);
        });

        it('keeps scalar values, which the general table stores', async () => {
            await fsstorage.setDefault();
            expect(await value(TableType.GENERAL, 'version')).to.equal('1.00');
        });

        it('preserves insertion order, which is the order views are listed in', async () => {
            for (const name of ['zulu', 'alpha', 'mike']) {
                await fsstorage.setSection({ table: TableType.VIEWS, name, value: aView(name, name) });
            }
            const rows = await fsstorage.getSection(TableType.VIEWS);
            expect(rows.map(r => r.name)).to.deep.equal(['zulu', 'alpha', 'mike']);
        });
    });

    describe('files on disk', () => {
        it('writes a view as real SVG next to its bindings', async () => {
            await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Main View') });

            expect(exists('views/Main-View/view.svg')).to.equal(true);
            expect(read('views/Main-View/view.svg')).to.equal(SVG + '\n');
            expect(JSON.parse(read('views/Main-View/items.json'))).to.have.property('r1');
            // The drawing must not be duplicated inside the JSON.
            expect(read('views/Main-View/view.json')).to.not.contain('<svg');
        });

        it('writes a script as a real .js file', async () => {
            const code = 'function main() {\n    return 42;\n}';
            await fsstorage.setSection({
                table: TableType.SCRIPTS,
                name: 's1',
                value: { id: 's1', name: 'Compute', code, parameters: [] },
            });

            expect(read('scripts/Compute/script.js')).to.equal(code + '\n');
            expect(read('scripts/Compute/script.json')).to.not.contain('function main');
            expect(await value(TableType.SCRIPTS, 's1')).to.have.property('code', code);
        });

        it('splits a device from its tags', async () => {
            await fsstorage.setSection({
                table: TableType.DEVICES,
                name: 'd1',
                value: { id: 'd1', name: 'PLC 1', type: 'OPCUA', property: { address: 'opc.tcp://x' }, tags: { t1: { id: 't1', name: 'Speed' } } },
            });

            expect(JSON.parse(read('devices/PLC-1/tags.json'))).to.have.property('t1');
            expect(JSON.parse(read('devices/PLC-1/device.json'))).to.not.have.property('tags');
        });

        it('writes stable, sorted, pretty JSON so re-saving produces no diff', async () => {
            const alarm = { id: 'a1', name: 'High', property: { max: 90, min: 10 } };
            await fsstorage.setSection({ table: TableType.ALARMS, name: 'a1', value: alarm });
            const first = read('alarms/High.json');

            // Same data, different key order.
            await fsstorage.setSection({
                table: TableType.ALARMS,
                name: 'a1',
                value: { property: { min: 10, max: 90 }, name: 'High', id: 'a1' },
            });
            expect(read('alarms/High.json')).to.equal(first);
            expect(first.split('\n').length).to.be.greaterThan(3);
        });
    });

    describe('round trip fidelity', () => {
        it('returns every table unchanged', async () => {
            const sections = [
                { table: TableType.GENERAL, name: 'version', value: '1.00' },
                { table: TableType.GENERAL, name: 'charts', value: [{ id: 'c1', lines: [{ id: 'l1' }, { id: 'l2' }] }] },
                { table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Main') },
                { table: TableType.DEVICES, name: 'd1', value: { id: 'd1', name: 'PLC', tags: { t1: { id: 't1' } } } },
                { table: TableType.SCRIPTS, name: 's1', value: { id: 's1', name: 'S', code: 'return 1;' } },
                { table: TableType.ALARMS, name: 'a1', value: { id: 'a1', name: 'A' } },
                { table: TableType.TEXTS, name: 'x1', value: { id: 'x1', name: 'X' } },
                { table: TableType.NOTIFICATIONS, name: 'n1', value: { id: 'n1', name: 'N' } },
                { table: TableType.REPORTS, name: 'r1', value: { id: 'r1', name: 'R' } },
                { table: TableType.LOCATIONS, name: 'l1', value: { id: 'l1', name: 'L' } },
                { table: TableType.ARMARKERS, name: 'm1', value: { id: 'm1', name: 'M' } },
            ];
            await fsstorage.setSections(sections);

            for (const section of sections) {
                expect(await value(section.table, section.name), `${section.table}/${section.name}`)
                    .to.deep.equal(section.value);
            }
        });

        it('keeps chart array order, which is significant', async () => {
            const charts = [{ id: 'z' }, { id: 'a' }, { id: 'm' }];
            await fsstorage.setSection({ table: TableType.GENERAL, name: 'charts', value: charts });
            expect(await value(TableType.GENERAL, 'charts')).to.deep.equal(charts);
        });

        it('keeps script code byte for byte, including trailing newlines', async () => {
            for (const code of ['no trailing newline', 'trailing\n', 'two\n\n', '', 'tab\tand "quotes"']) {
                await fsstorage.setSection({ table: TableType.SCRIPTS, name: 's', value: { id: 's', name: 'S', code } });
                expect((await value(TableType.SCRIPTS, 's')).code).to.equal(code);
            }
        });

        it('keeps a cards view svgcontent string identical', async () => {
            // svgcontent holds JSON rather than markup for these views, and the
            // editor compares it as a raw string when deciding if a project is dirty.
            const dashboard = JSON.stringify({ rows: [{ cards: [{ id: 'c1', type: 'view' }] }], zoom: 1 });
            await fsstorage.setSection({
                table: TableType.VIEWS,
                name: 'cv',
                value: { id: 'cv', name: 'Cards', type: 'cards', svgcontent: dashboard, items: {} },
            });

            expect(exists('views/Cards/cards.json')).to.equal(true);
            expect((await value(TableType.VIEWS, 'cv')).svgcontent).to.equal(dashboard);
        });

        it('distinguishes an absent key from an empty one', async () => {
            await fsstorage.setSection({ table: TableType.VIEWS, name: 'bare', value: { id: 'bare', name: 'Bare', type: 'svg' } });
            const back = await value(TableType.VIEWS, 'bare');
            expect(back).to.not.have.property('svgcontent');
            expect(back).to.not.have.property('items');
        });

        it('drops files an entity no longer owns', async () => {
            await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Main') });
            expect(exists('views/Main/items.json')).to.equal(true);

            await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: { id: 'v1', name: 'Main', type: 'svg' } });
            expect(exists('views/Main/items.json')).to.equal(false);
            expect(exists('views/Main/view.svg')).to.equal(false);
        });
    });

    describe('naming', () => {
        it('renames the folder when the entity is renamed, so git sees a rename', async () => {
            await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Before') });
            expect(exists('views/Before')).to.equal(true);

            await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: aView('v1', 'After') });
            expect(exists('views/Before')).to.equal(false);
            expect(exists('views/After')).to.equal(true);
            expect(await value(TableType.VIEWS, 'v1')).to.have.property('name', 'After');
        });

        it('gives colliding names distinct folders', async () => {
            await fsstorage.setSections([
                { table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Pump') },
                { table: TableType.VIEWS, name: 'v2', value: aView('v2', 'Pump') },
            ]);
            const rows = await fsstorage.getSection(TableType.VIEWS);
            expect(rows).to.have.length(2);
            expect(JSON.parse(rows[0].value).id).to.equal('v1');
            expect(JSON.parse(rows[1].value).id).to.equal('v2');
        });

        it('gives colliding names distinct files on single file tables', async () => {
            // Regression: the collision check compared the slug 'high' against
            // the filename 'high.json', never matched, and the second alarm
            // overwrote the first.
            await fsstorage.setSections([
                { table: TableType.ALARMS, name: 'a1', value: { id: 'a1', name: 'High' } },
                { table: TableType.ALARMS, name: 'a2', value: { id: 'a2', name: 'High' } },
                { table: TableType.ALARMS, name: 'a3', value: { id: 'a3', name: 'high' } },
            ]);

            expect(fs.readdirSync(path.join(workspace, 'alarms'))).to.have.length(3);
            for (const id of ['a1', 'a2', 'a3']) {
                expect(await value(TableType.ALARMS, id), id).to.have.property('id', id);
            }
        });

        it('treats names differing only by case as colliding', async () => {
            await fsstorage.setSections([
                { table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Pump') },
                { table: TableType.VIEWS, name: 'v2', value: aView('v2', 'pump') },
            ]);
            const dirs = fs.readdirSync(path.join(workspace, 'views'));
            const lowered = dirs.map(d => d.toLowerCase());
            expect(new Set(lowered).size).to.equal(dirs.length);
        });

        it('survives names that are hostile to filesystems', async () => {
            const names = ['a/b\\c', 'CON', '   ', '...', 'Ünïcode ✓', 'x'.repeat(300), '.hidden'];
            const sections = names.map((name, i) => ({
                table: TableType.ALARMS, name: `a${i}`, value: { id: `a${i}`, name },
            }));
            await fsstorage.setSections(sections);

            const rows = await fsstorage.getSection(TableType.ALARMS);
            expect(rows).to.have.length(names.length);
            for (const section of sections) {
                expect(await value(TableType.ALARMS, section.name)).to.deep.equal(section.value);
            }
            for (const file of fs.readdirSync(path.join(workspace, 'alarms'))) {
                expect(file).to.have.length.below(80);
                expect(file.startsWith('.')).to.equal(false);
            }
        });

        it('keeps a stable path across repeated saves', async () => {
            for (let i = 0; i < 3; i++) {
                await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Steady') });
            }
            expect(fs.readdirSync(path.join(workspace, 'views'))).to.deep.equal(['Steady']);
        });
    });

    describe('deletion', () => {
        it('deleteSection removes the whole entity folder', async () => {
            await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Gone') });
            await fsstorage.deleteSection({ table: TableType.VIEWS, name: 'v1' });

            expect(exists('views/Gone')).to.equal(false);
            expect(await fsstorage.getSection(TableType.VIEWS)).to.deep.equal([]);
        });

        it('deleting an absent row is not an error', async () => {
            await fsstorage.deleteSection({ table: TableType.VIEWS, name: 'never-existed' });
        });

        it('clearAll removes project files but not the git repository around them', async () => {
            await fsstorage.setSections([
                { table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Main') },
                { table: TableType.GENERAL, name: 'version', value: '1.00' },
            ]);
            fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
            fs.writeFileSync(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
            fs.writeFileSync(path.join(workspace, 'README.md'), '# My plant\n');
            fs.writeFileSync(path.join(workspace, '.gitignore'), '*.tmp\n');

            await fsstorage.clearAll();

            expect(exists('views/Main')).to.equal(false);
            expect(await fsstorage.getSection(TableType.GENERAL)).to.deep.equal([]);
            expect(exists('.git/HEAD')).to.equal(true);
            expect(exists('README.md')).to.equal(true);
            expect(exists('.gitignore')).to.equal(true);
        });

        it('a project can be written again after clearAll', async () => {
            await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Main') });
            await fsstorage.clearAll();
            await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Main') });

            expect(await value(TableType.VIEWS, 'v1')).to.have.property('name', 'Main');
        });
    });

    describe('credentials', () => {
        it('keeps device secrets out of the workspace', async () => {
            await fsstorage.setSection({
                table: TableType.DEVICESSECURITY,
                name: 'd1',
                value: { username: 'admin', password: 'hunter2' },
            });

            expect(await value(TableType.DEVICESSECURITY, 'd1')).to.deep.equal({ username: 'admin', password: 'hunter2' });
            expect(fs.existsSync(path.join(workDir, 'project.secrets.json'))).to.equal(true);

            const inWorkspace = [];
            const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
                const full = path.join(dir, e.name);
                e.isDirectory() ? walk(full) : inWorkspace.push(fs.readFileSync(full, 'utf8'));
            });
            walk(workspace);
            expect(inWorkspace.join('')).to.not.contain('hunter2');
        });

        it('clearAll leaves secrets alone, matching the sqlite backend', async () => {
            await fsstorage.setSection({ table: TableType.DEVICESSECURITY, name: 'd1', value: { password: 'x' } });
            await fsstorage.clearAll();
            expect(await value(TableType.DEVICESSECURITY, 'd1')).to.deep.equal({ password: 'x' });
        });
    });

    describe('the manifest', () => {
        it('is rewritten to point at the current state', async () => {
            await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Main') });
            const manifest = JSON.parse(read('.fuxa-index.json'));

            expect(manifest.formatVersion).to.equal(1);
            expect(manifest.rows).to.have.length(1);
            expect(manifest.rows[0]).to.include({ table: 'views', name: 'v1', path: 'views/Main' });
            expect(manifest.rows[0].files).to.include('view.svg');
        });

        it('a project written by one instance is readable by the next', async () => {
            const original = aView('v1', 'Main');
            await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: original });
            fsstorage.close();

            await fsstorage.init({ workDir, project: { storage: 'fs', workspaceDir: '_project' } }, makeLogger());
            expect(await value(TableType.VIEWS, 'v1')).to.deep.equal(original);
        });

        it('starts empty rather than throwing when corrupted', async () => {
            await fsstorage.setSection({ table: TableType.VIEWS, name: 'v1', value: aView('v1', 'Main') });
            fs.writeFileSync(path.join(workspace, '.fuxa-index.json'), 'not json at all');

            // Reported as empty, so the runtime seeds a default project rather
            // than refusing to start. The files stay on disk and the manifest
            // is recoverable from git.
            const existed = await fsstorage.init({ workDir, project: { storage: 'fs', workspaceDir: '_project' } }, makeLogger());
            expect(existed).to.equal(false);
            expect(await fsstorage.getSection(TableType.VIEWS)).to.deep.equal([]);
            expect(exists('views/Main/view.svg')).to.equal(true);
        });
    });

    describe('the dispatcher', () => {
        it('defaults to sqlite when no storage is configured', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuxa-prjdisp-'));
            tmpDirs.push(dir);
            await prjstorage.init({ workDir: dir }, makeLogger());

            expect(fs.existsSync(path.join(dir, 'project.fuxap.db'))).to.equal(true);
            prjstorage.close();
        });

        it('uses the workspace when asked to', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuxa-prjdisp-'));
            tmpDirs.push(dir);
            await prjstorage.init({ workDir: dir, project: { storage: 'fs', workspaceDir: 'ws' } }, makeLogger());
            await prjstorage.setDefault();

            expect(fs.existsSync(path.join(dir, 'ws', '.fuxa-index.json'))).to.equal(true);
            expect(fs.existsSync(path.join(dir, 'project.fuxap.db'))).to.equal(false);
            prjstorage.close();
        });
    });

    describe('as a drop-in replacement for the database', () => {
        // The shipped demo project, which is an exported JSON document rather
        // than a database file. It is the largest realistic project available,
        // and 99% of it is SVG markup, so it exercises the part that matters.
        function loadDemo() {
            const file = path.join(__dirname, '..', '..', 'project.demo.fuxap');
            // The shipped file carries a UTF-8 byte order mark.
            const text = fs.readFileSync(file, 'utf8');
            return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
        }

        // Store the project through the real runtime, so the mapping from a
        // project document to storage rows is the production one rather than a
        // copy of it that could drift.
        async function sectionsVia(storageSettings) {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuxa-prjdemo-'));
            tmpDirs.push(dir);
            const project = require('../../runtime/project/index');
            await project.init(Object.assign({ workDir: dir }, storageSettings), makeLogger(), {});
            await project.setProject(loadDemo());
            return { dir, sections: await migrate.readAll(prjstorage.current()) };
        }

        function sqliteAvailable() {
            try {
                require('sqlite3');
                return true;
            } catch (err) {
                return false;
            }
        }

        it('produces exactly the sections the sqlite backend does', async function () {
            if (!sqliteAvailable()) {
                this.skip();
            }
            const viaSqlite = await sectionsVia({});
            const viaWorkspace = await sectionsVia({ project: { storage: 'fs', workspaceDir: 'ws' } });

            expect(viaSqlite.sections.length, 'demo project should not be empty').to.be.greaterThan(5);
            expect(viaWorkspace.sections.length).to.equal(viaSqlite.sections.length);

            const stored = new Map(viaWorkspace.sections.map(s => [`${s.table} ${s.name}`, s.value]));
            for (const section of viaSqlite.sections) {
                const key = `${section.table} ${section.name}`;
                expect(stored.has(key), `${key} missing from the workspace`).to.equal(true);
                // Key order is not meaningful; the SVG strings inside are.
                expect(J.stringify(stored.get(key)), key).to.equal(J.stringify(section.value));
            }
        });

        it('turns the demo drawings into real files', async () => {
            const { dir, sections } = await sectionsVia({ project: { storage: 'fs', workspaceDir: 'ws' } });
            const views = path.join(dir, 'ws', 'views');

            const dirs = fs.readdirSync(views);
            expect(dirs.length).to.be.greaterThan(0);
            expect(dirs.some(v => fs.existsSync(path.join(views, v, 'view.svg')))).to.equal(true);

            // The drawings should now be the bulk of the workspace as files, not
            // as one escaped line inside a JSON blob.
            const biggest = dirs
                .map(v => path.join(views, v, 'view.svg'))
                .filter(f => fs.existsSync(f))
                .map(f => fs.statSync(f).size)
                .sort((a, b) => b - a)[0];
            expect(biggest).to.be.greaterThan(10000);

            for (const section of sections.filter(s => s.table === TableType.VIEWS)) {
                expect(section.value, `${section.name} keeps its drawing`).to.have.property('svgcontent');
            }
        });
    });
});
