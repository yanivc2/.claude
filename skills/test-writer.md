---
description: Write tests for existing code — unit tests for utilities, component tests for React components, and edge case coverage. Pass a file path or function name.
---

When this skill is invoked:

## Step 1 — Identify what to test

If the user passed a file path or function name, use it.
If not, ask: "איזה קוד תרצה שאכסה בטסטים?"

Read the target file. Also check if a test file already exists (look for `<name>.test.ts`, `<name>.test.tsx`, `__tests__/<name>.test.ts`).

## Step 2 — Understand what to test

Read the code and identify:
- **Exported functions/components** — these are the public API to test
- **Input/output pairs** — what inputs produce what outputs?
- **Edge cases** — empty input, null, zero, very large, boundary values
- **Error paths** — what throws, what rejects, what renders an error state?
- **Side effects** — what does this change externally?

Do NOT test:
- Implementation details (private functions, internal state shape)
- Framework internals (React re-render counts, routing internals)
- Code already covered by third-party library tests

## Step 3 — Determine test type

**Pure utility function** → Vitest/Jest unit test
**React component** → React Testing Library component test
**API route / server function** → integration test with real or mock DB
**Critical user journey** → note that E2E (Playwright) would be better, offer to scaffold it

Check the project for existing test setup: look for `vitest.config.*`, `jest.config.*`, existing test files to match the pattern.

## Step 4 — Write the tests

Use AAA structure:
```ts
it('describes user-visible behavior, not function names', async () => {
  // Arrange — set up data, mocks, render
  // Act — call the function or interact with the component
  // Assert — verify the outcome
})
```

Rules:
- Test names describe behavior: "returns empty array when input is empty" not "getItems works"
- One logical assertion per test (multiple expects are fine if they verify the same behavior)
- Use `userEvent` over `fireEvent` for component tests
- Mock at the network boundary (MSW) not at the module level
- Use `screen.getByRole`, `getByLabelText` — not `getByTestId` unless unavoidable

Write tests for:
1. The happy path
2. Each meaningful edge case
3. Each error path

## Step 5 — Write to file

Write to the test file (create if it doesn't exist, append if it does).
After writing, read it back to verify it looks correct.
Tell the user how to run it: `npm test` / `npx vitest <file>`.
