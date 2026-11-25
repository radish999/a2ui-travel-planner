/** Server-side A2UI: load the official basic catalog and compile validated model output. */
import path from 'node:path';
import { A2uiGenerator, CatalogConfig } from '@a2ui/agent';

export const CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';

export const CAPABILITIES = {
  '1.0': { supportedCatalogIds: [CATALOG_ID] },
};

let generator: A2uiGenerator | null = null;

function getGenerator(): A2uiGenerator {
  if (!generator) {
    const catalogPath = path.join(process.cwd(), 'catalog-basic.json');
    generator = new A2uiGenerator([CatalogConfig.fromPath(catalogPath)]);
  }
  return generator;
}

/** A fresh processor per turn: chat responses are independent surfaces. */
export function createProcessor() {
  return getGenerator().createProcessor(CAPABILITIES);
}

/** The catalog-derived prompt snippet that teaches the model A2UI Express. */
export function a2uiPromptSnippet(): string {
  return createProcessor().promptSnippet;
}

export interface ParsedPart {
  type: 'text' | 'a2ui' | string;
  text?: string;
  a2ui?: unknown[];
  [key: string]: unknown;
}

/** Parse + validate a full model answer into ordered text and A2UI message parts. */
export function parseAnswer(content: string): ParsedPart[] {
  return createProcessor().parseResponse(content) as ParsedPart[];
}
