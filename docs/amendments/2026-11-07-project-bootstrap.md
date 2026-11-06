# Project bootstrap and lead-only planning

This amendment records U2 implementation decisions for R2, R3, KTD3 and the
command-center plan dated 2026-11-06. It leaves that source plan unchanged.

## Preview and snapshot

- Named creation keeps the planned `{ repository, name }` request. `dryRun: true`
  is informational, not a digest-bound approval of immutable bytes. Creation
  inspects the folder again after authentication and before taking its snapshot.
- Preview leaves the selected folder and database unchanged. It uses disposable
  Git metadata outside that folder to apply Git's ignore semantics, then removes
  it. The plan's "nothing on disk" wording means no changes to the selected
  project; it is not a claim of zero temporary filesystem writes.
- A first commit is assembled through a temporary index. Existing owner index
  bytes and working files stay unchanged. Advancing an unborn branch changes the
  index's comparison baseline, so this does not promise an unchanged displayed
  staged diff.
- If commits already exist, creation pushes the selected commit and its reachable
  history, not a new commit of dirty work. Credential-policy paths in any reachable
  tree stop the upload, even if a later commit deleted them. Shallow history needs
  a complete fetch before this check can pass. This is path-policy enforcement,
  not arbitrary secret-content detection.
- An existing origin is registered without creating a repository or pushing.
  The legacy explicit-seat request remains available.

## Checkpoints and private upload

- Repository creation and push are separate operations so a failed push retains
  the recorded team, origin, commit and target branch. Retry uses those identities
  and leaves later owner work local. The upload verifies private visibility and
  repository identity immediately before pushing; no other branches or tags are
  requested. Git resolves the named origin's effective push destinations, including
  `insteadOf`, `pushInsteadOf` and explicit push URLs, before transport. Only one
  destination equal to the checked HTTPS URL is accepted; owner configuration is
  unchanged. Mirror mode, automatic tags and recursive submodule pushes are disabled
  for this operation. Even a same-repository protocol rewrite is left pending: this
  path deliberately uses the scoped HTTPS credential rather than an SSH identity.
- Create requests share one lane per owner database. The receipt records the
  original account and lead client, and a changed origin stops the retry. A name
  conflict before remote creation leaves no team and permits a different name.
- An origin installed before its database checkpoint can be recovered. An
  interruption inside remote creation before origin installation remains an
  ambiguous external outcome: an empty remote may exist without a local receipt
  identifying it. Automatic recovery of that case is not claimed.
- Migration 117 contains bootstrap state and the seat retirement field reserved
  for U3; it is registered in both production and full-fixture migration lists.

## Lead-only planning and compatibility

- New projects get one lead using `team.leadClient`, defaulting to `claude-code`.
  Planning accepts an empty member roster; delivery still requires an implementer.
- The lead context records the explicit planning or delivery phase. Resuming a
  legacy nonempty lead context may omit only this newly introduced field, and
  only when the complete reconstructed hash exactly matches the same attempt's
  saved receipt. New empty-roster planning contexts retain their phase. Projection
  integrity and the launcher's identity/hash checks remain unchanged.
