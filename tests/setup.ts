import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without `globals`, so Testing Library cannot register its own auto-cleanup.
// Without this, each test's DOM leaks into the next and queries match duplicates.
afterEach(cleanup);
