import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type Database from "better-sqlite3";
import { credentialExcluded } from "./scope-extension.js";
import { GithubCliError, type GithubAccount, type GithubCli } from "./github-cli.js";
import { availableTeamName, createTeam, listTeams, TeamSetupError, type Team, type TeamClient } from "./team-setup.js";

const DEFAULT_IGNORES = ["node_modules/", "dist/", "build/", "coverage/", ".env*", "*.pem", "*.key",
  ".config/", ".ssh/", ".aws/", ".codex/", ".claude/", ".npmrc", ".netrc", "credentials*"];
const DEFAULT_IGNORE_FILE = DEFAULT_IGNORES.join("\n") + "\n";

export class ProjectBootstrapError extends Error {
  constructor(readonly code: string, message: string, readonly excludedPaths: string[] = []) {
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
interface ProjectFile { path: string; mode: string; data: Buffer }
interface ProjectInspection {
  preview: ProjectPreview;
  files: ProjectFile[];
  head: string | null;
  origin: string | null;
}
interface Bootstrap {
  repository: string; name: string; lead_client: TeamClient; github_login: string;
  step: "pending" | "folder" | "init" | "ignore" | "commit" | "repo" | "push";
  commit_oid: string | null; branch_ref: string | null; remote_url: string | null;
  team_id: string | null; last_error_code: string | null;
}

const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
};
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
  return join(realpathSync(parent), ...suffix);
}

export function projectFolder(repository: string, home = homedir()): string {
  if (!isAbsolute(repository)) throw refusedFolder();
  const root = canonical(repository), ownerHome = canonical(home);
  if (within(root, ownerHome) || dirname(root) === root || /^\/mnt\/[a-z]$/i.test(root)
    || /^\/mnt\/[a-z]\/Users(?:\/[^/]+)?$/i.test(root) || excluded(root)) throw refusedFolder();
  return root;
}

function git(root: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: Buffer | string } = {}): string {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: 60_000, maxBuffer: 16 * 1024 * 1024, input: options.input,
    env: { ...env, LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", ...options.env },
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

function historyExclusions(repository: string, commit: string): string[] {
  if (git(repository, ["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new ProjectBootstrapError("team_history_incomplete", "Fetch the complete repository history before creating its remote.");
  }
  const paths = new Set<string>();
  const trees = new Set(git(repository, ["rev-list", "--format=%T", "--no-commit-header", commit, "--"]).trim().split("\n"));
  for (const tree of trees) for (const path of git(repository, ["ls-tree", "-r", "-z", "--name-only", tree]).split("\0")) {
    if (path && excluded(path)) paths.add(path);
  }
  return [...paths].sort();
}

function inspectProject(input: ProjectInput, home = homedir(), bootstrap?: Bootstrap): ProjectInspection {
  if (!/^[a-z\d][a-z\d_.-]{0,99}$/i.test(input.name)) {
    throw new ProjectBootstrapError("team_name_invalid", "Use a repository name beginning with a letter or number, followed by letters, numbers, dots, underscores or dashes.");
  }
  const repository = projectFolder(input.repository, home);
  let parent = repository;
  while (!existsSync(parent)) parent = dirname(parent);
  const top = gitValue(parent, ["rev-parse", "--show-toplevel"]);
  if (top && realpathSync(top) !== repository) throw refusedFolder();
  if (!top && existsSync(join(repository, ".git"))) {
    throw new ProjectBootstrapError("team_repository_not_git", "The selected folder has unreadable Git metadata.");
  }
  const head = top ? gitValue(repository, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]) : null;
  const origin = top ? gitValue(repository, ["config", "--get", "remote.origin.url"]) : null;
  if (origin && !head) throw new ProjectBootstrapError("team_repository_no_commit", "An existing origin needs a local commit before its team is registered.");
  if (bootstrap?.remote_url && origin !== bootstrap.remote_url) throw originChanged();
  const uploadHead = bootstrap?.commit_oid ?? head;
  const uploads = !!bootstrap || !origin;
  const files: ProjectFile[] = [], excludedPaths = new Set<string>();
  let fileCount = 0;
  if (uploads && uploadHead) {
    const unsafe = historyExclusions(repository, uploadHead);
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
        const paths = git(repository, [...prefix, "ls-files", "--others", "--exclude-standard", "-z", ...patterns])
          .split("\0").filter(Boolean);
        const ignored = git(repository, [...prefix, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", ...patterns])
          .split("\0").filter(Boolean);
        for (const path of [...paths, ...ignored]) {
          if (path !== ".git" && path !== ".git/" && excluded(path)) excludedPaths.add(path);
        }
        for (const path of paths) {
          if (excluded(path)) continue;
          const absolute = join(repository, path), stat = lstatSync(absolute);
          if (stat.isSymbolicLink()) {
            let target: string;
            try { target = realpathSync(absolute); } catch { excludedPaths.add(path); continue; }
            if (!within(repository, target) || excluded(relative(repository, target))) { excludedPaths.add(path); continue; }
            files.push({ path, mode: "120000", data: Buffer.from(readlinkSync(absolute)) });
          } else if (stat.isFile()) {
            files.push({ path, mode: stat.mode & 0o111 ? "100755" : "100644", data: readFileSync(absolute) });
          }
        }
      } finally { rmSync(metadata, { recursive: true, force: true }); }
    }
    if (!existsSync(join(repository, ".gitignore"))) {
      files.push({ path: ".gitignore", mode: "100644", data: Buffer.from(DEFAULT_IGNORE_FILE) });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    fileCount = files.length;
  }
  const preview: ProjectPreview = { repository, name: input.name, action: !uploads ? "register" : uploadHead ? "push" : "create",
    fileCount, excludedPaths: [...excludedPaths].sort() };
  return { preview, files, head, origin };
}

export function previewProject(input: ProjectInput, home = homedir(), db?: Database.Database): ProjectPreview {
  const bootstrap = db ? readBootstrap(db, projectFolder(input.repository, home)) : undefined;
  if (bootstrap?.step === "push") throw teamExists();
  return inspectProject(input, home, bootstrap).preview;
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
  let inspection = inspectProject(input, undefined, state);
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
      inspection = inspectProject(input, undefined, state);
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
      state.commit_oid = inspection.head ?? initialCommit(repository, state.branch_ref, inspection.files, account);
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
    if (!state.team_id) db.transaction(() => {
      const team = createTeam(db, { repository, name: state!.name, leadClient: state!.lead_client });
      state!.team_id = team.id;
      save();
    })();
    await options.github.push(repository, state.remote_url, `${state.commit_oid}:${state.branch_ref}`, state.github_login);
    checkpoint("push");
    return listTeams(db).find(team => team.id === state!.team_id)!;
  } catch (error) {
    const failure = error instanceof GithubCliError || error instanceof ProjectBootstrapError || error instanceof TeamSetupError
      ? error : new ProjectBootstrapError("team_bootstrap_failed", "Project setup did not finish. Retry Create to continue from its last checkpoint.");
    if (state) { state.last_error_code = failure.code; save(); }
    throw failure;
  }
}

function initialCommit(repository: string, branch: string, files: ProjectFile[], account: GithubAccount): string {
  const temporary = mkdtempSync(join(tmpdir(), "project-commit-"));
  const index = join(temporary, "index"), env = { GIT_INDEX_FILE: index };
  try {
    git(repository, ["read-tree", "--empty"], { env });
    const entries = files.map(file => {
      const oid = git(repository, ["hash-object", "-w", "--stdin"], { input: file.data }).trim();
      return `${file.mode} ${oid}\t${file.path}\0`;
    }).join("");
    git(repository, ["update-index", "-z", "--index-info"], { env, input: entries });
    const tree = git(repository, ["write-tree"], { env }).trim();
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
  const roots = [realpathSync(homedir())];
  if (existsSync("/mnt")) for (const entry of readdirSync("/mnt", { withFileTypes: true })) {
    if (/^[a-z]$/i.test(entry.name) && entry.isDirectory()) roots.push(realpathSync(join("/mnt", entry.name)));
  }
  return roots;
}

export function listProjectDirectories(path?: string, roots = directoryRoots()): {
  roots: string[]; path: string | null; directories: Array<{ name: string; path: string }>;
} {
  if (!path) return { roots, path: null, directories: roots.map(root => ({ name: basename(root) || root, path: root })) };
  if (!isAbsolute(path)) throw refusedFolder();
  const root = roots.find(root => within(root, path));
  let canonicalPath: string;
  try { canonicalPath = realpathSync(path); } catch { throw refusedFolder(); }
  if (!root || !within(root, canonicalPath) || !statSync(canonicalPath).isDirectory()) throw refusedFolder();
  const directories = readdirSync(canonicalPath, { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return [];
    try {
      const child = realpathSync(join(canonicalPath, entry.name));
      return within(root, child) && statSync(child).isDirectory() ? [{ name: entry.name, path: child }] : [];
    } catch { return []; }
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { roots, path: canonicalPath, directories };
}
