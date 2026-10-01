These are the default conventions for fixing the findings in this report. Follow them unless the codebase already has an established, conflicting convention; in that case match the codebase and say so in your summary.

### G0. Failing tests come first

- If Section 5 shows failing tests or test files that could not run, fix those before anything else. Coverage from a failing run under-reports, so later findings may disappear once the suite is green.

### G1. Large files and long functions: extract by responsibility

- Split a large module into smaller modules that each own one responsibility, named for what they do (`parseInvoice.ts`, `invoiceTotals.ts`), not `utils2.ts`. Re-export from the original path if other code imports it, so callers do not change.
- Extract long functions into smaller named functions. Prefer pure functions (input → output, no hidden state) because they are trivially testable.
- Keep collaborators replaceable: pass dependencies in as parameters or a `deps` object (or constructor arguments if the codebase uses classes) rather than importing singletons deep inside logic. Tests can then pass fakes without module mocking.
- Match the codebase's style: plain functions if it uses functions, classes if it uses classes. Do not introduce a new pattern (DI container, class hierarchy) just for the refactor.
- Write tests for each extracted module and update the original module's tests.

### G2. Too many parameters: use an options object

- Replace long positional parameter lists (more than about 4) with a single options object and destructure it in the signature: `function createUser({ name, email, role = 'member' })`.
- In TypeScript, declare the shape as a named `interface` or `type` next to the function (or in the module's types file if one exists).
- Keep defaults in the destructuring rather than in the body.

### G3. Deep nesting and high cyclomatic complexity

Pick whichever of these leaves the code easiest to read, and combine them when that helps:

- Guard clauses and early returns for validation and special cases.
- Lookup tables (`const handlers = { a: handleA, b: handleB }`) instead of long `switch`/`if-else` chains on the same value.
- Extract complex conditions into well-named predicate functions (`isEligibleForRefund(order)`).
- Move a self-contained block of branching logic into its own function or module (G1) when it is a unit of work in its own right.

Do not leave a long chain of nested conditionals in place just because each branch is short; the depth itself is the problem.

### G4. Low or missing test coverage

- Use the project's existing test runner, file naming and layout (Section 4.1 shows them; Section 2 suggests a path when a file has no test). Do not add a second test framework.
- Test behaviour through the module's public exports. Mock only at boundaries (network, filesystem, timers, randomness) using the runner's facilities (`vi.mock`/`vi.fn`, `jest.mock`/`jest.fn`, `node:test` mocks) or injected fakes.
- Start with the functions listed as "never called by tests", then the uncovered lines and branches.
- Assert on outcomes, not implementation details. Each test should fail if the behaviour it names breaks.

### G5. Complex and untested code (highest priority)

- Before refactoring, write characterization tests that pin the current observable behaviour, including odd edge cases. The goal is a safety net, not an endorsement of the behaviour.
- Then apply G1 to G3, and extend the tests to cover the new modules and functions.

### Data-heavy files

- A file flagged DataHeavy (high FTA score, low cyclomatic) is usually lookup tables, constants or configuration. Leave it alone unless it also mixes in logic; moving data around only to lower a score adds churn without value.

### General

- Preserve public behaviour; refactors must not change observable results.
- Batch the work: group several related hotspots into one commit (for example, everything in one module or one feature area, or all the new tests for a directory). Do not make one commit per hotspot.
- Commit messages are a single summary line with no body (trailers such as `Co-Authored-By` are fine).
- Run the project's tests, type-checker and linter after each batch.
- Re-run the analysis after the changes to confirm the findings are gone.
