import { PREVIEW_CAPABILITY } from '../contracts/preview.js';
import { COLLABORATION_CAPABILITY } from '../contracts/collaboration.js';
import { IMPORT_CAPABILITY } from '../contracts/imports.js';
import { EDITOR_OPERATIONS_CAPABILITY } from '../contracts/editor-operations.js';
import { EDITOR_CAPABILITY, PNG_CAPABILITY } from '../contracts/editor.js';
import { PRODUCT_CAPABILITY } from '../contracts/product.js';
import { ACCESS_CAPABILITY, ACCOUNT_CAPABILITY } from '../contracts/access.js';
import { ADAPTER_CAPABILITY, ADAPTER_REBASE_CAPABILITY, WORKSPACE_CAPABILITY } from '../contracts/adapters.js';
import { RUNNER_CAPABILITY } from '../contracts/runner.js';
import { CAPABILITY } from '../contracts/index.js';
import { MEDIA_CAPABILITY, MEDIA_PROFILES_CAPABILITY } from './media-contract.js';

/**
 * The previous installer treated every `CAPABILITY`/`*_CAPABILITY` export as a
 * requirement. This list preserves exactly that set; a new server capability
 * must be declared here explicitly instead of silently becoming required.
 */
export const REQUIRED_CAPABILITIES = [
  CAPABILITY,
  RUNNER_CAPABILITY,
  ADAPTER_CAPABILITY,
  ADAPTER_REBASE_CAPABILITY,
  WORKSPACE_CAPABILITY,
  ACCESS_CAPABILITY,
  PRODUCT_CAPABILITY,
  EDITOR_CAPABILITY,
  PNG_CAPABILITY,
  EDITOR_OPERATIONS_CAPABILITY,
  IMPORT_CAPABILITY,
  COLLABORATION_CAPABILITY,
  PREVIEW_CAPABILITY,
] as const;

/** New capabilities stay optional so a new plugin keeps working with an old compatible server. */
export const OPTIONAL_CAPABILITIES = [ACCOUNT_CAPABILITY, MEDIA_CAPABILITY, MEDIA_PROFILES_CAPABILITY] as const;

export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];
export type OptionalCapability = (typeof OPTIONAL_CAPABILITIES)[number];

/** Required capabilities the server did not advertise; an empty list means compatible. */
export function missingCapabilities(advertised: readonly string[]): RequiredCapability[] {
  const available = new Set(advertised ?? []);
  return REQUIRED_CAPABILITIES.filter(capability => !available.has(capability));
}

/** Optional capabilities the server did not advertise; absence is allowed. */
export function missingOptionalCapabilities(advertised: readonly string[]): OptionalCapability[] {
  const available = new Set(advertised ?? []);
  return OPTIONAL_CAPABILITIES.filter(capability => !available.has(capability));
}
