# Performance

> **Applies to:** adding dependencies, bundle/build work, rendering hot paths, and image-heavy UI.

## Bundle Size

- Check bundle impact before adding any dependency: `npm run build` and inspect the output, or use `bundlephobia.com`.
- Prefer smaller focused packages over large ones (e.g., `date-fns` over `moment`, `zod` over `yup`).
- Never import an entire library when you need one function: `import { debounce } from 'lodash-es'` not `import _ from 'lodash'`.
- Tree-shaking only works with ES modules — avoid CJS-only packages where possible.

## Code Splitting

- Lazy-load route-level components: `const Page = lazy(() => import('./Page'))`.
- Heavy components (rich text editors, charts, map libraries) must be lazy-loaded.
- Never lazy-load components that appear above the fold on first load — it causes visible pop-in.

## Rendering

- Avoid unnecessary re-renders:
  - Don't create new objects/arrays/functions inline in JSX props if the child is memoized.
  - `useMemo` and `useCallback` are not free — only use them when you have a measured problem or a stable reference is required (e.g., passing to a memoized child or `useEffect` dependency).
- Avoid reading from the DOM in a render cycle (`getBoundingClientRect`, `scrollTop`) — use `useLayoutEffect` if unavoidable.
- Lists with 50+ items should be virtualized (`react-virtual`, `tanstack-virtual`).

## Images

- Use next-gen formats (WebP, AVIF).
- Always provide `width` and `height` to prevent Cumulative Layout Shift (CLS).
- Hero images: `fetchpriority="high"`, `loading="eager"`. All others: `loading="lazy"`.

## Web Vitals Targets

| Metric | Target |
|---|---|
| LCP (Largest Contentful Paint) | < 2.5s |
| CLS (Cumulative Layout Shift) | < 0.1 |
| INP (Interaction to Next Paint) | < 200ms |

Measure with Lighthouse CI or the browser DevTools Performance panel before shipping features that change the critical rendering path.
