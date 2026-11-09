import { existsSync, readFileSync } from "node:fs";
import { relativePath } from "../contracts/team-control.js";

const credentialConfigUrl = [
  new URL("../../../../config/governance/credential-exclusions.json", import.meta.url),
  new URL("../../config/governance/credential-exclusions.json", import.meta.url),
].find(url => existsSync(url));
if (!credentialConfigUrl) throw new Error("credential exclusion policy is missing");
const credentialPatterns: RegExp[] = JSON.parse(readFileSync(credentialConfigUrl, "utf8")).patterns
  .map((pattern: string) => new RegExp(pattern));
export const credentialExcluded = (path: string): boolean => credentialPatterns.some(pattern => pattern.test(path));

export const protectedPath = (path: string) =>
  /^(docs\/(?:plans|tasks)|engine\/config\/(?:isolation|governance))(\/|$)/.test(path)
  || /(^|\/)(contracts|migrations|\.github|\.circleci|\.buildkite|\.husky)(\/|$)/.test(path)
  || /(^|\/)(?:all-migrations\.ts|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?)$/.test(path)
  || /(^|\/)(?:Cargo\.(?:toml|lock)|pyproject\.toml|(?:poetry|uv)\.lock|requirements[^/]*\.txt|go\.(?:mod|sum)|Gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|pnpm-workspace\.ya?ml|\.yarnrc\.ya?ml)$/.test(path)
  || /(^|\/)(?:Jenkinsfile|(?:\.gitlab-ci|azure-pipelines|\.travis|\.?appveyor|bitbucket-pipelines|\.?drone|cloudbuild)\.ya?ml)$/.test(path)
  || /^engine\/packages\/daemon\/src\/(?:index\.ts|startup\.ts|server\.ts|domain\/(?:plan-governance|queue-repository|workflow-runtime|binding-scope|scope-extension)\.ts|adapters\/(?:tmux\.ts|worker-launch[^/]*\.ts)|middleware\/|routes\/team-control\.ts)/.test(path)
  || credentialExcluded(path);

/** A project-root grant covers ordinary paths; explicit owner scopes retain their exact meaning. */
export function bindingCovers(path: string, scopes: readonly string[]): boolean {
  try { relativePath(path, "scope.path"); } catch { return false; }
  return scopes.some(scope => scope === "." ? !protectedPath(path) : path === scope || path.startsWith(scope + "/"));
}
