const esbuild = require('esbuild');
const AdmZip = require('adm-zip');

async function build() {
    console.log("Compiling bootstrap.ts...");
    await esbuild.build({
        entryPoints: ['src/bootstrap.ts'],
        bundle: true,
        outfile: 'bootstrap.js',
        target: 'es2022',
        format: 'iife',
        globalName: 'ZoteroPlugin',
        footer: {
            js: 'var install = ZoteroPlugin.install;\nvar startup = ZoteroPlugin.startup;\nvar shutdown = ZoteroPlugin.shutdown;\nvar uninstall = ZoteroPlugin.uninstall;'
        }
    });

    console.log("Zipping extension...");
    const zip = new AdmZip();
    zip.addLocalFile('manifest.json');
    zip.addLocalFile('bootstrap.js');
    zip.writeZip('zotero-pdf-highlighter.xpi');
    console.log("Created zotero-pdf-highlighter.xpi");
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});