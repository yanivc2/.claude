# Testing

> **Applies to:** writing or changing tests — unit, component, or E2E. Consult before adding a test file or a new test dependency.

## Framework

Use **{{TEST_RUNNER}}** (e.g. Vitest or Jest). Never introduce a second test runner.
Component tests: **{{COMPONENT_TEST_LIB}}** (e.g. React Testing Library). E2E: **{{E2E_RUNNER}}** (e.g. Playwright or Cypress).

## What to Test

- **Unit test**: pure utility functions, complex business logic, edge-case branches.
- **Component test**: user-visible behavior — what the user sees and does, not implementation details.
- **E2E test**: critical user journeys (sign-up, checkout, primary feature flow).

Do not test:
- Framework internals (React re-renders, routing internals).
- Implementation details (private functions, internal state shape).
- Code that is already covered by third-party library tests.

## Structure (AAA)

```ts
it('shows error message when login fails', async () => {
  // Arrange
  server.use(http.post('/api/login', () => HttpResponse.json({ error: 'Invalid credentials' }, { status: 401 })))

  // Act
  render(<LoginForm />)
  await userEvent.type(screen.getByLabelText('Email'), 'user@example.com')
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }))

  // Assert
  expect(screen.getByRole('alert')).toHaveTextContent('Invalid credentials')
})
```

## Conventions

- Test files: co-located with source (`UserCard.test.tsx` next to `UserCard.tsx`), or in `__tests__/`.
- Test names: describe user behavior, not function names. `'shows error when...'` not `'handleSubmit throws'`.
- One logical assertion per test. Multiple `expect` calls are fine when they verify the same behavior.
- Use `userEvent` over `fireEvent` — it simulates real browser interactions.
- Don't test styles (class names). Test visibility, text content, and ARIA attributes.
- Mock at the network boundary (MSW), not at the module level, unless unavoidable.

## Coverage

- 100% coverage is not the goal — confidence is.
- Every bug fix should come with a regression test.
- Run the full suite before opening a PR.
