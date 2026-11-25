'use client';

import { useSyncExternalStore } from 'react';
import { A2uiSurface, MarkdownContext } from '@a2ui/react';
import { renderMarkdown } from '@a2ui/markdown-it';
import { injectBasicCatalogStyles } from '@a2ui/web_core/catalogs/basic/v1';
import type { MessageProcessor } from '@a2ui/web_core';
import type { ReactCatalogComponent } from '@a2ui/react';

injectBasicCatalogStyles();

export interface SurfaceHost {
  processor: MessageProcessor<ReactCatalogComponent>;
  subscribe: (listener: () => void) => () => void;
  getVersion: () => number;
  getSurface: (id: string) => ReturnType<MessageProcessor<ReactCatalogComponent>['getSurface']>;
}

export function useHostVersion(host: SurfaceHost): number {
  return useSyncExternalStore(host.subscribe, host.getVersion, host.getVersion);
}

export function SurfaceView({ host, surfaceId }: { host: SurfaceHost; surfaceId: string }) {
  useHostVersion(host);
  const surface = host.getSurface(surfaceId);
  if (!surface) return null;
  return (
    <MarkdownContext.Provider value={renderMarkdown}>
      <div className="a2ui-surface">
        <A2uiSurface surface={surface} />
      </div>
    </MarkdownContext.Provider>
  );
}
