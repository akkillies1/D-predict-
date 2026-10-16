// An installed D-Predict is staged twice: the setup package copies its [Files]
// payload into the application folder, and bootstrap-windows.ps1 clones the
// release tag over the same folder. The uninstaller only ever removes what the
// package staged, so a launcher that is listed in one of these places and not the
// others can vanish from a working install - which is how a machine ended up with
// a running Docker stack, no docker-compose.yml and no way to repair it.
// These tests keep the four lists describing one set of files.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const repoFile = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

// Files the installed app must have to start, repair or update itself.
const RUNTIME_LAUNCHERS = [
  "docker-compose.yml",
  ".env.example",
  "install-dpredict.ps1",
  "bootstrap-windows.ps1",
  "update-dpredict.ps1",
  "database-setup.ps1",
  "launch-dpredict.ps1",
  "stop-d-predict.ps1",
  "run.ps1",
  "dp.ps1",
  "d-predict.ps1",
];

const DOCUMENTS = ["README.md", "LOCAL_INSTALL_GUIDE.md", "WINDOWS.md"];

function toRepoPath(raw) {
  const parts = raw.split("\\");
  if (parts[0] === "..") return parts.slice(1).join("/");
  return ["installer", ...parts].join("/");
}

function issPayload(source) {
  return [...source.matchAll(/^Source:\s*"([^"]+)"/gm)].map((match) => toRepoPath(match[1]));
}

// Reads a PowerShell `name = @('a','b')` array out of a script or a workflow step.
function powerShellArray(source, name) {
  const start = source.indexOf(`${name} = @(`);
  assert.notEqual(start, -1, `${name} array is missing`);
  // The array closes on its own line, which is indented inside a workflow step.
  const offset = source.slice(start).search(/\n[ \t]*\)/);
  assert.notEqual(offset, -1, `${name} array is not closed`);
  return [...source.slice(start, start + offset).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

async function testTheStagedPayloadIsTheRuntimeFileSet() {
  const iss = await repoFile("installer/D-predict.iss");
  const payload = issPayload(iss);
  for (const file of RUNTIME_LAUNCHERS) {
    assert.ok(payload.includes(file), `the setup package must stage ${file}`);
  }
  for (const staged of payload) {
    assert.ok(
      RUNTIME_LAUNCHERS.concat(DOCUMENTS).includes(staged) || staged.startsWith("installer/assets/"),
      `${staged} is staged by the setup package but no list accounts for it`
    );
  }
}

async function testTheBootstrapManifestOnlyNeedsStagedFiles() {
  const bootstrap = await repoFile("bootstrap-windows.ps1");
  const manifest = powerShellArray(bootstrap, "$RequiredSourceFiles");
  const payload = issPayload(await repoFile("installer/D-predict.iss"));
  for (const file of RUNTIME_LAUNCHERS) {
    assert.ok(manifest.includes(file), `bootstrap must verify ${file} after synchronizing source`);
  }
  // A manifest entry the package cannot stage would fail an install that no repair
  // can fix, so every root-level requirement has to be part of the payload.
  for (const entry of manifest.filter((file) => !file.includes("/"))) {
    assert.ok(payload.includes(entry), `${entry} is required by bootstrap but never staged by the setup package`);
  }
  assert.match(bootstrap, /Assert-SourceComplete 'installation'/, "bootstrap must verify the installed files before provisioning");
  // Copy-Item into a directory that survived a failed removal nests the new tree one
  // level down, silently leaving the stale source in charge.
  assert.match(
    bootstrap,
    /if \(Test-Path \$target\) \{[\s\S]*?throw/,
    "a target that cannot be removed must abort the sync instead of nesting a copy"
  );
}

async function testBothWorkflowsCarryTheSameFiles() {
  const release = await repoFile(".github/workflows/windows-release.yml");
  const installer = await repoFile(".github/workflows/windows-installer.yml");
  const iss = await repoFile("installer/D-predict.iss");
  const bundleFiles = powerShellArray(release, "$files");
  const requiredFiles = powerShellArray(installer, "$required").filter((file) => !file.startsWith("installer/"));
  const payload = issPayload(iss).filter((file) => !file.startsWith("installer/"));
  assert.deepEqual(
    [...bundleFiles].sort(),
    [...payload].sort(),
    "the script-based install bundle must carry exactly what the setup package stages"
  );
  for (const file of payload) {
    assert.ok(requiredFiles.includes(file), `Windows Installer CI must require ${file}`);
  }
  for (const file of RUNTIME_LAUNCHERS) {
    assert.ok(bundleFiles.includes(file), `the release bundle must ship ${file}`);
    // A launcher change that triggers nothing is a change no CI ever builds.
    assert.ok(installer.includes(`- '${file}'`), `${file} is installer input but no paths trigger names it`);
  }
}

async function testTheVersionAndUpdaterAreWired() {
  const iss = await repoFile("installer/D-predict.iss");
  const installer = await repoFile(".github/workflows/windows-installer.yml");
  const defined = iss.match(/^#define MyAppVersion "([^"]+)"/m);
  const ci = installer.match(/INSTALLER_VERSION:\s*'([^']+)'/);
  assert.ok(defined && ci, "the installer version must be declared in the script and in CI");
  assert.equal(defined[1], ci[1], "installer/D-predict.iss and INSTALLER_VERSION must move together");
  // The in-app update check only works on an install that knows its own version.
  assert.match(iss, /install-dpredict\.ps1[^\n]*-AppVersion/, "the wizard must hand its version to the bootstrap");
  assert.match(iss, /Source: "\.\.\\update-dpredict\.ps1"/, "the updater must ship inside the installer");
  assert.match(iss, /Exec\('powershell\.exe'/, "uninstall must stop the Docker stack instead of orphaning it");
  assert.match(iss, /" stop'/, "the uninstall stop hook must ask the launcher to stop the services");
  assert.match(iss, /MB_YESNO or MB_DEFBUTTON2/, "deleting the saved configuration must not be the default answer");
}

const tests = [
  testTheStagedPayloadIsTheRuntimeFileSet,
  testTheBootstrapManifestOnlyNeedsStagedFiles,
  testBothWorkflowsCarryTheSameFiles,
  testTheVersionAndUpdaterAreWired,
];

for (const test of tests) await test();
console.log("installerBundle.test.mjs: all assertions passed");
