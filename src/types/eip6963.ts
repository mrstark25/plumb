import type { EIP1193Provider } from 'viem';

export interface EIP6963ProviderInfo {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly rdns: string;
}

export interface EIP6963ProviderDetail {
  readonly info: EIP6963ProviderInfo;
  readonly provider: EIP1193Provider;
}

declare global {
  interface WindowEventMap {
    'eip6963:announceProvider': CustomEvent<EIP6963ProviderDetail>;
  }
}
