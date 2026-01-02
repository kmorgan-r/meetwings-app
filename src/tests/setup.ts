import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Cleanup after each test case (React Testing Library)
afterEach(() => {
  cleanup();
});

// Mock Web Audio API (not available in test environment)
// Use function syntax for proper constructor mocking
global.AudioContext = function (this: any) {
  this.decodeAudioData = vi.fn();
  this.createBuffer = vi.fn();
  this.createBufferSource = vi.fn();
  this.destination = {};
  this.sampleRate = 44100;
  this.state = 'running';
  this.close = vi.fn();
} as any;

// Mock window.AudioContext for browsers
(global as any).window = global.window || {};
(global.window as any).AudioContext = global.AudioContext;
(global.window as any).webkitAudioContext = global.AudioContext;

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn(),
};
global.localStorage = localStorageMock as any;

// Mock performance.now() for consistent timing in tests
let performanceNow = 0;
global.performance = {
  now: vi.fn(() => {
    performanceNow += 10; // Each call adds 10ms
    return performanceNow;
  }),
} as any;
