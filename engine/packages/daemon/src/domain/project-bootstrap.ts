import { execFileSync, spawn } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type Database from "better-sqlite3";
import { credentialExcluded } from "./scope-extension.js";
import { GithubCliError, type GithubAccount, type GithubCli } from "./github-cli.js";
import { availableTeamName, createTeam, listTeams, TeamSetupError, type Team, type TeamClient } from "./team-setup.js";
import { canonicalPath, isWindows, pathWithin } from "./platform.js";

const DEFAULT_IGNORES = ["node_modules/", "dist/", "build/", "coverage/", ".env*", "*.pem", "*.key",
  ".config/", ".ssh/", ".aws/", ".codex/", ".claude/", ".npmrc", ".netrc", "credentials*"];
const DEFAULT_IGNORE_FILE = DEFAULT_IGNORES.join("\n") + "\n";

/**
 * R17 — the largest file an initial upload may carry.
 *
 * GitHub refuses a pushed object over 100 MiB, and the push is the last step of setup, so a file
 * that large turns a local mistake into a failed upload the owner reads as a connection problem.
 * The limit is checked from the directory entry, before the file is opened.
 */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export class ProjectBootstrapError extends Error {
  constructor(readonly code: string, message: string, readonly excludedPaths: string[] = [],
    readonly oversizedPaths: string[] = []) {
    super(message);
    this.name = "ProjectBootstrapError";
  }
}

export interface ProjectInput { repository: string; name: string }
export interface ProjectPreview extends ProjectInput {
  action: "create" | "push" | "register";
  fileCount: number;
  excludedPaths: string[];
}

/**
 * One entry of the initial snapshot, as it is classified and before it is read.
 *
 * `file` names a path Git will read for itself, `link` carries the target text a symlink is
 * committed with, and `inline` is content this module writes (the default ignore file). Only the
 * last two hold bytes, and both are small by construction.
 */
type ProjectEntry =
  | { path: string; mode: "100644" | "100755"; kind: "file" }
  | { path: string; mode: "120000"; kind: "link"; target: string }
  | { path: string; mode: "100644"; kind: "inline"; data: Buffer };

interface ProjectInspection {
  preview: ProjectPreview;
  files: ProjectEntry[];
  head: string | null;
  origin: string | null;
}
interface Bootstrap {
  repository: string; name: string; lead_client: TeamClient; github_login: string;
  step: "pending" | "folder" | "init" | "ignore" | "commit" | "repo" | "push";
  commit_oid: string | null; branch_ref: string | null; remote_url: string | null;
  team_id: string | null; last_error_code: string | null;
}

const excluded = (path: string) => credentialExcluded(path) || /(^|\/)\.config(?:\/|$)/.test(path);
const refusedFolder = () => new ProjectBootstrapError("team_folder_refused", "Select a project folder, not a home, drive, profile, or parent repository root.");

/** Resolve a missing descendant through its existing ancestor without creating it. */
function canonical(path: string): string {
  const suffix: string[] = [];
  let parent = resolve(path);
  while (!existsSync(parent)) {
    // A dangling link is not a missing directory that Create may replace.
    try { if (lstatSync(parent).isSymbolicLink()) throw refusedFolder(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    suffix.unshift(basename(parent));
    parent = dirname(parent);
  }
  if (!statSync(parent).isDirectory()) throw refusedFolder();
  // The long form, so a Windows root given in its 8.3 spelling resolves to the spelling Git and
  // every later comparison use.
  return join(canonicalPath(parent), ...suffix);
}

export function projectFolder(repository: string, home = homedir()): string {
  if (!isAbsolute(repository)) throw refusedFolder();
  const root = canonical(repository), ownerHome = canonical(home);
  // A drive, a filesystem root, a user-profile folder and a parent repository root are all
  // "somewhere a project is not". The WSL mount spellings (`/mnt/c`, `/mnt/c/Users/<name>`) are
  // named here because on that host they are the same three shapes under a different root.
  if (pathWithin(root, ownerHome) || dirname(root) === root || /^\/mnt\/[a-z]$/i.test(root)
    || /^\/mnt\/[a-z]\/Users(?:\/[^/]+)?$/i.test(root) || isWindowsProfileFolder(root) || excluded(root)) throw refusedFolder();
  return root;
}

/**
 * R15 — a Windows profile folder, which `dirname(root) === root` cannot catch.
 *
 * `C:\Users\<name>` is a user profile (the owner's own home is refused already, but a different
 * profile on the same machine is not the project either) and `C:\Users` holds them all. The
 * comparison folds case because Windows does.
 */
function isWindowsProfileFolder(root: string): boolean {
  if (process.platform !== "win32") return false;
  return /^[A-Za-z]:[\\/]Users(?:[\\/][^\\/]+)?$/i.test(root);
}

function git(root: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: Buffer | string } = {}): string {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
  return execFileSync("git", ["-C", root, ...args], {
    windowsHide: true,
    encoding: "utf8", stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 60_000, maxBuffer: 16 * 1024 * 1024, input: options.input,
    env: { ...env, LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", ...options.env },
  });
}

/**
 * One Git command off the event loop, for the work that scales with the folder.
 *
 * `inspectProject` runs on the request that previews a project and again inside the create, so a
 * synchronous child process per file would hold the daemon's only thread for as long as the folder
 * is large. The commands below are batch-shaped (one process for the whole snapshot), and this
 * boundary is what lets the timer-driven parts of the daemon keep running while they work.
 */
function gitAsync(root: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: Buffer | string } = {}):
  Promise<string> {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", ["-C", root, ...args], {
      windowsHide: true,
      env: { ...env, LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", ...options.env },
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < 16 * 1024 * 1024) stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < 1024 * 1024) stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", status => {
      clearTimeout(timer);
      if (status === 0) { resolvePromise(stdout); return; }
      const failure = Object.assign(new Error(stderr.trim() || `git ${args[0]} exited with ${status}`),
        { status, stderr });
      reject(failure);
    });
    if (options.input !== undefined) {
      child.stdin?.on("error", () => { /* A refused write surfaces as a non-zero exit. */ });
      child.stdin?.end(options.input);
    }
  });
}

function gitValue(root: string, args: string[]): string | null {
  try { return git(root, args).trim() || null; } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer | string };
    if (failure.status === 1 || (args[1] === "--show-toplevel" && failure.status === 128
      && String(failure.stderr).includes("not a git repository"))) return null;
    throw new ProjectBootstrapError("team_repository_not_git", "The selected folder's Git metadata could not be read.");
  }
}

async function historyExclusions(repository: string, commit: string): Promise<string[]> {
  if (git(repository, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new ProjectBootstrapError("team_history_incomplete", "Fetch the complete repository history before creating its remote.");
  }
  const paths = new Set<string>();
  const trees = new Set((await gitAsync(repository, ["rev-list", "--format=%T", "--no-commit-header", commit, "--"])).trim().split("\n"));
  for (const tree of trees) for (const path of (await gitAsync(repository, ["ls-tree", "-r", "-z", "--name-only", tree])).split("\0")) {
    if (path && excluded(path)) paths.add(path);
  }
  return [...paths].sort();
}

async function inspectProject(input: ProjectInput, home = homedir(), bootstrap?: Bootstrap): Promise<ProjectInspection> {
  if (!/^[a-z\d][a-z\d_.-]{0,99}$/i.test(input.name)) {
    throw new ProjectBootstrapError("team_name_invalid", "Use a repository name beginning with a letter or number, followed by letters, numbers, dots, underscores or dashes.");
  }
  const repository = projectFolder(input.repository, home);
  let parent = repository;
  while (!existsSync(parent)) parent = dirname(parent);
  const top = gitValue(parent, ["rev-parse", "--show-toplevel"]);
  if (top && canonicalPath(top) !== repository) throw refusedFolder();
  if (!top && existsSync(join(repository, ".git"))) {
    throw new ProjectBootstrapError("team_repository_not_git", "The selected folder has unreadable Git metadata.");
  }
  const head = top ? gitValue(repository, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) : null;
  const origin = top ? gitValue(repository, ["config", "--get", "remote.origin.url"]) : null;
  if (origin && !head) throw new ProjectBootstrapError("team_repository_no_commit", "An existing origin needs a local commit before its team is registered.");
  if (bootstrap?.remote_url && origin !== bootstrap.remote_url) throw originChanged();
  const uploadHead = bootstrap?.commit_oid ?? head;
  const uploads = !!bootstrap || !origin;
  const files: ProjectEntry[] = [], excludedPaths = new Set<string>();
  let fileCount = 0;
  if (uploads && uploadHead) {
    const unsafe = await historyExclusions(repository, uploadHead);
    if (unsafe.length) throw new ProjectBootstrapError("team_history_credentials",
      "Credential-policy paths exist in the outgoing history. That history stays local and is left unchanged.", unsafe);
    fileCount = git(repository, ["ls-tree", "-r", "-z", "--name-only", uploadHead]).split("\0").filter(Boolean).length;
  } else if (uploads) {
    if (existsSync(repository)) {
      // Git owns ignore semantics. Temporary metadata stays outside the selected folder;
      // preview never writes its files, index, objects, refs, configuration or bootstrap state.
      const metadata = mkdtempSync(join(tmpdir(), "project-preview-git-"));
      try {
        git(metadata, ["init", "--bare", "--quiet", "--template="]);
        const prefix = ["--git-dir=" + metadata, "--work-tree=" + repository];
        const patterns = ["--exclude=.git", ...(!existsSync(join(repository, ".gitignore"))
          ? DEFAULT_IGNORES.map(pattern => "--exclude=" + pattern) : [])];
        const paths = (await gitAsync(repository, [...prefix, "ls-files", "--others", "--exclude-standard", "-z", ...patterns]))
          .split("\0").filter(Boolean);
        const ignored = (await gitAsync(repository, [...prefix, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", ...patterns]))
          .split("\0").filter(Boolean);
        for (const path of [...paths, ...ignored]) {
          if (path !== ".git" && path !== ".git/" && excluded(path)) excludedPaths.add(path);
        }
        const oversized: string[] = [];
        const seen = new Map<string, string | null>();
        for (const path of paths) {
          if (excluded(path)) continue;
          // Windows only: on POSIX Git lists a symlink itself, so an ancestor can never be one.
          const redirect = isWindows() ? redirectingAncestor(repository, path, seen) : null;
          if (redirect !== null) { excludedPaths.add(redirect); continue; }
          const entry = classify(repository, path, excludedPaths, oversized);
          if (entry !== null) files.push(entry);
        }
        if (oversized.length) throw new ProjectBootstrapError("team_file_too_large",
          "Files over 100 MiB cannot be uploaded to GitHub. Remove them or add them to the project's ignore file, then review the files again.",
          [], oversized.sort());
      } finally { rmSync(metadata, { recursive: true, force: true }); }
    }
    if (!existsSync(join(repository, ".gitignore"))) {
      files.push({ path: ".gitignore", mode: "100644", kind: "inline", data: Buffer.from(DEFAULT_IGNORE_FILE) });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    fileCount = files.length;
  }
  const preview: ProjectPreview = { repository, name: input.name, action: !uploads ? "register" : uploadHead ? "push" : "create",
    fileCount, excludedPaths: [...excludedPaths].sort() };
  return { preview, files, head, origin };
}

/**
 * The link a listed path was reached through, or `null` when it was reached directly.
 *
 * On POSIX Git lists a symlink as the link, never as the directory it names, so this is a no-op
 * there. Windows is the exception: a junction is a directory entry to Git, so
 * `ls-files --others` descends into it and reports `linked/file.ts`. Uploading that would put
 * another directory's contents under the link's name. Each path's ancestors are therefore checked
 * once and the answer is cached, so the walk costs one `lstat` per distinct directory.
 */
function redirectingAncestor(repository: string, path: string, seen: Map<string, string | null>): string | null {
  const parts = path.replace(/\/$/, "").split("/");
  for (let length = 1; length < parts.length; length += 1) {
    const prefix = parts.slice(0, length).join("/");
    let redirect = seen.get(prefix);
    if (redirect === undefined) {
      try { redirect = lstatSync(join(repository, prefix)).isSymbolicLink() ? prefix : null; }
      catch { redirect = null; }
      seen.set(prefix, redirect);
    }
    if (redirect !== null) return redirect;
  }
  return null;
}

/**
 * Classify one candidate from its directory entry, without reading its bytes.
 *
 * R17 — the size check happens here, on the entry Git listed, so a file over the limit is refused
 * before anything opens it. The mode is decided per host: NTFS reports every regular file with the
 * same permission bits (`chmod +x` does not change them), so a Windows snapshot records `100644`
 * for every regular file rather than inventing an executable bit; a POSIX host keeps the bit it
 * actually reports. A symlink is committed as `120000` with its target text, and only when that
 * target stays inside the project and outside the credential policy.
 */
function classify(repository: string, path: string, excludedPaths: Set<string>, oversized: string[]): ProjectEntry | null {
  const absolute = join(repository, path);
  let stat: Stats;
  try { stat = lstatSync(absolute); } catch { return null; }
  if (stat.isSymbolicLink()) {
    let target: string;
    try { target = canonicalPath(absolute); } catch { excludedPaths.add(path); return null; }
    if (!pathWithin(repository, target) || excluded(relative(repository, target))) { excludedPaths.add(path); return null; }
    return { path, mode: "120000", kind: "link", target: readlinkSync(absolute) };
  }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_UPLOAD_BYTES) { oversized.push(path); return null; }
  return { path, mode: !isWindows() && stat.mode & 0o111 ? "100755" : "100644", kind: "file" };
}

export async function previewProject(input: ProjectInput, home = homedir(), db?: Database.Database): Promise<ProjectPreview> {
  const bootstrap = db ? readBootstrap(db, projectFolder(input.repository, home)) : undefined;
  if (bootstrap?.step === "push") throw teamExists();
  return (await inspectProject(input, home, bootstrap)).preview;
}

const teamExists = () => new TeamSetupError("team_exists", "This project already has a team. Open it instead of creating it again.");
const originChanged = () => new ProjectBootstrapError("team_origin_changed", "The project's origin changed during setup. Restore the recorded origin before retrying Create.");
function readBootstrap(db: Database.Database, repository: string): Bootstrap | undefined {
  return db.prepare("SELECT * FROM team_bootstraps WHERE repository = ?").get(repository) as Bootstrap | undefined;
}

/** One owner database has one Create lane, including overlapping requests for the same name. */
const creates = new WeakMap<Database.Database, Promise<void>>();
export function bootstrapProject(db: Database.Database, input: ProjectInput, options: {
  github: GithubCli; leadClient: TeamClient;
}): Promise<Team> {
  const result = (creates.get(db) ?? Promise.resolve()).then(() => performBootstrap(db, input, options));
  const settled = result.then(() => {}, () => {});
  creates.set(db, settled);
  void settled.then(() => { if (creates.get(db) === settled) creates.delete(db); });
  return result;
}

async function performBootstrap(db: Database.Database, input: ProjectInput, options: {
  github: GithubCli; leadClient: TeamClient;
}): Promise<Team> {
  const repository = projectFolder(input.repository);
  let state = readBootstrap(db, repository);
  if (state?.step === "push") throw teamExists();
  let inspection = await inspectProject(input, undefined, state);
  if (!state && inspection.origin) return createTeam(db, { repository, name: input.name, leadClient: options.leadClient });
  if (!state?.team_id) availableTeamName(db, repository, input.name);
  if (state && state.name !== input.name) {
    if (state.remote_url || inspection.origin) throw new ProjectBootstrapError("team_bootstrap_changed", "Retry with the project name recorded when its remote was created.");
    state.name = input.name;
  }
  const save = () => {
    db.prepare(`INSERT INTO team_bootstraps (repository, name, lead_client, github_login, step, commit_oid, branch_ref, remote_url, team_id, last_error_code)
      VALUES (@repository, @name, @lead_client, @github_login, @step, @commit_oid, @branch_ref, @remote_url, @team_id, @last_error_code)
      ON CONFLICT(repository) DO UPDATE SET name = excluded.name, step = excluded.step,
      commit_oid = excluded.commit_oid, branch_ref = excluded.branch_ref, remote_url = excluded.remote_url,
      team_id = excluded.team_id, last_error_code = excluded.last_error_code`).run(state!);
  };
  const checkpoint = (step: Bootstrap["step"]) => { state!.step = step; state!.last_error_code = null; save(); };
  try {
    if (!state?.commit_oid) {
      const account = await options.github.account();
      if (state && state.github_login !== account.login) throw new GithubCliError("github_not_signed_in");
      // Authentication is asynchronous; inspect again before making a local snapshot.
      inspection = await inspectProject(input, undefined, state);
      if (!state && inspection.origin) return createTeam(db, { repository, name: input.name, leadClient: options.leadClient });
      state ??= { repository, name: input.name, lead_client: options.leadClient, github_login: account.login,
        step: "pending", commit_oid: null, branch_ref: null, remote_url: null, team_id: null, last_error_code: null };
      save();
      mkdirSync(repository, { recursive: true });
      checkpoint("folder");
      if (!gitValue(repository, ["rev-parse", "--show-toplevel"])) git(repository, ["init", "--quiet", "--initial-branch=main", "--template="]);
      checkpoint("init");
      if (!inspection.head && !existsSync(join(repository, ".gitignore"))) {
        writeFileSync(join(repository, ".gitignore"), DEFAULT_IGNORE_FILE, { flag: "wx" });
      }
      checkpoint("ignore");
      state.branch_ref = gitValue(repository, ["symbolic-ref", "--quiet", "HEAD"]);
      if (!state.branch_ref) throw new ProjectBootstrapError("team_branch_required", "Switch to a local branch before creating its remote.");
      state.commit_oid = inspection.head ?? await initialCommit(repository, state.branch_ref, inspection.files, account);
      checkpoint("commit");
    }
    const expectedOrigin = `https://github.com/${state.github_login}/${state.name}.git`;
    const origin = gitValue(repository, ["config", "--get", "remote.origin.url"]);
    if (origin !== null && origin !== (state.remote_url ?? expectedOrigin)) throw originChanged();
    if (!state.remote_url) {
      // gh may have installed origin before the process or database checkpoint was interrupted.
      if (!origin) await options.github.createPrivateRepository(state.name, repository, state.github_login);
      if (gitValue(repository, ["config", "--get", "remote.origin.url"]) !== expectedOrigin) throw originChanged();
      state.remote_url = expectedOrigin;
      checkpoint("repo");
    }
    await options.github.push(repository, state.remote_url, `${state.commit_oid}:${state.branch_ref}`, state.github_login);

    // KTD12: create the team row only after a successful push. Leave no normal
    // team row when the remote or upload fails.
    if (!state.team_id) {
      const team = createTeam(db, { repository, name: state!.name, leadClient: state!.lead_client });
      state!.team_id = team.id;
      save();
    }
    checkpoint("push");
    return listTeams(db).find(team => team.id === state!.team_id)!;
  } catch (error) {
    const failure = error instanceof GithubCliError || error instanceof ProjectBootstrapError || error instanceof TeamSetupError
      ? error : new ProjectBootstrapError("team_bootstrap_failed", "Project setup did not finish. Retry Create to continue from its last checkpoint.");
    if (state) { state.last_error_code = failure.code; save(); }
    throw failure;
  }
}

/** A regular file's bytes, read off the event loop, for the one name a batch cannot carry. */
async function readFileBytes(path: string): Promise<Buffer> {
  try { return await readFile(path); } catch {
    throw new ProjectBootstrapError("team_bootstrap_failed", "The project's files could not be read for its initial snapshot.");
  }
}

/**
 * Build the initial snapshot and point the branch at it.
 *
 * KTD12 — one bounded external operation. Git hashes every accepted file in one
 * `hash-object --stdin-paths` process and reads each of them from the working tree itself, so this
 * module never holds a regular file's bytes and the work does not scale with one process per file.
 * The two contents Git cannot take from a path — a symlink's target and the default ignore file —
 * are written from memory and joined into the same index.
 *
 * Windows is asked for `100644` explicitly: NTFS reports no executable bit, so the index-info
 * entry is the only place the mode is decided, and `core.fileMode=false` in the owner's
 * configuration cannot change it. `update-index --index-info` (rather than `--add --stdin`) is
 * used for exactly that reason, and `write-tree` then records the modes unchanged.
 */
async function initialCommit(repository: string, branch: string, files: ProjectEntry[], account: GithubAccount): Promise<string> {
  const temporary = mkdtempSync(join(tmpdir(), "project-commit-"));
  const index = join(temporary, "index"), env = { GIT_INDEX_FILE: index };
  try {
    await gitAsync(repository, ["read-tree", "--empty"], { env });
    // `--stdin-paths` takes one path per line and has no NUL-separated form, so a POSIX name that
    // contains a newline cannot be expressed there. Such a name is hashed on its own instead; NTFS
    // forbids the character, so a Windows project never takes that branch.
    const fromPaths = files.flatMap(file => file.kind === "file" && !file.path.includes("\n") ? [file.path] : []);
    const oids = new Map<string, string>();
    if (fromPaths.length) {
      const hashed = await gitAsync(repository, ["hash-object", "-w", "--stdin-paths", "--no-filters"],
        { input: fromPaths.join("\n") + "\n" });
      const lines = hashed.split("\n").filter(Boolean);
      // Git answers in request order, one object id per line. A count that disagrees would pair a
      // path with another file's content, so the snapshot is refused instead of misbuilt.
      if (lines.length !== fromPaths.length) {
        throw new ProjectBootstrapError("team_bootstrap_failed", "The project's files could not be read for its initial snapshot.");
      }
      fromPaths.forEach((path, position) => oids.set(path, lines[position]!.trim()));
    }
    for (const file of files) {
      if (oids.has(file.path)) continue;
      // A symlink's target and the default ignore file are written from memory; a regular file
      // only reaches here when its name could not be sent in a batch.
      const content = file.kind === "file" ? await readFileBytes(join(repository, file.path))
        : Buffer.from(file.kind === "link" ? file.target : file.data);
      oids.set(file.path, (await gitAsync(repository, ["hash-object", "-w", "--stdin"], { input: content })).trim());
    }
    const entries = files.map(file => `${file.mode} ${oids.get(file.path)!}\t${file.path}\0`).join("");
    await gitAsync(repository, ["update-index", "-z", "--index-info"], { env, input: entries });
    const tree = (await gitAsync(repository, ["write-tree"], { env })).trim();
    const name = gitValue(repository, ["config", "--get", "user.name"]) ?? account.name;
    const email = gitValue(repository, ["config", "--get", "user.email"]) ?? account.email;
    const oid = git(repository, ["-c", "commit.gpgsign=false", "commit-tree", tree, "-m", "Initial project snapshot"], {
      env: { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email },
    }).trim();
    git(repository, ["-c", "core.hooksPath=/dev/null", "update-ref", branch, oid, ""]);
    // A pre-existing index belongs to the owner, including any pre-staged credentials.
    // Only a repository with no index receives the newly constructed snapshot index.
    const ownerIndex = resolve(repository, git(repository, ["rev-parse", "--git-path", "index"]).trim());
    try { copyFileSync(index, ownerIndex, constants.COPYFILE_EXCL); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return oid;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function directoryRoots(): string[] {
  const roots = [canonicalPath(homedir())];
  if (process.platform === "win32") {
    // R15 — the Windows counterpart of `/mnt/<drive>`: the drive the owner's home is on, then
    // every other fixed drive that exists. Removable and network drives are not browsed by
    // default; a project there is reachable by typing the path, which `projectFolder` accepts.
    const home = roots[0]!;
    const homeDrive = /^[A-Za-z]:/.exec(home)?.[0];
    for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZAB") {
      if (homeDrive && `${letter}:`.toLowerCase() === homeDrive.toLowerCase()) continue;
      const drive = `${letter}:\\`;
      if (existsSync(drive)) roots.push(drive);
    }
  } else if (existsSync("/mnt")) for (const entry of readdirSync("/mnt", { withFileTypes: true })) {
    if (/^[a-z]$/i.test(entry.name) && entry.isDirectory()) roots.push(canonicalPath(join("/mnt", entry.name)));
  }
  return roots;
}

export function listProjectDirectories(path?: string, roots = directoryRoots()): {
  roots: string[]; path: string | null; directories: Array<{ name: string; path: string }>;
} {
  if (!path) return { roots, path: null, directories: roots.map(root => ({ name: basename(root) || root, path: root })) };
  if (!isAbsolute(path)) throw refusedFolder();
  // Canonicalise before matching a root: a Windows path may arrive in its 8.3 spelling while the
  // root is the long one, and the containment test is a string comparison.
  let folder: string;
  try { folder = canonical(path); } catch { throw refusedFolder(); }
  // A root the owner may browse is the home or a drive/share; the comparison folds case only
  // where the filesystem does, so `c:\users\leo` and `C:\Users\leo` are one place on Windows.
  const root = roots.find(root => pathWithin(root, folder));
  if (!root || !pathWithin(root, folder) || !statSync(folder).isDirectory()) throw refusedFolder();
  const directories = readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return [];
    try {
      const child = canonical(join(folder, entry.name));
      return pathWithin(root, child) && statSync(child).isDirectory() ? [{ name: entry.name, path: child }] : [];
    } catch { return []; }
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { roots, path: folder, directories };
}
