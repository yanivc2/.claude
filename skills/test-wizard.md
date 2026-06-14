---
name: "test-wizard"
description: "A skill to automatically design, write, and verify unit tests for code in the workspace. Auto-detects the project language, framework (Jest, PyTest, JUnit, Vitest, Cypress, Playwright), and generates tests covering normal execution, edge cases, error handling, and mock assertions."
---

# Test Wizard Skill

A specialized skill to automatically generate high-quality unit and integration tests.

## Description

The `test-wizard` skill analyzes your source code files, identifies testable functions, classes, and logic blocks, detects the active testing framework, and generates clean, standard-compliant test suites.

**What this skill does:**
1. **Detects Frameworks:** Looks at `package.json`, `requirements.txt`, or folder structures to identify the testing framework (e.g. Jest, Vitest, PyTest, JUnit, Playwright, Cypress).
2. **Identifies Code Seams:** Finds dependencies, API calls, and complex logic that need to be mocked or stubbed.
3. **Generates Tests:** Writes test cases covering positive paths, negative paths, boundary values, error scenarios, and mock verification.
4. **Validates Tests:** Recommends running the appropriate test execution commands.

## Code Testing Guidelines

- **Isolate the Code Under Test:** Mock external systems, database calls, and network requests to ensure tests are fast and reliable.
- **Clear Test Structure (AAA Pattern):**
  - **Arrange:** Set up preconditions, inputs, and mocks.
  - **Act:** Execute the code under test.
  - **Assert:** Verify output values, state changes, or mock invocations.
- **Coverage of Edge Cases:** Focus on null inputs, empty lists, extreme numbers, network timeouts, and rejected promises.
- **Descriptive Names:** Write test names that clearly describe the expected behavior (e.g., `should return 400 when email is invalid` or `test_should_raise_value_error_for_negative_input`).

## Example Workflow

1. **Analyze:** Inspect the target file structure and imports.
2. **Detect:** Determine the testing tools configured in the project.
3. **Draft:** Produce the test suite code.
4. **Review:** Ensure correct imports and mock structures are implemented.
