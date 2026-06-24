'use client';

import { createContext } from 'react';

import type { WalletMode } from './wallet-mode';
import type { WalletSource } from './wallet-source';

/**
 * Shared Context for the active wallet source.
 *
 * Lives in its own file so the dev-mode and Privy-mode providers can
 * both publish into it without a circular import (the Privy provider
 * is loaded lazily, and dropping the Context into `wallet-source-
 * providers.tsx` would force the lazy chunk to import its own
 * loader).
 */

export interface WalletSourceContextValue {
  source: WalletSource | null;
  ready: boolean;
  mode: WalletMode;
  connectWallet: () => Promise<WalletSource>;
  disconnectWallet: () => Promise<void>;
}

export const WalletSourceContext = createContext<WalletSourceContextValue | null>(null);
