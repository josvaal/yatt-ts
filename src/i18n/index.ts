/**
 * i18n selector (D14): English is the default locale, Spanish is the option.
 * All user-facing copy (prompts, SCHEMA_DOC, tool descriptions, validation
 * envelopes and error messages) lives in the locale files; code elsewhere
 * only consumes `getStrings(locale)`.
 */
import { en } from './en.js';
import { es } from './es.js';

export type Locale = 'en' | 'es';

/** A registered MCP prompt: localized name, description and body. */
export interface PromptCopy {
  name: string;
  description: string;
  text: string;
}

/** Localized user-facing messages used by tools and resources. */
export interface YattMessages {
  testDoesNotExist: (name: string) => string;
  testAlreadyExists: (name: string) => string;
  testMissingCreate: (name: string) => string;
  testNameTaken: (name: string) => string;
  reportMissingGet: (name: string) => string;
  reportMissingDelete: (name: string) => string;
  baselineMissing: (name: string) => string;
  subFlowMissing: (name: string) => string;
  datasetSummary: (rows: number, columns: number) => string;
  /** Default name suffix for test_duplicate ("<name> (copy)"). */
  duplicateSuffix: string;
  dbReadOnly: () => string;
  dbEngineRequired: string;
  dbQueryTimeout: (timeoutMs: number) => string;
}

/** Localized descriptions for tool input arguments. */
export interface YattArgCopy {
  testName: string;
  nameToUpdate: string;
  newName: string;
  content: string;
  overwrite: string;
  suggestedName: string;
  format: string;
  write: string;
  reportName: string;
  sql: string;
  db: string;
}

/** Localized tool descriptions. */
export interface YattToolCopy {
  ping: string;
  schema: string;
  baselineList: string;
  baselineGet: string;
  testList: string;
  testGet: string;
  testCreate: string;
  testUpdate: string;
  testDelete: string;
  testRename: string;
  testDuplicate: string;
  testValidate: string;
  testExport: string;
  reportList: string;
  reportGet: string;
  reportDelete: string;
  dbQuery: string;
}

/** Complete copy for one locale. */
export interface YattStrings {
  locale: Locale;
  /** Authoring manual for the YATT test format (schemaVersion 1). */
  schemaDoc: string;
  /** The 5 work prompts (localized names included). */
  prompts: PromptCopy[];
  resources: {
    schema: string;
    test: string;
    report: string;
  };
  tools: YattToolCopy;
  args: YattArgCopy;
  messages: YattMessages;
}

/** Returns the full copy for a locale (`'en'` default, `'es'` option). */
export function getStrings(locale: Locale): YattStrings {
  return locale === 'es' ? es : en;
}

export { en, es };
