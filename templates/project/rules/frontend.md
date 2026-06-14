# Frontend

## React Components

- One component per file. File name matches the component name.
- Keep components under ~150 lines — extract subcomponents or custom hooks if larger.
- Props interface defined in the same file, just above the component.
- No prop drilling beyond 2 levels — use Context or a state manager.
- Avoid `React.FC` — use plain function declarations with typed props.

```tsx
// preferred
function UserCard({ name, email }: UserCardProps) { ... }

// avoid
const UserCard: React.FC<UserCardProps> = ({ name, email }) => { ... }
```

## Hooks

- Extract logic into custom hooks when a component has more than one `useEffect` or complex derived state.
- Custom hook files: `use` prefix, `camelCase` (`useAuthSession.ts`).
- Never call hooks conditionally or inside loops.
- `useEffect` must have a complete dependency array. If lint warns, fix the dependency — don't suppress it.
- Avoid `useEffect` for derived state — compute it inline or with `useMemo`.

## State

- Keep state as close to where it's used as possible — lift only when necessary.
- Prefer `useReducer` over multiple related `useState` calls when state transitions are complex.
- Server state (fetched data) belongs in a data-fetching library (React Query, SWR, Next.js cache) — not in `useState`.

## Accessibility

- Always use semantic HTML: `<button>` for actions, `<a>` for navigation, `<nav>`, `<main>`, `<section>` etc.
- Interactive elements must be keyboard accessible (focus ring visible, `Enter`/`Space` fire the action).
- Images must have descriptive `alt` text. Decorative images: `alt=""`.
- Form inputs must have associated `<label>` (via `htmlFor` or wrapping).
- Use `aria-label` only when visible text isn't available — prefer visible labels.
- Color contrast must meet WCAG AA (4.5:1 for text, 3:1 for UI components).

## CSS / Styling

- [Tailwind / CSS Modules / styled-components — fill in your choice and remove the others]
- No inline styles except for truly dynamic values (e.g., `style={{ width: progress + '%' }}`).
- Design tokens (colors, spacing, radii) live in one place — don't hardcode hex values.
- Mobile-first breakpoints. Start with the small viewport, add larger overrides.
- Avoid `z-index` values above 50 without documenting why in a comment.

## Images & Media

- Always use `next/image` (or framework equivalent) for optimized loading.
- Provide `width` and `height` to prevent layout shift.
- Use `loading="lazy"` for images below the fold.
- Prefer SVG for icons; use an icon component system rather than ad-hoc inline SVGs.

## Error & Loading States

Every data-dependent UI must handle three states explicitly:
1. **Loading** — skeleton, spinner, or placeholder
2. **Error** — user-friendly message + retry action where applicable
3. **Empty** — intentional empty state, not just "nothing rendered"

Never leave a component that silently renders nothing on error.
