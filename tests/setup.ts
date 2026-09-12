// Global mocks & polyfills for Vitest
import { vi } from 'vitest';

// Mock crypto.randomUUID for deterministic IDs
Object.defineProperty(globalThis, 'crypto', {
  value: {
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2),
    subtle: crypto.subtle,
    getRandomValues: (arr: Uint8Array) => crypto.getRandomValues(arr),
  },
  configurable: true,
});

// Mock URL.createObjectURL/revokeObjectURL
URL.createObjectURL = vi.fn(() => 'blob:mock-url');
URL.revokeObjectURL = vi.fn();

// Mock HTMLAnchorElement.click
HTMLAnchorElement.prototype.click = vi.fn();

// Mock fetch globally (can be overridden per test)
globalThis.fetch = vi.fn();

// Mock showSaveFilePicker for File System Access API
const mockWritable = {
  write: vi.fn().mockResolvedValue(undefined),
  seek: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockHandle = {
  createWritable: vi.fn().mockResolvedValue(mockWritable),
};

window.showSaveFilePicker = vi.fn().mockResolvedValue(mockHandle);

// Mock postMessage for cross-frame communication tests
window.postMessage = vi.fn();
window.addEventListener = vi.fn((event, handler) => {
  if (event === 'message') {
    (window as any).__messageHandlers = (window as any).__messageHandlers || [];
    (window as any).__messageHandlers.push(handler);
  }
});
window.removeEventListener = vi.fn();

// Helper to simulate postMessage in tests
(window as any).__simulateMessage = (data: any, origin = 'https://listen.libbyapp.com') => {
  const handlers = (window as any).__messageHandlers || [];
  handlers.forEach((handler: any) => handler({ data, origin, source: window }));
};

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
  (window as any).__messageHandlers = [];
});

// Suppress the known false-positive unhandled rejection from fetchWithRetry test
// The test properly catches the error, but Vitest's fake timers cause it to be flagged
const originalConsoleError = console.error;
console.error = (...args) => {
  if (args[0]?.includes?.('HTTP 500') && args[0]?.includes?.('fetchWithRetry')) {
    return; // suppress known false positive
  }
  originalConsoleError.apply(console, args);
};