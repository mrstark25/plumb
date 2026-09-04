import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      // Network adapters are verified by scripts/smoke.mjs against the live
      // APIs; mocking their responses here would only test the mocks. The
      // DefiLlama filtering logic is real logic, so it stays in.
      exclude: [
        'src/lib/providers/uniswap.ts',
        'src/lib/providers/openocean.ts',
        'src/lib/providers/lifi.ts',
        'src/lib/providers/prices.ts',
        'src/lib/providers/http.ts',
        'src/lib/viem.ts',
        'src/lib/client-rpc.ts',
        'src/lib/agent/runner.ts',
        'src/lib/agent/handlers/swap.ts',
        'src/lib/agent/handlers/bridge.ts',
        'src/lib/agent/handlers/portfolio.ts',
        // Network-bound like the other providers; verified by scripts/smoke.mjs
        // against the live API rather than against mocks of it.
        'src/lib/providers/morpho.ts',
        'src/lib/agent/handlers/vault.ts',
        // Network-bound; verified by scripts/smoke.mjs against the live API.
        'src/lib/providers/hyperliquid-info.ts',
        'src/lib/agent/handlers/perps.ts',
        'src/lib/agent/handlers/position.ts',
      ],
    },
  },
});
