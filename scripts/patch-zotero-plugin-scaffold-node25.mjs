import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const TARGET = 'styleText("grey",';
const REPLACEMENT = 'styleText("gray",';

function resolveScaffoldSharedDir() {
  const explicitSharedDir = process.argv[2];

  if (explicitSharedDir) {
    return path.resolve(process.cwd(), explicitSharedDir);
  }

  return path.join(
    process.cwd(),
    "node_modules",
    "zotero-plugin-scaffold",
    "dist",
    "shared",
  );
}

async function patchSharedModule(scaffoldSharedDir, fileName) {
  const filePath = path.join(scaffoldSharedDir, fileName);
  const source = await readFile(filePath, "utf8");

  if (!source.includes(TARGET)) {
    return false;
  }

  await writeFile(filePath, source.replace(TARGET, REPLACEMENT), "utf8");
  return true;
}

async function main() {
  const scaffoldSharedDir = resolveScaffoldSharedDir();

  try {
    await access(scaffoldSharedDir);
  } catch {
    return;
  }

  const sharedFiles = await readdir(scaffoldSharedDir);
  const targetFiles = sharedFiles.filter(
    (fileName) =>
      fileName.startsWith("zotero-plugin-scaffold.") && fileName.endsWith(".mjs"),
  );

  if (targetFiles.length === 0) {
    throw new Error(`No scaffold shared modules found in ${scaffoldSharedDir}`);
  }

  let patchedCount = 0;
  for (const fileName of targetFiles) {
    if (await patchSharedModule(scaffoldSharedDir, fileName)) {
      patchedCount += 1;
    }
  }

  if (patchedCount > 0) {
    console.log(`Patched zotero-plugin-scaffold Node 25 color alias in ${patchedCount} file(s).`);
  }
}

await main();
