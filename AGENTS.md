# Repository instructions

- Preserve the boundary between deterministic Regraft operations and Regrafter orchestration.
- Do not add model tools for Regraft operations. Regrafter must call the `regraft` executable through `bash`.
- Keep app-bundle resources rooted in this package and repository tools rooted in the selected target repository.
- Do not release a repository lease because time passed. Resume and abort require repository-state verification.
- Keep controller input and output schemas strict and versioned.
- Do not persist request or decision file contents in the run index.
- Do not store or copy credentials. Redact credential-bearing URLs from reports and logs.
- Never amend, squash, drop, or rewrite pristine Regraft base commits.
- Run `npm run check` and `npm run mutate` before opening or updating a pull request.
